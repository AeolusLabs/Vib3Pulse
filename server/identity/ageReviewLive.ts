// Live age check: a private two-person LiveKit room, never recorded. The invite is 15 minutes, the room is closed after 20.
// There is no egress, recording or composite call anywhere in this module (a test greps for it).
import { LIVE_INVITE_TTL_MS, LIVE_ROOM_MAX_MS } from "../../shared/ageReview";
import { AgeReviewError } from "./ageReviewService";
import { ageReviewPaused } from "./ageReviewFeatures";
import { isSelfReview, type AdminRef } from "./ageReviewAdmin";

export const ageCheckRoomName = (requestId: string) => `agecheck-${requestId}`;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

async function getPool() { return (await import("../storage")).pool; }
async function voice() {
  const v = (await import("../rooms/voice/voiceService")).getVoiceService();
  if (!v) throw new AgeReviewError(503, "VOICE_UNAVAILABLE", "Video calls are not available right now.");
  return v;
}

type LiveRow = { id: string; user_id: string; method: string; status: string; live_invite_expires_at: Date | null; user_email: string | null; display_name: string | null; username: string };
async function loadLive(id: string): Promise<LiveRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AgeReviewError(404, "NOT_FOUND", "Not found");
  const r = (await (await getPool()).query(
    `select r.id, r.user_id, r.method, r.status, r.live_invite_expires_at, u.email as user_email, u.display_name, u.username
       from age_review_requests r join users u on u.id = r.user_id where r.id = $1`, [id])).rows[0] as LiveRow | undefined;
  if (!r) throw new AgeReviewError(404, "NOT_FOUND", "Not found");
  return r;
}
/** A live join works only while the 15 minute invite is unexpired and the request is still waiting. */
export const isInviteLive = (r: { live_invite_expires_at: Date | null; status: string }, now: Date) =>
  !!r.live_invite_expires_at && new Date(r.live_invite_expires_at) > now && ["submitted", "in_review"].includes(r.status);

function scheduleClose(requestId: string) {
  if (timers.has(requestId)) return;
  const t = setTimeout(() => { timers.delete(requestId); void closeAgeCheckRoom(requestId); }, LIVE_ROOM_MAX_MS);
  t.unref?.();
  timers.set(requestId, t);
}

export async function closeAgeCheckRoom(requestId: string): Promise<void> {
  const t = timers.get(requestId);
  if (t) { clearTimeout(t); timers.delete(requestId); }
  try { await (await voice()).deleteNamedRoom(ageCheckRoomName(requestId)); } catch { console.error("[AGE-REVIEW] closing a live room failed"); }
}

/** The sweep calls this: any live room whose invite is long past is deleted (idempotent), in case a process restart lost the timer. */
export async function closeStaleAgeCheckRooms(): Promise<number> {
  const rows = (await (await getPool()).query(
    `select id from age_review_requests where method = 'live' and live_invite_expires_at between now() - interval '2 hours' and now() - interval '5 minutes'`)).rows as { id: string }[];
  for (const r of rows) await closeAgeCheckRoom(r.id);
  return rows.length;
}

export async function inviteLiveCheck(admin: AdminRef, id: string, now: Date = new Date()) {
  const r = await loadLive(id);
  if (isSelfReview(admin, { email: r.user_email, dateOfBirth: null })) throw new AgeReviewError(403, "SELF_REVIEW", "You cannot review your own age check.");
  if (r.method !== "live") throw new AgeReviewError(409, "WRONG_STATE", "This request is not a live check.");
  if (!["submitted", "in_review"].includes(r.status)) throw new AgeReviewError(409, "WRONG_STATE", "This request is not waiting for a reviewer.");
  if (await ageReviewPaused()) throw new AgeReviewError(503, "AGE_REVIEW_PAUSED", "Age checks are paused right now.");
  const expiresAt = new Date(now.getTime() + LIVE_INVITE_TTL_MS);
  await (await getPool()).query(`update age_review_requests set live_invite_expires_at = $2, status = 'in_review', reviewer_id = coalesce(reviewer_id, $3) where id = $1`, [id, expiresAt, admin.id]);
  const { notifyAgeReview } = await import("./ageReviewNotify");
  await notifyAgeReview(r.user_id, "live_invite");
  const { storage } = await import("../storage");
  await storage.logAdminActivity({ adminId: admin.id, action: "age_review.invite_live", targetType: "age_review_request", targetId: id, details: `request=${id}`, reason: "live age check invite" })
    .catch(() => console.error("[AGE-REVIEW] ALERT invite took effect but the audit row failed"));
  return { expiresAt: expiresAt.toISOString() };
}

async function join(r: LiveRow, identity: string, name: string) {
  const v = await voice();
  const roomName = ageCheckRoomName(r.id);
  await v.ensureAgeCheckRoom(roomName);
  scheduleClose(r.id);
  return { url: v.url, token: await v.mintAgeCheckToken({ roomName, identity, name }), roomName };
}

export async function reviewerLiveJoin(admin: AdminRef, id: string, now: Date = new Date()) {
  const r = await loadLive(id);
  if (isSelfReview(admin, { email: r.user_email, dateOfBirth: null })) throw new AgeReviewError(403, "SELF_REVIEW", "You cannot review your own age check.");
  if (r.method !== "live" || !isInviteLive(r, now)) throw new AgeReviewError(409, "WRONG_STATE", "No live check is open for this request.");
  return join(r, `reviewer:${admin.id}`, "Age reviewer");
}

export async function userLiveJoin(userId: string, id: string, now: Date = new Date()) {
  const r = await loadLive(id);
  if (r.user_id !== userId) throw new AgeReviewError(403, "NOT_ALLOWED", "Not allowed");
  if (r.method !== "live" || !isInviteLive(r, now)) throw new AgeReviewError(409, "WRONG_STATE", "No live check is open for this request.");
  return join(r, `user:${userId}`, r.display_name || r.username);
}
