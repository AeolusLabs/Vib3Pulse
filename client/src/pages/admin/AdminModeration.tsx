import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import AdminLayout from "./AdminLayout";
import ReasonDialog from "@/components/admin/ReasonDialog";
import RevealPanel from "@/components/admin/RevealPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangleIcon, ChevronRightIcon, ClockIcon } from "@/components/ui/icons";

type Action = "approve" | "reject" | "hide" | "restore" | "request_edit" | "remove";
type Item = {
  eventId: string; title: string; description: string; socialType: string; eventDate: string; area: string; ageRestriction: string; servesAlcohol: boolean;
  rsvp: { capacity: number; headcount: number }; moderationStatus: string; queueReason: string | null; flags: string[]; hoursInQueue: number | null; slaBreached: boolean;
  reports: { total: number; credible: number; reasons: Array<{ reason: string; count: number }> };
  openAppeal: { id: string; message: string } | null;
  host: { id: string; username: string | null; accountAgeDays: number; emailVerified: boolean; phoneVerified: boolean; tier: string; banned: boolean; pastEvents: number; removedOrRejectedEvents: number; strikes: { active: number; total: number; warns: number }; reportsReceived: number };
};
type Report = { id: string; reason: string; description: string | null; status: string; reporter: { id: string; username: string; markedAbusive: boolean } };

const ACTIONS_BY_STATUS: Record<string, Action[]> = {
  pending: ["approve", "reject", "request_edit", "hide", "remove"],
  hidden: ["restore", "request_edit", "remove"],
  rejected: ["restore", "remove"],
  changes_requested: ["approve", "reject", "remove"],
  approved: ["hide", "remove"],
};
const LABEL: Record<Action, string> = { approve: "Approve", reject: "Reject", hide: "Hide", restore: "Restore", request_edit: "Request edit", remove: "Remove permanently" };
const DESTRUCTIVE = new Set<Action>(["reject", "remove", "hide"]);
const REASON_LABEL: Record<string, string> = { new_account_review: "New account review", report_threshold: "Auto-hidden by reports", auto_flag: "Auto-flagged", admin_hidden: "Hidden by admin", edit_requested: "Edit requested", host_banned: "Host banned" };
const FLAG_LABEL: Record<string, string> = { external_link: "External link", contact_pattern: "Contact details", free_entry_payment: "Free entry → payment" };
const TIER_STYLE: Record<string, string> = { new: "bg-amber-500/15 text-amber-300", standard: "bg-slate-600/40 text-slate-200", trusted: "bg-emerald-500/15 text-emerald-300" };

const chip = (cls: string, text: string, key?: string) => <span key={key ?? text} className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>{text}</span>;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const hoursLabel = (h: number | null) => (h === null ? "—" : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);

type Pending =
  | { kind: "action"; action: Action; ids: string[] }
  | { kind: "appeal"; appealId: string; decision: "uphold" | "deny" }
  | { kind: "dismiss" | "abusive"; reportId: string };

