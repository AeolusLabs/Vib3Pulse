// Board 7 "Spending limits": the most you can spend in a day (a rolling 24 hours, counted by the server) and the saved
// card. Raising the daily limit above the default needs a verified account; the server checks that again. Removing the
// card wipes it on the server; the next spray goes through the bank.
// Not built (no server API yet): "remind me every ₦5,000", the 24 hour pause and hiding top sprayer boards from the board.
import { useState } from "react";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Loader2Icon, Trash2Icon } from "@/components/ui/icons";
import { formatNaira } from "@/lib/roomTickets";
import { deleteMethod, putDailyLimit } from "@/lib/sprayApi";
import { SPRAY_COPY, cardLabel, dailyChoices, type SprayMe } from "@/lib/sprayUi";

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

  const setDaily = async (kobo: number) => {
    if (busy) return;
    setBusy(`d${kobo}`);
    setLine(null);
    const r = await putDailyLimit(kobo);
    setBusy(null);
    if (r.ok) { setLine({ text: `Daily limit set to ${formatNaira(kobo)}.`, bad: false }); onChanged(); }
    else setLine({ text: r.status === 0 ? offline : "Couldn't change the daily limit. Try again.", bad: true });
  };
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
        <SheetDescription>{me ? `Spent in the last 24 hours: ${formatNaira(me.dailySpentKobo)} of ${formatNaira(me.dailyLimitKobo)}.` : "Loading your limits."}</SheetDescription>
      </SheetHeader>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{SPRAY_COPY.dailyLabel}</legend>
        <div className="flex flex-wrap gap-2">
          {dailyChoices(me?.verified === true).map((c) => {
            const current = me?.dailyLimitKobo === c.kobo;
            return (
              <button key={c.kobo} type="button" disabled={!me || !c.ok || !!busy} onClick={() => void setDaily(c.kobo)} aria-pressed={current}
                aria-label={`${formatNaira(c.kobo)} a day${c.why ? `. ${c.why}` : ""}`}
                className={`inline-flex min-h-[44px] items-center gap-1 rounded-full border px-4 text-sm font-medium disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${current ? "border-primary bg-primary text-primary-foreground" : "border-border bg-muted"}`}
                data-testid={`spray-daily-${c.kobo}`}>
                {busy === `d${c.kobo}` && <Loader2Icon className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />}
                {formatNaira(c.kobo)}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">{SPRAY_COPY.dailyNote}</p>
      </fieldset>
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
