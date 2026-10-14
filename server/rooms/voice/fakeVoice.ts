import type { VoiceService } from "./voiceService";

export interface VoiceCall { op: "mint" | "setCanPublish" | "remove" | "delete"; roomId: string; userId?: string; canPublish?: boolean; camera?: boolean }

/** In-memory stand-in used by tests: records every call, and its tokens decode (`fake.<base64url json>.sig`). */
export class FakeVoice implements VoiceService {
  readonly url = "wss://fake.livekit.test";
  calls: VoiceCall[] = [];
  /** What LiveKit "has" right now, for sweep tests. */
  participants: Array<{ identity: string; canPublish: boolean; canCamera?: boolean }> = [];

  async mintToken(a: { roomId: string; userId: string; displayName: string; canPublish: boolean }): Promise<string> {
    this.calls.push({ op: "mint", roomId: a.roomId, userId: a.userId, canPublish: a.canPublish });
    return `fake.${Buffer.from(JSON.stringify(a)).toString("base64url")}.sig`;
  }
  async setCanPublish(roomId: string, userId: string, canPublish: boolean, camera = false) { this.calls.push({ op: "setCanPublish", roomId, userId, canPublish, ...(camera ? { camera: true } : {}) }); }
  async removeParticipant(roomId: string, userId: string) { this.calls.push({ op: "remove", roomId, userId }); }
  async listParticipants(_roomId: string) { return this.participants.map((p) => ({ ...p, canCamera: p.canCamera === true })); }
  async deleteRoom(roomId: string) { this.calls.push({ op: "delete", roomId }); }
}
