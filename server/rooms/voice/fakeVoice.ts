import type { PublishSource, VoiceParticipant, VoiceService } from "./voiceService";

export interface VoiceCall { op: "mint" | "setCanPublish" | "setPublishSources" | "remove" | "delete"; roomId: string; userId?: string; canPublish?: boolean; camera?: boolean; sources?: PublishSource[] }

/** In-memory stand-in used by tests: records every call, and its tokens decode (`fake.<base64url json>.sig`). */
export class FakeVoice implements VoiceService {
  readonly url = "wss://fake.livekit.test";
  calls: VoiceCall[] = [];
  /** What LiveKit "has" right now, for sweep tests. */
  participants: Array<{ identity: string; canPublish: boolean; canCamera?: boolean; hasCamera?: boolean; sources?: PublishSource[]; publishing?: PublishSource[] }> = [];
  /** Test hook: make matching calls throw, like a LiveKit outage. */
  failOn: ((c: VoiceCall) => boolean) | null = null;

  async mintToken(a: { roomId: string; userId: string; displayName: string; canPublish: boolean; camera?: boolean; sources?: PublishSource[] }): Promise<string> {
    this.calls.push({ op: "mint", roomId: a.roomId, userId: a.userId, canPublish: a.canPublish, ...(a.camera ? { camera: true } : {}), ...(a.sources ? { sources: [...a.sources] } : {}) });
    return `fake.${Buffer.from(JSON.stringify(a)).toString("base64url")}.sig`;
  }
  async setCanPublish(roomId: string, userId: string, canPublish: boolean, camera = false) {
    const call: VoiceCall = { op: "setCanPublish", roomId, userId, canPublish, ...(camera ? { camera: true } : {}) };
    this.calls.push(call);
    if (this.failOn?.(call)) throw new Error("fake LiveKit outage");
  }
  /** Gaming: records the call and, like a connected participant, updates (or adds) their entry with exactly these sources. */
  async setPublishSources(roomId: string, userId: string, sources: PublishSource[]) {
    const call: VoiceCall = { op: "setPublishSources", roomId, userId, canPublish: sources.length > 0, sources: [...sources] };
    this.calls.push(call);
    if (this.failOn?.(call)) throw new Error("fake LiveKit outage");
    const p = this.participants.find((x) => x.identity === userId);
    if (p) { p.canPublish = sources.length > 0; p.sources = [...sources]; p.canCamera = sources.includes("camera"); }
    else this.participants.push({ identity: userId, canPublish: sources.length > 0, canCamera: sources.includes("camera"), sources: [...sources] });
  }
  async removeParticipant(roomId: string, userId: string) { this.calls.push({ op: "remove", roomId, userId }); }
  async listParticipants(_roomId: string): Promise<VoiceParticipant[]> {
    return this.participants.map((p) => ({
      ...p, canCamera: p.canCamera === true, hasCamera: p.hasCamera === true,
      ...(p.sources ? { sources: [...p.sources] } : {}), ...(p.publishing ? { publishing: [...p.publishing] } : {}),
    }));
  }
  async deleteRoom(roomId: string) { this.calls.push({ op: "delete", roomId }); }
}
