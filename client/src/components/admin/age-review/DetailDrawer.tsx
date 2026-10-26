import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { CameraIcon, Loader2Icon } from "@/components/ui/icons";
import ReasonDialog from "@/components/admin/ReasonDialog";
import { documentTypeLabel, minutesLeft, formatCode } from "@/lib/ageReview";
import { ReviewApiError, getDetail, inviteLive, liveJoin, secondApprove, errText } from "@/lib/adminAgeReviewApi";
import { approveDescription, methodLabel, registeredAge } from "@/lib/adminAgeReviewUi";
import StatusChip from "./StatusChip";
import EvidenceTile from "./EvidenceTile";
import DecisionForm from "./DecisionForm";
import ReviewerCall from "./ReviewerCall";

interface Props { id: string | null; role: string; reviewer: string; onClose: () => void; onChanged: () => void }

const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div className="flex items-baseline justify-between gap-4 border-b border-slate-700/60 py-2 text-sm">
    <dt className="text-slate-400">{k}</dt><dd className="text-right text-white tabular-nums">{children}</dd>
  </div>
);

export default function DetailDrawer({ id, role, reviewer, onClose, onChanged }: Props) {
  const qc = useQueryClient();
  // Metadata only. Evidence images never pass through the query cache (see EvidenceTile).
  const q = useQuery({ queryKey: ["age-review-detail", id], queryFn: () => getDetail(id!), enabled: !!id, retry: false, gcTime: 0 });
  const [revealed, setRevealed] = useState<string | null>(null);
  const [call, setCall] = useState<{ url: string; token: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [approve, setApprove] = useState<boolean | null>(null);
  const [dupe, setDupe] = useState(false); // set only after the server answers 409 DUPLICATE_DOCUMENT
  const [overrideReason, setOverrideReason] = useState("");
  const [now, setNow] = useState(() => new Date());
  const joinRef = useRef<HTMLButtonElement>(null);
  const hadCall = useRef(false);
  useEffect(() => { setRevealed(null); setMsg(null); }, [id]);
  // The sheet closes while the call is up, so its focus trap and outside-click handling cannot fight the call; focus comes back to Join.
  useEffect(() => {
    if (call) { hadCall.current = true; return; }
    if (hadCall.current) { hadCall.current = false; const t = window.setTimeout(() => joinRef.current?.focus(), 120); return () => window.clearTimeout(t); }
  }, [call]);
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 15_000); return () => window.clearInterval(t); }, []);

  const d = q.data;
  const r = d?.request;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["age-review-detail", id] }); onChanged(); };
  const done = () => { onChanged(); onClose(); };
  const invited = !!r && minutesLeft(r.liveInviteExpiresAt, now) > 0;

  const invite = async () => {
    if (!r) return;
    setBusy("invite"); setMsg(null);
    try { await inviteLive(r.id); refresh(); setMsg("Invite sent. It is valid for 15 minutes."); } catch (e) { setMsg(errText(e)); } finally { setBusy(null); }
  };
  const join = async () => {
    if (!r) return;
    setBusy("join"); setMsg(null);
    try { const j = await liveJoin(r.id); setCall({ url: j.url, token: j.token }); } catch (e) { setMsg(errText(e)); } finally { setBusy(null); }
  };

  return (
    <>
      <Sheet open={!!id && !call} onOpenChange={(o) => !o && onClose()}>
        <SheetContent side="right" className="w-full overflow-y-auto border-slate-700 bg-slate-900 text-white sm:max-w-xl" data-testid="age-review-drawer">
          <SheetHeader className="text-left">
            <SheetTitle className="text-white">{r ? r.displayName : "Age review"}</SheetTitle>
            <SheetDescription className="text-slate-400">{r ? `Request ${r.id.slice(0, 8)}` : "Loading the request"}</SheetDescription>
          </SheetHeader>

          {q.isLoading && <p role="status" className="py-8 text-center text-sm text-slate-400">Loading</p>}
          {q.error && <p role="alert" className="py-8 text-center text-sm text-red-400">{errText(q.error)}</p>}

          {d && r && (
            <div className="mt-4 space-y-6">
              <dl>
                <Row k="Status"><StatusChip status={r.status} /></Row>
                <Row k="Method">{methodLabel(r.method)}</Row>
                {r.wantsPayouts && <Row k="Payouts"><span className="rounded-full border border-purple-400/60 px-2.5 py-1 text-xs font-medium text-purple-200">Wants payouts</span></Row>}
                <Row k="Registered birthdate">{r.registeredDob || "Not on file"}{registeredAge(r.registeredDob) !== null && <span className="text-slate-400"> (age {registeredAge(r.registeredDob)})</span>}</Row>
                {r.proposedDob && <Row k="Proposed birthdate (from the ID)"><span className="text-amber-200">{r.proposedDob}</span></Row>}
                <Row k="Document type">{documentTypeLabel(r.documentType)}</Row>
                {r.method === "upload" && (
                  <Row k="Selfie code">
                    <span className="font-mono text-base tracking-widest">{formatCode(r.code) || "None"}</span>
                    <span className="block text-xs text-slate-400">{r.codeExpiresAt ? (minutesLeft(r.codeExpiresAt, now) > 0 ? `${minutesLeft(r.codeExpiresAt, now)} min left` : "Code expired") : ""}</span>
                  </Row>
                )}
                <Row k="Consent">{r.consentRecorded ? "Recorded" : "Not recorded"}</Row>
                <Row k="Extra photos asked">{r.moreRequests}</Row>
              </dl>

              {r.method === "upload" && (
                d.evidence.length > 0 ? (
                  <section aria-label="Evidence" className="grid gap-4 sm:grid-cols-2">
                    {d.evidence.map((ev) => (
                      <EvidenceTile key={ev.id} requestId={r.id} evidence={ev} reviewer={reviewer} revealedId={revealed} onReveal={setRevealed} onGone={refresh} />
                    ))}
                  </section>
                ) : (
                  <p className="rounded-lg border border-slate-700 p-3 text-sm text-slate-400">No photos are held for this request.</p>
                )
              )}

              {r.method === "live" && d.canDecide && (
                <section aria-label="Live check" className="space-y-3 rounded-lg border border-slate-700 p-3">
                  <p className="text-sm text-slate-300">{invited ? `Invite open for ${minutesLeft(r.liveInviteExpiresAt, now)} more minutes.` : "Invite the user to a private call. Nothing is recorded."}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => void invite()} disabled={busy !== null} variant="outline" className="min-h-[44px] border-slate-600 text-slate-200" data-testid="button-invite-live">
                      {busy === "invite" && <Loader2Icon className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}Invite to live check
                    </Button>
                    <Button ref={joinRef} onClick={() => void join()} disabled={busy !== null || !invited} className="min-h-[44px] bg-purple-600 hover:bg-purple-700" data-testid="button-join-live">
                      {busy === "join" ? <Loader2Icon className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <CameraIcon className="mr-2 h-4 w-4" aria-hidden />}Join the call
                    </Button>
                  </div>
                </section>
              )}

              <p role="status" className={msg ? "text-sm text-slate-300" : "sr-only"}>{msg ?? ""}</p>

              {d.canDecide && <DecisionForm key={r.id} requestId={r.id} role={role} registeredDob={r.registeredDob} method={r.method} documentType={r.documentType} wantsPayouts={r.wantsPayouts === true} onDone={done} />}
              {!d.canDecide && r.status !== "pending_second_approval" && <p className="text-sm text-slate-400">This request cannot be decided by you right now.</p>}

              {r.status === "pending_second_approval" && (
                <section aria-label="Second approval" className="space-y-3 rounded-lg border border-slate-700 p-3">
                  <h3 className="text-base font-semibold">Second approval</h3>
                  {d.canSecondApprove ? (
                    <div className="flex flex-wrap gap-2">
                      <Button className="min-h-[44px] bg-emerald-600 hover:bg-emerald-700" onClick={() => setApprove(true)} data-testid="button-second-approve">Approve</Button>
                      <Button variant="outline" className="min-h-[44px] border-slate-600 text-slate-200" onClick={() => setApprove(false)} data-testid="button-second-reject">Reject</Button>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-400">A different super admin from the first reviewer must decide this.</p>
                  )}
                </section>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      <ReasonDialog
        open={approve !== null} title={approve ? "Approve the birthdate change" : "Reject the birthdate change"}
        description={approveDescription(approve === true, r?.registeredDob ?? "", r?.proposedDob ?? null)}
        confirmLabel={approve ? "Approve" : "Reject"} destructive={approve === false} minLength={3} maxLength={300} busy={busy === "second"} error={msg}
        extra={approve === true && dupe && role === "super_admin" ? (
          <div className="space-y-2 rounded-lg border border-amber-500/40 p-3" data-testid="second-override">
            <label htmlFor="second-override-reason" className="text-sm text-amber-200">This document already verified another account. To approve anyway, give an override reason, then press Approve again.</label>
            <textarea id="second-override-reason" rows={2} maxLength={300} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} className="w-full rounded-md border border-slate-600 bg-slate-700/50 p-2 text-sm text-white" />
          </div>
        ) : undefined}
        onClose={() => { setApprove(null); setDupe(false); setOverrideReason(""); }}
        onConfirm={async (reason) => {
          if (!r || approve === null) return;
          setBusy("second"); setMsg(null);
          try { await secondApprove(r.id, approve, reason, dupe ? overrideReason : ""); setApprove(null); setDupe(false); setOverrideReason(""); done(); }
          catch (e) {
            if (e instanceof ReviewApiError && e.code === "DUPLICATE_DOCUMENT" && role === "super_admin") setDupe(true);
            setMsg(errText(e));
          } finally { setBusy(null); }
        }}
      />

      {call && r && <ReviewerCall join={call} registeredDob={r.registeredDob} onEnd={(p) => { setCall(null); if (p) setMsg(p); refresh(); }} />}
    </>
  );
}
