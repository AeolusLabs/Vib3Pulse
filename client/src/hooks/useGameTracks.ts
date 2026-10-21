// Gamers live, media side: a player puts their own screen into the room (getDisplayMedia -> LiveKit), and a viewer subscribes to
// only the feeds the match needs. The server decides who may publish (a player's token grants only the two screen sources);
// this hook only asks. Subscriptions follow client/src/lib/gameScreen.ts: featured feeds only, thumbnails never video, at most
// four video feeds, none in sound-only mode, and only ONE feed's game sound.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocalAudioTrack, LocalVideoTrack, RemoteTrackPublication, Room } from "livekit-client";
import type { GameView, Side } from "@shared/gameScreen";
import { gameProfileSettings, viewerLayer, type GameProfile } from "@/lib/bandwidth";
import { allPlayers, playerIdOf, soundFeed, videoFeeds, type Follow, type GameLayout } from "@/lib/gameScreen";
import { loadLk, type ScreenTrack } from "@/hooks/useRoomVoice";

export interface GameTracks {
  /** Call from a click: asks the browser for a screen or window, then publishes it. Resolves once it is on its way. */
  startShare(profile: GameProfile): Promise<void>;
  /** Stops publishing and releases the capture. Does not leave the match (the caller sends `remove` for that). */
  stopShare(): void;
  sharing: boolean;
  shareError: string | null;
  /** The video for a player: their feed for a viewer, your own preview for yourself. null when not subscribed (a thumbnail, sound only). */
  trackFor(userId: string): ScreenTrack | null;
  /** Watch this player on your own device. Changes only your subscriptions. */
  follow(side: Side, userId: string): void;
  /** Back to the host's pick for this team. */
  unfollow(side: Side): void;
  following: Follow;
  /** The one player whose game sound plays, and a way to choose another. */
  soundId: string | null;
  setSound(userId: string): void;
  /** A tile tells the hook how wide it is so a small tile asks for a smaller layer (720 / 360 / 180). */
  reportWidth(userId: string, px: number): void;
}

const SOURCE_VIDEO = "screen_share";
const SOURCE_AUDIO = "screen_share_audio";

const shareErrorLine = (e: unknown): string => {
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotAllowedError") return "Sharing was cancelled or blocked. Pick a window and allow it to try again.";
  if (name === "NotFoundError" || name === "NotReadableError") return "Couldn't capture that window. Pick another one.";
  if (name === "TypeError" || name === "NotSupportedError") return "This browser can't share a screen. Use a desktop browser, or stream with OBS.";
  const msg = (e as { message?: string } | null)?.message ?? "";
  if (/permission/i.test(msg)) return "The room hasn't let you share yet. Wait for the host to accept you, then try again.";
  return "Couldn't start your screen. Try again.";
};

