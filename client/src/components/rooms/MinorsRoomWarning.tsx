import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { AlertTriangleIcon, Loader2Icon } from "@/components/ui/icons";
import { MINORS_ROOM_WARNING, type MinorsRoomCode } from "@shared/rooms";
import { acknowledgeMinorsRoom } from "@/lib/minorsRoomApi";
import { ackAlreadyDone, acknowledgeErrorMessage, BACK_BUTTON, ENTER_BUTTON, RELOAD_FAILED_COPY, warningScreenFor, WARNING_TITLE } from "@/lib/minorsRoomUi";

interface Props {
  /** Only ever the two minors' room codes. The page renders this for no other reason, so a teen never sees it. */
  code: MinorsRoomCode;
  roomId: string;
  /** The warning was acknowledged (or already was): the page loads the room again and joins. Resolves false if the room could not be opened. */
  onAcknowledged(): Promise<boolean>;
}

/**
 * What an adult sees at the door of a room for under 18s. Deliberately knows nothing about the room: no title, no host, no
 * counts. The wording is the shared constant, so the screen, the API and the socket always say the same thing.
 */
export default function MinorsRoomWarning({ code, roomId, onAcknowledged }: Props) {
  const screen = warningScreenFor(code);
  const heading = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A refusal replaces the page, so put the reader at its start rather than leaving focus on nothing.
  useEffect(() => { heading.current?.focus(); }, []);

  if (!screen) return null;

  const enter = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    const r = await acknowledgeMinorsRoom(roomId);
    if (r.ok || ackAlreadyDone(r.status, r.code)) {
      // Stay busy while the room reloads: no second tap. On success this screen is replaced; on failure say so.
      const opened = await onAcknowledged().catch(() => false);
      if (!opened) { setBusy(false); setError(RELOAD_FAILED_COPY); }
      return;
    }
    setBusy(false);
    setError(acknowledgeErrorMessage(r.status, r.code));
  };

  return (
    <section aria-labelledby="minors-warning-title" className="mx-auto max-w-md space-y-4 rounded-2xl border border-destructive/40 bg-card p-6 text-card-foreground" data-testid="minors-room-warning" data-code={code}>
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-destructive/10 text-destructive"><AlertTriangleIcon className="h-5 w-5" aria-hidden /></span>
        <h1 id="minors-warning-title" ref={heading} tabIndex={-1} className="font-serif text-2xl font-bold leading-tight text-destructive focus:outline-none">{WARNING_TITLE}</h1>
      </div>
      <p className="text-base leading-relaxed" data-testid="minors-warning-text">{MINORS_ROOM_WARNING}</p>
      {error && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" data-testid="minors-warning-error">{error}</p>}
      <div className="flex flex-col gap-2 sm:flex-row">
        {screen === "ack" && (
          <Button variant="destructive" className="min-h-[44px] sm:flex-1" onClick={enter} disabled={busy} data-testid="button-minors-enter">
            {busy && <Loader2Icon className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}{ENTER_BUTTON}
          </Button>
        )}
        <Button asChild variant="outline" className="min-h-[44px] sm:flex-1"><Link href="/rooms" data-testid="button-minors-back">{BACK_BUTTON}</Link></Button>
      </div>
    </section>
  );
}
