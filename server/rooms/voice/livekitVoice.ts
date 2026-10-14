import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import type { VoiceService } from "./voiceService";

export const roomNameFor = (roomId: string) => `vp-${roomId}`;
// Short on purpose: LiveKit refreshes the token of a connected participant itself, and the server sweeps (stage.ts sweepVoice)
// anyone it should not have, but a replayed old token stops working after a minute.
const TOKEN_TTL_SECONDS = 60;
// Speakers publish audio only: no camera, no screen share (bandwidth and cost, and nothing in the UI shows them).
const MIC_ONLY = [TrackSource.MICROPHONE];
// The holder of the room's live screen also gets the camera. Never screen share.
const MIC_AND_CAMERA = [TrackSource.MICROPHONE, TrackSource.CAMERA];

/** "Not found" means the person or the session is already gone, which is the state we wanted. */
const ignoreMissing = (e: any) => { if (e?.status === 404 || /not.?found|does not exist/i.test(String(e?.message))) return; throw e; };

export class LiveKitVoice implements VoiceService {
  private client: RoomServiceClient | null = null;

  constructor(readonly url: string, private apiKey: string, private apiSecret: string) {}

  /** Created on first real use: the REST host is the same as the websocket URL with https. */
  private rooms() {
    return (this.client ??= new RoomServiceClient(this.url.replace(/^wss:/, "https:").replace(/^ws:/, "http:"), this.apiKey, this.apiSecret));
  }

  async mintToken(a: { roomId: string; userId: string; displayName: string; canPublish: boolean }): Promise<string> {
    const t = new AccessToken(this.apiKey, this.apiSecret, { identity: a.userId, name: a.displayName, ttl: TOKEN_TTL_SECONDS });
    t.addGrant({ roomJoin: true, room: roomNameFor(a.roomId), canSubscribe: true, canPublish: a.canPublish, canPublishData: false, canPublishSources: MIC_ONLY });
    return t.toJwt();
  }

  async setCanPublish(roomId: string, userId: string, canPublish: boolean, camera = false): Promise<void> {
    await this.rooms().updateParticipant(roomNameFor(roomId), userId, undefined, { canSubscribe: true, canPublish, canPublishData: false, canPublishSources: canPublish && camera ? MIC_AND_CAMERA : MIC_ONLY }).catch(ignoreMissing);
  }

  async removeParticipant(roomId: string, userId: string): Promise<void> {
    await this.rooms().removeParticipant(roomNameFor(roomId), userId).catch(ignoreMissing);
  }

  async listParticipants(roomId: string): Promise<Array<{ identity: string; canPublish: boolean; canCamera: boolean; hasCamera: boolean }>> {
    const list = await this.rooms().listParticipants(roomNameFor(roomId)).catch((e) => { ignoreMissing(e); return []; });
    return list.map((p) => ({ identity: p.identity, canPublish: !!p.permission?.canPublish, canCamera: !!p.permission?.canPublish && !!p.permission?.canPublishSources?.includes(TrackSource.CAMERA), hasCamera: !!p.tracks?.some((t) => t.source === TrackSource.CAMERA) }));
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.rooms().deleteRoom(roomNameFor(roomId)).catch(ignoreMissing);
  }
}
