// Read-only. Fails if any public social read returns an embedded user carrying private fields.
// Run: npx tsx --env-file=.env scripts/check-public-embeds-leak.ts
import { storage, db } from "../server/storage";
import { toPublicUser } from "../server/auth";
import { users, conversationParticipants, conversationMessages, polls } from "@shared/schema";

const PRIVATE = new Set(["email", "dateOfBirth", "phoneNumber", "verifiedPhone"]);

/** Every private key found anywhere in `value`, as a dotted path. */
function findPrivate(value: unknown, path = "", out: string[] = [], depth = 0): string[] {
  if (!value || typeof value !== "object" || depth > 8) return out;
  if (Array.isArray(value)) { value.forEach((v, i) => findPrivate(v, `${path}[${i}]`, out, depth + 1)); return out; }
  if (value.constructor !== Object) return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (PRIVATE.has(k) && v != null) out.push(`${path}.${k}`);
    else findPrivate(v, `${path}.${k}`, out, depth + 1);
  }
  return out;
}

const feed = await storage.getFeedPosts(undefined, 20);
const firstAuthor: string | undefined = feed.posts[0]?.userId;

const stories = await storage.getActiveStories();
const storyId: string | undefined = stories[0]?.id;
const communities = await storage.getCommunities();
const communityId: string | undefined = communities[0]?.id;
const postWithComments = (await storage.getPosts()).find((p) => p.id) as { id: string } | undefined;
const comments = postWithComments ? await storage.getPostComments(postWithComments.id) : [];
const commentId: string | undefined = comments[0]?.id;
const someUserId: string | undefined = firstAuthor ?? stories[0]?.userId;

// Pick the conversation with the most messages so the chat cases have real rows to inspect.
const [busy] = await db.select({ c: conversationMessages.conversationId }).from(conversationMessages).limit(1);
const convoId: string | undefined = busy?.c;
const [member] = convoId
  ? await db.select({ u: conversationParticipants.userId }).from(conversationParticipants).limit(1)
  : [];
const chatUserId: string | undefined = member?.u;
const someConvos = chatUserId ? await storage.getUserConversations(chatUserId) : [];
const [aPoll] = await db.select({ id: polls.id }).from(polls).limit(1);

// Self-test: the old chat shape (toPublicUser alone) must trip the detector, or a pass below means nothing.
const [anyUser] = await db.select().from(users).limit(1);
const oldShapeLeaks = anyUser ? findPrivate({ sender: toPublicUser(anyUser) }) : ["no users"];
if (oldShapeLeaks.length === 0) { console.log("FAIL  detector self-test: toPublicUser alone should leak"); process.exit(1); }
console.log("ok    detector self-test (old chat shape leaks: " + oldShapeLeaks.join(", ") + ")");

const cases: Array<[string, () => Promise<unknown>]> = [
  ["getFeedPosts", async () => feed.posts],
  ["getPostsWithCommunity", () => storage.getPostsWithCommunity()],
  ["getPosts", () => storage.getPosts()],
  ["searchPosts", () => storage.searchPosts("a")],
  ["getTrendingPosts", () => storage.getTrendingPosts(20)],
  ["getUserLikedPosts", async () => (firstAuthor ? storage.getUserLikedPosts(firstAuthor) : [])],
  ["getUserRepostedPosts", async () => (firstAuthor ? storage.getUserRepostedPosts(firstAuthor) : [])],
  ["getPostComments", async () => comments],
  ["getCommentReplies", async () => (commentId ? storage.getCommentReplies(commentId) : [])],
  ["getCommentThread", async () => (commentId ? storage.getCommentThread(commentId) : [])],
  ["getStoryComments", async () => (storyId ? storage.getStoryComments(storyId) : [])],
  ["getActiveStories", async () => stories],
  ["getStoryViewersWithLikeStatus", async () => (storyId ? storage.getStoryViewersWithLikeStatus(storyId) : [])],
  ["getFollowers", async () => (someUserId ? storage.getFollowers(someUserId) : [])],
  ["getFollowing", async () => (someUserId ? storage.getFollowing(someUserId) : [])],
  ["getCommunities", async () => communities],
  ["getTrendingCommunities", () => storage.getTrendingCommunities(20)],
  ["getCommunityWithDetails", async () => (communityId ? storage.getCommunityWithDetails(communityId) : undefined)],
  ["getCommunityMembers", async () => (communityId ? storage.getCommunityMembers(communityId) : [])],
  ["getSuggestedUsers", async () => (someUserId ? storage.getSuggestedUsers(someUserId) : [])],
  ["getRecommendedUsers", async () => (someUserId ? storage.getRecommendedUsers(someUserId) : [])],
  ["searchUsers", () => storage.searchUsers("a")],
  ["getUserConversations", async () => someConvos],
  ["getPoll", async () => (aPoll ? storage.getPoll(aPoll.id) : undefined)],
  ["getConversationParticipants", async () => (convoId ? storage.getConversationParticipants(convoId) : [])],
  ["getConversationMessages", async () => (convoId ? storage.getConversationMessages(convoId, 50) : [])],
  ["searchConversationMessages", async () => (convoId ? storage.searchConversationMessages(convoId, "a") : [])],
];

let failed = 0;
for (const [name, run] of cases) {
  const result = await run();
  const rows = Array.isArray(result) ? result.length : 1;
  const leaks = findPrivate(result);
  console.log(`${leaks.length ? "FAIL" : "ok  "}  ${name}  (${rows} rows)${leaks.length ? "  leaks: " + [...new Set(leaks.map((l) => l.replace(/\[\d+\]/g, "[]")))].join(", ") : ""}`);
  if (leaks.length) failed++;
}
// Chat must keep "Seen" working: readReceiptsEnabled has to survive on every participant's user.
if (convoId) {
  const parts = (await storage.getConversationParticipants(convoId)) as Array<{ user: Record<string, unknown> }>;
  const missing = parts.filter((p) => !("readReceiptsEnabled" in p.user)).length;
  console.log(`${missing ? "FAIL" : "ok  "}  chat keeps readReceiptsEnabled  (${parts.length} participants)`);
  if (missing) failed++;
}
if (feed.posts.length === 0) { console.log("WARN  no posts in the DB: this check proved nothing"); failed++; }
process.exit(failed ? 1 : 0);