export default function AdminModeration() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [filters, setFilters] = useState({ flag: "all", tier: "all", sort: "event_date", minReports: "", minAgeHours: "" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (filters.flag !== "all") p.set("flag", filters.flag);
    if (filters.tier !== "all") p.set("tier", filters.tier);
    if (filters.minReports) p.set("minReports", filters.minReports);
    if (filters.minAgeHours) p.set("minAgeHours", filters.minAgeHours);
    p.set("sort", filters.sort);
    return p.toString();
  }, [filters]);
  const queueKey = `/api/admin/moderation/queue?${qs}`;
  const queue = useQuery<{ items: Item[]; total: number; slaHours: number; slaBreached: number }>({ queryKey: [queueKey], refetchInterval: 60_000 });
  const me = useQuery<{ role: string }>({ queryKey: ["/api/admin/me"] });
  const reports = useQuery<{ reports: Report[] }>({ queryKey: [`/api/admin/moderation/events/${open}/reports`], enabled: !!open });

  const refresh = () => { qc.invalidateQueries({ queryKey: [queueKey] }); qc.invalidateQueries({ queryKey: [`/api/admin/moderation/events/${open}/reports`] }); };

  const run = useMutation({
    mutationFn: async ({ p, reason }: { p: Pending; reason: string }) => {
      if (p.kind === "action") {
        if (p.ids.length > 1) return (await apiRequest("POST", "/api/admin/moderation/bulk", { eventIds: p.ids, action: p.action, reason })).json();
        return (await apiRequest("POST", `/api/admin/moderation/events/${p.ids[0]}/action`, { action: p.action, reason })).json();
      }
      if (p.kind === "appeal") return (await apiRequest("POST", `/api/admin/moderation/appeals/${p.appealId}/resolve`, { decision: p.decision, reason })).json();
      return (await apiRequest("POST", `/api/admin/moderation/reports/${p.reportId}/${p.kind === "dismiss" ? "dismiss" : "mark-abusive"}`, { reason })).json();
    },
    onSuccess: (j, v) => {
      setPending(null); setDialogError(null); setSelected(new Set()); refresh();
      toast({ title: v.p.kind === "action" && v.p.ids.length > 1 ? `Done: ${j.succeeded} succeeded${j.failed ? `, ${j.failed} skipped` : ""}` : "Done", description: "Recorded in the audit log." });
    },
    onError: (e: Error) => setDialogError(e.message),
  });

  const items = queue.data?.items ?? [];
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const dialog = pending && (pending.kind === "action"
    ? { title: `${LABEL[pending.action]}${pending.ids.length > 1 ? ` ${pending.ids.length} events` : ""}`, desc: ["approve", "restore"].includes(pending.action) ? "The host is told it's live." : "The host is told why and how to appeal.", confirm: LABEL[pending.action], destructive: DESTRUCTIVE.has(pending.action) }
    : pending.kind === "appeal" ? { title: pending.decision === "uphold" ? "Uphold appeal" : "Deny appeal", desc: "The host is told the decision and your note.", confirm: pending.decision === "uphold" ? "Uphold" : "Deny", destructive: pending.decision === "deny" }
    : pending.kind === "dismiss" ? { title: "Dismiss report", desc: "It stops counting toward auto-hide.", confirm: "Dismiss", destructive: false }
    : { title: "Mark reporter as abusive", desc: "Their reports stop counting and their other open reports are dismissed.", confirm: "Mark abusive", destructive: true });

  return (
    <AdminLayout>
      <div className="mx-auto max-w-5xl">
        <div className="mb-4 flex items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white" data-testid="heading-moderation">Moderation queue</h1>
            <p className="text-sm text-slate-400">Public social events held for review, auto-hidden, flagged, or appealed. Soonest events first.</p>
          </div>
          <p className="text-sm text-slate-400" data-testid="queue-count">{queue.data ? `${queue.data.total} in queue` : ""}</p>
        </div>

        {!!queue.data?.slaBreached && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200" data-testid="sla-banner">
            <AlertTriangleIcon className="h-4 w-4" />{queue.data.slaBreached} item{queue.data.slaBreached === 1 ? " has" : "s have"} waited longer than the {queue.data.slaHours}h target.
          </div>
        )}

        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Select value={filters.flag} onValueChange={(v) => setFilters({ ...filters, flag: v })}>
            <SelectTrigger className="border-slate-600 bg-slate-800 text-slate-200" data-testid="filter-flag"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All flags</SelectItem>
              {Object.entries(FLAG_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
              {Object.entries(REASON_LABEL).slice(0, 4).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filters.tier} onValueChange={(v) => setFilters({ ...filters, tier: v })}>
            <SelectTrigger className="border-slate-600 bg-slate-800 text-slate-200" data-testid="filter-tier"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">Any host tier</SelectItem><SelectItem value="new">New</SelectItem><SelectItem value="standard">Standard</SelectItem><SelectItem value="trusted">Trusted</SelectItem></SelectContent>
          </Select>
          <Select value={filters.sort} onValueChange={(v) => setFilters({ ...filters, sort: v })}>
            <SelectTrigger className="border-slate-600 bg-slate-800 text-slate-200" data-testid="filter-sort"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="event_date">Event date (soonest)</SelectItem><SelectItem value="queued_oldest">Longest in queue</SelectItem><SelectItem value="reports">Most reports</SelectItem></SelectContent>
          </Select>
          <Input inputMode="numeric" placeholder="Min reports" value={filters.minReports} onChange={(e) => setFilters({ ...filters, minReports: e.target.value.replace(/\D/g, "") })} className="border-slate-600 bg-slate-800 text-white" data-testid="filter-reports" />
          <Input inputMode="numeric" placeholder="In queue ≥ hours" value={filters.minAgeHours} onChange={(e) => setFilters({ ...filters, minAgeHours: e.target.value.replace(/\D/g, "") })} className="border-slate-600 bg-slate-800 text-white" data-testid="filter-age" />
        </div>

        {selected.size > 0 && (
          <div className="sticky top-2 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-purple-500/40 bg-slate-800 px-3 py-2" data-testid="bulk-bar">
            <span className="text-sm text-slate-200">{selected.size} selected</span>
            {(["approve", "reject", "hide", "request_edit"] as Action[]).map((a) => (
              <Button key={a} size="sm" variant="outline" className="border-slate-600 text-slate-200" onClick={() => setPending({ kind: "action", action: a, ids: Array.from(selected) })} data-testid={`bulk-${a}`}>{LABEL[a]}</Button>
            ))}
            <Button size="sm" variant="ghost" className="ml-auto text-slate-400" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        )}

        {queue.isLoading && <div className="space-y-3"><Skeleton className="h-24 bg-slate-800" /><Skeleton className="h-24 bg-slate-800" /></div>}
        {queue.isError && <p className="rounded-lg border border-slate-700 p-6 text-center text-sm text-slate-400">Couldn't load the queue.</p>}
        {queue.data && items.length === 0 && <p className="rounded-lg border border-dashed border-slate-700 p-10 text-center text-slate-400" data-testid="queue-empty">Nothing waiting. The queue is clear.</p>}

        <ul className="space-y-3">
          {items.map((it) => {
            const isOpen = open === it.eventId;
            const acts = ACTIONS_BY_STATUS[it.moderationStatus] ?? [];
            return (
              <li key={it.eventId} className="rounded-xl border border-slate-700 bg-slate-800/50" data-testid={`queue-item-${it.eventId}`}>
                <div className="flex items-start gap-3 p-4">
                  <input type="checkbox" className="mt-1.5" checked={selected.has(it.eventId)} onChange={() => toggle(it.eventId)} aria-label={`Select ${it.title}`} data-testid={`select-${it.eventId}`} />
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(isOpen ? null : it.eventId)} aria-expanded={isOpen}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-white">{it.title}</span>
                      {chip(it.moderationStatus === "hidden" ? "bg-red-500/15 text-red-300" : it.moderationStatus === "pending" ? "bg-blue-500/15 text-blue-300" : "bg-slate-600/40 text-slate-200", it.moderationStatus.replace("_", " "))}
                      {it.queueReason && chip("bg-purple-500/15 text-purple-300", REASON_LABEL[it.queueReason] ?? it.queueReason)}
                      {it.flags.map((f) => chip("bg-amber-500/15 text-amber-300", FLAG_LABEL[f] ?? f))}
                      {it.reports.total > 0 && chip("bg-red-500/15 text-red-300", `${it.reports.credible} credible report${it.reports.credible === 1 ? "" : "s"}`)}
                      {it.openAppeal && chip("bg-sky-500/15 text-sky-300", "Appeal open")}
                    </div>
                    <p className="mt-1 text-xs text-slate-400">{when(it.eventDate)} · {it.area} · {it.rsvp.headcount}/{it.rsvp.capacity} RSVPs</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-slate-400">
                      <span>Host @{it.host.username ?? "unknown"}</span>
                      {chip(TIER_STYLE[it.host.tier] ?? "", it.host.tier)}
                      <span>{it.host.accountAgeDays}d old</span>
                      <span>{it.host.pastEvents} events</span>
                      {it.host.strikes.active > 0 && <span className="text-red-300">{it.host.strikes.active} active strike{it.host.strikes.active === 1 ? "" : "s"}</span>}
                      {it.host.banned && <span className="text-red-300">banned</span>}
                      <span className={`ml-auto inline-flex items-center gap-1 ${it.slaBreached ? "font-medium text-amber-300" : ""}`} data-testid={`age-${it.eventId}`}><ClockIcon className="h-3 w-3" />{hoursLabel(it.hoursInQueue)} in queue</span>
                    </p>
                  </button>
                  <ChevronRightIcon className={`mt-1 h-4 w-4 text-slate-500 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                </div>

                {isOpen && (
                  <div className="space-y-4 border-t border-slate-700 p-4" data-testid={`detail-${it.eventId}`}>
                    <p className="whitespace-pre-wrap text-sm text-slate-200">{it.description}</p>
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-slate-400 sm:grid-cols-4">
                      <div><dt>Type</dt><dd className="text-slate-200">{it.socialType}</dd></div>
                      <div><dt>Age limit</dt><dd className="text-slate-200">{it.ageRestriction}{it.servesAlcohol ? " · alcohol" : ""}</dd></div>
                      <div><dt>Host verified</dt><dd className="text-slate-200">email {it.host.emailVerified ? "✓" : "✗"} · phone {it.host.phoneVerified ? "✓" : "✗"}</dd></div>
                      <div><dt>Host history</dt><dd className="text-slate-200">{it.host.strikes.total} strikes · {it.host.strikes.warns} warns · {it.host.removedOrRejectedEvents} taken down · {it.host.reportsReceived} reports</dd></div>
                    </dl>

                    {it.openAppeal && (
                      <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
                        <p className="text-xs font-medium text-sky-300">Host's appeal</p>
                        <p className="mt-1 text-sm text-slate-200">{it.openAppeal.message}</p>
                        <div className="mt-2 flex gap-2">
                          <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={() => setPending({ kind: "appeal", appealId: it.openAppeal!.id, decision: "uphold" })} data-testid="button-appeal-uphold">Uphold</Button>
                          <Button size="sm" variant="outline" className="border-slate-600 text-slate-200" onClick={() => setPending({ kind: "appeal", appealId: it.openAppeal!.id, decision: "deny" })} data-testid="button-appeal-deny">Deny</Button>
                        </div>
                      </div>
                    )}

                    {it.reports.total > 0 && (
                      <div>
                        <p className="mb-1 text-xs font-medium text-slate-300">Reports ({it.reports.reasons.map((r) => `${r.reason} ×${r.count}`).join(", ")})</p>
                        <ul className="divide-y divide-slate-700 rounded-lg border border-slate-700 text-sm">
                          {(reports.data?.reports ?? []).map((r) => (
                            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                              <span className="text-slate-200">@{r.reporter.username} · <span className="text-slate-400">{r.reason}{r.description ? ` — ${r.description}` : ""}</span>{r.reporter.markedAbusive && chip("ml-2 bg-red-500/15 text-red-300", "abusive reporter")}{r.status === "dismissed" && chip("ml-2 bg-slate-600/40 text-slate-300", "dismissed")}</span>
                              {r.status !== "dismissed" && (
                                <span className="flex gap-2">
                                  <Button size="sm" variant="ghost" className="h-7 text-slate-300" onClick={() => setPending({ kind: "dismiss", reportId: r.id })}>Dismiss</Button>
                                  {!r.reporter.markedAbusive && <Button size="sm" variant="ghost" className="h-7 text-red-300" onClick={() => setPending({ kind: "abusive", reportId: r.id })}>Mark abusive</Button>}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <RevealPanel eventId={it.eventId} role={me.data?.role ?? ""} cases={[{ caseType: "moderation_item", caseId: it.eventId, label: "This moderation item" }, ...(reports.data?.reports ?? []).map((r) => ({ caseType: "report" as const, caseId: r.id, label: `Report by @${r.reporter.username} (${r.reason})` }))]} />

                    <div className="flex flex-wrap gap-2" data-testid={`actions-${it.eventId}`}>
                      {acts.map((a) => (
                        <Button key={a} size="sm" variant={DESTRUCTIVE.has(a) ? "outline" : "default"} className={DESTRUCTIVE.has(a) ? "border-red-500/50 text-red-300 hover:bg-red-500/10" : "bg-purple-600 hover:bg-purple-700"} onClick={() => setPending({ kind: "action", action: a, ids: [it.eventId] })} data-testid={`action-${a}-${it.eventId}`}>{LABEL[a]}</Button>
                      ))}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {dialog && pending && (
        <ReasonDialog open title={dialog.title} description={dialog.desc} confirmLabel={dialog.confirm} destructive={dialog.destructive} busy={run.isPending} error={dialogError}
          onConfirm={(reason) => run.mutate({ p: pending, reason })} onClose={() => { setPending(null); setDialogError(null); }} />
      )}
    </AdminLayout>
  );
}
