// Live voice for a room: LiveKit carries the audio, our server decides who may speak (token + permission updates).
// Audio and the microphone only start from a user's tap. The server's permission changes arrive as LiveKit events,
// so `canPublish` here is always what LiveKit says, never a guess from the stage list.
import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track, type RemoteTrack } from "livekit-client";
import { apiRequest } from "@/lib/queryClient";
import { voiceStatus, type VoiceStatus } from "@/lib/voiceState";

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
      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => { if (track.kind === Track.Kind.Audio) box.appendChild(track.attach()); });
      room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => { track.detach().forEach((el) => el.remove()); });
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => setActive(speakers.map((s) => s.identity)));
      room.on(RoomEvent.ParticipantPermissionsChanged, (_prev, p) => {
        if (p === room.localParticipant) { setCanPublish(!!p.permissions?.canPublish); if (!p.permissions?.canPublish) setMicOn(false); }
      });
      room.on(RoomEvent.LocalTrackUnpublished, () => setMicOn(false)); // permission removed: LiveKit drops the track
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

  return { status: voiceStatus({ voiceEnabled: opts.enabled, unlocked, connected, failed, canPublish, micOn }), unlock, canPublish, micOn, toggleMic, activeSpeakers: active, error, micError };
}
