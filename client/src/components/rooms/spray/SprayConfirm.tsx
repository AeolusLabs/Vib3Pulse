// Board 7 "Slide to pay" (img/f-slide). A note pays with a tap; bundle, bag and rain need a deliberate slide all the way
// across. The slide fires once per open: `fired` is a ref, so a second pointer, a key repeat or a re-render cannot pay twice
// (the hook and the machine refuse a second payment as well).
//
// Accessibility (review I8, ruling 7). The slider is a real role="slider" (arrow keys a quarter at a time, End all the way,
// aria-valuetext), but touch screen readers often can't move ARIA sliders, so there is ALWAYS a plain button path next to
// it: "Pay with a button instead" shows a Pay button that needs a second, deliberate tap ("Tap again to pay ₦X") within a
// few seconds. Both paths are two deliberate steps, like the slide.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ChevronRightIcon, ExternalLinkIcon, Loader2Icon } from "@/components/ui/icons";
import { AMBER } from "@/lib/roomTickets";
import { sprayPrice } from "@shared/spray";
import type { SprayTier } from "@shared/money";
import { SPRAY_COPY, TIER_LINE, chargeLine, confirmAgainText, confirmTitle, needsSlide, priceLine, slidePayLabel, type SprayCard } from "@/lib/sprayUi";
import { TierMark } from "./SprayTray";
import NonRefundableNotice from "./NonRefundableNotice";

interface Props {
  tier: SprayTier;
  name: string;
  method: SprayCard | null;
  /** The request is out (or the server is delivering): no second pay, a calm progress line instead. */
  paying: boolean;
  /** The server has the spray and is delivering it. */
  sending: boolean;
  /** No answer yet: we keep checking with the same key. Say "don't pay again", never "failed". */
  unknown?: boolean;
  /** The bank's approval page for this spray, when we had one (so it can be opened again while we keep checking). */
  bankUrl?: string | null;
  onPay(): void;
  onCancel(): void;
  /** While paying: hide the sheet; the flow keeps going and says when it lands. */
  onHide(): void;
}

const COMPLETE = 0.92;
/** How long the button path's "Tap again" stays armed. */
const ARM_MS = 6000;

function SlideToPay({ label, onComplete, disabled, describedBy }: { label: string; onComplete(): void; disabled: boolean; describedBy?: string }) {
  const track = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(0); // 0..1
  const [dragging, setDragging] = useState(false);
  const fired = useRef(false);
  const startX = useRef(0);
  const startPos = useRef(0);

  const finish = (p: number) => {
    if (p >= COMPLETE && !fired.current && !disabled) { fired.current = true; setPos(1); onComplete(); }
    else if (!fired.current) setPos(0);
  };
  const width = () => Math.max(1, (track.current?.clientWidth ?? 1) - 56);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || fired.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    startX.current = e.clientX;
    startPos.current = pos;
    setDragging(true);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setPos(Math.min(1, Math.max(0, startPos.current + (e.clientX - startX.current) / width())));
  };
  const up = () => { if (!dragging) return; setDragging(false); finish(pos); };
  // Keyboard: arrows move it a quarter at a time, End goes all the way. Each step is deliberate, like the slide.
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || fired.current) return;
    let next = pos;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(1, pos + 0.25);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "Home") next = 0;
    else if (e.key === "End") next = 1;
    else return;
    e.preventDefault();
    setPos(next);
    if (next >= 1) finish(1);
  };

  const pct = Math.round(pos * 100);
  return (
    <div
      ref={track}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={pct >= 100 ? "Paying" : `${pct}%. Slide all the way to pay, or press the right arrow four times.`}
      aria-describedby={describedBy}
      aria-disabled={disabled || undefined}
      onKeyDown={key}
      className="relative h-14 w-full select-none overflow-hidden rounded-full bg-muted outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      style={{ touchAction: "none" }}
      data-testid="spray-slide"
    >
      <div className={`absolute inset-y-0 left-0 rounded-full ${AMBER.fill} ${dragging ? "" : "motion-safe:transition-[width] motion-safe:duration-200"}`} style={{ width: `calc(56px + (100% - 56px) * ${pos})` }} aria-hidden />
      <span className="pointer-events-none absolute inset-0 grid place-items-center text-base font-semibold text-foreground" aria-hidden>{label}</span>
      <div
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        className={`absolute top-1 grid h-12 w-12 cursor-grab place-items-center rounded-full bg-background shadow ${dragging ? "" : "motion-safe:transition-[left] motion-safe:duration-200"}`}
        style={{ left: `calc(4px + (100% - 56px) * ${pos})` }}
        aria-hidden
        data-testid="spray-slide-knob"
      >
        <ChevronRightIcon size={20} aria-hidden />
      </div>
    </div>
  );
}

