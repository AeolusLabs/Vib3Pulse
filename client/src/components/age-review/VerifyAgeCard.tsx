import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CameraIcon, CheckCircleIcon, ClockIcon, Loader2Icon, ShieldCheckIcon, UploadIcon } from "@/components/ui/icons";
import { useToast } from "@/hooks/use-toast";
import { AgeReviewError, useAgeReview } from "@/hooks/useAgeReview";
import { COPY, cancelOffered, cardMode, cardView, errorMessage, payoutsAction, payoutsPreselected, startLiveRequest, type AgeReviewMethod, type CardTone } from "@/lib/ageReview";
import PrivacyNotice from "./PrivacyNotice";
import UploadFlow from "./UploadFlow";
import LiveCheckFlow from "./LiveCheckFlow";

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const TONE_BORDER: Record<CardTone, string> = {
  neutral: "border-border",
  pending: "border-primary/30",
  success: "border-primary/40",
  warning: "border-border",
};

/** Account settings card. Renders nothing while the AGE_REVIEW flag is off (the server answers 404). */
export default function VerifyAgeCard() {
  const { me, create, submit, cancel } = useAgeReview();
  const [starting, setStarting] = useState(false);
  const { toast } = useToast();
  const [flow, setFlow] = useState<"upload" | null>(null);
  const [notice, setNotice] = useState<{ mode: "consent" | "readonly"; method: AgeReviewMethod } | null>(null);
  const [accepted, setAccepted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "Receive money" is a choice the person makes: the box starts off, unless the link they came from asked for payouts.
  const [wants, setWants] = useState(() => (typeof window !== "undefined" ? payoutsPreselected(window.location.search) : false));
  const [payoutChoices, setPayoutChoices] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  // The page renders this card after its own data loads, so the browser's hash jump has already missed it.
  const present = !!me;
  useEffect(() => {
    if (present && window.location.hash === "#verify-age") anchor.current?.scrollIntoView({ block: "start" });
  }, [present]);
  // /account/settings?payouts=1 opens the payouts action for a verified user who has no name on file yet.
  const asksPayouts = present && typeof window !== "undefined" && payoutsPreselected(window.location.search);
  useEffect(() => { if (asksPayouts) setPayoutChoices(true); }, [asksPayouts]);

  if (!me) return null;
  const view = cardView(me);
  const req = me.request;
  const mode = cardMode(me);
  const pAction = payoutsAction(me);
  const showChoices = mode === "choose" || (mode === "none" && payoutChoices && pAction !== null);
  // In the payouts-only flow the intent is fixed; otherwise it is the checkbox.
  const wantsPayouts = mode === "none" ? true : wants;
  const busy = starting || create.isPending || submit.isPending || cancel.isPending;

  const fail = (e: unknown) => setError(e instanceof AgeReviewError ? errorMessage(e.code, { retryAfter: e.retryAfter }) : errorMessage(undefined));

  const choose = (method: AgeReviewMethod, el: HTMLElement) => {
    opener.current = el;
    setError(null);
    setNotice({ mode: "consent", method });
  };
  const closeNotice = () => {
    setNotice(null);
    // Radix returns focus to the trigger it knows about; the card button is re-rendered often, so we do it ourselves.
    window.setTimeout(() => opener.current?.focus(), 0);
  };
  const onContinue = async () => {
    if (!notice) return;
    if (notice.method === "upload") { setAccepted(me.consentVersion); setFlow("upload"); setNotice(null); return; }
    setStarting(true);
    try {
      await startLiveRequest({ create: (v) => create.mutateAsync(v), submit: (id) => submit.mutateAsync(id) }, me.consentVersion, wantsPayouts);
      setNotice(null);
      window.setTimeout(() => anchor.current?.focus(), 0); // the choice buttons are gone; keep focus inside the card
    } catch (e) { setNotice(null); fail(e); } finally { setStarting(false); }
  };
  const doCancel = async () => {
    if (!req) return;
    try { await cancel.mutateAsync(req.id); toast({ title: "Request cancelled", description: "Any photos you sent have been deleted." }); }
    catch (e) { fail(e); }
  };

  const Icon = view.tone === "success" ? CheckCircleIcon : view.tone === "pending" ? ClockIcon : ShieldCheckIcon;

  return (
    <div id="verify-age" ref={anchor} tabIndex={-1} className="scroll-mt-20 outline-none" data-testid="verify-age-card">
      <Card className={TONE_BORDER[view.tone]}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Icon className="h-5 w-5" aria-hidden />{view.title}</CardTitle>
          <CardDescription aria-live="polite">{view.body}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {flow === "upload" && (
            <UploadFlow
              me={me} consentVersion={accepted} wantsPayouts={wantsPayouts}
              onClose={() => { setFlow(null); setAccepted(null); }}
              onHowHandled={() => setNotice({ mode: "readonly", method: "upload" })}
            />
          )}

          {flow === null && mode === "live" && req && (
            <LiveCheckFlow request={req} onHowHandled={() => setNotice({ mode: "readonly", method: "live" })} />
          )}

          {flow === null && showChoices && (
            <div className="grid gap-2">
              {mode === "choose" && (
                <div className="rounded-2xl border border-border p-3">
                  <label className="flex min-h-[44px] cursor-pointer items-center gap-3 text-sm font-medium">
                    <input
                      type="checkbox" checked={wants} onChange={(e) => setWants(e.target.checked)} aria-describedby="wants-payouts-help"
                      className={`h-5 w-5 shrink-0 rounded accent-primary ${FOCUS}`} data-testid="age-wants-payouts"
                    />
                    {COPY.wantsPayoutsLabel}
                  </label>
                  <p id="wants-payouts-help" className="pl-8 text-xs text-muted-foreground">{COPY.wantsPayoutsHelp}</p>
                </div>
              )}
              {mode === "none" && <p className="text-sm font-medium" aria-live="polite">{COPY.verifyNameAction}</p>}
              <button
                type="button" disabled={busy} onClick={(e) => choose("upload", e.currentTarget)}
                className={`flex min-h-[56px] items-center gap-3 rounded-2xl border border-border bg-muted/40 px-4 text-left transition-colors hover:border-primary/40 disabled:opacity-50 ${FOCUS}`}
                data-testid="age-choose-upload"
              >
                <UploadIcon className="h-5 w-5 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0"><span className="block text-sm font-medium">{COPY.choiceUpload}</span><span className="block text-xs text-muted-foreground">{COPY.choiceUploadHint}</span></span>
              </button>
              <button
                type="button" disabled={busy} onClick={(e) => choose("live", e.currentTarget)}
                className={`flex min-h-[56px] items-center gap-3 rounded-2xl border border-border bg-muted/40 px-4 text-left transition-colors hover:border-primary/40 disabled:opacity-50 ${FOCUS}`}
                data-testid="age-choose-live"
              >
                {starting ? <Loader2Icon className="h-5 w-5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden /> : <CameraIcon className="h-5 w-5 shrink-0 text-primary" aria-hidden />}
                <span className="min-w-0"><span className="block text-sm font-medium">{COPY.choiceLive}</span><span className="block text-xs text-muted-foreground">{COPY.choiceLiveHint}</span></span>
              </button>
            </div>
          )}

          {flow === null && mode === "none" && pAction === "verify_name" && !payoutChoices && (
            <div className="space-y-1">
              <Button variant="outline" className="min-h-[44px] rounded-full" onClick={() => setPayoutChoices(true)} data-testid="age-verify-name">{COPY.verifyNameAction}</Button>
              <p className="text-xs text-muted-foreground">{COPY.verifyNameHelp}</p>
            </div>
          )}

          {flow === null && mode === "none" && pAction === "recheck" && !payoutChoices && (
            <button type="button" onClick={() => setPayoutChoices(true)} className={`min-h-[44px] self-start text-xs text-muted-foreground underline underline-offset-2 ${FOCUS}`} data-testid="age-recheck-payouts">{COPY.recheckLink}</button>
          )}

          {flow === null && mode === "resume_upload" && (
            <Button className="min-h-[44px] rounded-full" onClick={() => { setError(null); setFlow("upload"); }} data-testid="age-continue">
              {me.state === "needs_more" ? "Add a photo" : "Continue your upload"}
            </Button>
          )}

          {flow === null && req && cancelOffered(me) && (
            <Button variant="ghost" className="min-h-[44px] rounded-full" disabled={busy} onClick={() => void doCancel()} data-testid="age-cancel">{COPY.cancel}</Button>
          )}

          <p role="alert" className={error ? "text-sm text-destructive" : "sr-only"}>{error ?? ""}</p>

          <div className="flex flex-col gap-0.5 border-t border-border pt-3">
            <p className="text-xs text-muted-foreground">{COPY.scopeNote}</p>
            <button
              type="button" onClick={(e) => { opener.current = e.currentTarget; setNotice({ mode: "readonly", method: req?.method ?? "upload" }); }}
              className={`min-h-[44px] self-start text-sm font-medium text-primary underline underline-offset-2 ${FOCUS}`}
            >{COPY.howHandled}</button>
          </div>
        </CardContent>
      </Card>

      <PrivacyNotice
        open={notice !== null} mode={notice?.mode ?? "readonly"} method={notice?.method ?? "upload"}
        wantsPayouts={notice?.mode === "consent" ? wantsPayouts : req?.wantsPayouts === true}
        busy={create.isPending} onContinue={() => void onContinue()} onClose={closeNotice}
      />
    </div>
  );
}
