// The only door to LiveKit. The server decides who may speak; this interface turns that decision into LiveKit tokens and
// permission changes. Tests install a FakeVoice, so no test ever talks to the real service.
import { LiveKitVoice } from "./livekitVoice";
export { roomNameFor } from "./livekitVoice";

/** A kind of track someone may publish. Game players get the two screen sources only (ROOMS_GAMING); never set by a client. */
export type PublishSource = "microphone" | "camera" | "screen_share" | "screen_share_audio";

/** Gaming (OBS / RTMP): the identity of a player's ingress participant. Never the bare user id: LiveKit lets one identity in once,
 *  so an ingress named like the player would throw the player's own browser connection out of the room. */
export const INGRESS_SUFFIX = "#obs";
export const ingressIdentity = (userId: string) => `${userId}${INGRESS_SUFFIX}`;
/** The player behind an ingress identity, or null for an ordinary participant. */
export const ingressOwner = (identity: string): string | null => (identity.endsWith(INGRESS_SUFFIX) ? identity.slice(0, -INGRESS_SUFFIX.length) : null);

/** A player's OBS ingest point. `streamKey` is a secret: only ever returned to its owner, never logged or stored. */
export interface GameIngress { ingressId: string; url: string; streamKey: string }

export interface VoiceParticipant {
  identity: string;
  canPublish: boolean;
  canCamera: boolean;
  hasCamera: boolean;
  /** Gaming: the sources they may publish now ([] when they cannot publish). */
  sources?: PublishSource[];
  /** Gaming: the sources of the tracks they are publishing right now. */
  publishing?: PublishSource[];
}

export interface VoiceService {
  readonly url: string;
  /** `camera`: the current holder of the live screen may also publish the camera, so a performer who reconnects can go straight back on air. */
  /** A 60 second token (TOKEN_TTL_SECONDS in livekitVoice.ts) to join the room's LiveKit session. Everyone can subscribe; only `canPublish` people can speak. */
  /** `sources` (gaming only, a current game player): the exact sources the token grants, in place of canPublish / camera. */
  mintToken(a: { roomId: string; userId: string; displayName: string; canPublish: boolean; camera?: boolean; sources?: PublishSource[] }): Promise<string>;
  /** `camera` adds the camera source on top of the microphone: only ever for the person holding the room's live screen. */
  /** Takes effect immediately for someone already connected (no waiting for their token to expire). */
  setCanPublish(roomId: string, userId: string, canPublish: boolean, camera?: boolean): Promise<void>;
  /** Gaming: sets exactly these sources for someone already connected. An empty list means they cannot publish at all. */
  setPublishSources(roomId: string, userId: string, sources: PublishSource[]): Promise<void>;
  /** Disconnects them from the session. */
  removeParticipant(roomId: string, userId: string): Promise<void>;
  /** Who LiveKit currently has in the room's session, and whether they can publish. Used to sweep out anyone the room should not have. */
  /** `hasCamera`: they are publishing a camera track right now (a permission change alone does not prove it stopped). */
  listParticipants(roomId: string): Promise<VoiceParticipant[]>;
  /** Age review live check: a 20 minute token for a room by exact name, camera + microphone only, no data channel. */
  mintAgeCheckToken(a: { roomName: string; identity: string; name: string }): Promise<string>;
  /** Age review live check: creates the named room capped at 2 participants (idempotent). Nothing here ever records or egresses. */
  ensureAgeCheckRoom(roomName: string): Promise<void>;
  deleteNamedRoom(roomName: string): Promise<void>;
  /** Ends the whole session for everyone. */
  deleteRoom(roomId: string): Promise<void>;
  /**
   * Gaming (LIVEKIT_INGRESS): the player's RTMP ingest into the room, publishing as ingressIdentity(userId) with the two screen
   * sources only. Idempotent: an ingress that already exists for this player and room is returned, never a second one.
   */
  createIngress(roomId: string, userId: string): Promise<GameIngress>;
  /** Removes an ingress (its stream key stops working). Missing is fine. */
  deleteIngress(ingressId: string): Promise<void>;
}

let override: VoiceService | null | undefined;
let cached: { key: string; svc: VoiceService } | null = null;

/** Test hook: a service, `null` to force voice off, `undefined` to go back to reading the environment. */
export function setVoiceServiceForTests(v: VoiceService | null | undefined): void {
  override = v;
}

/** null when LIVEKIT_URL, LIVEKIT_API_KEY or LIVEKIT_API_SECRET is missing: voice is then simply unavailable. */
export function getVoiceService(): VoiceService | null {
  if (override !== undefined) return override;
  const url = process.env.LIVEKIT_URL, key = process.env.LIVEKIT_API_KEY, secret = process.env.LIVEKIT_API_SECRET;
  if (!url || !key || !secret) return null;
  const id = `${url}|${key}|${secret}`;
  if (cached?.key !== id) cached = { key: id, svc: new LiveKitVoice(url, key, secret) };
  return cached.svc;
}
