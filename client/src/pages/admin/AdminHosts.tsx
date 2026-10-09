import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import AdminLayout from "./AdminLayout";
import ReasonDialog from "@/components/admin/ReasonDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type HostRow = { id: string; username: string; displayName: string | null; accountAgeDays: number; socialEvents: number; banned: boolean; phoneVerified: boolean; isVerified: boolean; deleted: boolean };
type Profile = {
  id: string; username: string; displayName: string | null; email: string; accountAgeDays: number; emailVerified: boolean; phone: { verified: boolean; last4: string | null };
  trust: { tier: string; override: { tier: string; reason: string } | null; featuredEligible: boolean; featuredOverride: { eligible: boolean; reason: string } | null; abusiveReporter: boolean };
  strikes: Array<{ id: string; type: string; reason: string; by: string; createdAt: string; active: boolean; revokedAt: string | null }>; activeStrikes: number;
  bans: Array<{ id: string; kind: string; reason: string; createdAt: string; liftedAt: string | null }>; banned: boolean;
  suspensions: Array<{ id: string; reason: string; active: boolean }>;
  linkedAccounts: Array<{ userId: string; username: string; sharedDevices: number; banned: boolean }>;
  events: Array<{ id: string; title: string; moderationStatus: string; visibility: string; eventDate: string }>;
  reportsReceived: { total: number; byReason: Array<{ reason: string; n: number }> };
};
type Appeal = { id: string; subjectType: string; subjectId: string; message: string; appellant: { username: string }; hoursOpen: number };

type Dlg =
  | { kind: "strike"; type: "warn" | "strike" }
  | { kind: "revoke"; id: string }
  | { kind: "ban" }
  | { kind: "lift"; id: string }
  | { kind: "tier"; tier: string | null }
  | { kind: "featured"; eligible: boolean | null }
  | { kind: "abusive"; abusive: boolean }
  | { kind: "appeal"; id: string; decision: "uphold" | "deny" };

const dlgText = (d: Dlg) => d.kind === "strike" ? { t: d.type === "warn" ? "Warn host" : "Issue strike", c: d.type === "warn" ? "Send warning" : "Issue strike", x: d.type === "strike", n: "The host is notified with this reason. Strikes count toward an automatic ban." }
  : d.kind === "revoke" ? { t: "Revoke strike", c: "Revoke", x: false, n: "" } : d.kind === "ban" ? { t: "Ban host", c: "Ban", x: true, n: "Bans the account, its verified phone number and its known devices, and hides their public events." }
  : d.kind === "lift" ? { t: "Lift ban", c: "Lift ban", x: false, n: "" } : d.kind === "tier" ? { t: d.tier ? `Set tier to ${d.tier}` : "Clear tier override", c: "Save", x: false, n: "Overrides the computed tier. Visible to other admins." }
  : d.kind === "featured" ? { t: d.eligible === null ? "Clear featured override" : d.eligible ? "Allow featuring" : "Block featuring", c: "Save", x: false, n: "" }
  : d.kind === "abusive" ? { t: d.abusive ? "Mark as abusive reporter" : "Remove abusive-reporter flag", c: "Save", x: d.abusive, n: "" } : { t: d.decision === "uphold" ? "Uphold appeal" : "Deny appeal", c: d.decision === "uphold" ? "Uphold" : "Deny", x: false, n: "The host is told the decision." };

const row = "flex flex-wrap items-center justify-between gap-2 border-b border-slate-700 py-2 text-sm last:border-0";
const card = "rounded-xl border border-slate-700 bg-slate-800/50 p-4";

