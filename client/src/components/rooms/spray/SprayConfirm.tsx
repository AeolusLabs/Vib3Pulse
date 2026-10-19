// Board 7 "Slide to pay" (img/f-slide). A note pays with a tap; bundle, bag and rain need a deliberate slide all the way
// across. The slide fires once per open: `fired` is a ref, so a second pointer, a key repeat or a re-render cannot pay twice
// (the hook and the machine refuse a second payment as well).
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Loader2Icon } from "@/components/ui/icons";
import { AMBER } from "@/lib/roomTickets";
import { sprayPrice } from "@shared/spray";
import type { SprayTier } from "@shared/money";
import { SPRAY_COPY, TIER_LINE, chargeLine, confirmTitle, needsSlide, priceLine } from "@/lib/sprayUi";
import { TierMark } from "./SprayTray";

interface Props {
  tier: SprayTier;
  name: string;
  method: { last4: string; brand: string } | null;
  /** The request is out (or the server is delivering): no second pay, a calm progress line instead. */
  paying: boolean;
  /** The server has the spray and is delivering it. */
  sending: boolean;
  onPay(): void;
  onCancel(): void;
  /** While paying: hide the sheet; the flow keeps going and says when it lands. */
  onHide(): void;
}

const COMPLETE = 0.92;

function SlideToPay({ label, onComplete, disabled }: { label: string; onComplete(): void; disabled: boolean }) {
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
      aria-valuetext={pct >= 100 ? "Paying" : `${pct}%. Slide all the way to pay.`}
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
        <span className="text-lg leading-none">›</span>
      </div>
    </div>
  );
}

export default function SprayConfirm({ tier, name, method, paying, sending, onPay, onCancel, onHide }: Props) {
  const price = sprayPrice(tier);
  const tapped = useRef(false);
  useEffect(() => { if (!paying) tapped.current = false; }, [paying]);
  const tap = () => { if (tapped.current || paying) return; tapped.current = true; onPay(); };

  return (
    <div className="grid gap-4" data-testid="spray-confirm" data-tier={tier}>
      <SheetHeader className="items-center space-y-1.5 text-center">
        <TierMark tier={tier} className="h-16 w-24" />
        <SheetTitle>{confirmTitle(tier, name)}</SheetTitle>
        <SheetDescription>{priceLine(tier)}. {TIER_LINE[tier].charAt(0).toUpperCase() + TIER_LINE[tier].slice(1)}.</SheetDescription>
      </SheetHeader>

      {paying ? (
        <p role="status" aria-live="polite" className="flex min-h-[56px] items-center justify-center gap-2 rounded-full bg-muted text-sm font-medium" data-testid="spray-paying">
          <Loader2Icon className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> {sending ? SPRAY_COPY.sending : SPRAY_COPY.paying}
        </p>
      ) : needsSlide(tier) ? (
        <SlideToPay key={`${tier}`} label={`Slide to pay ${price.display}`} onComplete={tap} disabled={paying} />
      ) : (
        <Button className={`h-14 w-full rounded-full text-base font-semibold ${AMBER.button}`} onClick={tap} disabled={paying} data-testid="spray-pay">Pay {price.display}</Button>
      )}

      <p className="text-center text-xs text-muted-foreground" data-testid="spray-charge-line">{chargeLine(tier, method)}</p>
      {paying
        ? <Button variant="ghost" className="min-h-[44px]" onClick={onHide} data-testid="spray-hide">{SPRAY_COPY.bankDismiss}</Button>
        : <Button variant="ghost" className="min-h-[44px]" onClick={onCancel} data-testid="spray-not-now">{SPRAY_COPY.notNow}</Button>}
    </div>
  );
}
