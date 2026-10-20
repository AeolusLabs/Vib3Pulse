// Live voice for a room: LiveKit carries the audio, our server decides who may speak (token + permission updates).
// Audio and the microphone only start from a user's tap. The server's permission changes arrive as LiveKit events,
// so `canPublish` here is always what LiveKit says, never a guess from the stage list.
import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalVideoTrack, ReconnectPolicy, RemoteTrack, Room, RemoteTrackPublication } from "livekit-client";
import { LIVE_HOLD_MS } from "@shared/liveScreen";
import { apiRequest } from "@/lib/queryClient";
import { mediaIssueLine, mediaLineFor } from "@/lib/mediaIssues";
import { shouldRetryStart, startErrorKind, voiceStatus, type StartErrorKind, type VoiceStatus } from "@/lib/voiceState";
import { cameraSimulcast, micCapture, pickStartProfile, profileSettings, viewerStartsAudioOnly, type ConnInfo, type LinkQuality, type VideoProfile } from "@/lib/bandwidth";

// Keep trying to get back for as long as the server holds the performer's spot, backing off from 1 s to 8 s: a weak connection that
// comes and goes must not end the stream. After that LiveKit gives up and the room releases the screen anyway.
const holdReconnectPolicy: ReconnectPolicy = {
  nextRetryDelayInMs: ({ elapsedMs, retryCount }) => (elapsedMs >= LIVE_HOLD_MS ? null : Math.min(1000 * 2 ** retryCount, 8000)),
};
// livekit-client is large: it is only downloaded the first time someone actually starts room audio or video, so everyone else
// (and everyone on a slow connection who is just browsing) never pays for it.
let lkModule: Promise<typeof import("livekit-client")> | null = null;
const loadLk = () => (lkModule ??= import("livekit-client").catch((e) => { lkModule = null; throw e; })); // a failed download must be retryable on the next tap
const connInfo = (): ConnInfo | undefined => (typeof navigator !== "undefined" ? (navigator as unknown as { connection?: ConnInfo }).connection : undefined);
const AUDIO_ONLY_KEY = "vp.room.audioOnly";
const readAudioOnly = (): boolean => {
  try { const v = localStorage.getItem(AUDIO_ONLY_KEY); if (v !== null) return v === "1"; } catch { /* storage blocked */ }
  return viewerStartsAudioOnly(connInfo());
};
// LiveKit disconnected us on purpose (we left, we were removed, another tab joined, the room is gone): do not try to get back on air.
const NO_RESUME = new Set(["CLIENT_INITIATED", "DUPLICATE_IDENTITY", "PARTICIPANT_REMOVED", "ROOM_DELETED", "USER_REJECTED", "ROOM_CLOSED"]);
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const START_ERROR: Record<StartErrorKind, string> = {
  "not-allowed-yet": "The screen isn't ready for you yet. Wait a moment and press Go live again.",
  blocked: "Your browser blocked the camera or microphone. Allow it in the address bar and try again.",
  other: "Couldn't start your camera. Check it is connected and not used by another app.",
};

/** What the screen needs from a video track: attach it to a <video>, detach it again. */
export interface ScreenTrack { attach(el: HTMLVideoElement): unknown; detach(el: HTMLVideoElement): unknown }

export interface RoomVoice {
  status: VoiceStatus;
  /** Call from a click: lets the browser play audio, then joins the voice session. */
  unlock(): Promise<void>;
  canPublish: boolean;
  micOn: boolean;
  /** Call from a click: asks for the microphone the first time. */
  toggleMic(): Promise<void>;
  activeSpeakers: string[];
  error: string | null;
  micError: string | null;
  /** The live screen: the holder's video as everyone else receives it, and your own preview while you are the holder. */
  video: ScreenTrack | null;
  localVideo: ScreenTrack | null;
  cameraOn: boolean;
  cameraError: string | null;
  /** The media connection dropped and is being re-established (your stream resumes by itself when it is back). */
  reconnecting: boolean;
  /** The automatic comeback after a drop is running: nothing else may start the camera meanwhile. */
  comingBack: boolean;
  /** Call from a click: starts your camera and microphone (the holder only; the server has already allowed it). */
  startCamera(devices: CameraDevices): Promise<boolean>;
  stopCamera(): Promise<void>;
  /** The holder dropped the picture on a weak link but is still on air with sound; `resumeVideo` puts the picture back. */
  /** This person is meant to be on air (they went live and have not stopped): true through a drop and the automatic comeback. */
  onAir: boolean;
  videoPaused: boolean;
  pauseVideo(): Promise<void>;
  resumeVideo(): Promise<void>;
  /** Viewer data saver: no video is downloaded, only sound. */
  audioOnly: boolean;
  setAudioOnly(on: boolean): void;
  /** This person's own link to LiveKit, and since when it has been poor or lost (null while fine). */
  linkQuality: LinkQuality;
  linkPoorSince: number | null;
}

