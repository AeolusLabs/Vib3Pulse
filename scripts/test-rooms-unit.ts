// Rooms unit checks (no database):   npx tsx scripts/test-rooms-unit.ts   (or npm run test:rooms)
import assert from "node:assert/strict";
import { resolveScreen, screenFromStored } from "../shared/screen";
import { DEFAULT_ROOM_PRIVACY, ROOM_LIMITS, ROOM_REACTIONS, resolveRoomPrivacy, validateRoomPrivacy, validateRoomInput } from "../shared/rooms";
import { canJoinRoom, canInteract, canHostRoom } from "../shared/roomRules";
import { TokenBucket } from "../server/rooms/rateLimit";
import { RoomHub } from "../server/rooms/RoomHub";
import { roomReducer, initialRoomState, CHAT_CAP } from "../client/src/lib/roomReducer";
import { MAX_SPEAKERS, applyStage, canBeOnStage, type StageState } from "../shared/stage";
import { cueCountdownMs, needsCorrection, sanitizePlaybackInput, targetPositionMs } from "../shared/playback";
import { getVoiceService, roomNameFor, setVoiceServiceForTests } from "../server/rooms/voice/voiceService";
import { FakeVoice } from "../server/rooms/voice/fakeVoice";
import { speakerIds, speakingRings, voiceStatus } from "../client/src/lib/voiceState";
import { syncDecision, youtubeEmbedWithApi } from "../client/src/lib/playerAdapters";
import { ageFromDob, ageBand, meetsAgeLimit, minAgeForLimit, sameBand, AGE_LIMITS, MIN_PLATFORM_AGE } from "../shared/age";

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e: any) { failed++; console.log(`FAIL ${name}  ${e.message.split("\n")[0]}`); }
};

// ---------------------------------------------------------------- age
test("ageFromDob: birthday today / day before / invalid / null", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  assert.equal(ageFromDob("2013-10-13", now), 13);
  assert.equal(ageFromDob("2013-10-14", now), 12);
  assert.equal(ageFromDob("nope", now), null);
  assert.equal(ageFromDob("2013-13-45", now), null);
  assert.equal(ageFromDob(null, now), null);
  assert.equal(ageFromDob(undefined, now), null);
});

test("ageBand boundaries", () => {
  assert.equal(ageBand(12), null);
  assert.equal(ageBand(13), "teen");
  assert.equal(ageBand(17), "teen");
  assert.equal(ageBand(18), "adult");
  assert.equal(ageBand(null), null);
});

test("minAgeForLimit + MIN_PLATFORM_AGE", () => {
  assert.equal(MIN_PLATFORM_AGE, 13);
  assert.deepEqual([...AGE_LIMITS], ["all", "13+", "16+", "18+", "21+"]);
  assert.deepEqual(AGE_LIMITS.map(minAgeForLimit), [13, 13, 16, 18, 21]);
});

test("meetsAgeLimit matrix", () => {
  const ages = [12, 13, 15, 16, 17, 18, 20, 21];
  const expect: Record<string, boolean[]> = {
    "all": [false, true, true, true, true, true, true, true],
    "13+": [false, true, true, true, true, true, true, true],
    "16+": [false, false, false, true, true, true, true, true],
    "18+": [false, false, false, false, false, true, true, true],
    "21+": [false, false, false, false, false, false, false, true],
  };
  for (const l of AGE_LIMITS) {
    ages.forEach((a, i) => assert.equal(meetsAgeLimit(a, l), expect[l][i], `${l} @ ${a}`));
    assert.equal(meetsAgeLimit(null, l), false, `${l} @ null`);
  }
});

test("sameBand", () => {
  assert.equal(sameBand(17, 18), false);
  assert.equal(sameBand(13, 17), true);
  assert.equal(sameBand(18, 40), true);
  assert.equal(sameBand(null, 18), false);
  assert.equal(sameBand(18, null), false);
  assert.equal(sameBand(12, 12), false);
});

// ---------------------------------------------------------------- screen
const embed = (u: string) => { const r = resolveScreen(u); assert.ok(r.ok, `expected ok for ${u}: ${JSON.stringify(r)}`); return (r as any).screen; };
const ID = "dQw4w9WgXcQ";

test("screen: youtube forms -> nocookie embed from parsed id", () => {
  for (const u of [`https://www.youtube.com/watch?v=${ID}`, `https://youtube.com/watch?v=${ID}&t=5`, `https://m.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`, `https://youtu.be/${ID}?si=abc`, `https://www.youtube.com/shorts/${ID}`, `https://music.youtube.com/watch?v=${ID}`]) {
    const s = embed(u);
    assert.equal(s.provider, "youtube", u); assert.equal(s.kind, "video");
    assert.equal(s.embedUrl, `https://www.youtube-nocookie.com/embed/${ID}`, u);
    assert.equal(s.v, 1); assert.ok(s.openUrl.startsWith("https://"));
  }
});
test("screen: vimeo", () => {
  const s = embed("https://vimeo.com/76979871");
  assert.equal(s.provider, "vimeo"); assert.equal(s.kind, "video");
  assert.equal(s.embedUrl, "https://player.vimeo.com/video/76979871");
});
test("screen: spotify (with intl prefix)", () => {
  assert.equal(embed("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x").embedUrl, "https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC");
  assert.equal(embed("https://open.spotify.com/intl-fr/playlist/37i9dQZF1DXcBWIGoYBM5M").embedUrl, "https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M");
  assert.equal(embed("https://open.spotify.com/album/1A2GTWGtFfWp7KSQTwWOyo").kind, "audio");
});
test("screen: apple music host swapped, soundcloud widget", () => {
  const a = embed("https://music.apple.com/us/album/some-album/1234567890?i=1234567891");
  assert.equal(a.provider, "apple_music"); assert.ok(a.embedUrl.startsWith("https://embed.music.apple.com/us/album/some-album/1234567890"));
  assert.equal(new URL(a.embedUrl).host, "embed.music.apple.com");
  const sc = embed("https://soundcloud.com/some-artist/some-track");
  assert.equal(sc.provider, "soundcloud");
  assert.equal(sc.embedUrl, `https://w.soundcloud.com/player/?url=${encodeURIComponent("https://soundcloud.com/some-artist/some-track")}`);
});
test("screen: images and our media route", () => {
  const i = embed("https://cdn.example.com/a/b.PNG"); assert.equal(i.provider, "image"); assert.equal(i.kind, "image"); assert.equal(i.embedUrl, undefined);
  assert.equal(embed("/api/media/abc123").provider, "image");
  assert.equal(embed("https://example.com/p.webp?x=1").kind, "image");
});
test("screen: other https is a link card with no embed", () => {
  const s = embed("https://example.com/page"); assert.equal(s.provider, "link"); assert.equal(s.kind, "link"); assert.equal(s.embedUrl, undefined); assert.equal(s.openUrl, "https://example.com/page");
  const t = embed("https://www.tiktok.com/@x/video/1"); assert.equal(t.kind, "link");
});
test("screen: hostile input never becomes an iframe", () => {
  const bad = ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "http://youtube.com/watch?v=" + ID, "ftp://youtube.com/x", "//youtube.com/watch?v=" + ID, "/api/media/../../etc/passwd", "not a url", "", `https://youtube.com@evil.test/watch?v=${ID}`];
  for (const u of bad) { const r = resolveScreen(u); assert.equal(r.ok, false, u); }
  assert.equal((resolveScreen("javascript:alert(1)") as any).reason, "unsafe_scheme");
  assert.equal((resolveScreen("not a url") as any).reason, "invalid_url");
  const long = resolveScreen("https://example.com/" + "a".repeat(3000)); assert.equal(long.ok, false); assert.equal((long as any).reason, "too_long");
  for (const u of [`https://youtube.com.evil.test/watch?v=${ID}`, `https://evil.test/?u=https://youtube.com/watch?v=${ID}`, `https://evilyoutube.com/watch?v=${ID}`,
    "https://vimeo.com.evil.test/123456", "https://open.spotify.com.evil.test/track/4uLU6hMCjMI75M1A2tKUQC",
    "https://music.apple.com.evil.test/us/album/x/1", "https://soundcloud.com.evil.test/a/b"]) {
    const r = resolveScreen(u); assert.ok(r.ok && r.screen.provider === "link" && r.screen.embedUrl === undefined, u);
  }
  // known host but malformed id -> link, not embed
  const r = resolveScreen("https://www.youtube.com/watch?v=x%22onload=alert(1)"); assert.ok(r.ok && r.screen.embedUrl === undefined);
});
test("screen: embedUrl is never built from raw user strings", () => {
  const s = embed(`https://youtu.be/${ID}?x="><script>`);
  assert.equal(s.embedUrl, `https://www.youtube-nocookie.com/embed/${ID}`);
});
test("screenFromStored re-validates and never throws", () => {
  assert.equal(screenFromStored("junk"), null);
  assert.equal(screenFromStored(null), null);
  assert.equal(screenFromStored({ provider: "youtube", embedUrl: "https://evil.test" }), null);
  assert.equal(screenFromStored({ url: "javascript:alert(1)" }), null);
  const s = screenFromStored({ v: 1, provider: "link", url: `https://youtu.be/${ID}`, embedUrl: "https://evil.test/x", title: "T" });
  assert.equal(s?.embedUrl, `https://www.youtube-nocookie.com/embed/${ID}`); // stored embedUrl ignored, recomputed
  assert.equal(s?.title, "T");
});

