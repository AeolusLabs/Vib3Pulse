import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangleIcon, CheckCircleIcon, Loader2Icon } from "@/components/ui/icons";
import ReasonDialog from "@/components/admin/ReasonDialog";
import { useToast } from "@/hooks/use-toast";
import { emergencyPurge, errText, getHealth, setPause } from "@/lib/adminAgeReviewApi";
import { PURGE_WORD, STALE_TEXT, ageText, canPurge, canSetPause, isStale, pauseDisabledReason, purgeReady } from "@/lib/adminAgeReviewUi";

const Stat = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="min-w-0 rounded-lg border border-slate-700 p-3">
    <dt className="text-xs text-slate-400">{label}</dt>
    <dd className="mt-1 text-lg font-semibold tabular-nums text-white">{children}</dd>
  </div>
);

export default function HealthStrip({ role }: { role: string }) {
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["age-review-health"], queryFn: getHealth, refetchInterval: 60_000, retry: false });
  const [pauseTo, setPauseTo] = useState<boolean | null>(null);
  const [pauseErr, setPauseErr] = useState<string | null>(null);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [purgeErr, setPurgeErr] = useState<string | null>(null);

  const pause = useMutation({
    mutationFn: (v: { on: boolean; reason: string }) => setPause(v.on, v.reason),
    onSuccess: (r) => { setPauseTo(null); void q.refetch(); toast({ title: r.paused ? "Age checks paused" : "Age checks resumed" }); },
    onError: (e) => setPauseErr(errText(e)),
  });
  const purge = useMutation({
    mutationFn: (r: string) => emergencyPurge(r),
    onSuccess: (r) => { setPurgeOpen(false); void q.refetch(); toast({ title: "Evidence deleted", description: `${r.deleted} items removed.` }); },
    onError: (e) => setPurgeErr(errText(e)),
    onSettled: () => { setTyped(""); setReason(""); },
  });

  const h = q.data;
  if (q.isLoading) return <p role="status" className="py-8 text-center text-sm text-slate-400">Loading health</p>;
  if (q.error || !h) return <p role="alert" className="py-8 text-center text-sm text-red-400">{errText(q.error)}</p>;

  const next = !h.paused; // the switch means "intake paused"
  const blocked = pauseDisabledReason(role, next);
  const stale = isStale(h);

  return (
    <section aria-label="Age review health" className="space-y-4" data-testid="age-review-health">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-700 p-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-white">{h.paused ? "Age checks are paused" : "Age checks are on"}</p>
          <p className="text-xs text-slate-400">{h.paused ? "New uploads and invites are refused. Decisions and cancels still work." : "Pausing stops new uploads and invites straight away."}</p>
          {blocked && h.paused && <p className="mt-1 text-xs text-amber-300">{blocked}</p>}
        </div>
        <div className="flex min-h-[44px] items-center gap-3">
          <Label htmlFor="pause-switch" className="text-sm text-slate-300">Pause intake</Label>
          <Switch id="pause-switch" checked={h.paused} disabled={!canSetPause(role, next)} onCheckedChange={() => { setPauseErr(null); setPauseTo(next); }} data-testid="switch-pause" />
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Evidence held">{h.pendingEvidence}</Stat>
        <Stat label="Oldest evidence">{ageText(h.oldestEvidenceAgeHours)}</Stat>
        <Stat label="Last sweep">{h.lastSweepAt ? new Date(h.lastSweepAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "Not yet"}</Stat>
        <Stat label="Stale evidence">
          <span className={`inline-flex items-center gap-1.5 ${stale ? "text-red-300" : "text-emerald-300"}`}>
            {stale ? <AlertTriangleIcon className="h-4 w-4" aria-hidden /> : <CheckCircleIcon className="h-4 w-4" aria-hidden />}{h.staleEvidence}
          </span>
        </Stat>
      </dl>
      {stale && <p role="alert" className="rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-200" data-testid="stale-warning">{STALE_TEXT}</p>}

      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm">
          <caption className="p-3 text-left text-sm font-medium text-white">Images revealed today, by reviewer</caption>
          <thead className="text-left text-xs text-slate-400"><tr><th scope="col" className="px-3 py-2">Reviewer</th><th scope="col" className="px-3 py-2 text-right">Reveals</th></tr></thead>
          <tbody>
            {h.revealsToday.length === 0 && <tr><td colSpan={2} className="px-3 py-3 text-slate-400">None yet today</td></tr>}
            {h.revealsToday.map((r) => <tr key={r.reviewer} className="border-t border-slate-700/60"><td className="px-3 py-2 text-slate-200">{r.reviewer}</td><td className="px-3 py-2 text-right tabular-nums text-white">{r.count}</td></tr>)}
          </tbody>
        </table>
      </div>

      {canPurge(role) && (
        <div className="rounded-lg border border-red-500/40 p-3">
          <p className="text-sm font-medium text-white">Emergency purge</p>
          <p className="mb-3 text-xs text-slate-400">Deletes every held ID photo at once. Open requests go back to the user for new photos.</p>
          <Button variant="destructive" className="min-h-[44px]" onClick={() => { setPurgeErr(null); setPurgeOpen(true); }} data-testid="button-emergency-purge">Delete all evidence</Button>
        </div>
      )}

      <ReasonDialog
        open={pauseTo !== null} title={pauseTo ? "Pause age checks" : "Resume age checks"}
        description={pauseTo ? "New uploads and live invites stop at once. Users see a notice." : "New uploads and invites start again."}
        confirmLabel={pauseTo ? "Pause" : "Resume"} destructive={pauseTo === true} minLength={3} maxLength={300}
        busy={pause.isPending} error={pauseErr} onClose={() => setPauseTo(null)}
        onConfirm={(r) => { if (pauseTo !== null) pause.mutate({ on: pauseTo, reason: r }); }}
      />

      <Dialog open={purgeOpen} onOpenChange={(o) => { if (!o) { setPurgeOpen(false); setTyped(""); setReason(""); } }}>
        <DialogContent className="border-slate-700 bg-slate-800 text-white sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete all evidence</DialogTitle>
            <DialogDescription className="text-slate-300">This cannot be undone. Type {PURGE_WORD} and give a reason.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); if (purgeReady(typed, reason) && !purge.isPending) purge.mutate(reason.trim()); }} className="space-y-3">
            <Label htmlFor="purge-word" className="text-slate-300">Type {PURGE_WORD}</Label>
            <Input id="purge-word" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoFocus className="min-h-[44px] border-slate-600 bg-slate-700/50 text-white" data-testid="input-purge-word" />
            <Label htmlFor="purge-reason" className="text-slate-300">Reason (recorded in the audit log)</Label>
            <Textarea id="purge-reason" rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} className="border-slate-600 bg-slate-700/50 text-white" data-testid="input-purge-reason" />
            <p role="alert" className={purgeErr ? "text-sm text-red-400" : "sr-only"}>{purgeErr ?? ""}</p>
            <DialogFooter>
              <Button type="button" variant="ghost" className="min-h-[44px] text-slate-300" onClick={() => setPurgeOpen(false)}>Cancel</Button>
              <Button type="submit" variant="destructive" className="min-h-[44px]" disabled={!purgeReady(typed, reason) || purge.isPending} data-testid="button-confirm-purge">
                {purge.isPending && <Loader2Icon className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}Delete everything
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
