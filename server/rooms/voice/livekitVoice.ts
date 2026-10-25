import { AccessToken, IngressAudioOptions, IngressClient, IngressInput, IngressVideoOptions, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import { ingressIdentity, type GameIngress, type PublishSource, type VoiceParticipant, type VoiceService } from "./voiceService";

export const roomNameFor = (roomId: string) => `vp-${roomId}`;
// Short on purpose: LiveKit refreshes the token of a connected participant itself, and the server sweeps (stage.ts sweepVoice)
// anyone it should not have, but a replayed old token stops working after a minute.
const TOKEN_TTL_SECONDS = 60;
// Age review live check: one token covers the whole call (the room itself is capped at 20 minutes by the server).
const AGE_CHECK_TTL_SECONDS = 20 * 60;
// Speakers publish audio only: no camera, no screen share (bandwidth and cost, and nothing in the UI shows them).
const MIC_ONLY = [TrackSource.MICROPHONE];
// The holder of the room's live screen also gets the camera. Never screen share.
const MIC_AND_CAMERA = [TrackSource.MICROPHONE, TrackSource.CAMERA];

// Gaming (ROOMS_GAMING): the exact sources the server decided, one to one with LiveKit's.
const TO_LK: Record<PublishSource, TrackSource> = {
  microphone: TrackSource.MICROPHONE, camera: TrackSource.CAMERA,
  screen_share: TrackSource.SCREEN_SHARE, screen_share_audio: TrackSource.SCREEN_SHARE_AUDIO,
};
const FROM_LK = new Map<TrackSource, PublishSource>((Object.entries(TO_LK) as Array<[PublishSource, TrackSource]>).map(([k, v]) => [v, k]));
const ALL_SOURCES = Object.keys(TO_LK) as PublishSource[];
const fromLk = (list: TrackSource[] | undefined): PublishSource[] => (list ?? []).map((s) => FROM_LK.get(s)).filter((s): s is PublishSource => !!s);

/** "Not found" means the person or the session is already gone, which is the state we wanted. */
const ignoreMissing = (e: any) => { if (e?.status === 404 || /not.?found|does not exist/i.test(String(e?.message))) return; throw e; };

export class LiveKitVoice implements VoiceService {
  private client: RoomServiceClient | null = null;
  private ingressClient: IngressClient | null = null;

  constructor(readonly url: string, private apiKey: string, private apiSecret: string) {}

  /** Created on first real use: the REST host is the same as the websocket URL with https. */
  private rooms() {
    return (this.client ??= new RoomServiceClient(this.url.replace(/^wss:/, "https:").replace(/^ws:/, "http:"), this.apiKey, this.apiSecret));
  }

  async mintToken(a: { roomId: string; userId: string; displayName: string; canPublish: boolean; camera?: boolean; sources?: PublishSource[] }): Promise<string> {
    const t = new AccessToken(this.apiKey, this.apiSecret, { identity: a.userId, name: a.displayName, ttl: TOKEN_TTL_SECONDS });
    if (a.sources) {
      // Gaming: exactly the server's list. An empty list must be canPublish false: LiveKit reads empty sources as "any source".
      t.addGrant({ roomJoin: true, room: roomNameFor(a.roomId), canSubscribe: true, canPublish: a.sources.length > 0, canPublishData: false, canPublishSources: a.sources.length > 0 ? a.sources.map((s) => TO_LK[s]) : MIC_ONLY });
      return t.toJwt();
    }
    t.addGrant({ roomJoin: true, room: roomNameFor(a.roomId), canSubscribe: true, canPublish: a.canPublish, canPublishData: false, canPublishSources: a.canPublish && a.camera ? MIC_AND_CAMERA : MIC_ONLY });
    return t.toJwt();
  }

  async setCanPublish(roomId: string, userId: string, canPublish: boolean, camera = false): Promise<void> {
    await this.rooms().updateParticipant(roomNameFor(roomId), userId, undefined, { canSubscribe: true, canPublish, canPublishData: false, canPublishSources: canPublish && camera ? MIC_AND_CAMERA : MIC_ONLY }).catch(ignoreMissing);
  }

  async setPublishSources(roomId: string, userId: string, sources: PublishSource[]): Promise<void> {
    const canPublish = sources.length > 0;
    // Same shape as setCanPublish; with nothing to publish the list stays MIC_ONLY (canPublish false wins), never empty (= any).
    await this.rooms().updateParticipant(roomNameFor(roomId), userId, undefined, { canSubscribe: true, canPublish, canPublishData: false, canPublishSources: canPublish ? sources.map((s) => TO_LK[s]) : MIC_ONLY }).catch(ignoreMissing);
  }

  async mintAgeCheckToken(a: { roomName: string; identity: string; name: string }): Promise<string> {
    const t = new AccessToken(this.apiKey, this.apiSecret, { identity: a.identity, name: a.name, ttl: AGE_CHECK_TTL_SECONDS });
    t.addGrant({ roomJoin: true, room: a.roomName, canSubscribe: true, canPublish: true, canPublishData: false, canPublishSources: MIC_AND_CAMERA });
    return t.toJwt();
  }

  async ensureAgeCheckRoom(roomName: string): Promise<void> {
    await this.rooms().createRoom({ name: roomName, maxParticipants: 2, emptyTimeout: 120, departureTimeout: 30 });
  }

  async deleteNamedRoom(roomName: string): Promise<void> {
    await this.rooms().deleteRoom(roomName).catch(ignoreMissing);
  }

  async removeParticipant(roomId: string, userId: string): Promise<void> {
    await this.rooms().removeParticipant(roomNameFor(roomId), userId).catch(ignoreMissing);
  }

  async listParticipants(roomId: string): Promise<VoiceParticipant[]> {
    const list = await this.rooms().listParticipants(roomNameFor(roomId)).catch((e) => { ignoreMissing(e); return []; });
    return list.map((p) => {
      const canPublish = !!p.permission?.canPublish;
      const granted = p.permission?.canPublishSources ?? [];
      return {
        identity: p.identity, canPublish, canCamera: canPublish && !!p.permission?.canPublishSources?.includes(TrackSource.CAMERA), hasCamera: !!p.tracks?.some((t) => t.source === TrackSource.CAMERA),
        // An empty source list in LiveKit means every source is allowed.
        sources: !canPublish ? [] : granted.length === 0 ? [...ALL_SOURCES] : fromLk(granted),
        publishing: fromLk(p.tracks?.map((t) => t.source)),
      };
    });
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.rooms().deleteRoom(roomNameFor(roomId)).catch(ignoreMissing);
  }

  private ingress() {
    return (this.ingressClient ??= new IngressClient(this.url.replace(/^wss:/, "https:").replace(/^ws:/, "http:"), this.apiKey, this.apiSecret));
  }

  async createIngress(roomId: string, userId: string): Promise<GameIngress> {
    const identity = ingressIdentity(userId);
    const existing = (await this.ingress().listIngress({ roomName: roomNameFor(roomId) })).find((i) => i.participantIdentity === identity);
    const info = existing ?? await this.ingress().createIngress(IngressInput.RTMP_INPUT, {
      name: `game-${roomId}-${userId}`, roomName: roomNameFor(roomId), participantIdentity: identity, participantName: identity,
      // Screen sources only: an OBS feed is a game screen and its sound, never a camera or a microphone.
      video: new IngressVideoOptions({ source: TrackSource.SCREEN_SHARE }),
      audio: new IngressAudioOptions({ source: TrackSource.SCREEN_SHARE_AUDIO }),
    });
    return { ingressId: info.ingressId, url: info.url, streamKey: info.streamKey };
  }

  async deleteIngress(ingressId: string): Promise<void> {
    await this.ingress().deleteIngress(ingressId).then(() => undefined).catch(ignoreMissing);
  }
}