// ---------------------------------------------------------------- rooms types + rules
const NOW = new Date("2026-10-13T12:00:00Z");
const okInput = { title: "Friday pre-party", kind: "party", visibility: "public", ageLimit: "18+" };

test("resolveRoomPrivacy: null/junk/{} give defaults; partial merges per field", () => {
  for (const v of [null, undefined, "x", 5, [], {}]) assert.deepEqual(resolveRoomPrivacy(v), DEFAULT_ROOM_PRIVACY);
  assert.deepEqual(DEFAULT_ROOM_PRIVACY, { v: 1, interactions: "mutuals", appearInLists: true, allowInvites: true, allowCrossAgeDm: false });
  assert.deepEqual(resolveRoomPrivacy({ interactions: "none" }), { ...DEFAULT_ROOM_PRIVACY, interactions: "none" });
  assert.deepEqual(resolveRoomPrivacy({ interactions: "bogus", appearInLists: false }), { ...DEFAULT_ROOM_PRIVACY, appearInLists: false });
});

test("validateRoomPrivacy: strict, names the field", () => {
  const good = { interactions: "everyone", appearInLists: false, allowInvites: true };
  assert.deepEqual(validateRoomPrivacy(good), { ok: true, value: { v: 1, ...good, allowCrossAgeDm: false } }); // omitted -> the safe default
  assert.deepEqual(validateRoomPrivacy({ ...good, allowCrossAgeDm: true }), { ok: true, value: { v: 1, ...good, allowCrossAgeDm: true } });
  assert.deepEqual(validateRoomPrivacy({ ...good, allowCrossAgeDm: "yes" }), { ok: false, field: "allowCrossAgeDm" });
  assert.equal(resolveRoomPrivacy({ interactions: "none" }).allowCrossAgeDm, false); // stored values without the key stay restricted
  const bad = (x: unknown, field: string) => assert.deepEqual(validateRoomPrivacy(x), { ok: false, field });
  bad(null, "body"); bad("x", "body");
  bad({ ...good, interactions: "friends" }, "interactions");
  bad({ ...good, appearInLists: "yes" }, "appearInLists");
  bad({ ...good, allowInvites: 1 }, "allowInvites");
  bad({ ...good, admin: true }, "admin");
  bad({ interactions: "none", appearInLists: true }, "allowInvites");
  assert.ok(ROOM_REACTIONS.length === 8 && new Set(ROOM_REACTIONS).size === 8);
  assert.deepEqual(ROOM_LIMITS, { capacityDefault: 50, capacityMax: 50, capacityMaxPaid: 150, title: 80, description: 500, chat: 300 });
});

test("validateRoomInput: valid + defaults", () => {
  const r = validateRoomInput(okInput, NOW) as any;
  assert.equal(r.ok, true); assert.equal(r.value.capacity, 50); assert.equal(r.value.noDirectInteractions, false); assert.equal(r.value.title, "Friday pre-party");
  const d = validateRoomInput({ ...okInput, ageLimit: undefined, title: "  x  " }, NOW) as any;
  assert.equal(d.value.ageLimit, "all"); assert.equal(d.value.title, "x");
});

test("validateRoomInput: boundaries name the field", () => {
  const bad = (patch: object, field: string) => assert.deepEqual(validateRoomInput({ ...okInput, ...patch }, NOW), { ok: false, field }, JSON.stringify(patch));
  const good = (patch: object) => assert.equal((validateRoomInput({ ...okInput, ...patch }, NOW) as any).ok, true, JSON.stringify(patch));
  assert.deepEqual(validateRoomInput(null, NOW), { ok: false, field: "body" });
  bad({ title: "" }, "title"); bad({ title: "   " }, "title"); bad({ title: "a".repeat(81) }, "title"); good({ title: "a".repeat(80) });
  bad({ description: "a".repeat(501) }, "description"); good({ description: "a".repeat(500) });
  bad({ kind: "rave" }, "kind"); bad({ visibility: "secret" }, "visibility"); bad({ ageLimit: "19+" }, "ageLimit");
  bad({ capacity: 1 }, "capacity"); good({ capacity: 2 }); good({ capacity: 50 }); bad({ capacity: 51 }, "capacity"); bad({ capacity: 100 }, "capacity"); bad({ capacity: 5.5 }, "capacity");
  bad({ eventId: "e1", venueId: "v1" }, "venueId"); good({ eventId: "e1" }); good({ venueId: "v1" });
  bad({ noDirectInteractions: "yes" }, "noDirectInteractions");
  bad({ screenUrl: 5 }, "screenUrl"); bad({ screenUrl: "a".repeat(2049) }, "screenUrl");
  bad({ scheduledFor: "soon" }, "scheduledFor");
  bad({ scheduledFor: "2026-10-13T11:59:00Z" }, "scheduledFor");
  good({ scheduledFor: "2026-10-13T12:05:00Z" });
  good({ scheduledFor: new Date(NOW.getTime() + 90 * 86400000).toISOString() });
  bad({ scheduledFor: new Date(NOW.getTime() + 90 * 86400000 + 60000).toISOString() }, "scheduledFor");
});

