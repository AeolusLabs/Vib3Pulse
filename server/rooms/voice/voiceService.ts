// The only door to LiveKit. The server decides who may speak; this interface turns that decision into LiveKit tokens and
// permission changes. Tests install a FakeVoice, so no test ever talks to the real service.
import { LiveKitVoice } from "./livekitVoice";
export { roomNameFor } from "./livekitVoice";

export interface VoiceService {
  readonly url: string;
  /** `camera`: the current holder of the live screen may also publish the camera, so a performer who reconnects can go straight back on air. */
  /** A 10 minute token to join the room's LiveKit session. Everyone can subscribe; only `canPublish` people can speak. */
  mintToken(a: { roomId: string; userId: string; displayName: string; canPublish: boolean; camera?: boolean }): Promise<string>;
  /** `camera` adds the camera source on top of the microphone: only ever for the person holding the room's live screen. */
  /** Takes effect immediately for someone already connected (no waiting for their token to expire). */
  setCanPublish(roomId: string, userId: string, canPublish: boolean, camera?: boolean): Promise<void>;
  /** Disconnects them from the session. */
  removeParticipant(roomId: string, userId: string): Promise<void>;
  /** Who LiveKit currently has in the room's session, and whether they can publish. Used to sweep out anyone the room should not have. */
  /** `hasCamera`: they are publishing a camera track right now (a permission change alone does not prove it stopped). */
  listParticipants(roomId: string): Promise<Array<{ identity: string; canPublish: boolean; canCamera: boolean; hasCamera: boolean }>>;
  /** Ends the whole session for everyone. */
  deleteRoom(roomId: string): Promise<void>;
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
