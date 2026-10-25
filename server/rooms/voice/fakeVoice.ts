import type { GameIngress, PublishSource, VoiceParticipant, VoiceService } from "./voiceService";

export interface VoiceCall { op: "mint" | "setCanPublish" | "setPublishSources" | "remove" | "delete" | "createIngress" | "deleteIngress" | "mintAgeCheck" | "ensureAgeCheckRoom" | "deleteNamed"; ingressId?: string; maxParticipants?: number; ttlSeconds?: number; egress?: false; roomId: string; userId?: string; canPublish?: boolean; camera?: boolean; sources?: PublishSource[] }

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
  async mintAgeCheckToken(a: { roomName: string; identity: string; name: string }): Promise<string> {
    this.calls.push({ op: "mintAgeCheck", roomId: a.roomName, userId: a.identity, canPublish: true, sources: ["microphone", "camera"], ttlSeconds: 20 * 60 });
    return `fake.${Buffer.from(JSON.stringify(a)).toString("base64url")}.sig`;
  }
  async ensureAgeCheckRoom(roomName: string) { this.calls.push({ op: "ensureAgeCheckRoom", roomId: roomName, maxParticipants: 2, egress: false }); }
  async deleteNamedRoom(roomName: string) { this.calls.push({ op: "deleteNamed", roomId: roomName }); }
  async deleteRoom(roomId: string) { this.calls.push({ op: "delete", roomId }); }
  /** Gaming: live fake ingresses by `${roomId}:${userId}` (the call log never records a stream key). */
  ingresses = new Map<string, GameIngress>();
  private ingressSeq = 0;
  async createIngress(roomId: string, userId: string): Promise<GameIngress> {
    const k = `${roomId}:${userId}`;
    let i = this.ingresses.get(k);
    if (!i) { i = { ingressId: `IN_fake_${++this.ingressSeq}`, url: "rtmp://fake.livekit.test/x", streamKey: `sk_fake_${Math.random().toString(36).slice(2)}_${this.ingressSeq}` }; this.ingresses.set(k, i); }
    this.calls.push({ op: "createIngress", roomId, userId, ingressId: i.ingressId });
    return { ...i };
  }
  async deleteIngress(ingressId: string) {
    this.calls.push({ op: "deleteIngress", roomId: "", ingressId });
    this.ingresses.forEach((v, k) => { if (v.ingressId === ingressId) this.ingresses.delete(k); });
  }
}
