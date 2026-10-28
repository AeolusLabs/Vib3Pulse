// Board 7 "First spray: add a card". The card itself is entered on Paystack's page, never here: we never see the number.
// Saving it is an explicit choice (default off): only then does the server keep a reusable card for one-tap notes and
// bundles. Bag and rain always go to the bank again, saved card or not.
// "replace" is the way to "Use another card" after a decline: the saved card is forgotten first (the server wipes it),
// so the next payment goes through the bank with the new one.
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CreditCardIcon, Loader2Icon } from "@/components/ui/icons";
import NonRefundableNotice from "./NonRefundableNotice";
import { SPRAY_COPY, cardInSentence, cardLabel, type SprayCard } from "@/lib/sprayUi";

interface Props {
  mode: "add" | "replace";
  method: SprayCard | null;
  saveCard: boolean;
  onSaveCard(on: boolean): void;
  onContinue(): void;
  /** "add" mode only: skip the card and pay one time another way (bank, transfer, USSD...). */
  onPayOther?(): void;
  onCancel(): void;
  busy?: boolean;
  /** The last attempt to forget the card failed. */
  error?: string | null;
}

export default function CardSheet({ mode, method, saveCard, onSaveCard, onContinue, onPayOther, onCancel, busy = false, error = null }: Props) {
  const label = cardLabel(method);
  const card = label ? cardInSentence(label) : null; // mid-sentence: "we forget your saved Visa"
  const replacing = mode === "replace" && !!card;
  return (
    <div className="grid gap-4" data-testid="spray-card-sheet" data-mode={mode}>
      <SheetHeader className="space-y-1.5 text-left">
        <SheetTitle>{replacing ? SPRAY_COPY.anotherCard : SPRAY_COPY.addCardTitle}</SheetTitle>
        <SheetDescription>
          {replacing ? `To use another card we forget ${card}. Your bank then asks you to add and approve the new one.` : SPRAY_COPY.addCardBody}
        </SheetDescription>
      </SheetHeader>
      <NonRefundableNotice />
      <div className="flex min-h-[56px] items-center gap-3 rounded-xl border border-border bg-muted/60 px-3">
        <CreditCardIcon className="h-5 w-5 shrink-0" aria-hidden />
        <span className="text-sm font-medium">{replacing ? "A new card, added with your bank" : "Card details go to Paystack only"}</span>
      </div>
      {/* The whole 44 px row toggles the box (the box itself is 20 px), review M15. In "replace" mode the choice is kept
          by the flow and applied to the new intent (review M5). */}
      <div className="flex min-h-[44px] items-center gap-1">
        <label htmlFor="spray-save-card" className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
          <Checkbox id="spray-save-card" checked={saveCard} onCheckedChange={(v) => onSaveCard(v === true)} className="h-5 w-5" data-testid="spray-save-card" />
        </label>
        <label htmlFor="spray-save-card" className="flex min-h-[44px] flex-1 cursor-pointer items-center text-sm">{SPRAY_COPY.saveCard}</label>
      </div>
      {error && <p role="alert" className="text-sm text-destructive" data-testid="spray-card-error">{error}</p>}
      <Button className="min-h-[48px] rounded-full" onClick={onContinue} disabled={busy} data-testid="spray-card-continue">
        {busy && <Loader2Icon className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}
        {replacing ? "Forget this card and continue" : SPRAY_COPY.addCardGo}
      </Button>
      {mode === "add" && onPayOther && (
        <div className="grid gap-1 text-center">
          <Button variant="outline" className="min-h-[48px] rounded-full" onClick={onPayOther} disabled={busy} data-testid="spray-pay-other">{SPRAY_COPY.payOther}</Button>
          <p className="text-xs text-muted-foreground">{SPRAY_COPY.payOtherLine}</p>
        </div>
      )}
      <Button variant="ghost" className="min-h-[44px]" onClick={onCancel} data-testid="spray-card-cancel">{SPRAY_COPY.notNow}</Button>
    </div>
  );
}