const P = (interactions: "everyone" | "mutuals" | "none") => ({ ...DEFAULT_ROOM_PRIVACY, interactions });
test("canJoinRoom: boundaries and unknown age", () => {
  assert.deepEqual(canJoinRoom({ age: null }, { ageLimit: "all" }), { ok: false, code: "AGE_UNKNOWN" });
  assert.deepEqual(canJoinRoom({ age: 12 }, { ageLimit: "all" }), { ok: false, code: "AGE_LIMIT" });
  assert.deepEqual(canJoinRoom({ age: 13 }, { ageLimit: "all" }), { ok: true });
  assert.deepEqual(canJoinRoom({ age: 15 }, { ageLimit: "16+" }), { ok: false, code: "AGE_LIMIT" });
  assert.deepEqual(canJoinRoom({ age: 16 }, { ageLimit: "16+" }), { ok: true });
  assert.deepEqual(canJoinRoom({ age: 17 }, { ageLimit: "18+" }), { ok: false, code: "AGE_LIMIT" });
  assert.deepEqual(canJoinRoom({ age: 18 }, { ageLimit: "18+" }), { ok: true });
  assert.deepEqual(canJoinRoom({ age: 20 }, { ageLimit: "21+" }), { ok: false, code: "AGE_LIMIT" });
  assert.deepEqual(canJoinRoom({ age: 21 }, { ageLimit: "21+" }), { ok: true });
});

test("canInteract: full matrix, first failing code in order BLOCKED > ROOM_NO_DIRECT > PRIVACY > AGE_BAND", () => {
  let n = 0;
  for (const blocked of [false, true]) for (const mutual of [false, true]) for (const priv of ["everyone", "mutuals", "none"] as const)
    for (const noDirect of [false, true]) for (const [aAge, tAge] of [[20, 30], [17, 16], [17, 20], [20, 17], [null, 20], [20, null], [12, 12]] as const) {
      const privOk = priv === "everyone" || (priv === "mutuals" && mutual);
      const bandOk = ageBand(aAge) !== null && ageBand(aAge) === ageBand(tAge);
      const expected = blocked ? "BLOCKED" : noDirect ? "ROOM_NO_DIRECT" : !privOk ? "PRIVACY" : !bandOk ? "AGE_BAND" : null;
      const r = canInteract({ age: aAge, privacy: P("everyone") }, { age: tAge, privacy: P(priv) }, { noDirectInteractions: noDirect }, { blocked, mutualFollow: mutual });
      assert.deepEqual(r, expected ? { ok: false, code: expected } : { ok: true }, JSON.stringify({ blocked, mutual, priv, noDirect, aAge, tAge }));
      n++;
    }
  assert.equal(n, 2 * 2 * 3 * 2 * 7);
});

test("canInteract: actor's own opt-out does not stop them sending; target's does", () => {
  const rel = { blocked: false, mutualFollow: false };
  assert.deepEqual(canInteract({ age: 20, privacy: P("none") }, { age: 22, privacy: P("everyone") }, { noDirectInteractions: false }, rel), { ok: true });
  assert.deepEqual(canInteract({ age: 20, privacy: P("everyone") }, { age: 22, privacy: P("none") }, { noDirectInteractions: false }, rel), { ok: false, code: "PRIVACY" });
});

test("canHostRoom", () => {
  const cfg = { minAccountAgeDays: 7 };
  const host = (age: number | null, accountAgeDays = 30) => ({ age, accountAgeDays });
  assert.deepEqual(canHostRoom(host(null), { visibility: "friends", ageLimit: "all" }, cfg), { ok: false, code: "AGE_UNKNOWN" });
  assert.deepEqual(canHostRoom(host(16), { visibility: "public", ageLimit: "all" }, cfg), { ok: false, code: "TEEN_PUBLIC" });
  assert.deepEqual(canHostRoom(host(16), { visibility: "friends", ageLimit: "all" }, cfg), { ok: true });
  assert.deepEqual(canHostRoom(host(17), { visibility: "invite", ageLimit: "18+" }, cfg), { ok: false, code: "HOST_BELOW_LIMIT" });
  assert.deepEqual(canHostRoom(host(17), { visibility: "invite", ageLimit: "16+" }, cfg), { ok: true });
  assert.deepEqual(canHostRoom(host(20), { visibility: "public", ageLimit: "21+" }, cfg), { ok: false, code: "HOST_BELOW_LIMIT" });
  assert.deepEqual(canHostRoom(host(21), { visibility: "public", ageLimit: "21+" }, cfg), { ok: true });
  assert.deepEqual(canHostRoom(host(25, 6), { visibility: "public", ageLimit: "all" }, cfg), { ok: false, code: "ACCOUNT_TOO_NEW" });
  assert.deepEqual(canHostRoom(host(25, 7), { visibility: "public", ageLimit: "all" }, cfg), { ok: true });
  assert.deepEqual(canHostRoom(host(25, 0), { visibility: "friends", ageLimit: "all" }, cfg), { ok: true }); // new accounts may host non-public
  assert.deepEqual(canHostRoom(host(12), { visibility: "friends", ageLimit: "all" }, cfg), { ok: false, code: "HOST_BELOW_LIMIT" });
});

// ---------------------------------------------------------------- hub + rate limit (server/rooms, no database)
test("TokenBucket: burst, then refill at the rate (injected clock)", () => {
  let t = 0;
  const b = new TokenBucket(1, 5, () => t);
  assert.deepEqual(Array.from({ length: 7 }, () => b.take()), [true, true, true, true, true, false, false]);
  t += 999; assert.equal(b.take(), false);
  t += 1; assert.equal(b.take(), true);
  t += 60_000; assert.deepEqual(Array.from({ length: 6 }, () => b.take()), [true, true, true, true, true, false]); // never above burst
  const slow = new TokenBucket(0.5, 1, () => t); // 1 per 2 s
  assert.equal(slow.take(), true); t += 1999; assert.equal(slow.take(), false); t += 1; assert.equal(slow.take(), true);
});

