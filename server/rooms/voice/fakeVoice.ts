import type { VoiceService } from "./voiceService";

export interface VoiceCall { op: "mint" | "setCanPublish" | "remove" | "delete"; roomId: string; userId?: string; canPublish?: boolean; camera?: boolean }

/** In-memory stand-in used by tests: records every call, and its tokens decode (`fake.<base64url json>.sig`). */
export class FakeVoice implements VoiceService {
  readonly url = "wss://fake.livekit.test";
  calls: VoiceCall[] = [];
  /** What LiveKit "has" right now, for sweep tests. */
  participants: Array<{ identity: string; canPublish: boolean; canCamera?: boolean; hasCamera?: boolean }> = [];
  /** Test hook: make matching calls throw, like a LiveKit outage. */
  failOn: ((c: VoiceCall) => boolean) | null = null;

  async mintToken(a: { roomId: string; userId: string; displayName: string; canPublish: boolean; camera?: boolean }): Promise<string> {
    this.calls.push({ op: "mint", roomId: a.roomId, userId: a.userId, canPublish: a.canPublish, ...(a.camera ? { camera: true } : {}) });
    return `fake.${Buffer.from(JSON.stringify(a)).toString("base64url")}.sig`;
  }
  async setCanPublish(roomId: string, userId: string, canPublish: boolean, camera = false) {
    const call: VoiceCall = { op: "setCanPublish", roomId, userId, canPublish, ...(camera ? { camera: true } : {}) };
    this.calls.push(call);
    if (this.failOn?.(call)) throw new Error("fake LiveKit outage");
  }
  async removeParticipant(roomId: string, userId: string) { this.calls.push({ op: "remove", roomId, userId }); }
  async listParticipants(_roomId: string) { return this.participants.map((p) => ({ ...p, canCamera: p.canCamera === true, hasCamera: p.hasCamera === true })); }
  async deleteRoom(roomId: string) { this.calls.push({ op: "delete", roomId }); }
}
