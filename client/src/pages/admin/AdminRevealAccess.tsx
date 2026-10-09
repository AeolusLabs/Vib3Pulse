import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import AdminLayout from "./AdminLayout";
import ReasonDialog from "@/components/admin/ReasonDialog";
import { formatLeft } from "@/components/admin/RevealPanel";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type Grant = { id: string; eventId: string; eventTitle: string; caseType: string; reason: string; createdAt: string; expiresAt: string; revokedAt: string | null; grantorName: string; granteeName: string; status: "active" | "expired" | "revoked"; secondsLeft: number };
type MyGrant = { id: string; eventId: string; eventTitle: string; caseType: string; secondsLeft: number };
type Activity = { at: string; kind: string; actor: string | null; actorType: string | null; eventId: string | null; data: string | null; grantId: string | null; reason: string | null };

const KIND_LABEL: Record<string, string> = {
  data_revealed: "Data revealed", reveal_super_admin: "Super-admin reveal", reveal_grant_created: "Grant created", reveal_grant_used: "Grant used",
  reveal_grant_revoked: "Grant revoked", reveal_grant_expired: "Grant expired", reveal_denied: "Access denied",
};
const STATUS_STYLE = { active: "bg-emerald-500/15 text-emerald-300", expired: "bg-slate-600/40 text-slate-300", revoked: "bg-red-500/15 text-red-300" };
const card = "rounded-xl border border-slate-700 bg-slate-800/50 p-4";

function SuperView() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const grants = useQuery<{ grants: Grant[] }>({ queryKey: ["/api/admin/reveal-grants"], refetchInterval: 30_000 });
  const activity = useQuery<{ activity: Activity[] }>({ queryKey: ["/api/admin/reveal-activity"] });
  const [revoking, setRevoking] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const revoke = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => (await apiRequest("POST", `/api/admin/reveal-grants/${id}/revoke`, { reason })).json(),
    onSuccess: () => { setRevoking(null); setErr(null); qc.invalidateQueries({ queryKey: ["/api/admin/reveal-grants"] }); qc.invalidateQueries({ queryKey: ["/api/admin/reveal-activity"] }); toast({ title: "Access revoked", description: "It stops working immediately." }); },
    onError: (e: Error) => setErr(e.message),
  });
  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-1 text-lg font-semibold text-white">Delegated grants</h2>
        <p className="mb-3 text-xs text-slate-400">Create a grant from an event in the moderation queue. Grants are scoped to one event and one case, expire on their own, and can't be re-delegated.</p>
        {grants.data?.grants.length === 0 && <p className={`${card} text-sm text-slate-400`}>No grants yet.</p>}
        <ul className="space-y-2" data-testid="grants-list">
          {grants.data?.grants.map((g) => (
            <li key={g.id} className={card} data-testid={`grant-${g.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-white">{g.granteeName} → <span className="text-slate-300">{g.eventTitle}</span></p>
                <span className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[g.status]}`} data-testid="grant-status">{g.status}{g.status === "active" ? ` · ${formatLeft(g.secondsLeft)}` : ""}</span>
                  {g.status === "active" && <Button size="sm" variant="outline" className="border-red-500/50 text-red-300" onClick={() => setRevoking(g.id)} data-testid={`revoke-${g.id}`}>Revoke</Button>}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-400">Granted by {g.grantorName} on {new Date(g.createdAt).toLocaleString()} · case: {g.caseType.replace("_", " ")} · “{g.reason}”</p>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-1 text-lg font-semibold text-white">Reveal activity</h2>
        <p className="mb-3 text-xs text-slate-400">Everything that revealed, or tried to reveal, an address or guest list. Only super-admins can see this. Review it regularly.</p>
        <div className="overflow-x-auto rounded-xl border border-slate-700" data-testid="reveal-activity">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-800 text-slate-400"><tr><th className="px-3 py-2">When</th><th className="px-3 py-2">What</th><th className="px-3 py-2">Who</th><th className="px-3 py-2">Data</th><th className="px-3 py-2">Reason</th></tr></thead>
            <tbody className="divide-y divide-slate-700 text-slate-200">
              {activity.data?.activity.slice(0, 100).map((a, i) => (
                <tr key={i}><td className="whitespace-nowrap px-3 py-2 text-slate-400">{new Date(a.at).toLocaleString()}</td><td className="px-3 py-2">{KIND_LABEL[a.kind] ?? a.kind}{a.actorType === "grantee" && " (via grant)"}</td><td className="px-3 py-2">{a.actor ?? "—"}</td><td className="px-3 py-2">{a.data === "exact_address" ? "address" : a.data === "guest_list" ? "guest list" : "—"}</td><td className="max-w-xs truncate px-3 py-2 text-slate-400" title={a.reason ?? ""}>{a.reason ?? "—"}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {revoking && <ReasonDialog open title="Revoke access" description="The moderator loses access immediately." confirmLabel="Revoke" destructive busy={revoke.isPending} error={err} minLength={5} onConfirm={(reason) => revoke.mutate({ id: revoking, reason })} onClose={() => { setRevoking(null); setErr(null); }} />}
    </div>
  );
}

function ModeratorView() {
  const mine = useQuery<{ grants: MyGrant[] }>({ queryKey: ["/api/admin/reveal-grants/mine"], refetchInterval: 30_000 });
  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold text-white">Your reveal access</h2>
      <p className="mb-3 text-xs text-slate-400">A super-admin can lend you access to one event's address or guest list for a limited time. Use it from that event in the moderation queue. Every use is logged.</p>
      {mine.data?.grants.length === 0 && <p className={`${card} text-sm text-slate-400`} data-testid="no-grants">You have no active access.</p>}
      <ul className="space-y-2" data-testid="my-grants-list">
        {mine.data?.grants.map((g) => (
          <li key={g.id} className={`${card} flex items-center justify-between gap-3`}>
            <span className="text-sm text-white">{g.eventTitle}</span>
            <span className="text-xs text-amber-300">{formatLeft(g.secondsLeft)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function AdminRevealAccess() {
  const me = useQuery<{ role: string }>({ queryKey: ["/api/admin/me"] });
  return (
    <AdminLayout>
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-6 text-2xl font-bold text-white" data-testid="heading-reveal">Reveal access</h1>
        {me.data?.role === "super_admin" ? <SuperView /> : <ModeratorView />}
      </div>
    </AdminLayout>
  );
}
