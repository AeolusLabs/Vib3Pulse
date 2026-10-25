// Board 7 "Room limit". You choose the most you spend in this room; a spray above it asks first. The options and the ID
// rule mirror shared/spray.ts for the UI only: the server takes `{ kobo }`, checks it against the same list and the
// payer's verification, and answers the limit it kept.
import { useState } from "react";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Loader2Icon } from "@/components/ui/icons";
import VerifyAgeLink from "@/components/age-review/VerifyAgeLink";
import type { SprayTier } from "@shared/money";
import { sprayPrice } from "@shared/spray";
import { formatNaira } from "@/lib/roomTickets";
import { putRoomLimit } from "@/lib/sprayApi";
import { SPRAY_COPY, limitAsk, limitChipText, limitChoices, limitErrorText, parseLimitBody, type SprayBlock } from "@/lib/sprayUi";

interface Props {
  roomId: string;
  token?: string;
  block: SprayBlock;
  /** The spray that asked (over the limit), or null when opened from the chip. */
  tier: SprayTier | null;
  verified: boolean;
  /** Saved: the server's own numbers. With a tier, the flow goes on to that spray. */
  onSaved(limit: { limitKobo: number; spentKobo: number }): void;
  onClose(): void;
}

export default function RoomLimitSheet({ roomId, token, block, tier, verified, onSaved, onClose }: Props) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const price = tier ? sprayPrice(tier).kobo : 0;
  const choices = limitChoices(block, price, verified);

  const pick = async (kobo: number) => {
    if (busy !== null) return;
    setBusy(kobo);
    setError(null);
    const r = await putRoomLimit(roomId, kobo, token);
    setBusy(null);
    const saved = r.ok ? parseLimitBody(r.body) : null;
    if (saved) { onSaved(saved); return; }
    setError(limitErrorText(r.ok ? undefined : r.status, r.ok ? undefined : r.code, "Couldn't change the limit. Try again."));
  };

  return (
    <div className="grid gap-4" data-testid="spray-room-limit">
      <SheetHeader className="space-y-1.5 text-left">
        <SheetTitle>{SPRAY_COPY.limitTitle}</SheetTitle>
        <SheetDescription>{tier ? limitAsk(tier, block) : limitChipText(block)}</SheetDescription>
      </SheetHeader>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Room limit">
        {choices.map((c) => {
          const current = c.kobo === block.roomLimitKobo;
          return (
            <button key={c.kobo} type="button" disabled={!c.ok || busy !== null} onClick={() => void pick(c.kobo)}
              aria-pressed={current} aria-label={`${formatNaira(c.kobo)}${c.why ? `. ${c.why}` : ""}`}
              className={`inline-flex min-h-[44px] items-center gap-1 rounded-full border px-4 text-sm font-medium disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${current ? "border-primary bg-primary text-primary-foreground" : "border-border bg-muted"}`}
              data-testid={`spray-limit-${c.kobo}`}>
              {busy === c.kobo && <Loader2Icon className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />}
              {formatNaira(c.kobo)}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">{SPRAY_COPY.limitNote}</p>
      <VerifyAgeLink />
      {error && <p role="alert" className="text-sm text-destructive" data-testid="spray-limit-error">{error}</p>}
      <Button variant="ghost" className="min-h-[44px]" onClick={onClose} data-testid="spray-limit-close">{SPRAY_COPY.done}</Button>
    </div>
  );
}