/**
 * The plain button path: tap "Pay ₦X", then tap again within ARM_MS to confirm. The same button keeps focus between the two
 * taps, and the second step is announced. It fires once (a ref), like the slider.
 */
function TwoTapPay({ tier, onComplete, disabled }: { tier: SprayTier; onComplete(): void; disabled: boolean }) {
  const [armed, setArmed] = useState(false);
  const fired = useRef(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), ARM_MS);
    return () => clearTimeout(t);
  }, [armed]);
  const tap = () => {
    if (disabled || fired.current) return;
    if (!armed) { setArmed(true); return; }
    fired.current = true;
    onComplete();
  };
  const price = sprayPrice(tier).display;
  return (
    <div className="grid gap-1.5">
      <Button className={`h-14 w-full rounded-full text-base font-semibold ${AMBER.button}`} onClick={tap} disabled={disabled}
        aria-describedby="spray-two-tap-note" data-testid="spray-two-tap" data-armed={armed ? "1" : "0"}>
        {armed ? confirmAgainText(tier) : `Pay ${price}`}
      </Button>
      <p id="spray-two-tap-note" role="status" aria-live="polite" className="text-center text-xs text-muted-foreground">
        {armed ? `${SPRAY_COPY.confirmAgain}. This pays ${price}.` : ""}
      </p>
    </div>
  );
}

export default function SprayConfirm({ tier, name, method, paying, sending, unknown = false, bankUrl = null, onPay, onCancel, onHide }: Props) {
  const price = sprayPrice(tier);
  const tapped = useRef(false);
  useEffect(() => { if (!paying) tapped.current = false; }, [paying]);
  const tap = () => { if (tapped.current || paying) return; tapped.current = true; onPay(); };
  const [useButton, setUseButton] = useState(false);

  return (
    <div className="grid gap-4" data-testid="spray-confirm" data-tier={tier}>
      <SheetHeader className="items-center space-y-1.5 text-center">
        <TierMark tier={tier} className="h-16 w-24" />
        <SheetTitle>{confirmTitle(tier, name)}</SheetTitle>
        <SheetDescription>{priceLine(tier)}. {TIER_LINE[tier].charAt(0).toUpperCase() + TIER_LINE[tier].slice(1)}.</SheetDescription>
      </SheetHeader>
      <NonRefundableNotice />

      {paying ? (
        <div className="grid gap-2">
          <p role="status" aria-live="polite" className="flex min-h-[56px] items-center justify-center gap-2 rounded-2xl bg-muted px-3 text-center text-sm font-medium" data-testid={unknown ? "spray-checking" : "spray-paying"}>
            <Loader2Icon className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
            {unknown ? SPRAY_COPY.checking : sending ? SPRAY_COPY.sending : SPRAY_COPY.paying}
          </p>
          {bankUrl && (
            <Button asChild variant="outline" className="min-h-[48px] rounded-full">
              <a href={bankUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" data-testid="spray-bank-again">
                {SPRAY_COPY.bankAgain} <ExternalLinkIcon className="ml-2 h-4 w-4" aria-hidden />
              </a>
            </Button>
          )}
        </div>
      ) : !needsSlide(tier) ? (
        <Button className={`h-14 w-full rounded-full text-base font-semibold ${AMBER.button}`} onClick={tap} disabled={paying} data-testid="spray-pay">Pay {price.display}</Button>
      ) : useButton ? (
        <TwoTapPay key={`two-${tier}`} tier={tier} onComplete={tap} disabled={paying} />
      ) : (
        <SlideToPay key={`slide-${tier}`} label={slidePayLabel(tier)} onComplete={tap} disabled={paying} describedBy="spray-slide-alt" />
      )}

      {!paying && needsSlide(tier) && (
        <Button id="spray-slide-alt" variant="ghost" className="min-h-[44px]" onClick={() => setUseButton((u) => !u)} data-testid="spray-slide-alt">
          {useButton ? SPRAY_COPY.slideAltBack : SPRAY_COPY.slideAlt}
        </Button>
      )}

      <p className="text-center text-xs text-muted-foreground" data-testid="spray-charge-line">{chargeLine(tier, method)}</p>
      {paying
        ? <Button variant="ghost" className="min-h-[44px]" onClick={onHide} data-testid="spray-hide">{SPRAY_COPY.bankDismiss}</Button>
        : <Button variant="ghost" className="min-h-[44px]" onClick={onCancel} data-testid="spray-not-now">{SPRAY_COPY.notNow}</Button>}
    </div>
  );
}