test("RoomHub: one entry per user, one room per user, ordered members, end clears", () => {
  const hub = new RoomHub();
  const got: any[] = [];
  const m = (userId: string, role: any = "guest") => ({ userId, role, muted: false, joinedAt: 0, send: (x: object) => got.push([userId, x]) });
  assert.equal(hub.join("r1", m("a", "host")), null);
  hub.join("r1", m("b")); hub.join("r1", m("b")); // second socket of the same user
  assert.equal(hub.count("r1"), 2);
  assert.deepEqual(hub.members("r1").map((x) => x.userId), ["a", "b"]);
  assert.deepEqual(hub.members("r1", 1).map((x) => x.userId), ["a"]);
  hub.broadcast("r1", { type: "x" }, "a");
  assert.deepEqual(got.map((g) => g[0]), ["b"]);
  assert.equal(hub.join("r2", m("b")), "r1"); // joining another room leaves the first
  assert.equal(hub.count("r1"), 1); assert.equal(hub.roomOf("b"), "r2"); assert.equal(hub.get("r1", "b"), undefined);
  hub.recordChat("r2", { userId: "b", text: "hi", at: 1 });
  for (let i = 0; i < 60; i++) hub.recordChat("r2", { userId: "b", text: `m${i}`, at: i });
  assert.equal(hub.recentChat("r2").length, 50); assert.equal(hub.recentChat("r2")[49].text, "m59");
  got.length = 0;
  const gone = hub.end("r2");
  assert.deepEqual(gone.map((x) => x.userId), ["b"]); assert.equal(got[0][1].type, "room:ended");
  assert.equal(hub.count("r2"), 0); assert.equal(hub.roomOf("b"), null); assert.deepEqual(hub.recentChat("r2"), []);
  assert.equal(hub.leave("r1", "nobody"), undefined);
});

// ---------------------------------------------------------------- client room reducer (pure)
const member = (userId: string, role: any = "guest", extra: object = {}) => ({ userId, role, muted: false, joinedAt: 1, username: userId, ...extra });
const stateMsg = (roomId = "r1", members: any[] = [member("host", "host"), member("me")], memberCount = members.length) =>
  ({ type: "room:state", room: { id: roomId }, members, memberCount, screen: null, you: { role: "guest", muted: false } }) as const;
const reduce = (events: any[], selfId: string | null = "me", now = () => 1000) =>
  events.reduce((s, e) => roomReducer(s, e, now), initialRoomState(selfId));

test("reducer: idle -> connecting -> live with state", () => {
  assert.equal(initialRoomState().phase, "idle");
  const s = reduce([{ type: "client:connecting" }, stateMsg()]);
  assert.equal(s.phase, "live"); assert.equal(s.memberCount, 2); assert.equal(s.members.length, 2); assert.equal(s.you?.role, "guest"); assert.equal(s.room?.id, "r1");
});

test("reducer: joined adds, duplicate join is idempotent, left removes and counts down", () => {
  let s = reduce([stateMsg()]);
  s = roomReducer(s, { type: "room:joined", member: member("g1") });
  assert.equal(s.memberCount, 3); assert.equal(s.members.length, 3);
  s = roomReducer(s, { type: "room:joined", member: member("g1", "guest", { username: "renamed" }) });
  assert.equal(s.memberCount, 3); assert.equal(s.members.length, 3); assert.equal(s.members.find((m) => m.userId === "g1")?.username, "renamed");
  s = roomReducer(s, { type: "room:left", userId: "g1" });
  assert.equal(s.memberCount, 2); assert.ok(!s.members.some((m) => m.userId === "g1"));
  s = roomReducer(s, { type: "room:left", userId: "not-in-the-capped-list" });
  assert.equal(s.memberCount, 1); // list is capped server-side, the count still drops
  s = reduce([stateMsg("r1", [], 0), { type: "room:left", userId: "x" }]);
  assert.equal(s.memberCount, 0); // never negative
});

test("reducer: chat list capped at 200, newest kept, ids unique", () => {
  let s = reduce([stateMsg()]);
  for (let i = 0; i < 230; i++) s = roomReducer(s, { type: "room:chat", userId: "me", text: `m${i}`, at: i });
  assert.equal(s.chat.length, CHAT_CAP); assert.equal(s.chat[0].text, "m30"); assert.equal(s.chat[199].text, "m229");
  assert.equal(new Set(s.chat.map((c) => c.id)).size, CHAT_CAP);
});

test("reducer: reactions and interactions expire on demand", () => {
  let s = reduce([stateMsg()], "me", () => 5000);
  s = roomReducer(s, { type: "room:react", userId: "g1", emoji: "🔥", at: 1000 }, () => 5000);
  s = roomReducer(s, { type: "room:react", userId: "g1", emoji: "❤️" }, () => 5000);
  s = roomReducer(s, { type: "room:interact", fromId: "g1", targetId: "me", kind: "wave" }, () => 5000);
  assert.equal(s.reactions.length, 2); assert.equal(s.reactions[1].at, 5000); assert.equal(s.interactions.length, 1);
  s = roomReducer(s, { type: "client:expire", before: 3000 });
  assert.deepEqual(s.reactions.map((r) => r.emoji), ["❤️"]); assert.equal(s.interactions.length, 1);
  s = roomReducer(s, { type: "client:expire", before: 6000 });
  assert.equal(s.reactions.length, 0); assert.equal(s.interactions.length, 0);
});

test("reducer: screen updates; mute/unmute/role of self update you; of others update the member", () => {
  let s = reduce([stateMsg()]);
  s = roomReducer(s, { type: "room:screen", screen: { v: 1, provider: "link", kind: "link", url: "https://e.test/", openUrl: "https://e.test/" } });
  assert.equal(s.screen?.provider, "link");
  s = roomReducer(s, { type: "room:screen", screen: null }); assert.equal(s.screen, null);
  s = roomReducer(s, { type: "room:mod", action: "mute", targetId: "me" });
  assert.equal(s.you?.muted, true); assert.equal(s.members.find((m) => m.userId === "me")?.muted, true);
  s = roomReducer(s, { type: "room:mod", action: "unmute", targetId: "me" }); assert.equal(s.you?.muted, false);
  s = roomReducer(s, { type: "room:mod", action: "mute", targetId: "host" }); assert.equal(s.you?.muted, false); assert.equal(s.members.find((m) => m.userId === "host")?.muted, true);
  s = roomReducer(s, { type: "room:mod", action: "role", targetId: "me", role: "cohost" });
  assert.equal(s.you?.role, "cohost"); assert.equal(s.members.find((m) => m.userId === "me")?.role, "cohost");
});

test("reducer: being kicked or banned is terminal; someone else being removed is not", () => {
  const live = reduce([stateMsg()]);
  assert.equal(roomReducer(live, { type: "room:mod", action: "kick", targetId: "other" }).phase, "live");
  const k = roomReducer(live, { type: "room:mod", action: "kick", targetId: "me" });
  assert.equal(k.phase, "denied"); assert.equal(k.error, "KICKED");
  const b = roomReducer(live, { type: "room:mod", action: "ban", targetId: "me" });
  assert.equal(b.error, "BANNED");
});

