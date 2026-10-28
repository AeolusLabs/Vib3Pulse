// Board 7 "Payment declined" (img/f-decline), and every other way a spray can end without landing. Plain words: was money
// taken, was anything sent, what to do next. The words come from SPRAY_FAIL_COPY (lib/sprayUi.ts), keyed by the reason.
// Only a definitive failure is an alert; "still checking" and "still waiting for your bank" are calm status lines (the
// outcome is not known yet, so it is never shown as a failure). A rate limit keeps "Try again" off until Retry-After passes.
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { SPRAY_COPY, SPRAY_FAIL_COPY, type SprayFailReason } from "@/lib/sprayUi";

interface Props {
  reason: SprayFailReason;
  retryAfterSec?: number;
  onRetry(): void;
  onAnotherCard(): void;
  onClose(): void;
}

/** Seconds left until `until` (ms), ticking once a second; 0 when there is nothing to wait for. */
function useCountdown(until: number | null): number {
  const left = () => (until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0);
  const [sec, setSec] = useState(left);
  useEffect(() => {
    setSec(left());
    if (!until) return;
    const t = setInterval(() => { const s = left(); setSec(s); if (s <= 0) clearInterval(t); }, 1000);
    return () => clearInterval(t);
  }, [until]); // eslint-disable-line react-hooks/exhaustive-deps
  return sec;
}

export default function PaymentFailedSheet({ reason, retryAfterSec, onRetry, onAnotherCard, onClose }: Props) {
  const c = SPRAY_FAIL_COPY[reason];
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { requestAnimationFrame(() => first.current?.focus()); }, [reason]);
  const back = `${window.location.pathname}${window.location.search}`;
  // The sheet is keyed by the intent and reason, so this deadline is fixed when the refusal arrives.
  const [until] = useState<number | null>(() => (reason === "RATE_LIMITED" && retryAfterSec ? Date.now() + retryAfterSec * 1000 : null));
  const wait = useCountdown(until);
  const primary = (() => {
    switch (c.primary) {
      case "retry": return (
        <Button ref={first} className="min-h-[48px] rounded-full" onClick={() => { if (wait <= 0) onRetry(); }} disabled={wait > 0} data-testid="spray-failed-retry">
          {wait > 0 ? `${SPRAY_COPY.tryAgain} in ${wait}s` : SPRAY_COPY.tryAgain}
        </Button>
      );
      case "check": return <Button ref={first} className="min-h-[48px] rounded-full" onClick={onRetry} data-testid="spray-failed-check">{SPRAY_COPY.checkAgain}</Button>;
      case "signin": return <Button asChild className="min-h-[48px] rounded-full" data-testid="spray-failed-signin"><Link href={`/login?redirect=${encodeURIComponent(back)}`}>{SPRAY_COPY.signIn}</Link></Button>;
      default: return null;
    }
  })();
  const live = c.tone === "fail" ? "alert" : "status";
  return (
    <div className="grid gap-3" data-testid="spray-failed" data-reason={reason} data-tone={c.tone}>
      <SheetHeader className="space-y-1.5 text-left">
        <SheetTitle>{c.title}</SheetTitle>
        <SheetDescription role={live}>{c.body}</SheetDescription>
      </SheetHeader>
      {reason === "RATE_LIMITED" && wait > 0 ? <p className="text-sm text-muted-foreground" data-testid="spray-retry-after">You can spray again in about {wait} seconds.</p> : null}
      {primary}
      {c.anotherCard && <Button variant="outline" className="min-h-[48px] rounded-full" onClick={onAnotherCard} data-testid="spray-failed-another-card">{SPRAY_COPY.anotherCard}</Button>}
      <Button variant="ghost" className="min-h-[44px]" onClick={onClose} data-testid="spray-failed-close">{c.primary ? SPRAY_COPY.cancel : SPRAY_COPY.done}</Button>
    </div>
  );
}
