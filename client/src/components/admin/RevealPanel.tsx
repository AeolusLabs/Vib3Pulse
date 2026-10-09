import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { EyeIcon, LockIcon } from "@/components/ui/icons";

// Admin views never show an event's exact address or guest names. This panel is the ONLY way to see
// them, and every use is logged server-side:
//   super-admin: reveal now (reason + a linked case) or delegate to a moderator as a time-limited grant
//   moderator:   use a live grant for THIS event, with a countdown; nothing else
type CaseOption = { caseType: "report" | "moderation_item"; caseId: string; label: string };
type Grant = { id: string; eventId: string; eventTitle: string; caseType: string; secondsLeft: number; expiresAt: string };
type Props = { eventId: string; role: string; cases: CaseOption[] };

export function formatLeft(total: number): string {
  if (total <= 0) return "expired";
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h > 0 ? `${h}h ${m}m left` : `${m}m ${String(s).padStart(2, "0")}s left`;
}

function Countdown({ seconds, fetchedAt }: { seconds: number; fetchedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = Math.max(0, seconds - Math.floor((now - fetchedAt) / 1000));
  return <span className={left < 3600 ? "text-amber-400" : "text-slate-300"} data-testid="grant-countdown">{formatLeft(left)}</span>;
}

type Revealed = { address?: string | null; guests?: Array<{ name: string; attending: boolean; plusOneCount: number; hasAccount: boolean; removed: boolean }> };

export default function RevealPanel({ eventId, role, cases }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const isSuper = role === "super_admin";
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // super-admin form
  const [mode, setMode] = useState<"now" | "delegate">("now");
  const [scope, setScope] = useState<"address" | "guests">("address");
  const [caseKey, setCaseKey] = useState(cases[0] ? `${cases[0].caseType}:${cases[0].caseId}` : "");
  const [reason, setReason] = useState("");
  const [granteeId, setGranteeId] = useState("");
  const [hours, setHours] = useState("");

  const mine = useQuery<{ grants: Grant[] }>({ queryKey: ["/api/admin/reveal-grants/mine"], enabled: !isSuper, staleTime: 0 });
  const moderators = useQuery<{ moderators: Array<{ id: string; name: string; username: string }> }>({ queryKey: ["/api/admin/moderators"], enabled: isSuper && mode === "delegate" });
  const fetchedAt = mine.dataUpdatedAt || Date.now();
  const myGrants = (mine.data?.grants ?? []).filter((g) => g.eventId === eventId);
  const picked = cases.find((c) => `${c.caseType}:${c.caseId}` === caseKey);

  const call = async (fn: () => Promise<Response>, ok: (j: any) => void) => {
    setBusy(true); setError(null);
    try { ok(await (await fn()).json()); } catch (e) { setError((e as Error).message); mine.refetch(); } finally { setBusy(false); }
  };

  const doReveal = (body: Record<string, unknown>) => call(() => apiRequest("POST", `/api/admin/events/${eventId}/reveal`, body), (j) => { setRevealed(j); qc.invalidateQueries({ queryKey: ["/api/admin/reveal-activity"] }); });

  if (revealed) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3" data-testid="revealed-data">
        <div className="mb-2 flex items-center justify-between text-xs text-amber-300"><span className="inline-flex items-center gap-1"><EyeIcon className="h-3.5 w-3.5" />Revealed. This access was logged.</span><Button size="sm" variant="ghost" className="h-7 text-slate-300" onClick={() => setRevealed(null)}>Hide</Button></div>
        {revealed.address !== undefined && <p className="text-sm text-white" data-testid="revealed-address">{revealed.address ?? "No address on file"}</p>}
        {revealed.guests && (revealed.guests.length === 0 ? <p className="text-sm text-slate-400">No guests yet.</p> : (
          <ul className="divide-y divide-slate-700 text-sm" data-testid="revealed-guests">
            {revealed.guests.map((g, i) => <li key={i} className="flex justify-between py-1.5 text-slate-200"><span>{g.name}{g.plusOneCount > 0 && ` +${g.plusOneCount}`}</span><span className="text-slate-400">{g.removed ? "removed" : g.attending ? "coming" : "declined"}</span></li>)}
          </ul>
        ))}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3" data-testid="reveal-panel">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-300"><LockIcon className="h-3.5 w-3.5" />Address and guest names are hidden. Revealing is logged.</p>

      {!isSuper && (
        myGrants.length === 0 ? (
          <p className="text-xs text-slate-500">You don't have reveal access for this event. A super-admin can grant it for a limited time.</p>
        ) : (
          <div className="space-y-2">
            {myGrants.map((g) => (
              <div key={g.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-700 px-2 py-1.5 text-xs" data-testid="my-grant">
                <span className="text-slate-300">Access granted · <Countdown seconds={g.secondsLeft} fetchedAt={fetchedAt} /></span>
                <span className="flex gap-2">
                  <Button size="sm" variant="outline" className="h-7 border-slate-600 text-slate-200" disabled={busy} onClick={() => doReveal({ scope: "address", grantId: g.id })} data-testid="button-reveal-address">Show address</Button>
                  <Button size="sm" variant="outline" className="h-7 border-slate-600 text-slate-200" disabled={busy} onClick={() => doReveal({ scope: "guests", grantId: g.id })} data-testid="button-reveal-guests">Show guests</Button>
                </span>
              </div>
            ))}
          </div>
        )
      )}

      {isSuper && (
        <div className="space-y-2">
          <div className="flex gap-1 text-xs">
            {(["now", "delegate"] as const).map((m) => <button key={m} type="button" onClick={() => setMode(m)} className={`rounded px-2 py-1 ${mode === m ? "bg-purple-600 text-white" : "bg-slate-800 text-slate-300"}`} data-testid={`tab-reveal-${m}`}>{m === "now" ? "Reveal now" : "Delegate to a moderator"}</button>)}
          </div>
          <Select value={caseKey} onValueChange={setCaseKey}>
            <SelectTrigger className="h-8 border-slate-600 bg-slate-800 text-xs text-slate-200" data-testid="select-case"><SelectValue placeholder="Linked case" /></SelectTrigger>
            <SelectContent>{cases.map((c) => <SelectItem key={`${c.caseType}:${c.caseId}`} value={`${c.caseType}:${c.caseId}`}>{c.label}</SelectItem>)}</SelectContent>
          </Select>
          {mode === "now" && (
            <Select value={scope} onValueChange={(v) => setScope(v as typeof scope)}>
              <SelectTrigger className="h-8 border-slate-600 bg-slate-800 text-xs text-slate-200"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="address">Exact address</SelectItem><SelectItem value="guests">Guest list</SelectItem></SelectContent>
            </Select>
          )}
          {mode === "delegate" && (
            <div className="flex gap-2">
              <Select value={granteeId} onValueChange={setGranteeId}>
                <SelectTrigger className="h-8 flex-1 border-slate-600 bg-slate-800 text-xs text-slate-200" data-testid="select-grantee"><SelectValue placeholder="Moderator" /></SelectTrigger>
                <SelectContent>{(moderators.data?.moderators ?? []).map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}</SelectContent>
              </Select>
              <Input value={hours} onChange={(e) => setHours(e.target.value.replace(/\D/g, ""))} placeholder="Hours (default)" className="h-8 w-32 border-slate-600 bg-slate-800 text-xs text-white" data-testid="input-grant-hours" />
            </div>
          )}
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this needed? (10+ characters, logged)" className="border-slate-600 bg-slate-800 text-xs text-white" data-testid="input-reveal-reason" />
          <Button size="sm" className="bg-purple-600 hover:bg-purple-700" disabled={busy || reason.trim().length < 10 || !picked || (mode === "delegate" && !granteeId)} data-testid="button-reveal-submit"
            onClick={() => mode === "now"
              ? doReveal({ scope, case: { caseType: picked!.caseType, caseId: picked!.caseId }, reason: reason.trim() })
              : call(() => apiRequest("POST", "/api/admin/reveal-grants", { granteeId, eventId, case: { caseType: picked!.caseType, caseId: picked!.caseId }, reason: reason.trim(), ...(hours ? { hours: Number(hours) } : {}) }), () => { toast({ title: "Access granted", description: "It expires automatically and can be revoked from Reveal access." }); setReason(""); qc.invalidateQueries({ queryKey: ["/api/admin/reveal-grants"] }); })}>
            {mode === "now" ? "Reveal" : "Grant access"}
          </Button>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-red-400" data-testid="reveal-error">{error}</p>}
    </div>
  );
}
