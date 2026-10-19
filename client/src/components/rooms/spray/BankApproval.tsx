// Board 7 "Bank approval" (img/f-bank). The approval itself happens on the provider's page (Paystack, then the bank), which
// opens in a NEW tab from a plain link: the room tab stays connected (you stay in the room, and the server delivers to a
// payer who is still here), and a link is never blocked as a popup. rel="noopener noreferrer": the provider's page gets no
// handle on this tab and no referrer. Only an address that passed safeAuthorizationUrl is ever rendered.
// The provider sends the new tab back to /rooms/:id?spray=<sprayId>, where SprayReturn (below) reports the outcome; this
// tab learns it from the poll and the room:spray event, and asks at once when you come back to it.
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AlertCircleIcon, CheckCircleIcon, ExternalLinkIcon, Loader2Icon } from "@/components/ui/icons";
import type { SprayTier } from "@shared/money";
import { getSprayStatus } from "@/lib/sprayApi";
import { SPRAY_COPY, SPRAY_FAIL_COPY, bankAsk, outcomeOfStatus, pollDelayMs, waitDeadlineMs, type SprayOutcome } from "@/lib/sprayUi";

interface Props {
  tier: SprayTier;
  url: string;
  onClose(): void;
}

export default function BankApproval({ tier, url, onClose }: Props) {
  const [opened, setOpened] = useState(false);
  return (
    <div className="grid gap-4" data-testid="spray-bank">
      <SheetHeader className="space-y-1.5 text-left">
        <SheetTitle>{SPRAY_COPY.bankTitle}</SheetTitle>
        <SheetDescription>{bankAsk(tier)}</SheetDescription>
      </SheetHeader>
      {opened && (
        <p role="status" aria-live="polite" className="flex min-h-[56px] items-center gap-2 rounded-xl bg-muted px-3 text-sm" data-testid="spray-bank-waiting">
          <Loader2Icon className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden /> {SPRAY_COPY.bankWaiting}
        </p>
      )}
      <Button asChild className="min-h-[52px] rounded-full text-base">
        <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={() => setOpened(true)} data-testid="spray-bank-open">
          {SPRAY_COPY.bankOpen} <ExternalLinkIcon className="ml-2 h-4 w-4" aria-hidden />
        </a>
      </Button>
      <Button variant="ghost" className="min-h-[44px]" onClick={onClose} data-testid="spray-bank-close">{SPRAY_COPY.bankDismiss}</Button>
      <p className="text-center text-xs text-muted-foreground">{SPRAY_COPY.bankDismissNote}</p>
    </div>
  );
}

/**
 * The page the provider returns to (/rooms/:id?spray=<sprayId>), usually in the tab BankApproval opened. It never joins the
 * room (RoomPage holds the join while this shows): it only asks the server how the payer's own spray went and says so.
 * The server answers only the payer (anyone else gets 404), so this shows nothing about the room or anyone else.
 */
export function SprayReturn({ roomId, sprayId, token, onBack }: { roomId: string; sprayId: string; token?: string; onBack(): void }) {
  const [o, setO] = useState<SprayOutcome | { kind: "timeout" } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let stop = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const since = Date.now();
    const tick = async () => {
      if (stop) return;
      if (Date.now() - since > waitDeadlineMs("paying")) { setO({ kind: "timeout" }); return; }
      const r = await getSprayStatus(roomId, sprayId, token);
      if (stop) return;
      const out = outcomeOfStatus(r, sprayId);
      if (out.kind === "delivered" || out.kind === "failed") { setO(out); return; }
      t = setTimeout(() => { void tick(); }, pollDelayMs(Date.now() - since));
    };
    void tick();
    return () => { stop = true; clearTimeout(t); };
  }, [roomId, sprayId, token]);
  useEffect(() => { if (o) requestAnimationFrame(() => heading.current?.focus()); }, [o]);

  const closeWindow = () => { try { window.close(); } catch { /* not a window we opened: the link below still works */ } };
  const actions = (
    <div className="flex flex-wrap justify-center gap-2">
      <Button className="min-h-[44px]" onClick={closeWindow} data-testid="spray-return-close">{SPRAY_COPY.returnClose}</Button>
      <Button variant="outline" className="min-h-[44px]" onClick={onBack} data-testid="spray-return-back">{SPRAY_COPY.returnBack}</Button>
    </div>
  );

  if (!o) {
    return (
      <Card className="mx-auto max-w-md space-y-3 rounded-2xl p-8 text-center" role="status" aria-live="polite" data-testid="spray-return">
        <Loader2Icon className="mx-auto h-8 w-8 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
        <h1 className="font-serif text-2xl font-bold">{SPRAY_COPY.returnTitle}</h1>
        <p className="text-sm text-muted-foreground">{SPRAY_COPY.returnChecking}</p>
      </Card>
    );
  }
  const ok = o.kind === "delivered";
  const copy = o.kind === "failed" ? SPRAY_FAIL_COPY[o.reason] : o.kind === "timeout" ? SPRAY_FAIL_COPY.STILL_WAITING : null;
  return (
    <Card className="mx-auto max-w-md space-y-4 rounded-2xl p-8 text-center" data-testid="spray-return" data-outcome={o.kind}>
      <div className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full ${ok ? "bg-primary/15 text-primary" : "bg-destructive/15 text-destructive"}`} aria-hidden>
        {ok ? <CheckCircleIcon className="h-7 w-7" /> : <AlertCircleIcon className="h-7 w-7" />}
      </div>
      <h1 ref={heading} tabIndex={-1} className="font-serif text-2xl font-bold outline-none">{ok ? "Your spray landed" : copy!.title}</h1>
      <p role={ok ? "status" : "alert"} className="text-sm">{ok ? "Everyone in the room saw it. You can close this window and go back to the room." : copy!.body}</p>
      {actions}
      <p className="text-xs text-muted-foreground"><Link href="/rooms">Back to Rooms</Link></p>
    </Card>
  );
}