export function useGameTracks(
  room: Room | null,
  game: GameView | null,
  opts: { audioOnly: boolean; layout?: GameLayout; selfId?: string | null; /** The capture ended by itself (the browser's "Stop sharing" bar): tell the room so the slot is released. */ onShareEnded?: () => void },
): GameTracks {
  const [following, setFollowing] = useState<Follow>({});
  const [soundPick, setSoundPick] = useState<string | null>(null);
  const [tracks, setTracks] = useState<Record<string, ScreenTrack>>({});
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const layout = opts.layout ?? "team";
  const selfId = opts.selfId ?? null;

  const wantVideo = useMemo(() => (game ? videoFeeds(game, layout, following, opts.audioOnly) : []), [game, layout, following, opts.audioOnly]);
  const soundId = useMemo(() => (game ? soundFeed(game, following, soundPick) : null), [game, following, soundPick]);
  // The listeners below read the latest plan from refs, so they never go stale.
  const plan = useRef({ video: wantVideo, sound: soundId });
  plan.current = { video: wantVideo, sound: soundId };
  const widths = useRef(new Map<string, number>());
  const sink = useRef<HTMLDivElement | null>(null);

  // What we publish (null when not sharing). `stopping` makes our own teardown silent: only the browser ending the capture tells the room.
  const local = useRef<{ video: LocalVideoTrack; audio: LocalAudioTrack | null; stream: MediaStream; onEnd: () => void } | null>(null);
  const onEnded = useRef(opts.onShareEnded);
  onEnded.current = opts.onShareEnded;

  const applyPlan = useCallback(() => {
    if (!room) return;
    const { video, sound } = plan.current;
    room.remoteParticipants.forEach((p) => p.trackPublications.forEach((pub) => {
      const rp = pub as RemoteTrackPublication;
      if ((rp.source as string) === SOURCE_VIDEO) {
        const want = video.includes(playerIdOf(p.identity));
        if (rp.isSubscribed !== want) rp.setSubscribed(want);
      } else if ((rp.source as string) === SOURCE_AUDIO) {
        const want = sound === playerIdOf(p.identity);
        if (rp.isSubscribed !== want) rp.setSubscribed(want);
      }
    }));
  }, [room]);

  // Subscribe by plan whenever the plan or the set of publications changes; attach the one game sound; collect the video tracks.
  const hasGame = !!game;
  useEffect(() => {
    if (!room || !hasGame) return; // not a game room: nothing here may touch the room's subscriptions
    let cancelled = false;
    let off = () => {};
    void loadLk().then(({ RoomEvent }) => {
      if (cancelled) return;
      const box = document.createElement("div");
      box.style.display = "none";
      document.body.appendChild(box);
      sink.current = box;
      const onSub = (track: { kind: string; attach(): HTMLMediaElement; detach(): HTMLMediaElement[] }, pub: { source: unknown }, p: { identity: string }) => {
        if (pub.source === SOURCE_VIDEO) setTracks((t) => ({ ...t, [playerIdOf(p.identity)]: track as unknown as ScreenTrack }));
        else if (pub.source === SOURCE_AUDIO) box.appendChild(track.attach());
      };
      const onUnsub = (track: { detach(): HTMLMediaElement[] }, pub: { source: unknown }, p: { identity: string }) => {
        if (pub.source === SOURCE_VIDEO) setTracks((t) => { const { [playerIdOf(p.identity)]: _gone, ...rest } = t; return rest; });
        else if (pub.source === SOURCE_AUDIO) track.detach().forEach((el) => el.remove());
      };
      room.on(RoomEvent.TrackSubscribed, onSub as never);
      room.on(RoomEvent.TrackUnsubscribed, onUnsub as never);
      room.on(RoomEvent.TrackPublished, applyPlan);
      room.on(RoomEvent.ParticipantConnected, applyPlan);
      applyPlan();
      off = () => {
        room.off(RoomEvent.TrackSubscribed, onSub as never);
        room.off(RoomEvent.TrackUnsubscribed, onUnsub as never);
        room.off(RoomEvent.TrackPublished, applyPlan);
        room.off(RoomEvent.ParticipantConnected, applyPlan);
        box.remove();
        if (sink.current === box) sink.current = null;
      };
    }).catch(() => {});
    return () => { cancelled = true; off(); setTracks({}); };
  }, [room, hasGame, applyPlan]);

  useEffect(() => { applyPlan(); }, [wantVideo, soundId, applyPlan]);

  // Stop-sharing teardown. Silent unless the browser ended the capture (handled in startShare).
  const stopShare = useCallback(() => {
    const l = local.current;
    local.current = null;
    setSharing(false);
    setTracks((t) => { const { [selfId ?? ""]: _me, ...rest } = t; return rest; });
    if (!l) return;
    l.video.mediaStreamTrack.removeEventListener("ended", l.onEnd); // our own stop must not look like the browser's
    const lp = room?.localParticipant;
    if (lp) { void lp.unpublishTrack(l.video, true).catch(() => {}); if (l.audio) void lp.unpublishTrack(l.audio, true).catch(() => {}); }
    l.stream.getTracks().forEach((t) => t.stop()); // releases the capture: the browser's sharing bar goes away
  }, [room, selfId]);

  const startShare = useCallback(async (profile: GameProfile) => {
    setShareError(null);
    if (!room) { setShareError("The room's video isn't connected yet. Tap to join the sound, then try again."); return; }
    if (local.current) return;
    let stream: MediaStream | null = null;
    try {
      const q = gameProfileSettings(profile);
      // Game sound only: the browser offers the window's or tab's audio, never the microphone. Processing off, it is music not speech.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: q.width, height: q.height, frameRate: q.frameRate },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } as MediaTrackConstraints,
      });
      const vTrack = stream.getVideoTracks()[0];
      if (!vTrack) throw new Error("no video track");
      vTrack.contentHint = "motion"; // frame rate over sharpness when the link is tight
      const { LocalVideoTrack, LocalAudioTrack, Track, VideoPresets } = await loadLk();
      const video = new LocalVideoTrack(vTrack, undefined, false);
      const aTrack = stream.getAudioTracks()[0];
      const audio = aTrack ? new LocalAudioTrack(aTrack, undefined, false) : null;
      const onEnd = () => { stopShare(); onEnded.current?.(); }; // the browser's own "Stop sharing" bar: give the slot back
      vTrack.addEventListener("ended", onEnd);
      local.current = { video, audio, stream, onEnd };
      const lp = room.localParticipant;
      // Two simulcast layers only (full and 360p): a small tile never needs more, and every extra layer costs the player upload.
      await lp.publishTrack(video, {
        source: Track.Source.ScreenShare, simulcast: true, screenShareEncoding: { maxBitrate: q.maxBitrate, maxFramerate: q.frameRate },
        screenShareSimulcastLayers: [VideoPresets.h360], degradationPreference: "maintain-framerate",
      });
      if (audio) await lp.publishTrack(audio, { source: Track.Source.ScreenShareAudio, dtx: true, red: true });
      setSharing(true);
      if (selfId) setTracks((t) => ({ ...t, [selfId]: video as unknown as ScreenTrack }));
    } catch (e) {
      const had = local.current;
      if (had) stopShare(); else stream?.getTracks().forEach((t) => t.stop());
      setShareError(shareErrorLine(e));
    }
  }, [room, selfId, stopShare]);

  // Removed from the match (the host removed you, or the slot was released): stop uploading. The server already knows, so nothing is sent.
  const iPlay = !!selfId && !!game && allPlayers(game).includes(selfId);
  useEffect(() => { if (!iPlay && local.current) stopShare(); }, [iPlay, stopShare]);
  // The room's media went away (disconnected): the capture is gone with it.
  useEffect(() => { if (!room && local.current) stopShare(); }, [room, stopShare]);
  useEffect(() => () => { const l = local.current; if (l) { l.video.mediaStreamTrack.removeEventListener("ended", l.onEnd); l.stream.getTracks().forEach((t) => t.stop()); local.current = null; } }, []);

  // A tile's width picks the layer cap: 720 / 360 / 180 (LiveKit's own adaptive stream still trims it to what is on screen).
  const reportWidth = useCallback((userId: string, px: number) => {
    const layerOf = viewerLayer(px);
    if (widths.current.get(userId) === layerOf) return;
    widths.current.set(userId, layerOf);
    room?.remoteParticipants.forEach((p) => {
      if (playerIdOf(p.identity) !== userId) return;
      p.trackPublications.forEach((pub) => {
        if ((pub.source as string) === SOURCE_VIDEO) (pub as RemoteTrackPublication).setVideoQuality(layerOf === 720 ? 2 : layerOf === 360 ? 1 : 0); // HIGH / MEDIUM / LOW
      });
    });
  }, [room]);

  return {
    startShare, stopShare, sharing, shareError,
    trackFor: (userId) => tracks[userId] ?? null,
    follow: (side, userId) => setFollowing((f) => ({ ...f, [side]: userId })),
    unfollow: (side) => setFollowing((f) => { const { [side]: _x, ...rest } = f; return rest; }),
    following, soundId, setSound: setSoundPick, reportWidth,
  };
}
