import { useEffect, useId, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useIsMobile } from "@/hooks/use-mobile";
import { PRIVACY, continueEnabled, keepFor, whatHappens, whoSees, type AgeReviewMethod } from "@/lib/ageReview";

interface Props {
  open: boolean;
  /** "consent" asks for the tick; "readonly" is the reopenable "How your ID is handled" view. */
  mode: "consent" | "readonly";
  method: AgeReviewMethod;
  /** The payouts variant of "What we keep". */
  wantsPayouts?: boolean;
  busy?: boolean;
  onContinue?: () => void;
  onClose: () => void;
}

const LINK = "inline-flex min-h-[44px] items-center font-medium text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

function Body({ mode, method, wantsPayouts = false, busy, onContinue, onClose }: Omit<Props, "open">) {
  const [ticked, setTicked] = useState(false);
  const tickId = useId();
  const consent = mode === "consent";
  const sections = [PRIVACY.why, { h: PRIVACY.who.h, p: whoSees(method) }, { h: PRIVACY.whatHeading, p: whatHappens(method) }, { h: PRIVACY.keep.h, p: keepFor(wantsPayouts) }, PRIVACY.choices, PRIVACY.safety];
  return (
    <>
      <dl className="space-y-4 text-sm leading-relaxed">
        {sections.map((s) => (
          <div key={s.h}>
            <dt className="mb-1 text-[0.65rem] font-medium uppercase tracking-[0.28em] text-muted-foreground">{s.h}</dt>
            <dd className="text-foreground/90">{s.p}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-col gap-0.5">
        <a href={PRIVACY.policyHref} target="_blank" rel="noopener noreferrer" className={LINK}>{PRIVACY.policy}</a>
        <a href={PRIVACY.askHref} className={LINK}>{PRIVACY.ask}</a>
      </div>
      {consent ? (
        <>
          <label htmlFor={tickId} className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-xl border border-border bg-muted/40 px-3 text-sm">
            <Checkbox id={tickId} checked={ticked} onCheckedChange={(v) => setTicked(v === true)} className="h-6 w-6 rounded-md" />
            <span>{PRIVACY.tick}</span>
          </label>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" className="min-h-[44px] rounded-full" onClick={onClose}>{PRIVACY.notNow}</Button>
            <Button className="min-h-[44px] rounded-full" disabled={!continueEnabled(ticked, busy)} onClick={onContinue}>{PRIVACY.cont}</Button>
          </div>
        </>
      ) : (
        <Button variant="outline" className="min-h-[44px] rounded-full" onClick={onClose}>{PRIVACY.close}</Button>
      )}
    </>
  );
}

/** Opens before anything is captured. While consent is pending only "Not now" (or the close button) leaves it; outside taps and Escape do not. */
export default function PrivacyNotice(props: Props) {
  const mobile = useIsMobile();
  const { open, mode, onClose } = props;
  const pending = mode === "consent";
  // A fresh tick every time the notice opens, so consent is never carried over silently.
  const [epoch, setEpoch] = useState(0);
  useEffect(() => { if (open) setEpoch((n) => n + 1); }, [open]);

  const guard = pending ? { onInteractOutside: (e: Event) => e.preventDefault(), onEscapeKeyDown: (e: Event) => e.preventDefault() } : {};
  const change = (o: boolean) => { if (!o) onClose(); };
  const body = <Body key={epoch} {...props} />;

  if (mobile) {
    return (
      <Sheet open={open} onOpenChange={change}>
        <SheetContent side="bottom" {...guard} className="max-h-[90dvh] space-y-4 overflow-y-auto rounded-t-3xl pb-[max(1.5rem,env(safe-area-inset-bottom))]" data-testid="age-privacy-notice">
          <SheetTitle>{PRIVACY.title}</SheetTitle>
          <SheetDescription className="sr-only">How your ID and photos are used</SheetDescription>
          {body}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent {...guard} className="space-y-0 rounded-3xl" data-testid="age-privacy-notice">
        <DialogTitle>{PRIVACY.title}</DialogTitle>
        <DialogDescription className="sr-only">How your ID and photos are used</DialogDescription>
        {body}
      </DialogContent>
    </Dialog>
  );
}
