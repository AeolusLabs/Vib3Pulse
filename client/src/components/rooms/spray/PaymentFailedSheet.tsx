// Board 7 "Payment declined" (img/f-decline), and every other way a spray can end without landing. Plain words: was money
// taken, was anything sent, what to do next. The words come from SPRAY_FAIL_COPY (lib/sprayUi.ts), keyed by the reason.
import { useEffect, useRef } from "react";
import { Link } from "wouter";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { SPRAY_COPY, SPRAY_FAIL_COPY, type SprayFailReason } from "@/lib/sprayUi";

interface Props {
  reason: SprayFailReason;
  retryAfterSec?: number;
  onRetry(): void;
  onAnotherCard(): void;
  onLimit(): void;
  onLimits(): void;
  onClose(): void;
}

export default function PaymentFailedSheet({ reason, retryAfterSec, onRetry, onAnotherCard, onLimit, onLimits, onClose }: Props) {
  const c = SPRAY_FAIL_COPY[reason];
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { requestAnimationFrame(() => first.current?.focus()); }, [reason]);
  const back = `${window.location.pathname}${window.location.search}`;
  const primary = (() => {
    switch (c.primary) {
      case "retry": return <Button ref={first} className="min-h-[48px] rounded-full" onClick={onRetry} data-testid="spray-failed-retry">{SPRAY_COPY.tryAgain}</Button>;
      case "check": return <Button ref={first} className="min-h-[48px] rounded-full" onClick={onRetry} data-testid="spray-failed-check">{SPRAY_COPY.checkAgain}</Button>;
      case "limit": return <Button ref={first} className="min-h-[48px] rounded-full" onClick={onLimit} data-testid="spray-failed-limit">{SPRAY_COPY.changeLimit}</Button>;
      case "limits": return <Button ref={first} className="min-h-[48px] rounded-full" onClick={onLimits} data-testid="spray-failed-limits">{SPRAY_COPY.openLimits}</Button>;
      case "signin": return <Button asChild className="min-h-[48px] rounded-full" data-testid="spray-failed-signin"><Link href={`/login?redirect=${encodeURIComponent(back)}`}>{SPRAY_COPY.signIn}</Link></Button>;
      default: return null;
    }
  })();
  return (
    <div className="grid gap-3" data-testid="spray-failed" data-reason={reason}>
      <SheetHeader className="space-y-1.5 text-left">
        <SheetTitle>{c.title}</SheetTitle>
        <SheetDescription role="alert">{c.body}</SheetDescription>
      </SheetHeader>
      {reason === "RATE_LIMITED" && retryAfterSec ? <p className="text-sm text-muted-foreground" data-testid="spray-retry-after">You can spray again in about {retryAfterSec} seconds.</p> : null}
      {primary}
      {c.anotherCard && <Button variant="outline" className="min-h-[48px] rounded-full" onClick={onAnotherCard} data-testid="spray-failed-another-card">{SPRAY_COPY.anotherCard}</Button>}
      <Button variant="ghost" className="min-h-[44px]" onClick={onClose} data-testid="spray-failed-close">{c.primary ? SPRAY_COPY.cancel : SPRAY_COPY.done}</Button>
    </div>
  );
}