export default function AdminHosts() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [term, setTerm] = useState("");
  const [search, setSearch] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const found = useQuery<{ hosts: HostRow[] }>({ queryKey: [`/api/admin/hosts?search=${encodeURIComponent(search)}`], enabled: search.length >= 2 });
  const profile = useQuery<Profile>({ queryKey: [`/api/admin/hosts/${sel}`], enabled: !!sel });
  const appeals = useQuery<{ appeals: Appeal[] }>({ queryKey: ["/api/admin/moderation/appeals"] });
  const accountAppeals = (appeals.data?.appeals ?? []).filter((a) => a.subjectType !== "event");

  const refresh = () => { qc.invalidateQueries({ queryKey: [`/api/admin/hosts/${sel}`] }); qc.invalidateQueries({ queryKey: ["/api/admin/moderation/appeals"] }); };

  const run = useMutation({
    mutationFn: async ({ d, reason }: { d: Dlg; reason: string }) => {
      const u = sel!;
      const call = (m: string, url: string, body: unknown) => apiRequest(m, url, body).then((r) => r.json());
      switch (d.kind) {
        case "strike": return call("POST", `/api/admin/hosts/${u}/strikes`, { type: d.type, reason });
        case "revoke": return call("POST", `/api/admin/strikes/${d.id}/revoke`, { reason });
        case "ban": return call("POST", `/api/admin/hosts/${u}/ban`, { reason });
        case "lift": return call("POST", `/api/admin/bans/${d.id}/lift`, { reason });
        case "tier": return call("PUT", `/api/admin/hosts/${u}/trust-tier`, { tier: d.tier, reason });
        case "featured": return call("PUT", `/api/admin/hosts/${u}/featured`, { eligible: d.eligible, reason });
        case "abusive": return call("PUT", `/api/admin/hosts/${u}/abusive-reporter`, { abusive: d.abusive, reason });
        case "appeal": return call("POST", `/api/admin/moderation/appeals/${d.id}/resolve`, { decision: d.decision, reason });
      }
    },
    onSuccess: (j) => { setDlg(null); setErr(null); refresh(); toast({ title: j?.autoBanned ? "Done. That was the final strike, so the host is now banned." : "Done", description: "Recorded in the audit log." }); },
    onError: (e: Error) => setErr(e.message),
  });

  const p = profile.data;
  const [tierPick, setTierPick] = useState("standard");

  return (
    <AdminLayout>
      <div className="mx-auto max-w-5xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-white" data-testid="heading-hosts">Hosts</h1>
          <p className="text-sm text-slate-400">Strikes, bans, trust tier and featured eligibility for people who host social events.</p>
        </div>

        {accountAppeals.length > 0 && (
          <section className={card} data-testid="account-appeals">
            <h2 className="mb-2 text-sm font-semibold text-white">Open appeals about strikes, bans and suspensions</h2>
            {accountAppeals.map((a) => (
              <div key={a.id} className={row}>
                <span className="min-w-0 text-slate-200"><span className="text-sky-300">{a.subjectType}</span> · @{a.appellant.username} · <span className="text-slate-400">{a.message}</span></span>
                <span className="flex gap-2">
                  <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={() => setDlg({ kind: "appeal", id: a.id, decision: "uphold" })}>Uphold</Button>
                  <Button size="sm" variant="outline" className="border-slate-600 text-slate-200" onClick={() => setDlg({ kind: "appeal", id: a.id, decision: "deny" })}>Deny</Button>
                </span>
              </div>
            ))}
          </section>
        )}

        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setSearch(term.trim()); setSel(null); }}>
          <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search by username, name or email" className="border-slate-600 bg-slate-800 text-white" data-testid="input-host-search" />
          <Button type="submit" className="bg-purple-600 hover:bg-purple-700" disabled={term.trim().length < 2} data-testid="button-host-search">Search</Button>
        </form>

        {found.data && !sel && (
          <ul className={`${card} divide-y divide-slate-700 p-0`} data-testid="host-results">
            {found.data.hosts.length === 0 && <li className="p-4 text-sm text-slate-400">No one matches.</li>}
            {found.data.hosts.map((h) => (
              <li key={h.id}><button type="button" className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-700/40" onClick={() => setSel(h.id)} data-testid={`host-${h.username}`}>
                <span className="text-slate-100">@{h.username} <span className="text-slate-400">{h.displayName}</span></span>
                <span className="text-xs text-slate-400">{h.accountAgeDays}d · {h.socialEvents} events{h.banned && <span className="ml-2 text-red-300">banned</span>}</span>
              </button></li>
            ))}
          </ul>
        )}

        {sel && p && (
          <div className="space-y-4" data-testid="host-profile">
            <Button variant="ghost" className="text-slate-300" onClick={() => setSel(null)}>← Back to results</Button>
            <section className={card}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-white">@{p.username} <span className="text-sm font-normal text-slate-400">{p.displayName}</span></h2>
                {p.banned && <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs text-red-300" data-testid="badge-banned">Banned</span>}
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-400 sm:grid-cols-4">
                <div><dt>Account age</dt><dd className="text-slate-200">{p.accountAgeDays} days</dd></div>
                <div><dt>Email</dt><dd className="text-slate-200">{p.email} {p.emailVerified ? "✓" : "✗"}</dd></div>
                <div><dt>Phone</dt><dd className="text-slate-200">{p.phone.verified ? `verified •••• ${p.phone.last4}` : "not verified"}</dd></div>
                <div><dt>Reports received</dt><dd className="text-slate-200">{p.reportsReceived.total}{p.reportsReceived.byReason.length > 0 && ` (${p.reportsReceived.byReason.map((r) => `${r.reason} ×${r.n}`).join(", ")})`}</dd></div>
              </dl>
            </section>

            <section className={card}>
              <h3 className="mb-2 text-sm font-semibold text-white">Trust</h3>
              <div className={row}>
                <span className="text-slate-200">Tier: <strong data-testid="trust-tier">{p.trust.tier}</strong>{p.trust.override && <span className="ml-2 text-xs text-amber-300">overridden: “{p.trust.override.reason}”</span>}</span>
                <span className="flex items-center gap-2">
                  <Select value={tierPick} onValueChange={setTierPick}><SelectTrigger className="h-8 w-32 border-slate-600 bg-slate-800 text-slate-200"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="new">new</SelectItem><SelectItem value="standard">standard</SelectItem><SelectItem value="trusted">trusted</SelectItem></SelectContent></Select>
                  <Button size="sm" variant="outline" className="border-slate-600 text-slate-200" onClick={() => setDlg({ kind: "tier", tier: tierPick })} data-testid="button-set-tier">Override</Button>
                  {p.trust.override && <Button size="sm" variant="ghost" className="text-slate-300" onClick={() => setDlg({ kind: "tier", tier: null })}>Clear</Button>}
                </span>
              </div>
              <div className={row}>
                <span className="text-slate-200">Featured placement: <strong data-testid="featured-state">{p.trust.featuredEligible ? "eligible" : "not eligible"}</strong>{p.trust.featuredOverride && <span className="ml-2 text-xs text-amber-300">overridden: “{p.trust.featuredOverride.reason}”</span>}</span>
                <span className="flex gap-2">
                  <Button size="sm" variant="outline" className="border-slate-600 text-slate-200" onClick={() => setDlg({ kind: "featured", eligible: true })}>Allow</Button>
                  <Button size="sm" variant="outline" className="border-slate-600 text-slate-200" onClick={() => setDlg({ kind: "featured", eligible: false })}>Block</Button>
                  {p.trust.featuredOverride && <Button size="sm" variant="ghost" className="text-slate-300" onClick={() => setDlg({ kind: "featured", eligible: null })}>Clear</Button>}
                </span>
              </div>
              <div className={row}>
                <span className="text-slate-200">Abusive reporter: {p.trust.abusiveReporter ? "yes" : "no"}</span>
                <Button size="sm" variant="outline" className="border-slate-600 text-slate-200" onClick={() => setDlg({ kind: "abusive", abusive: !p.trust.abusiveReporter })}>{p.trust.abusiveReporter ? "Remove flag" : "Mark abusive"}</Button>
              </div>
            </section>

            <section className={card}>
              <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-semibold text-white">Strikes ({p.activeStrikes} active)</h3>
                <span className="flex gap-2">
                  <Button size="sm" variant="outline" className="border-slate-600 text-slate-200" onClick={() => setDlg({ kind: "strike", type: "warn" })} data-testid="button-warn">Warn</Button>
                  <Button size="sm" variant="outline" className="border-red-500/50 text-red-300" onClick={() => setDlg({ kind: "strike", type: "strike" })} data-testid="button-strike">Strike</Button>
                  {!p.banned && <Button size="sm" className="bg-red-600 hover:bg-red-700" onClick={() => setDlg({ kind: "ban" })} data-testid="button-ban">Ban</Button>}
                </span></div>
              {p.strikes.length === 0 && <p className="text-sm text-slate-400">None.</p>}
              {p.strikes.map((s) => (
                <div key={s.id} className={row}>
                  <span className="text-slate-200"><span className={s.type === "strike" ? "text-red-300" : "text-amber-300"}>{s.type}</span> · {s.reason} <span className="text-xs text-slate-500">by {s.by}, {new Date(s.createdAt).toLocaleDateString()}{s.revokedAt ? " · revoked" : ""}</span></span>
                  {s.active && <Button size="sm" variant="ghost" className="text-slate-300" onClick={() => setDlg({ kind: "revoke", id: s.id })}>Revoke</Button>}
                </div>
              ))}
            </section>

            <section className={card}>
              <h3 className="mb-2 text-sm font-semibold text-white">Bans (account, phone number, devices)</h3>
              {p.bans.length === 0 && <p className="text-sm text-slate-400">None.</p>}
              {p.bans.map((b) => (
                <div key={b.id} className={row}>
                  <span className="text-slate-200">{b.kind} · {b.reason} <span className="text-xs text-slate-500">{new Date(b.createdAt).toLocaleDateString()}{b.liftedAt ? " · lifted" : ""}</span></span>
                  {!b.liftedAt && <Button size="sm" variant="ghost" className="text-slate-300" onClick={() => setDlg({ kind: "lift", id: b.id })}>Lift</Button>}
                </div>
              ))}
            </section>

            <section className={card}>
              <h3 className="mb-2 text-sm font-semibold text-white">Linked accounts (share a device)</h3>
              {p.linkedAccounts.length === 0 ? <p className="text-sm text-slate-400">None.</p> : p.linkedAccounts.map((l) => (
                <div key={l.userId} className={row}><button type="button" className="text-purple-300 underline" onClick={() => setSel(l.userId)}>@{l.username}</button><span className="text-xs text-slate-400">{l.sharedDevices} shared device{l.sharedDevices === 1 ? "" : "s"}{l.banned && <span className="ml-2 text-red-300">banned</span>}</span></div>
              ))}
            </section>

            <section className={card}>
              <h3 className="mb-2 text-sm font-semibold text-white">Social events</h3>
              {p.events.length === 0 ? <p className="text-sm text-slate-400">None.</p> : p.events.map((e) => (
                <div key={e.id} className={row}><span className="text-slate-200">{e.title}</span><span className="text-xs text-slate-400">{e.visibility} · {e.moderationStatus.replace("_", " ")} · {new Date(e.eventDate).toLocaleDateString()}</span></div>
              ))}
            </section>
          </div>
        )}
      </div>

      {dlg && (
        <ReasonDialog open title={dlgText(dlg).t} description={dlgText(dlg).n} confirmLabel={dlgText(dlg).c} destructive={dlgText(dlg).x} busy={run.isPending} error={err}
          onConfirm={(reason) => run.mutate({ d: dlg, reason })} onClose={() => { setDlg(null); setErr(null); }} />
      )}
    </AdminLayout>
  );
}
