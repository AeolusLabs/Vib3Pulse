import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2Icon } from "@/components/ui/icons";
import { ReviewApiError, decide, errText } from "@/lib/adminAgeReviewApi";
import {
  CHECKLIST_LABEL, CONFIRM_TEXT, DECLINE_LABEL, DECLINE_REASONS, DOC_TYPES, DOC_TYPE_LABEL, OUTCOME_HELP, OUTCOME_LABEL, canOverrideDuplicate,
  decisionBody, decisionReady, emptyChecklist, isIdOutcome, legalNameProblem, needsDocumentNumber, outcomesFor, requiredChecks, type DecisionForm as Form, type Outcome,
} from "@/lib/adminAgeReviewUi";

const FIELD = "min-h-[44px] border-slate-600 bg-slate-700/50 text-white";

interface Props { requestId: string; role: string; registeredDob: string; method: "upload" | "live"; documentType: string | null; wantsPayouts?: boolean; onDone: () => void }

export default function DecisionForm({ requestId, role, registeredDob, method, documentType, wantsPayouts = false, onDone }: Props) {
  const [f, setF] = useState<Form>({ outcome: null, checklist: emptyChecklist(), idBirthdate: "", documentNumber: "", documentType: documentType ?? "", legalName: "", declineReason: "", note: "", overrideReason: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsOverride, setNeedsOverride] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));
  const overrideAllowed = canOverrideDuplicate(role);
  const ready = decisionReady(f, method, wantsPayouts) && (!needsOverride || !overrideAllowed || f.overrideReason.trim().length >= 3);

  const send = async () => {
    setBusy(true); setError(null); setConfirm(false);
    try {
      await decide(requestId, decisionBody(f, { overrideAllowed: needsOverride && overrideAllowed, wantsPayouts, method }) as Parameters<typeof decide>[1]);
      onDone();
    } catch (e) {
      if (e instanceof ReviewApiError && e.code === "DUPLICATE_DOCUMENT") setNeedsOverride(true);
      setError(e instanceof ReviewApiError && e.code === "DUPLICATE_DOCUMENT" && overrideAllowed
        ? "This document already verified another account. To go ahead, type the document number again and give a reason below."
        : errText(e));
      if (e instanceof ReviewApiError && e.code === "WRONG_STATE") onDone();
    } finally {
      set({ documentNumber: "", legalName: "" }); // never kept after a submit, success or not
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    if (f.outcome && CONFIRM_TEXT[f.outcome]) setConfirm(true);
    else void send();
  };

  return (
    <form onSubmit={submit} className="space-y-5" aria-labelledby="decision-title" data-testid="decision-form">
      <h3 id="decision-title" className="text-base font-semibold text-white">Decision</h3>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-slate-300">Checks</legend>
        {requiredChecks(method).map((k) => (
          <label key={k} className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border border-slate-700 px-3 text-sm text-slate-200">
            <Checkbox checked={f.checklist[k]} onCheckedChange={(v) => set({ checklist: { ...f.checklist, [k]: v === true } })} className="h-5 w-5 border-slate-400" />
            {CHECKLIST_LABEL[k]}
          </label>
        ))}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-slate-300">Outcome</legend>
        <div role="radiogroup" aria-label="Outcome" className="grid gap-2 sm:grid-cols-2">
          {outcomesFor(method).map((o) => (
            <button
              key={o} type="button" role="radio" aria-checked={f.outcome === o} onClick={() => set({ outcome: o })}
              className={`min-h-[44px] rounded-lg border px-3 text-left text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-400 ${f.outcome === o ? "border-purple-400 bg-purple-500/15 text-white" : "border-slate-700 text-slate-300 hover:border-slate-500"}`}
              data-testid={`outcome-${o}`}
            >{OUTCOME_LABEL[o]}</button>
          ))}
        </div>
        {f.outcome && <p className="text-sm text-slate-400" aria-live="polite">{OUTCOME_HELP[f.outcome]}</p>}
      </fieldset>

      {(f.outcome === "verify" || f.outcome === "teen_correction" || f.outcome === "birthdate_change") && (
        <div className="space-y-2">
          <Label htmlFor="id-birthdate" className="text-slate-300">ID birthdate</Label>
          <Input id="id-birthdate" type="date" value={f.idBirthdate} onChange={(e) => set({ idBirthdate: e.target.value })} className={`${FIELD} max-w-[12rem] tabular-nums`} data-testid="input-id-birthdate" />
          <p className="text-xs text-slate-400">Registered birthdate is <span className="tabular-nums">{registeredDob || "not on file"}</span>.</p>
        </div>
      )}

      {documentType === null && needsDocumentNumber(f.outcome, method) && (
        <div className="space-y-2">
          <Label htmlFor="doc-type" className="text-slate-300">Document type (required)</Label>
          <select id="doc-type" required value={f.documentType} onChange={(e) => set({ documentType: e.target.value })} className={`${FIELD} w-full rounded-md px-3 text-sm`} data-testid="select-document-type">
            <option value="">Choose the document shown</option>
            {DOC_TYPES.map((t) => <option key={t} value={t}>{DOC_TYPE_LABEL[t]}</option>)}
          </select>
        </div>
      )}

      {needsDocumentNumber(f.outcome, method) && (
        <div className="space-y-2">
          <Label htmlFor="doc-number" className="text-slate-300">Document number</Label>
          <Input
            id="doc-number" value={f.documentNumber} onChange={(e) => set({ documentNumber: e.target.value })}
            autoComplete="off" autoCorrect="off" autoCapitalize="characters" spellCheck={false} data-lpignore="true"
            className={FIELD} data-testid="input-document-number"
          />
          <p className="text-xs text-slate-400">Used to stop one ID being used on many accounts. It is turned into a one-way code and never stored.</p>
        </div>
      )}

      {wantsPayouts && isIdOutcome(f.outcome) && (
        <div className="space-y-2">
          <Label htmlFor="legal-name" className="text-slate-300">Full name on the document</Label>
          <Input
            id="legal-name" value={f.legalName} onChange={(e) => set({ legalName: e.target.value })}
            autoComplete="off" autoCorrect="off" spellCheck={false} data-lpignore="true" required aria-required="true"
            aria-invalid={legalNameProblem(f.legalName) ? true : undefined} aria-describedby="legal-name-help legal-name-problem"
            className={FIELD} data-testid="input-legal-name"
          />
          <p id="legal-name-help" className="text-xs text-slate-400">Used only to check the bank account holder's name. Stored encrypted. Not shown anywhere.</p>
          <p id="legal-name-problem" role="status" className={legalNameProblem(f.legalName) ? "text-xs text-amber-300" : "sr-only"}>{legalNameProblem(f.legalName) ?? ""}</p>
        </div>
      )}

      {f.outcome === "decline" && (
        <div className="space-y-2">
          <Label htmlFor="decline-reason" className="text-slate-300">Reason</Label>
          <select id="decline-reason" value={f.declineReason} onChange={(e) => set({ declineReason: e.target.value })} className={`${FIELD} w-full rounded-md px-3 text-sm`} data-testid="select-decline-reason">
            <option value="">Choose a reason</option>
            {DECLINE_REASONS.map((r) => <option key={r} value={r}>{DECLINE_LABEL[r]}</option>)}
          </select>
        </div>
      )}

      {needsOverride && overrideAllowed && (
        <div className="space-y-2 rounded-lg border border-amber-500/40 p-3">
          <Label htmlFor="override-reason" className="text-amber-200">Override reason (recorded in the audit log)</Label>
          <Textarea id="override-reason" rows={3} maxLength={300} value={f.overrideReason} onChange={(e) => set({ overrideReason: e.target.value })} className="border-slate-600 bg-slate-700/50 text-white" data-testid="input-override-reason" />
        </div>
      )}

      {f.outcome && (
        <div className="space-y-2">
          <Label htmlFor="decision-note" className="text-slate-300">Note (optional, for the audit log)</Label>
          <Textarea id="decision-note" rows={2} maxLength={500} value={f.note} onChange={(e) => set({ note: e.target.value })} aria-describedby="decision-note-help" className="border-slate-600 bg-slate-700/50 text-white" />
          <p id="decision-note-help" className="text-xs text-slate-400">Do not write names or document numbers here.</p>
        </div>
      )}

      <p role="alert" className={error ? "text-sm text-red-400" : "sr-only"} data-testid="decision-error">{error ?? ""}</p>

      <Button type="submit" disabled={!ready || busy} className="min-h-[44px] bg-purple-600 hover:bg-purple-700" data-testid="button-submit-decision">
        {busy && <Loader2Icon className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}
        {f.outcome ? `Send: ${OUTCOME_LABEL[f.outcome]}` : "Choose an outcome"}
      </Button>

      <Dialog open={confirm} onOpenChange={(o) => !o && setConfirm(false)}>
        <DialogContent className="border-slate-700 bg-slate-800 text-white sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{f.outcome ? OUTCOME_LABEL[f.outcome] : ""}</DialogTitle>
            <DialogDescription className="text-slate-300">{f.outcome ? CONFIRM_TEXT[f.outcome] : ""}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" className="min-h-[44px] text-slate-300" onClick={() => setConfirm(false)}>Go back</Button>
            <Button type="button" className="min-h-[44px] bg-red-600 hover:bg-red-700" onClick={() => void send()} data-testid="button-confirm-decision">Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}
