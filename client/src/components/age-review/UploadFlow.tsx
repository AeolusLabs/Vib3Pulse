import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CameraIcon, CheckCircleIcon, Loader2Icon, RefreshCwIcon } from "@/components/ui/icons";
import { AgeReviewError, useAgeReview } from "@/hooks/useAgeReview";
import { COPY, DOCUMENT_TYPES, documentTypeLabel, errorMessage, formatCode, minutesLeft, type AgeReviewMe, type AgeReviewRequest } from "@/lib/ageReview";
import { ImagePrepError, prepareImage } from "@/lib/ageReviewImage";

type Step = "type" | "document" | "selfie" | "review";
type Kind = "document" | "selfie";

interface Props {
  me: AgeReviewMe;
  /** Set once the privacy notice has been accepted this session; a resumed draft already carries its own consent. */
  consentVersion: string | null;
  onClose: () => void;
  onHowHandled: () => void;
}

const BTN = "min-h-[44px] rounded-full";
const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

export default function UploadFlow({ me, consentVersion, onClose, onHowHandled }: Props) {
  const api = useAgeReview();
  // Fixed at mount: once create succeeds `me` gains a request, which must not turn a fresh flow into a resumed one.
  const [resumed] = useState(() => (me.request && me.request.method === "upload" ? me.request : null));
  const [request, setRequest] = useState<AgeReviewRequest | null>(resumed);
  const [docType, setDocType] = useState<string | null>(resumed?.documentType ?? null);
  const [step, setStep] = useState<Step>(resumed ? "document" : "type");
  const [thumbs, setThumbs] = useState<Partial<Record<Kind, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const heading = useRef<HTMLHeadingElement>(null);
  const thumbsRef = useRef(thumbs);
  thumbsRef.current = thumbs;

  useEffect(() => { heading.current?.focus(); }, [step]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(t);
  }, []);
  // Local previews never leave this tab: release them when the flow closes.
  useEffect(() => () => { Object.values(thumbsRef.current).forEach((u) => u && URL.revokeObjectURL(u)); }, []);

  const fail = (e: unknown) => {
    if (e instanceof ImagePrepError) setError(errorMessage(e.code));
    else if (e instanceof AgeReviewError) setError(errorMessage(e.code, { retryAfter: e.retryAfter }));
    else setError(errorMessage(undefined));
  };

  const start = async () => {
    if (request) { setStep("document"); return; }
    if (!docType || !consentVersion) return;
    setError(null); setBusy("create");
    try {
      const r = await api.create.mutateAsync({ method: "upload", documentType: docType, consentVersion });
      setRequest(r.request); setStep("document");
    } catch (e) { fail(e); } finally { setBusy(null); }
  };

  const put = async (kind: Kind, file: File | undefined) => {
    if (!file || !request) return;
    setError(null); setBusy(kind);
    try {
      const img = await prepareImage(file);
      try {
        await api.uploadEvidence({ id: request.id, kind, mime: img.mime, data: img.data });
      } catch (e) { URL.revokeObjectURL(img.previewUrl); throw e; }
      setThumbs((t) => { if (t[kind]) URL.revokeObjectURL(t[kind]!); return { ...t, [kind]: img.previewUrl }; });
      setRequest((r) => (r ? { ...r, [kind === "document" ? "hasDocument" : "hasSelfie"]: true } : r));
    } catch (e) { fail(e); } finally { setBusy(null); }
  };

  const newCode = async () => {
    if (!request) return;
    setError(null); setBusy("code");
    try { setRequest((await api.newCode.mutateAsync(request.id)).request); } catch (e) { fail(e); } finally { setBusy(null); }
  };

  const submit = async () => {
    if (!request) return;
    setError(null); setBusy("submit");
    try { await api.submit.mutateAsync(request.id); onClose(); } catch (e) { fail(e); } finally { setBusy(null); }
  };

  const cancelDraft = async () => {
    if (request) { try { await api.cancel.mutateAsync(request.id); } catch { /* the card shows the real state next */ } }
    onClose();
  };

  const left = minutesLeft(request?.codeExpiresAt, now);
  const hasDoc = !!request?.hasDocument;
  const hasSelfie = !!request?.hasSelfie;

  const picker = (kind: Kind, capture?: "user") => (
    <label className={`inline-flex ${BTN} cursor-pointer items-center gap-2 border border-border bg-muted px-5 text-sm font-medium transition-colors hover:border-primary/40 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary ${busy === kind ? "pointer-events-none opacity-60" : ""}`}>
      {busy === kind ? <Loader2Icon className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <CameraIcon className="h-4 w-4" aria-hidden />}
      <span>{(kind === "document" ? hasDoc : hasSelfie) ? "Take it again" : kind === "document" ? "Take or choose a photo" : "Take your selfie"}</span>
      <input
        type="file" accept="image/*" capture={capture} className="sr-only" disabled={busy !== null}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void put(kind, f); }}
        data-testid={`age-input-${kind}`}
      />
    </label>
  );

  const thumb = (kind: Kind, label: string, has: boolean) => (
    <figure className="min-w-0">
      <div className="grid aspect-[4/3] place-items-center overflow-hidden rounded-xl border border-border bg-muted/40">
        {thumbs[kind] ? <img src={thumbs[kind]} alt={label} className="h-full w-full object-cover" /> : <span className="px-2 text-center text-xs text-muted-foreground">{has ? "Already sent" : "Missing"}</span>}
      </div>
      <figcaption className="mt-1 text-xs text-muted-foreground">{label}</figcaption>
    </figure>
  );

  const titles: Record<Step, string> = {
    type: "What are you showing?",
    document: "Photo of your document",
    selfie: "Selfie with your code",
    review: "Check and send",
  };
  const order: Step[] = ["type", "document", "selfie", "review"];

  return (
    <section aria-labelledby="age-flow-title" className="space-y-4" data-testid="age-upload-flow">
      <div>
        <p className="text-[0.65rem] uppercase tracking-[0.28em] text-muted-foreground">Step {order.indexOf(step) + 1} of 4</p>
        <h3 id="age-flow-title" ref={heading} tabIndex={-1} className="mt-1 text-lg font-semibold outline-none">{titles[step]}</h3>
      </div>

      {step === "type" && (
        <div role="radiogroup" aria-label="Document type" className="grid gap-2">
          {DOCUMENT_TYPES.map((t) => (
            <button
              key={t} type="button" role="radio" aria-checked={docType === t} onClick={() => setDocType(t)}
              className={`min-h-[44px] rounded-xl border px-4 text-left text-sm font-medium transition-colors ${FOCUS} ${docType === t ? "border-primary bg-primary/10" : "border-border bg-muted/40 hover:border-primary/40"}`}
            >{documentTypeLabel(t)}</button>
          ))}
        </div>
      )}

      {step === "document" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{COPY.guidance}</p>
          {picker("document")}
          {(thumbs.document || hasDoc) && <div className="max-w-[12rem]">{thumb("document", documentTypeLabel(request?.documentType ?? docType), hasDoc)}</div>}
        </div>
      )}

      {step === "selfie" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Hold a paper with this code next to your face, then take the selfie.</p>
          <div className="rounded-2xl border border-border bg-muted/40 p-4 text-center">
            <p className="font-mono text-3xl font-semibold tracking-[0.2em]" aria-label={`Your code is ${(request?.code ?? "").split("").join(" ")}`} data-testid="age-code">{formatCode(request?.code)}</p>
            <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
              {left > 0 ? `Valid for about ${left} more minute${left === 1 ? "" : "s"}` : "This code has run out"}
            </p>
          </div>
          {left === 0 && (
            <Button variant="outline" className={BTN} onClick={() => void newCode()} disabled={busy !== null} data-testid="age-new-code">
              {busy === "code" ? <Loader2Icon className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCwIcon className="mr-2 h-4 w-4" aria-hidden />}
              Get a new code
            </Button>
          )}
          {left > 0 && picker("selfie", "user")}
          {(thumbs.selfie || hasSelfie) && <div className="max-w-[12rem]">{thumb("selfie", "Selfie", hasSelfie)}</div>}
        </div>
      )}

      {step === "review" && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">{thumb("document", documentTypeLabel(request?.documentType ?? docType), hasDoc)}{thumb("selfie", "Selfie", hasSelfie)}</div>
          <p className="text-xs text-muted-foreground">These previews stay on your device. Only the sent copies reach a reviewer.</p>
        </div>
      )}

      <p role="alert" aria-live="assertive" className={error ? "text-sm text-destructive" : "sr-only"} data-testid="age-flow-error">{error ?? ""}</p>

      <div className="flex flex-wrap items-center gap-2">
        {step !== "type" && !(step === "document" && resumed) && (
          <Button variant="ghost" className={BTN} disabled={busy !== null} onClick={() => setStep(order[order.indexOf(step) - 1])}>Back</Button>
        )}
        {step === "type" && <Button className={BTN} disabled={!docType || busy !== null} onClick={() => void start()}>{busy === "create" && <Loader2Icon className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}Continue</Button>}
        {step === "document" && <Button className={BTN} disabled={!hasDoc || busy !== null} onClick={() => setStep("selfie")}>Next</Button>}
        {step === "selfie" && <Button className={BTN} disabled={!hasSelfie || busy !== null} onClick={() => setStep("review")}>Next</Button>}
        {step === "review" && (
          <Button className={BTN} disabled={!hasDoc || !hasSelfie || busy !== null} onClick={() => void submit()} data-testid="age-submit">
            {busy === "submit" ? <Loader2Icon className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <CheckCircleIcon className="mr-2 h-4 w-4" aria-hidden />}
            Send to a reviewer
          </Button>
        )}
        {resumed && <Button variant="ghost" className={BTN} disabled={busy !== null} onClick={onClose}>Close</Button>}
        <Button variant="ghost" className={BTN} disabled={busy !== null} onClick={() => void cancelDraft()} data-testid="age-flow-cancel">{request ? "Cancel request" : "Cancel"}</Button>
      </div>
      <button type="button" onClick={onHowHandled} className={`min-h-[44px] text-sm font-medium text-primary underline underline-offset-2 ${FOCUS}`}>{COPY.howHandled}</button>
    </section>
  );
}
