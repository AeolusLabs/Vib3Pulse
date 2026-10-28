// The saved card for spraying: see it, or remove it (this wipes it on the server; the next spray goes through the bank).
// There are no spending limits.
import { useState } from "react";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Loader2Icon, Trash2Icon } from "@/components/ui/icons";
import { deleteMethod } from "@/lib/sprayApi";
import { SPRAY_COPY, cardLabel, type SprayMe } from "@/lib/sprayUi";

interface Props {
  me: SprayMe | null;
  /** Something changed on the server: reload the payer's settings. */
  onChanged(): void;
  onClose(): void;
}

export default function SpendingLimits({ me, onChanged, onClose }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [line, setLine] = useState<{ text: string; bad: boolean } | null>(null);
  const card = cardLabel(me?.method ?? null);
  const offline = "You're offline. Try again when you're back online.";

  const removeCard = async () => {
    if (busy) return;
    setBusy("card");
    setLine(null);
    const r = await deleteMethod();
    setBusy(null);
    if (r.ok) { setLine({ text: SPRAY_COPY.removedCard, bad: false }); onChanged(); }
    else setLine({ text: r.status === 0 ? offline : "Couldn't remove the card. Try again.", bad: true });
  };

  return (
    <div className="grid gap-4" data-testid="spray-spending-limits">
      <SheetHeader className="space-y-1.5 text-left">
        <SheetTitle>{SPRAY_COPY.limitsTitle}</SheetTitle>
        <SheetDescription>{me ? (card ? "The card your sprays are charged to." : "No card saved. Your bank asks you to add one the first time.") : "Loading your card."}</SheetDescription>
      </SheetHeader>
      {card && (
        <div className="flex min-h-[56px] items-center justify-between gap-2 rounded-xl border border-border px-3">
          <span className="text-sm font-medium">{card}</span>
          <Button variant="ghost" className="min-h-[44px] text-destructive" onClick={() => void removeCard()} disabled={!!busy} data-testid="spray-remove-card">
            {busy === "card" ? <Loader2Icon className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Trash2Icon className="mr-1 h-4 w-4" aria-hidden />}
            {SPRAY_COPY.removeCard}
          </Button>
        </div>
      )}
      {line && <p role={line.bad ? "alert" : "status"} className={`text-sm ${line.bad ? "text-destructive" : "text-muted-foreground"}`} data-testid="spray-limits-line">{line.text}</p>}
      <Button variant="ghost" className="min-h-[44px]" onClick={onClose} data-testid="spray-limits-close">{SPRAY_COPY.done}</Button>
    </div>
  );
}
