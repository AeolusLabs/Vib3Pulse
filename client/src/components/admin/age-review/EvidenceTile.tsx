import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EyeIcon, Loader2Icon, XIcon } from "@/components/ui/icons";
import { ReviewApiError, errText, revealEvidence } from "@/lib/adminAgeReviewApi";
import { REBLUR_MS, startReblur, watermarkText } from "@/lib/adminAgeReviewUi";

interface Props {
  requestId: string;
  evidence: { id: string; kind: "document" | "selfie"; bytes: number };
  reviewer: string;
  /** Only one tile shows an image at a time. */
  revealedId: string | null;
  onReveal: (id: string | null) => void;
  /** The server says the evidence is gone (cancelled or expired): refresh the detail. */
  onGone: () => void;
}

const KIND = { document: "Document photo", selfie: "Selfie with code" } as const;

/** Blurred placeholder with no image data until Reveal. The image lives only in component state as a blob URL, and is dropped after 30 seconds. */
export default function EvidenceTile({ requestId, evidence, reviewer, revealedId, onReveal, onGone }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [stamp, setStamp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<{ cancel: () => void } | null>(null);
  const urlRef = useRef<string | null>(null);
  const gone = useRef(false);

  const drop = useCallback(() => {
    timer.current?.cancel(); timer.current = null;
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    setSrc(null);
  }, []);

  useEffect(() => { gone.current = false; return () => { gone.current = true; drop(); }; }, [drop]);
  useEffect(() => { if (revealedId !== evidence.id && urlRef.current) drop(); }, [revealedId, evidence.id, drop]);

  const reveal = async () => {
    setBusy(true); setError(null);
    try {
      const url = await revealEvidence(requestId, evidence.id, () => gone.current);
      if (url === null || gone.current) { if (url) URL.revokeObjectURL(url); return; }
      drop();
      urlRef.current = url;
      setStamp(watermarkText(reviewer, requestId));
      setSrc(url);
      onReveal(evidence.id);
      timer.current = startReblur(() => { drop(); onReveal(null); }, REBLUR_MS);
    } catch (e) {
      if (gone.current) return;
      setError(errText(e));
      if (e instanceof ReviewApiError && (e.code === "WRONG_STATE" || e.code === "NOT_FOUND")) { setError("The user cancelled or it expired."); onGone(); }
    } finally { if (!gone.current) setBusy(false); }
  };

  return (
    <figure className="min-w-0" data-testid={`evidence-${evidence.kind}`}>
      <div className="relative grid aspect-[4/3] place-items-center overflow-hidden rounded-xl border border-slate-700 bg-slate-900">
        {src ? (
          <>
            <img src={src} alt={`${KIND[evidence.kind]} (revealed)`} className="h-full w-full object-contain" draggable={false} referrerPolicy="no-referrer" />
            <span aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center overflow-hidden text-center text-xs font-medium tabular-nums text-white/40 [text-shadow:0_0_2px_#000] [transform:rotate(-18deg)]">
              {Array.from({ length: 6 }, (_, i) => <span key={i} className="block w-full whitespace-nowrap py-3">{stamp}</span>)}
            </span>
          </>
        ) : (
          <div aria-hidden className="h-full w-full bg-slate-800 blur-[2px]" />
        )}
        {!src && (
          <div className="absolute inset-0 grid place-items-center p-3">
            <Button onClick={() => void reveal()} disabled={busy} className="min-h-[44px] bg-purple-600 hover:bg-purple-700" data-testid={`reveal-${evidence.kind}`}>
              {busy ? <Loader2Icon className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <EyeIcon className="mr-2 h-4 w-4" aria-hidden />}Reveal
            </Button>
          </div>
        )}
      </div>
      <figcaption className="mt-1.5 flex min-h-[44px] items-center justify-between gap-2 text-xs text-slate-400">
        <span>{KIND[evidence.kind]} <span className="tabular-nums">({Math.max(1, Math.round(evidence.bytes / 1024))} KB)</span></span>
        {src ? (
          <Button size="sm" variant="ghost" className="min-h-[44px] text-slate-300" onClick={() => { drop(); onReveal(null); }}>
            <XIcon className="mr-1 h-4 w-4" aria-hidden />Hide now
          </Button>
        ) : (
          <span>Hides again after {REBLUR_MS / 1000} seconds</span>
        )}
      </figcaption>
      <p role="alert" className={error ? "text-sm text-red-400" : "sr-only"}>{error ?? ""}</p>
    </figure>
  );
}