test("reducer: ended and error are terminal; later messages cannot resurrect the room", () => {
  let s = reduce([stateMsg(), { type: "room:ended" }]);
  assert.equal(s.phase, "ended");
  const after = [stateMsg(), { type: "room:chat", userId: "x", text: "late", at: 1 }, { type: "room:joined", member: member("z") }, { type: "client:reconnecting" }];
  for (const e of after) assert.equal(roomReducer(s, e as any), s, e.type);
  const d = reduce([{ type: "client:connecting" }, { type: "room:error", code: "AGE_LIMIT" }]);
  assert.equal(d.phase, "denied"); assert.equal(d.error, "AGE_LIMIT"); assert.equal(roomReducer(d, stateMsg()), d);
  assert.equal(roomReducer(d, { type: "client:connecting" }).phase, "connecting"); // an explicit retry is allowed
  assert.equal(roomReducer(s, { type: "client:reset" }).phase, "idle");
});

test("reducer: notices are non-terminal and repeat-detectable", () => {
  let s = reduce([stateMsg()]);
  s = roomReducer(s, { type: "room:notice", code: "RATE_LIMITED" }); const n1 = s.notice!.n;
  s = roomReducer(s, { type: "room:notice", code: "RATE_LIMITED" });
  assert.equal(s.phase, "live"); assert.equal(s.notice?.code, "RATE_LIMITED"); assert.ok(s.notice!.n > n1);
});

test("reducer: reconnect keeps the room, state resync restores live; a different room resets chat", () => {
  let s = reduce([stateMsg("r1"), { type: "room:chat", userId: "g", text: "hi", at: 1 }]);
  s = roomReducer(s, { type: "client:reconnecting" });
  assert.equal(s.phase, "reconnecting"); assert.equal(s.chat.length, 1); assert.equal(s.members.length, 2);
  s = roomReducer(s, stateMsg("r1"));
  assert.equal(s.phase, "live"); assert.equal(s.chat.length, 1);
  s = roomReducer(s, stateMsg("r2"));
  assert.equal(s.chat.length, 0);
  assert.equal(roomReducer(initialRoomState(), { type: "client:reconnecting" }).phase, "idle"); // nothing to reconnect to
});

// ---------------------------------------------------------------- stage rules + playback maths (pure)
const ctx = (over: Partial<Parameters<typeof applyStage>[2]> = {}) => ({ actorId: "me", actorRole: "guest" as const, targetId: "me", targetRole: "guest" as const, targetPresent: true, targetEligible: true, implicitSpeakers: 1, maxSpeakers: MAX_SPEAKERS, ...over });
const S = (over: Partial<StageState> = {}): StageState => ({ stage: [], hands: [], invited: [], ...over });
const okState = (r: any) => { assert.equal(r.ok, true, JSON.stringify(r)); return r.state as StageState; };
const code = (r: any) => { assert.equal(r.ok, false, JSON.stringify(r)); return r.code as string; };

test("canBeOnStage: adults always, teens only when everyone present is a teen, unknown never", () => {
  assert.equal(MAX_SPEAKERS, 6);
  assert.deepEqual(canBeOnStage({ age: 30 }, { bands: ["adult", "teen", "adult"] }), { ok: true });
  assert.deepEqual(canBeOnStage({ age: 16 }, { bands: ["teen", "teen", "teen"] }), { ok: true });
  assert.deepEqual(canBeOnStage({ age: 16 }, { bands: ["teen", "adult"] }), { ok: false, code: "ADULT_PRESENT" });
  assert.deepEqual(canBeOnStage({ age: 17 }, { bands: ["teen", null] }), { ok: false, code: "ADULT_PRESENT" }); // someone of unknown age is not a teen either
  assert.deepEqual(canBeOnStage({ age: 13 }, { bands: ["teen"] }), { ok: true });
  assert.deepEqual(canBeOnStage({ age: null }, { bands: ["teen"] }), { ok: false, code: "AGE_UNKNOWN" });
  assert.deepEqual(canBeOnStage({ age: 12 }, { bands: ["teen"] }), { ok: false, code: "AGE_UNKNOWN" });
});

test("applyStage: raise and lower are self only; raise needs eligibility", () => {
  assert.deepEqual(okState(applyStage(S(), "raise", ctx())).hands, ["me"]);
  assert.deepEqual(okState(applyStage(S({ hands: ["me"] }), "raise", ctx())).hands, ["me"]); // idempotent
  assert.equal(code(applyStage(S(), "raise", ctx({ targetId: "x" }))), "FORBIDDEN");
  assert.equal(code(applyStage(S(), "raise", ctx({ targetEligible: false }))), "NOT_ELIGIBLE");
  assert.equal(code(applyStage(S({ stage: ["me"] }), "raise", ctx())), "BAD_STATE");
  assert.equal(code(applyStage(S(), "raise", ctx({ actorRole: "host", targetRole: "host" }))), "BAD_STATE"); // implicit speaker
  const lowered = okState(applyStage(S({ stage: ["me", "b"], hands: ["me"], invited: ["me"] }), "lower", ctx()));
  assert.deepEqual(lowered, S({ stage: ["b"] }));
  assert.equal(code(applyStage(S({ stage: ["x"] }), "lower", ctx({ targetId: "x" }))), "FORBIDDEN"); // you cannot lower someone else: use remove
});

test("applyStage: host and co-host give speaking rights to ANY present eligible guest (hand not required)", () => {
  for (const actorRole of ["host", "cohost"] as const) {
    const noHand = okState(applyStage(S(), "accept", ctx({ actorId: "h", actorRole, targetId: "g" })));
    assert.deepEqual(noHand.stage, ["g"]);
    const withHand = okState(applyStage(S({ hands: ["g", "z"], invited: ["g"] }), "accept", ctx({ actorId: "h", actorRole, targetId: "g" })));
    assert.deepEqual(withHand, S({ stage: ["g"], hands: ["z"] }));
  }
  assert.equal(code(applyStage(S(), "accept", ctx({ actorId: "h", actorRole: "host", targetId: "g", targetPresent: false }))), "TARGET_GONE");
  assert.equal(code(applyStage(S(), "accept", ctx({ actorId: "h", actorRole: "host", targetId: "g", targetEligible: false }))), "NOT_ELIGIBLE");
  assert.equal(code(applyStage(S({ stage: ["g"] }), "accept", ctx({ actorId: "h", actorRole: "host", targetId: "g" }))), "BAD_STATE");
  assert.equal(code(applyStage(S(), "accept", ctx({ actorId: "h", actorRole: "host", targetId: "c", targetRole: "cohost" }))), "FORBIDDEN");
  assert.equal(code(applyStage(S(), "accept", ctx({ actorId: "g1", actorRole: "guest", targetId: "g2" }))), "FORBIDDEN"); // a guest cannot give rights to another
});

