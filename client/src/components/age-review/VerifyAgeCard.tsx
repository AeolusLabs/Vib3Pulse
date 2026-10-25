import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CameraIcon, CheckCircleIcon, ClockIcon, Loader2Icon, ShieldCheckIcon, UploadIcon } from "@/components/ui/icons";
import { useToast } from "@/hooks/use-toast";
import { AgeReviewError, useAgeReview } from "@/hooks/useAgeReview";
import { COPY, cardView, errorMessage, type AgeReviewMethod, type CardTone } from "@/lib/ageReview";
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
  const { me, create, cancel } = useAgeReview();
  const { toast } = useToast();
  const [flow, setFlow] = useState<"upload" | null>(null);
  const [notice, setNotice] = useState<{ mode: "consent" | "readonly"; method: AgeReviewMethod } | null>(null);
  const [accepted, setAccepted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  // The page renders this card after its own data loads, so the browser's hash jump has already missed it.
  const present = !!me;
  useEffect(() => {
    if (present && window.location.hash === "#verify-age") anchor.current?.scrollIntoView({ block: "start" });
  }, [present]);

  if (!me) return null;
  const view = cardView(me);
  const req = me.request;
  const draftUpload = req?.method === "upload" && (req.status === "draft" || req.needsMore);
  const canPick = view.action?.id === "start" && !draftUpload;
  const busy = create.isPending || cancel.isPending;

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
    try {
      await create.mutateAsync({ method: "live", consentVersion: me.consentVersion });
      setNotice(null);
    } catch (e) { setNotice(null); fail(e); }
  };
  const doCancel = async () => {
    if (!req) return;
    try { await cancel.mutateAsync(req.id); toast({ title: "Request cancelled", description: "Any photos you sent have been deleted." }); }
    catch (e) { fail(e); }
  };

  const Icon = view.tone === "success" ? CheckCircleIcon : view.tone === "pending" ? ClockIcon : ShieldCheckIcon;

  return (
    <div id="verify-age" ref={anchor} className="scroll-mt-20" data-testid="verify-age-card">
      <Card className={TONE_BORDER[view.tone]}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Icon className="h-5 w-5" aria-hidden />{view.title}</CardTitle>
          <CardDescription aria-live="polite">{view.body}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {flow === "upload" && (
            <UploadFlow
              me={me} consentVersion={accepted}
              onClose={() => { setFlow(null); setAccepted(null); }}
              onHowHandled={() => setNotice({ mode: "readonly", method: "upload" })}
            />
          )}

          {flow === null && req?.method === "live" && me.state === "in_review" && (
            <LiveCheckFlow request={req} onHowHandled={() => setNotice({ mode: "readonly", method: "live" })} />
          )}

          {flow === null && canPick && (
            <div className="grid gap-2">
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
                {busy && create.variables?.method === "live" ? <Loader2Icon className="h-5 w-5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden /> : <CameraIcon className="h-5 w-5 shrink-0 text-primary" aria-hidden />}
                <span className="min-w-0"><span className="block text-sm font-medium">{COPY.choiceLive}</span><span className="block text-xs text-muted-foreground">{COPY.choiceLiveHint}</span></span>
              </button>
            </div>
          )}

          {flow === null && (view.action?.id === "continue" || (draftUpload && req?.status === "draft")) && (
            <Button className="min-h-[44px] rounded-full" onClick={() => { setError(null); setFlow("upload"); }} data-testid="age-continue">
              {view.action?.id === "continue" ? view.action.label : "Continue your upload"}
            </Button>
          )}

          {flow === null && me.state === "in_review" && req?.canCancel && (
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
        busy={create.isPending} onContinue={() => void onContinue()} onClose={closeNotice}
      />
    </div>
  );
}
