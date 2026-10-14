// Live voice for a room: LiveKit carries the audio, our server decides who may speak (token + permission updates).
// Audio and the microphone only start from a user's tap. The server's permission changes arrive as LiveKit events,
// so `canPublish` here is always what LiveKit says, never a guess from the stage list.
import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track, TrackEvent, type RemoteTrack } from "livekit-client";
import { apiRequest } from "@/lib/queryClient";
import { voiceStatus, type VoiceStatus } from "@/lib/voiceState";

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
  /** Call from a click: starts your camera and microphone (the holder only; the server has already allowed it). */
  startCamera(devices: { cameraId?: string; micId?: string }): Promise<void>;
  stopCamera(): Promise<void>;
}

export function useRoomVoice(roomId: string, opts: { enabled: boolean; inviteToken?: string }): RoomVoice {
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
  const lk = useRef<Room | null>(null);
  const sink = useRef<HTMLDivElement | null>(null);
  const connecting = useRef(false);
  const generation = useRef(0); // bumped whenever we hang up: an async connect that finds it changed must undo itself

  const hangUp = useCallback(() => {
    generation.current++;
    lk.current?.disconnect();
    lk.current = null;
    sink.current?.remove();
    sink.current = null;
    setConnected(false); setCanPublish(false); setMicOn(false); setActive([]);
    setVideo(null); setLocalVideo(null); setCameraOn(false);
  }, []);

  const connect = useCallback(async () => {
    if (lk.current || connecting.current) return;
    connecting.current = true;
    const gen = generation.current;
    setFailed(false); setError(null);
    try {
      const res = await apiRequest("POST", `/api/rooms/${roomId}/voice-token${opts.inviteToken ? `?token=${encodeURIComponent(opts.inviteToken)}` : ""}`);
      const { url, token, canPublish: allowed } = await res.json() as { url: string; token: string; canPublish: boolean };
      if (gen !== generation.current) return; // left the page / voice switched off while the token was on its way
      const room = new Room();
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
      room.on(RoomEvent.Disconnected, () => { if (lk.current === room) { lk.current = null; setConnected(false); setMicOn(false); setFailed(true); setError("Audio disconnected. Tap to reconnect."); } }); // LiveKit gave up reconnecting
      await room.connect(url, token);
      if (gen !== generation.current) { room.disconnect(); box.remove(); return; } // hung up while connecting: do not leave audio running
      await room.startAudio().catch(() => {}); // fine if the browser still wants another tap; the audio element resumes on the next one
      lk.current = room;
      setCanPublish(allowed);
      setConnected(true);
    } catch (e: any) {
      setFailed(true);
      setError("Couldn't connect to the audio service. Check your connection and try again.");
      hangUp();
    } finally {
      connecting.current = false;
    }
  }, [roomId, opts.inviteToken, hangUp]);

  const unlock = useCallback(async () => { setUnlocked(true); await connect(); }, [connect]);

  const toggleMic = useCallback(async () => {
    const room = lk.current;
    if (!room) return;
    setMicError(null);
    try {
      await room.localParticipant.setMicrophoneEnabled(!micOn);
      setMicOn(!micOn);
    } catch (e: any) {
      setMicError(/denied|permission|NotAllowed/i.test(String(e?.name) + String(e?.message)) ? "Your browser blocked the microphone. Allow it in the address bar and try again." : "Couldn't start the microphone.");
    }
  }, [micOn]);

  // Voice switched off by the host: leave the session. Switched back on after a tap earlier: rejoin without another tap.
  useEffect(() => {
    if (!opts.enabled) { hangUp(); return; }
    if (unlocked && !lk.current) void connect();
  }, [opts.enabled, unlocked, connect, hangUp]);

  useEffect(() => hangUp, [hangUp]); // leaving the page ends the session

  const stopCamera = useCallback(async () => {
    const room = lk.current;
    setCameraOn(false); setLocalVideo(null);
    if (!room) return;
    await room.localParticipant.setCameraEnabled(false).catch(() => {});
  }, []);

  const startCamera = useCallback(async (devices: { cameraId?: string; micId?: string }) => {
    const room = lk.current;
    if (!room) return;
    setCameraError(null);
    try {
      // 720p at 30 frames a second: keeps the room's bandwidth (and our LiveKit bill) predictable.
      await room.localParticipant.setCameraEnabled(true, { deviceId: devices.cameraId, resolution: { width: 1280, height: 720, frameRate: 30 } });
      await room.localParticipant.setMicrophoneEnabled(true, devices.micId ? { deviceId: devices.micId } : undefined);
      const track = room.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack;
      if (!track) throw new Error("no camera track");
      track.on(TrackEvent.Ended, () => { setCameraError("Your camera or microphone was disconnected, so the stream stopped."); void stopCamera(); });
      setLocalVideo(track as unknown as ScreenTrack);
      setCameraOn(true); setMicOn(true);
    } catch (e: any) {
      await room.localParticipant.setCameraEnabled(false).catch(() => {});
      setCameraError(/denied|permission|NotAllowed/i.test(String(e?.name) + String(e?.message)) ? "Your browser blocked the camera or microphone. Allow it in the address bar and try again." : "Couldn't start your camera. Check it is connected and not used by another app.");
    }
  }, [stopCamera]);

  return { status: voiceStatus({ voiceEnabled: opts.enabled, unlocked, connected, failed, canPublish, micOn }), unlock, canPublish, micOn, toggleMic, activeSpeakers: active, error, micError, video, localVideo, cameraOn, cameraError, startCamera, stopCamera };
}