test("applyStage: invite then the guest accepts; accept without an invite is BAD_STATE", () => {
  const invited = okState(applyStage(S(), "invite", ctx({ actorId: "h", actorRole: "host", targetId: "g" })));
  assert.deepEqual(invited.invited, ["g"]);
  assert.deepEqual(okState(applyStage(invited, "invite", ctx({ actorId: "h", actorRole: "host", targetId: "g" }))).invited, ["g"]); // idempotent
  const onStage = okState(applyStage(invited, "accept", ctx({ actorId: "g", targetId: "g" })));
  assert.deepEqual(onStage, S({ stage: ["g"] }));
  assert.equal(code(applyStage(S(), "accept", ctx({ actorId: "g", targetId: "g" }))), "BAD_STATE");
  assert.equal(code(applyStage(S(), "invite", ctx({ actorId: "g1", actorRole: "guest", targetId: "g2" }))), "FORBIDDEN");
  assert.equal(code(applyStage(S(), "invite", ctx({ actorId: "h", actorRole: "host", targetId: "g", targetPresent: false }))), "TARGET_GONE");
  assert.equal(code(applyStage(S(), "invite", ctx({ actorId: "h", actorRole: "host", targetId: "g", targetEligible: false }))), "NOT_ELIGIBLE");
});

test("applyStage: the speaker cap counts host + co-hosts + stage guests", () => {
  const full = S({ stage: ["a", "b", "c", "d"] }); // 2 implicit + 4 = 6
  assert.equal(code(applyStage(full, "accept", ctx({ actorId: "h", actorRole: "host", targetId: "g", implicitSpeakers: 2 }))), "STAGE_FULL");
  assert.deepEqual(okState(applyStage(S({ stage: ["a", "b", "c"] }), "accept", ctx({ actorId: "h", actorRole: "host", targetId: "g", implicitSpeakers: 2 }))).stage, ["a", "b", "c", "g"]); // lands exactly on 6
  assert.equal(code(applyStage(S({ invited: ["g"], stage: ["a", "b", "c", "d", "e"] }), "accept", ctx({ actorId: "g", targetId: "g", implicitSpeakers: 1 }))), "STAGE_FULL");
});

test("applyStage: remove is host/co-host on guests; nobody acts on a host; a co-host cannot act on a co-host; state is never mutated", () => {
  const before = S({ stage: ["g"], hands: ["g"], invited: ["g"] });
  const snapshot = JSON.stringify(before);
  assert.deepEqual(okState(applyStage(before, "remove", ctx({ actorId: "h", actorRole: "host", targetId: "g" }))), S());
  assert.deepEqual(okState(applyStage(before, "remove", ctx({ actorId: "c", actorRole: "cohost", targetId: "g" }))), S());
  assert.equal(JSON.stringify(before), snapshot);
  assert.equal(code(applyStage(before, "remove", ctx({ actorId: "g2", actorRole: "guest", targetId: "g" }))), "FORBIDDEN");
  assert.equal(code(applyStage(before, "remove", ctx({ actorId: "c", actorRole: "cohost", targetId: "h", targetRole: "host" }))), "FORBIDDEN");
  assert.equal(code(applyStage(before, "remove", ctx({ actorId: "c", actorRole: "cohost", targetId: "c2", targetRole: "cohost" }))), "FORBIDDEN");
  assert.equal(code(applyStage(before, "remove", ctx({ actorId: "h", actorRole: "host", targetId: "c", targetRole: "host" }))), "FORBIDDEN");
});

test("sanitizePlaybackInput: only valid states, finite clamped positions, current screen version", () => {
  const ok = (i: unknown) => sanitizePlaybackInput(i, 3) as any;
  assert.deepEqual(ok({ state: "playing", positionMs: 5000, screenVersion: 3 }), { ok: true, state: "playing", positionMs: 5000 });
  assert.deepEqual(ok({ state: "paused", positionMs: 12.9, screenVersion: 3 }), { ok: true, state: "paused", positionMs: 12 });
  for (const bad of [null, "x", { state: "play", positionMs: 1, screenVersion: 3 }, { state: "playing", positionMs: NaN, screenVersion: 3 }, { state: "playing", positionMs: Infinity, screenVersion: 3 },
    { state: "playing", positionMs: "5", screenVersion: 3 }, { state: "playing", positionMs: 5, screenVersion: 2 }, { state: "playing", positionMs: 5 }]) {
    assert.equal(ok(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(ok({ state: "cue", positionMs: 0, screenVersion: 3 }).inMs, 5000); // a cue without inMs defaults to 5 s
  assert.equal(ok({ state: "playing", positionMs: -5, screenVersion: 3 }).positionMs, 0);
  assert.equal(ok({ state: "playing", positionMs: 9e12, screenVersion: 3 }).positionMs, 86_400_000);
  assert.equal(ok({ state: "cue", positionMs: 0, inMs: 5, screenVersion: 3 }).inMs, 1000);
  assert.equal(ok({ state: "cue", positionMs: 0, inMs: 999999, screenVersion: 3 }).inMs, 30000);
  assert.equal(ok({ state: "cue", positionMs: 0, inMs: 5000, screenVersion: 3 }).inMs, 5000);
  assert.equal(ok({ state: "playing", positionMs: 5, inMs: 5000, screenVersion: 3 }).inMs, undefined); // inMs only means something for a cue
});

test("playback maths: target position, drift tolerance, cue countdown", () => {
  const np = (over: object = {}) => ({ v: 1 as const, screenVersion: 1, state: "playing" as const, positionMs: 10_000, atServerMs: 1_000_000, ...over });
  assert.equal(targetPositionMs(np(), 1_002_500), 12_500);
  assert.equal(targetPositionMs(np({ state: "paused" }), 1_009_000), 10_000);
  assert.equal(targetPositionMs(np({ state: "ended" }), 1_009_000), 10_000);
  assert.equal(targetPositionMs(np(), 999_000), 10_000); // a client clock that is behind never goes negative or backwards
  assert.equal(needsCorrection(1000, 2400), false);
  assert.equal(needsCorrection(1000, 2600), true);
  assert.equal(needsCorrection(5000, 3000), true);
  assert.equal(needsCorrection(1000, 1600, 500), true);
  assert.equal(cueCountdownMs(np(), 1_000_100), null);
  assert.equal(cueCountdownMs(np({ state: "cue", startAtServerMs: 1_005_000 }), 1_002_000), 3000);
  assert.equal(cueCountdownMs(np({ state: "cue", startAtServerMs: 1_005_000 }), 1_009_000), 0);
});

// ---------------------------------------------------------------- voice service (no network)
const b64json = (seg: string) => JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void> | void) => {
  const keys = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]; const prev = keys.map((k) => process.env[k]);
  keys.forEach((k) => { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; });
  try { await fn(); } finally { keys.forEach((k, i) => { if (prev[i] === undefined) delete process.env[k]; else process.env[k] = prev[i]; }); }
};
const DUMMY = { LIVEKIT_URL: "wss://example.livekit.test", LIVEKIT_API_KEY: "APIdummykey", LIVEKIT_API_SECRET: "dummy-secret-value-for-tests-0123456789" };

await (async () => {
  try {
    await withEnv({}, () => { assert.equal(getVoiceService(), null); });
    for (const missing of ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]) await withEnv({ ...DUMMY, [missing]: undefined }, () => { assert.equal(getVoiceService(), null, `missing ${missing}`); });
    await withEnv(DUMMY, () => { const v = getVoiceService(); assert.ok(v); assert.equal(v!.url, DUMMY.LIVEKIT_URL); });
    passed++; console.log("PASS voice: unavailable unless URL, key and secret are all set; url comes from env");
  } catch (e: any) { failed++; console.log(`FAIL voice: env selection  ${e.message.split("\n")[0]}`); }
  try {
    assert.equal(roomNameFor("abc"), "vp-abc");
    await withEnv(DUMMY, async () => {
      const v = getVoiceService()!;
      const pub = b64json((await v.mintToken({ roomId: "r1", userId: "u1", displayName: "Alex", canPublish: true })).split(".")[1]);
      assert.equal(pub.video.room, "vp-r1"); assert.equal(pub.video.roomJoin, true); assert.equal(pub.video.canSubscribe, true);
      assert.equal(pub.video.canPublish, true); assert.equal(pub.video.canPublishData, false);
      assert.equal(pub.sub, "u1"); assert.equal(pub.name, "Alex"); assert.equal(pub.exp - pub.nbf, 60, "one minute token");
      assert.equal(pub.iss, DUMMY.LIVEKIT_API_KEY);
      const listen = b64json((await v.mintToken({ roomId: "r1", userId: "u2", displayName: "Sam", canPublish: false })).split(".")[1]);
      assert.equal(listen.video.canPublish, false); assert.equal(listen.video.canSubscribe, true);
      const raw = await v.mintToken({ roomId: "r1", userId: "u1", displayName: "Alex", canPublish: true });
      assert.ok(!raw.includes(DUMMY.LIVEKIT_API_SECRET), "the secret is never inside a token");
    });
    passed++; console.log("PASS voice: real token claims (room, identity, subscribe always, publish only when granted, no data channel, 10 min, no secret)");
  } catch (e: any) { failed++; console.log(`FAIL voice: token claims  ${e.stack?.split("\n").slice(0, 2).join(" | ")}`); }
  try {
    const fake = new FakeVoice();
    setVoiceServiceForTests(fake);
    assert.equal(getVoiceService(), fake);
    const t = await fake.mintToken({ roomId: "r", userId: "u", displayName: "N", canPublish: true });
    assert.equal(b64json(t.split(".")[1]).canPublish, true);
    await fake.setCanPublish("r", "u", false); await fake.removeParticipant("r", "u"); await fake.deleteRoom("r");
    assert.deepEqual(fake.calls.map((c) => c.op), ["mint", "setCanPublish", "remove", "delete"]);
    assert.equal(fake.calls[1].canPublish, false);
    setVoiceServiceForTests(null); assert.equal(getVoiceService(), null);
    setVoiceServiceForTests(undefined);
    passed++; console.log("PASS voice: fake records every call in order; test override can force on, off, or restore env behaviour");
  } catch (e: any) { failed++; console.log(`FAIL voice: fake  ${e.message.split("\n")[0]}`); }
})();

