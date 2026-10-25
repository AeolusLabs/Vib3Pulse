import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Room, Track } from "livekit-client";
import { Button } from "@/components/ui/button";
import { ClockIcon, Loader2Icon, LogOutIcon } from "@/components/ui/icons";
import { AgeReviewError, useAgeReview } from "@/hooks/useAgeReview";
import { loadLk } from "@/hooks/useRoomVoice";
import { COPY, errorMessage, liveInviteActive, minutesLeft, type AgeReviewRequest } from "@/lib/ageReview";

const BTN = "min-h-[44px] rounded-full";

type Join = { url: string; token: string };

function LiveCall({ join, onEnd }: { join: Join; onEnd: (problem: string | null) => void }) {
  const remote = useRef<HTMLVideoElement>(null);
  const local = useRef<HTMLVideoElement>(null);
  const audioBox = useRef<HTMLDivElement>(null);
  const roomRef = useRef<Room | null>(null);
  const [status, setStatus] = useState<"connecting" | "waiting" | "live">("connecting");
  const leave = useRef<HTMLButtonElement>(null);
  const endRef = useRef(onEnd);
  endRef.current = onEnd;

  useEffect(() => { leave.current?.focus(); }, []);

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
        if (!cancelled) endRef.current("We could not start the call. Check that your camera and microphone are allowed, then try again.");
      }
    })();
    return () => { cancelled = true; room?.disconnect(); roomRef.current = null; };
  }, [join]);

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Private live check" className="fixed inset-0 z-[100] flex flex-col bg-background" data-testid="age-live-call"
      onKeyDown={(e) => { if (e.key === "Tab") { e.preventDefault(); leave.current?.focus(); } }}>
      <div className="relative min-h-0 flex-1 bg-black/90">
        <video ref={remote} autoPlay playsInline className="h-full w-full object-cover" aria-label="Reviewer video" />
        <div ref={audioBox} className="hidden" />
        {status !== "live" && (
          <p className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-foreground/80" role="status">
            {status === "connecting" ? "Connecting to the private call" : "Waiting for the reviewer to join"}
          </p>
        )}
        <video ref={local} autoPlay playsInline muted className="absolute bottom-3 right-3 h-32 w-24 rounded-xl border border-white/10 bg-black object-cover [transform:scaleX(-1)]" aria-label="Your video" />
        <span className="absolute left-3 top-[max(0.75rem,env(safe-area-inset-top))] rounded-full border border-white/15 bg-black/60 px-3 py-1.5 text-[0.65rem] font-medium uppercase tracking-[0.2em] text-white" data-testid="age-not-recorded">
          {COPY.notRecorded}
        </span>
      </div>
      <div className="flex justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <Button ref={leave} variant="destructive" className="min-h-[44px] rounded-full px-6" onClick={() => roomRef.current ? roomRef.current.disconnect() : onEnd(null)} data-testid="age-leave">
          <LogOutIcon className="mr-2 h-4 w-4" aria-hidden />Leave the call
        </Button>
      </div>
    </div>,
    document.body,
  );
}

/** The live method on the Verify card: waiting for an invite, then Join and the full-screen call. */
export default function LiveCheckFlow({ request, onHowHandled }: { request: AgeReviewRequest; onHowHandled: () => void }) {
  const api = useAgeReview();
  const [now, setNow] = useState(() => new Date());
  const [join, setJoin] = useState<Join | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(t);
  }, []);

  const invited = liveInviteActive(request, now);
  const draft = request.status === "draft";
  const joinBtn = useRef<HTMLButtonElement>(null);

  const doJoin = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await api.liveJoin.mutateAsync(request.id);
      setJoin({ url: r.url, token: r.token });
    } catch (e) {
      setNote(e instanceof AgeReviewError ? errorMessage(e.code, { retryAfter: e.retryAfter }) : errorMessage(undefined));
    } finally { setBusy(false); }
  };

  const sendRequest = async () => {
    setBusy(true); setNote(null);
    try { await api.submit.mutateAsync(request.id); }
    catch (e) { setNote(e instanceof AgeReviewError ? errorMessage(e.code, { retryAfter: e.retryAfter }) : errorMessage(undefined)); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-3" data-testid="age-live-flow">
      <p className="flex items-start gap-2 text-sm text-muted-foreground" aria-live="polite">
        <ClockIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>{draft ? "Your live check is not sent yet. Send it so a reviewer can invite you." : invited ? `${COPY.joinReady} ${minutesLeft(request.liveInviteExpiresAt, now)} min left.` : COPY.waiting}</span>
      </p>
      {draft && (
        <Button className={BTN} onClick={() => void sendRequest()} disabled={busy} data-testid="age-live-send">
          {busy && <Loader2Icon className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}Send live check request
        </Button>
      )}
      {invited && !draft && (
        <Button ref={joinBtn} className={BTN} onClick={() => void doJoin()} disabled={busy} data-testid="age-join">
          {busy && <Loader2Icon className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}Join the live check
        </Button>
      )}
      <p role="alert" className={note ? "text-sm text-destructive" : "sr-only"}>{note ?? ""}</p>
      <button type="button" onClick={onHowHandled} className="min-h-[44px] text-sm font-medium text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">{COPY.howHandled}</button>
      {join && <LiveCall join={join} onEnd={(problem) => { setJoin(null); if (problem) setNote(problem); void api.refresh(); window.setTimeout(() => joinBtn.current?.focus(), 0); }} />}
    </div>
  );
}
