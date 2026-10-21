// Gamers live (ROOMS_GAMING + LIVEKIT_INGRESS): OBS / RTMP ingest for a player (PC, or a console through a capture card).
// A stream key is a secret: it is returned only to its own player, from the route, and is never logged, stored, put in
// room:state or any broadcast, or put in an error. Only the ingress id is kept (in memory), so the ingress can be removed
// when the player leaves the game, is removed, kicked or banned, or the room ends.
import { ingressFlag, roomFeatures } from "./features";
import { getVoiceService, type GameIngress } from "./voice/voiceService";

const ids = new Map<string, string>(); // `${roomId}:${userId}` -> ingressId
const key = (roomId: string, userId: string) => `${roomId}:${userId}`;

/** OBS ingest can be offered here: both flags on and a voice service that can create an ingress. */
export function ingestAvailable(): boolean {
  const svc = getVoiceService();
  return roomFeatures.gaming && ingressFlag() && !!svc && typeof svc.createIngress === "function";
}

/** Never the key, never the provider's message (it may echo the request): the step and a status code at most. */
const logFail = (what: string, e: unknown) => {
  const status = (e as { status?: unknown })?.status;
  console.error(`[rooms:ingress] ${what} failed${typeof status === "number" ? ` (status ${status})` : ""}`);
};

/** The player's ingest point (the same one on every call while it exists). The caller has checked they are a current player. */
export async function ingressFor(roomId: string, userId: string): Promise<GameIngress> {
  const svc = getVoiceService();
  if (!svc) throw new Error("INGEST_UNAVAILABLE");
  try {
    const i = await svc.createIngress(roomId, userId);
    ids.set(key(roomId, userId), i.ingressId);
    return i;
  } catch (e) {
    logFail("create", e);
    throw new Error("INGEST_FAILED"); // a fresh error: nothing from the provider travels further
  }
}

/** The player is out of the game (left, removed, kicked, banned, dropped): their key stops working. Never throws. */
export async function revokePlayerIngress(roomId: string, userId: string): Promise<void> {
  const id = ids.get(key(roomId, userId));
  if (!id) return;
  ids.delete(key(roomId, userId));
  try { await getVoiceService()?.deleteIngress(id); } catch (e) { logFail("delete", e); }
}

/** The room ended: every key of the room stops working. Never throws. */
export async function revokeRoomIngresses(roomId: string): Promise<void> {
  const mine = Array.from(ids.keys()).filter((k) => k.startsWith(`${roomId}:`));
  for (const k of mine) await revokePlayerIngress(roomId, k.slice(roomId.length + 1));
}

/** Read-only, for tests: does this player have an ingress on record? */
export const hasIngress = (roomId: string, userId: string) => ids.has(key(roomId, userId));
