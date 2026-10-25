import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Room, Track } from "livekit-client";
import { Button } from "@/components/ui/button";
import { LogOutIcon } from "@/components/ui/icons";
import { loadLk } from "@/hooks/useRoomVoice";
import { COPY } from "@/lib/ageReview";
import { registeredAge } from "@/lib/adminAgeReviewUi";

interface Props { join: { url: string; token: string }; registeredDob: string; onEnd: (problem: string | null) => void }

/** Full-screen private call for the reviewer. Not recorded; the registered birthdate stays beside the video for comparison. */
export default function ReviewerCall({ join, registeredDob, onEnd }: Props) {
  const remote = useRef<HTMLVideoElement>(null);
  const local = useRef<HTMLVideoElement>(null);
  const audioBox = useRef<HTMLDivElement>(null);
  const leave = useRef<HTMLButtonElement>(null);
  const roomRef = useRef<Room | null>(null);
  const endRef = useRef(onEnd);
  endRef.current = onEnd;
  const [status, setStatus] = useState<"connecting" | "waiting" | "live">("connecting");
  const age = registeredAge(registeredDob);

  useEffect(() => { leave.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); if (roomRef.current) roomRef.current.disconnect(); else endRef.current(null); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    let cancelled = false;
    let room: Room | null = null;
    (async () => {
      try {
        const lk = await loadLk();
        if (cancelled) return;
        room = new lk.Room();
        roomRef.current = room;
        const attach = (t: Track) => {
          if (t.kind === "video" && remote.current) t.attach(remote.current);
          else if (t.kind === "audio") audioBox.current?.appendChild(t.attach());
          setStatus("live");
        };
        room.on(lk.RoomEvent.TrackSubscribed, (t) => attach(t));
        room.on(lk.RoomEvent.TrackUnsubscribed, (t) => t.detach().forEach((el) => el.remove()));
        room.on(lk.RoomEvent.Disconnected, () => { if (!cancelled) endRef.current(null); });
        await room.connect(join.url, join.token);
        if (cancelled) { room.disconnect(); return; }
        await room.localParticipant.setCameraEnabled(true);
        await room.localParticipant.setMicrophoneEnabled(true);
        const cam = room.localParticipant.getTrackPublication(lk.Track.Source.Camera)?.track;
        if (cam && local.current) cam.attach(local.current);
        room.remoteParticipants.forEach((p) => p.trackPublications.forEach((pub) => pub.track && attach(pub.track)));
        setStatus((s) => (s === "live" ? s : "waiting"));
      } catch {
        if (!cancelled) endRef.current("The call could not start. Check camera and microphone permission and try again.");
      }
    })();
    return () => { cancelled = true; room?.disconnect(); roomRef.current = null; };
  }, [join]);

  return createPortal(
    <div
      role="dialog" aria-modal="true" aria-label="Private live check" className="pointer-events-auto fixed inset-0 z-[100] flex flex-col bg-slate-950 text-white md:flex-row"
      onKeyDown={(e) => { if (e.key === "Tab") { e.preventDefault(); leave.current?.focus(); } }}
      data-testid="reviewer-call"
    >
      <div className="relative min-h-0 flex-1 bg-black">
        <video ref={remote} autoPlay playsInline className="h-full w-full object-cover" aria-label="User video" />
        <div ref={audioBox} className="hidden" />
        {status !== "live" && (
          <p role="status" className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-white/80">
            {status === "connecting" ? "Connecting to the private call" : "Waiting for the user to join"}
          </p>
        )}
        <video ref={local} autoPlay playsInline muted className="absolute bottom-3 right-3 h-28 w-20 rounded-lg border border-white/10 bg-black object-cover [transform:scaleX(-1)]" aria-label="Your video" />
        <span className="absolute left-3 top-[max(0.75rem,env(safe-area-inset-top))] rounded-full border border-white/15 bg-black/60 px-3 py-1.5 text-[0.65rem] font-medium uppercase tracking-[0.2em]" data-testid="reviewer-not-recorded">{COPY.notRecorded}</span>
      </div>
      <aside className="flex shrink-0 flex-col justify-between gap-4 border-t border-slate-800 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:w-72 md:border-l md:border-t-0">
        <div>
          <p className="text-[0.65rem] font-medium uppercase tracking-[0.28em] text-slate-400">Registered birthdate</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{registeredDob || "Not on file"}</p>
          {age !== null && <p className="text-sm text-slate-400 tabular-nums">Age {age}</p>}
          <p className="mt-3 text-sm text-slate-400">Compare the document with this date. Decide after the call.</p>
        </div>
        <Button ref={leave} variant="destructive" className="min-h-[44px]" onClick={() => (roomRef.current ? roomRef.current.disconnect() : onEnd(null))} data-testid="reviewer-leave">
          <LogOutIcon className="mr-2 h-4 w-4" aria-hidden />Leave the call
        </Button>
      </aside>
    </div>,
    document.body,
  );
}