// ---------------------------------------------------------------- client reducer: stage, voice, playback (part 3a)
const np = (over: object = {}) => ({ v: 1 as const, screenVersion: 2, state: "playing" as const, positionMs: 4000, atServerMs: 1_000_000, ...over });

test("reducer: room:state carries stage, hands, voiceEnabled and nowPlaying", () => {
  const s = reduce([{ ...stateMsg(), stage: ["g1"], hands: ["g2"], voiceEnabled: true, nowPlaying: np() }]);
  assert.deepEqual(s.stage, ["g1"]); assert.deepEqual(s.hands, ["g2"]); assert.equal(s.voiceEnabled, true); assert.equal(s.nowPlaying?.positionMs, 4000);
  const plain = reduce([stateMsg()]);
  assert.deepEqual([plain.stage, plain.hands, plain.voiceEnabled, plain.nowPlaying], [[], [], false, null]); // an older server message still works
});

test("reducer: room:stage replaces stage and hands; invitedYou is set, kept, and cleared when you reach the stage", () => {
  let s = reduce([{ ...stateMsg(), stage: [], hands: [], voiceEnabled: true }]);
  s = roomReducer(s, { type: "room:stage", stage: ["g1"], hands: ["me"] });
  assert.deepEqual(s.stage, ["g1"]); assert.deepEqual(s.hands, ["me"]); assert.equal(s.invitedYou, false);
  s = roomReducer(s, { type: "room:stage", stage: ["g1"], hands: [], invitedYou: true });
  assert.equal(s.invitedYou, true);
  s = roomReducer(s, { type: "room:stage", stage: ["g1", "g2"], hands: [] });
  assert.equal(s.invitedYou, true, "someone else reaching the stage does not cancel your invite");
  s = roomReducer(s, { type: "room:stage", stage: ["g1", "me"], hands: [] });
  assert.equal(s.invitedYou, false, "reaching the stage clears it");
  s = roomReducer(s, { type: "room:stage", stage: [], hands: [], invitedYou: true });
  s = roomReducer(s, { type: "client:dismissInvite" });
  assert.equal(s.invitedYou, false);
});

test("reducer: room:voice toggles; turning it off clears stage, hands and the invite", () => {
  let s = reduce([{ ...stateMsg(), stage: ["g1"], hands: ["g2"], voiceEnabled: false }]);
  s = roomReducer(s, { type: "room:voice", enabled: true });
  assert.equal(s.voiceEnabled, true); assert.deepEqual(s.stage, ["g1"]);
  s = roomReducer(roomReducer(s, { type: "room:stage", stage: ["g1"], hands: [], invitedYou: true }), { type: "room:voice", enabled: false });
  assert.deepEqual([s.voiceEnabled, s.stage, s.hands, s.invitedYou], [false, [], [], false]);
});

test("reducer: room:playback stores nowPlaying and the server clock offset (server minus client); null clears", () => {
  let s = reduce([stateMsg()], "me", () => 999_000);
  s = roomReducer(s, { type: "room:playback", nowPlaying: np(), serverNowMs: 1_001_500 }, () => 999_000);
  assert.equal(s.nowPlaying?.state, "playing"); assert.equal(s.serverOffsetMs, 2500);
  s = roomReducer(s, { type: "room:playback", nowPlaying: null, serverNowMs: 1_003_000 }, () => 1_000_000);
  assert.equal(s.nowPlaying, null); assert.equal(s.serverOffsetMs, 3000);
});

test("reducer: a new screen clears nowPlaying and records the new screen version", () => {
  let s = reduce([{ ...stateMsg(), nowPlaying: np() }]);
  s = roomReducer(s, { type: "room:screen", screen: null, screenVersion: 5 });
  assert.equal(s.nowPlaying, null); assert.equal((s.room as any).screenVersion, 5);
  s = roomReducer(s, { type: "room:screen", screen: null });
  assert.equal((s.room as any).screenVersion, 5, "a screen message without a version leaves it alone");
});