export interface CameraDevices { cameraId?: string; micId?: string; profile?: VideoProfile; /** No echo cancellation, noise suppression or auto gain on the mic. */ musicMode?: boolean }

export function useRoomVoice(roomId: string, opts: { enabled: boolean; inviteToken?: string; /** The holder's camera or microphone went away mid-stream: tell the room to take the screen back. */ onCameraLost?: () => void }): RoomVoice {
  const [unlocked, setUnlocked] = useState(false);
  const [connected, setConnected] = useState(false);
  const [failed, setFailed] = useState(false);
  const [canPublish, setCanPublish] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [active, setActive] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [video, setVideo] = useState<ScreenTrack | null>(null);
  const [localVideo, setLocalVideo] = useState<ScreenTrack | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [comingBack, setComingBack] = useState(false);
  const [videoPaused, setVideoPaused] = useState(false);
  const [onAir, setOnAir] = useState(false);
  const [audioOnly, setAudioOnlyState] = useState<boolean>(readAudioOnly);
  const [linkQuality, setLinkQuality] = useState<LinkQuality>("unknown");
  const [linkPoorSince, setLinkPoorSince] = useState<number | null>(null);
  const audioOnlyRef = useRef(audioOnly);
  audioOnlyRef.current = audioOnly;
  const lk = useRef<Room | null>(null);
  const sink = useRef<HTMLDivElement | null>(null);
  const connecting = useRef(false);
  const intendedLive = useRef<{ devices: CameraDevices } | null>(null); // set while this person is on air; only a deliberate stop clears it
  const setIntent = (v: { devices: CameraDevices } | null) => { intendedLive.current = v; setOnAir(v !== null); };
  const resumeRef = useRef<() => Promise<void>>(async () => {});
  const generation = useRef(0); // bumped whenever we hang up: an async connect that finds it changed must undo itself

  const teardown = useCallback(() => {
    generation.current++;
    lk.current?.disconnect();
    lk.current = null;
    sink.current?.remove();
    sink.current = null;
    setConnected(false); setCanPublish(false); setMicOn(false); setActive([]);
    setVideo(null); setLocalVideo(null); setCameraOn(false); setLinkQuality("unknown"); setLinkPoorSince(null);
    if (!intendedLive.current) setVideoPaused(false); // still on air (a failed attempt during the comeback): keep "picture paused"
  }, []);

  // Leaving the session for good (voice switched off, leaving the page): nothing may try to bring the camera back later.
  const hangUp = useCallback(() => { intendedLive.current = null; setOnAir(false); teardown(); }, [teardown]);

  const connect = useCallback(async () => {
    if (lk.current || connecting.current) return;
    connecting.current = true;
    const gen = generation.current;
    setFailed(false); setError(null);
    try {
      const res = await apiRequest("POST", `/api/rooms/${roomId}/voice-token${opts.inviteToken ? `?token=${encodeURIComponent(opts.inviteToken)}` : ""}`);
      const { url, token, canPublish: allowed } = await res.json() as { url: string; token: string; canPublish: boolean };
      if (gen !== generation.current) return; // left the page / voice switched off while the token was on its way
      const { Room, RoomEvent, Track, DisconnectReason } = await loadLk();
      if (gen !== generation.current) return;
      const room = new Room({ adaptiveStream: true, dynacast: true, reconnectPolicy: holdReconnectPolicy });
      // Viewer data saver: never keep a video subscription while "audio only" is on.
      const applyAudioOnly = (pub: RemoteTrackPublication) => { if (pub.kind === Track.Kind.Video) pub.setSubscribed(!audioOnlyRef.current); };
      room.on(RoomEvent.TrackPublished, (pub) => applyAudioOnly(pub));
      room.on(RoomEvent.ConnectionQualityChanged, (q, p) => {
        if (p !== room.localParticipant) return;
        setLinkQuality(q as LinkQuality);
        setLinkPoorSince((since) => (q === "poor" || q === "lost" ? since ?? Date.now() : null));
      });
      const box = document.createElement("div");
      box.style.display = "none";
      document.body.appendChild(box);
      sink.current = box;
      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Audio) box.appendChild(track.attach());
        else if (track.kind === Track.Kind.Video) setVideo(track as unknown as ScreenTrack);
      });
      room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Video) { setVideo((v) => (v === (track as unknown as ScreenTrack) ? null : v)); return; } // <video> elements belong to the screen
        track.detach().forEach((el) => el.remove());
      });
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => setActive(speakers.map((s) => s.identity)));
      room.on(RoomEvent.ParticipantPermissionsChanged, (_prev, p) => {
        if (p === room.localParticipant) { setCanPublish(!!p.permissions?.canPublish); if (!p.permissions?.canPublish) setMicOn(false); }
      });
      room.on(RoomEvent.LocalTrackUnpublished, (pub) => { // permission removed: LiveKit drops the track
        if (pub.source === Track.Source.Camera) { setCameraOn(false); setLocalVideo(null); } else setMicOn(false);
      });
      room.on(RoomEvent.SignalReconnecting, () => setReconnecting(true));
      room.on(RoomEvent.Reconnecting, () => setReconnecting(true));
      room.on(RoomEvent.Reconnected, () => setReconnecting(false));
      room.on(RoomEvent.LocalTrackPublished, (pub) => { // a full rejoin republishes the camera by itself: follow it
        if (pub.source === Track.Source.Camera && pub.videoTrack) { setLocalVideo(pub.videoTrack as unknown as ScreenTrack); setCameraOn(true); }
      });
      room.on(RoomEvent.Disconnected, (reason) => { // LiveKit gave up reconnecting, or ended our session on purpose
        if (lk.current !== room) return;
        lk.current = null; setConnected(false); setMicOn(false); setCameraOn(false); setLocalVideo(null);
        box.remove(); if (sink.current === box) sink.current = null; // each drop used to leave an empty hidden element behind
        const why = reason === undefined ? "" : DisconnectReason[reason] ?? "";
        if (NO_RESUME.has(why)) { setIntent(null); setVideoPaused(false); setFailed(true); setError("You were disconnected from the room's audio. Tap to reconnect."); return; }
        if (intendedLive.current) { void resumeRef.current(); return; } // on air: keep trying with fresh tokens, do not wait for a tap
        setFailed(true); setError("Audio disconnected. Tap to reconnect.");
      });
      await room.connect(url, token, { peerConnectionTimeout: 30_000, websocketTimeout: 30_000 });
      if (gen !== generation.current) { room.disconnect(); box.remove(); return; } // hung up while connecting: do not leave audio running
      room.remoteParticipants.forEach((p) => p.trackPublications.forEach((pub) => applyAudioOnly(pub as RemoteTrackPublication)));
      await room.startAudio().catch(() => {}); // fine if the browser still wants another tap; the audio element resumes on the next one
      lk.current = room;
      setCanPublish(allowed);
      setConnected(true);
      setReconnecting(false);
    } catch (e: any) {
      setFailed(true);
      setError("Couldn't connect to the audio service. Check your connection and try again.");
      teardown(); // not hangUp: a failed attempt during an automatic comeback must keep the intent to try again
    } finally {
      connecting.current = false;
    }
  }, [roomId, opts.inviteToken, teardown]);

  const unlock = useCallback(async () => { setUnlocked(true); await connect(); }, [connect]);

  const toggleMic = useCallback(async () => {
    const room = lk.current;
    if (!room) return;
    setMicError(null);
    try {
      await room.localParticipant.setMicrophoneEnabled(!micOn);
      setMicOn(!micOn);
    } catch (e: any) {
      setMicError(mediaIssueLine("mic", e));
    }
  }, [micOn]);

  // Voice switched off by the host: leave the session. Switched back on after a tap earlier: rejoin without another tap.
  useEffect(() => {
    if (opts.enabled) void loadLk().catch(() => {}); // fetch it now so the first tap on a weak link only has to connect
    if (!opts.enabled) { hangUp(); return; }
    if (unlocked && !lk.current) void connect();
  }, [opts.enabled, unlocked, connect, hangUp]);

  useEffect(() => hangUp, [hangUp]); // leaving the page ends the session
  useEffect(() => () => { intendedLive.current = null; }, []); // ...and ends any attempt to get back on air

  const resuming = useRef(false);
  const videoPausedRef = useRef(false);
  videoPausedRef.current = videoPaused;
  const micStartedByLive = useRef(false); // Go live turned the microphone on: Stop live turns it off again
  const stops = useRef(0); // counts deliberate stops: a Go live retry still waiting must not start after one
  const liveMusic = useRef(false); // the live microphone runs in music mode: a mic that stays on after Stop live gets its voice processing back
  const ended = useRef<{ track: LocalVideoTrack; handler: () => void } | null>(null);
  const onCameraLost = useRef(opts.onCameraLost);
  onCameraLost.current = opts.onCameraLost;

  const unpublishCamera = useCallback(async () => {
    const room = lk.current;
    setCameraOn(false); setLocalVideo(null);
    if (ended.current) { const { TrackEvent } = await loadLk(); ended.current.track.off(TrackEvent.Ended, ended.current.handler); ended.current = null; }
    if (!room) return;
    const { Track } = await loadLk();
    const lp = room.localParticipant;
    // Unpublish (not just mute): the next Go live must open the chosen device afresh, and nothing may keep sending behind a "Stop".
    const cam = lp.getTrackPublication(Track.Source.Camera)?.track;
    if (cam) await lp.unpublishTrack(cam, true).catch(() => {});
  }, []);

  const stopCamera = useCallback(async () => {
    setIntent(null); // a deliberate stop (or the screen was taken back): do not try to resume
    stops.current++;
    setVideoPaused(false);
    await unpublishCamera();
    const room = lk.current;
    const music = liveMusic.current;
    liveMusic.current = false;
    if (room && micStartedByLive.current) { micStartedByLive.current = false; await room.localParticipant.setMicrophoneEnabled(false).catch(() => {}); setMicOn(false); }
    else if (room && music) { // the mic was on before Go live and stays on: speech needs echo cancellation again
      const { Track } = await loadLk();
      const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
      await mic?.restartTrack(micCapture(mic.mediaStreamTrack.getSettings().deviceId, false)).catch(() => {});
    }
  }, [unpublishCamera]);

  const startCamera = useCallback(async (devices: CameraDevices): Promise<boolean> => {
    setCameraError(null);
    if (!lk.current) await unlock(); // the Go live tap also joins the room's media if the person never tapped to hear it
    const room = lk.current;
    if (!room) { setCameraError("Couldn't connect to the room's video. Check your connection and try again."); return false; }
    const lp = room.localParticipant;
    const stopsAtStart = stops.current;
    const fresh = !intendedLive.current; // a comeback (after a drop or a paused picture) keeps what Go live found about the microphone
    for (let attempt = 0; ; attempt++) {
      try {
        const { Track, TrackEvent, AudioPresets } = await loadLk();
        const profile = devices.profile ?? pickStartProfile(connInfo());
        const q = profileSettings(profile);
        // Capped resolution, frame rate and bitrate keep data use predictable, and simulcast lets LiveKit send weaker viewers a smaller copy.
        await lp.setCameraEnabled(true, { deviceId: devices.cameraId, resolution: { width: q.width, height: q.height, frameRate: q.frameRate } }, { videoEncoding: { maxBitrate: q.maxBitrate, maxFramerate: q.frameRate }, simulcast: cameraSimulcast(profile) });
        if (devices.cameraId) await room.switchActiveDevice("videoinput", devices.cameraId).catch(() => false);
        const micWasOn = lp.isMicrophoneEnabled;
        const capture = micCapture(devices.micId, !!devices.musicMode);
        if (micWasOn) {
          // Capture options only apply when a microphone is opened: in music mode reopen the running one with them.
          if (devices.musicMode && (fresh || !liveMusic.current)) await lp.getTrackPublication(Track.Source.Microphone)?.audioTrack?.restartTrack(capture);
          else if (devices.micId) await room.switchActiveDevice("audioinput", devices.micId).catch(() => false);
        }
        // Sound comes first: Opus at 48 kbps with redundancy and silence suppression, which also copes with packet loss.
        else await lp.setMicrophoneEnabled(true, capture, { audioPreset: AudioPresets.music, dtx: true, red: true });
        if (fresh) micStartedByLive.current = !micWasOn;
        liveMusic.current = !!devices.musicMode;
        const track = lp.getTrackPublication(Track.Source.Camera)?.videoTrack;
        if (!track) throw new Error("no camera track");
        const handler = () => { setCameraError("Your camera or microphone was disconnected, so the stream stopped."); void stopCamera(); onCameraLost.current?.(); };
        if (ended.current) ended.current.track.off(TrackEvent.Ended, ended.current.handler); // never leave an older listener behind
        track.on(TrackEvent.Ended, handler);
        ended.current = { track, handler };
        setLocalVideo(track as unknown as ScreenTrack);
        setCameraOn(true); setMicOn(true); setVideoPaused(false);
        setIntent({ devices });
        return true;
      } catch (e: unknown) {
        await lp.setCameraEnabled(false).catch(() => {});
        const kind = startErrorKind(e);
        // Right after the host hands over the screen, LiveKit's camera permission can still be on its way: wait and try once more.
        if (shouldRetryStart(kind, attempt)) { await wait(1500); if (lk.current === room && stops.current === stopsAtStart) continue; return false; }
        setCameraError(kind === "not-allowed-yet" ? START_ERROR[kind] : kind === "blocked" ? mediaLineFor("camera", "denied") : mediaIssueLine("camera", e));
        return false;
      }
    }
  }, [stopCamera, unlock]);

  // A weak link: drop the picture, keep the sound and the screen. Viewers hear the performer; the picture comes back on request.
  const pauseVideo = useCallback(async () => {
    if (!intendedLive.current) return;
    setVideoPaused(true);
    await unpublishCamera();
  }, [unpublishCamera]);
  const resumeVideo = useCallback(async () => {
    const devices = intendedLive.current?.devices;
    if (devices) await startCamera(devices);
  }, [startCamera]);

  const setAudioOnly = useCallback((on: boolean) => {
    setAudioOnlyState(on);
    audioOnlyRef.current = on;
    try { localStorage.setItem(AUDIO_ONLY_KEY, on ? "1" : "0"); } catch { /* storage blocked: the choice just is not remembered */ }
    lk.current?.remoteParticipants.forEach((p) => p.trackPublications.forEach((pub) => { if (pub.kind === "video") (pub as RemoteTrackPublication).setSubscribed(!on); }));
    if (on) setVideo(null);
  }, []);

  // The media connection is gone for good (LiveKit gave up, or its token expired during a long drop): rejoin with a fresh token and put
  // the camera back on with the same devices, for as long as the server holds the spot. A weak connection must not end a stream.
  const resumeLive = useCallback(async () => {
    if (resuming.current) return;
    resuming.current = true;
    setReconnecting(true); setComingBack(true);
    const since = Date.now();
    try {
      for (let i = 0; intendedLive.current && Date.now() - since < LIVE_HOLD_MS; i++) {
        await wait(Math.min(1000 * 2 ** i, 8000));
        if (!intendedLive.current) break;
        await connect();
        const devices = intendedLive.current?.devices;
        if (lk.current && devices) {
          if (videoPausedRef.current) { // sound only: do not bring the picture back
            const { AudioPresets } = await loadLk();
            await lk.current.localParticipant.setMicrophoneEnabled(true, micCapture(devices.micId, !!devices.musicMode), { audioPreset: AudioPresets.music, dtx: true, red: true }).catch(() => {});
            liveMusic.current = !!devices.musicMode;
            setMicOn(true); break;
          }
          if (await startCamera(devices)) break;
        } else if (lk.current) break;
      }
    } finally {
      resuming.current = false;
      setReconnecting(false); setComingBack(false);
    }
    if (intendedLive.current && !lk.current) { setIntent(null); setVideoPaused(false); setFailed(true); setError("We couldn't reconnect in time. Tap to reconnect, then press Go live again."); }
  }, [connect, startCamera]);
  resumeRef.current = resumeLive;

  return { status: voiceStatus({ voiceEnabled: opts.enabled, unlocked, connected, failed, canPublish, micOn }), unlock, canPublish, micOn, toggleMic, activeSpeakers: active, error, micError, video, localVideo, cameraOn, cameraError, reconnecting, comingBack, startCamera, stopCamera, onAir, videoPaused, pauseVideo, resumeVideo, audioOnly, setAudioOnly, linkQuality, linkPoorSince };
}