test("reducer: ended and denied still ignore the new events", () => {
  const ended = reduce([stateMsg(), { type: "room:ended" }]);
  for (const e of [{ type: "room:stage", stage: ["x"], hands: [] }, { type: "room:voice", enabled: true }, { type: "room:playback", nowPlaying: np(), serverNowMs: 1 }]) assert.equal(roomReducer(ended, e as any), ended, e.type);
});

// ---------------------------------------------------------------- client voice helpers (pure)
test("voiceStatus: every branch", () => {
  const base = { voiceEnabled: true, unlocked: true, connected: true, failed: false, canPublish: false, micOn: false };
  assert.equal(voiceStatus({ ...base, voiceEnabled: false }), "off");
  assert.equal(voiceStatus({ ...base, unlocked: false, connected: false }), "needs-tap");
  assert.equal(voiceStatus({ ...base, connected: false }), "connecting");
  assert.equal(voiceStatus({ ...base, connected: false, failed: true }), "error");
  assert.equal(voiceStatus({ ...base }), "listening");
  assert.equal(voiceStatus({ ...base, canPublish: true }), "listening", "allowed to speak but the mic is off");
  assert.equal(voiceStatus({ ...base, canPublish: true, micOn: true }), "speaking");
  assert.equal(voiceStatus({ ...base, canPublish: false, micOn: true }), "listening", "a mic that is on but not allowed (just removed from the stage) is not speaking");
});

test("speakingRings: only people on the stage get a ring, lit only while they are the active speaker", () => {
  assert.deepEqual(speakingRings(["host", "g1", "g2"], ["g1", "listener"]), { host: false, g1: true, g2: false });
  assert.deepEqual(speakingRings([], ["g1"]), {});
});

test("speakerIds: host and co-hosts always, plus stage guests, no duplicates, only people present", () => {
  const members = [{ userId: "h", role: "host" }, { userId: "c", role: "cohost" }, { userId: "g1", role: "guest" }, { userId: "g2", role: "guest" }] as any;
  assert.deepEqual(speakerIds(members, ["g1", "gone"]), ["h", "c", "g1"]);
  assert.deepEqual(speakerIds(members, ["g1", "g1"]), ["h", "c", "g1"]);
});

// ---------------------------------------------------------------- client playback sync helpers (pure)
test("youtubeEmbedWithApi: adds the JS API switch and origin to a nocookie embed, refuses any other host", () => {
  const u = new URL(youtubeEmbedWithApi("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "https://app.example.com"));
  assert.equal(u.origin + u.pathname, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  assert.equal(u.searchParams.get("enablejsapi"), "1"); assert.equal(u.searchParams.get("origin"), "https://app.example.com");
  for (const bad of ["https://evil.test/embed/x", "https://www.youtube.com/embed/x", "https://www.youtube-nocookie.com.evil.test/embed/x", "not a url", "http://www.youtube-nocookie.com/embed/x"]) assert.throws(() => youtubeEmbedWithApi(bad, "https://app.example.com"), bad);
});

test("syncDecision: guests follow the host within tolerance, and only then", () => {
  const np = (over: object = {}) => ({ v: 1 as const, screenVersion: 1, state: "playing" as const, positionMs: 10_000, atServerMs: 1_000_000, ...over });
  const d = (over: object) => syncDecision({ nowPlaying: np(), serverOffsetMs: 500, clientNowMs: 999_500 + 2000, playerMs: 12_000, playerPlaying: true, watchOwn: false, ...over } as any);
  // server now = clientNow + offset = 1_002_000; target = 10_000 + 2_000 = 12_000
  assert.deepEqual(d({}), { action: "none" });
  assert.deepEqual(d({ playerMs: 13_000 }), { action: "none" }, "1 s off is inside the tolerance");
  assert.deepEqual(d({ playerMs: 20_000 }), { action: "seek", seekToMs: 12_000 });
  assert.deepEqual(d({ playerMs: 3_000 }), { action: "seek", seekToMs: 12_000 });
  assert.deepEqual(d({ playerPlaying: false }), { action: "play" });
  assert.deepEqual(d({ playerPlaying: false, playerMs: 3_000 }), { action: "play", seekToMs: 12_000 });
  assert.deepEqual(d({ nowPlaying: np({ state: "paused" }), playerPlaying: true, playerMs: 10_000 }), { action: "pause" });
  assert.deepEqual(d({ nowPlaying: np({ state: "paused" }), playerPlaying: true, playerMs: 50_000 }), { action: "pause", seekToMs: 10_000 });
  assert.deepEqual(d({ nowPlaying: np({ state: "paused" }), playerPlaying: false, playerMs: 10_000 }), { action: "none" });
  assert.deepEqual(d({ nowPlaying: np({ state: "paused" }), playerPlaying: false, playerMs: 30_000 }), { action: "seek", seekToMs: 10_000 });
  assert.deepEqual(d({ watchOwn: true, playerMs: 99_000 }), { action: "none" }, "Watch on my own");
  assert.deepEqual(d({ nowPlaying: null }), { action: "none" });
  assert.deepEqual(d({ playerMs: null }), { action: "none" }, "player not ready yet");
  assert.deepEqual(d({ nowPlaying: np({ state: "cue", startAtServerMs: 1_005_000 }) }), { action: "none" }, "a cue is for providers we cannot drive");
  assert.deepEqual(d({ nowPlaying: np({ state: "ended" }) }), { action: "none" });
});

test("reducer: a playback message for a screen that is no longer current is ignored; room:state sets the clock offset", () => {
  let s = reduce([{ ...stateMsg(), room: { id: "r1", screenVersion: 3 }, nowPlaying: null }] as any);
  const stale = roomReducer(s, { type: "room:playback", nowPlaying: np({ screenVersion: 2 }), serverNowMs: 5_000 } as any, () => 1_000);
  assert.equal(stale.nowPlaying, null, "old screen");
  const fresh = roomReducer(s, { type: "room:playback", nowPlaying: np({ screenVersion: 3 }), serverNowMs: 5_000 } as any, () => 1_000);
  assert.equal(fresh.nowPlaying?.screenVersion, 3); assert.equal(fresh.serverOffsetMs, 4000);
  const withClock = roomReducer(initialRoomState("me"), { ...stateMsg(), serverNowMs: 9_000 } as any, () => 2_000);
  assert.equal(withClock.serverOffsetMs, 7000);
});

await (async () => {
  try {
    await withEnv(DUMMY, async () => {
      const claims = b64json((await getVoiceService()!.mintToken({ roomId: "r", userId: "u", displayName: "N", canPublish: true })).split(".")[1]);
      assert.deepEqual(claims.video.canPublishSources, ["microphone"], "microphone only: no camera, no screen share");
    });
    passed++; console.log("PASS voice: tokens grant the microphone only");
  } catch (e: any) { failed++; console.log(`FAIL voice: tokens grant the microphone only  ${String(e.message).split(String.fromCharCode(10))[0]}`); }
})();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
