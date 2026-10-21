import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import AdminLayout from "./AdminLayout";
import AdminDateRangePicker from "@/components/admin/AdminDateRangePicker";
import ReasonDialog from "@/components/admin/ReasonDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangleIcon, Loader2Icon, LockIcon, PauseIcon, PlayIcon, ShieldIcon } from "@/components/ui/icons";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// Rooms admin (rooms admin plan, task 6). One screen for what an admin needs when something looks wrong: who is live right now,
// where the money went, and the switches that stop new money. A pause or freeze stops NEW money only; money already settled to a
// bank cannot be recalled from here. Every action asks for a reason and is audit-logged by the server.

type Tab = "live" | "reported" | "money" | "controls";
type Me = { role: string };
type LiveRoom = { id: string; title: string; hostId: string; hostUsername: string; ageLimit: string; members: number; startedAt: string | null; ticketed: boolean; hostFrozen: boolean };
type ReportedRoom = { roomId: string; title: string; status: string; ageLimit: string; hostId: string; host: { username?: string; displayName?: string } | null; reports: { id: string; reason: string; description?: string | null }[] };
type Controls = { spraysPaused: boolean; ticketsPaused: boolean; frozenHosts: { hostId: string; username: string; reason: string; frozenAt: string }[] };
type Overview = { roomsCreated: number; roomsStarted: number; uniqueHosts: number; peakConcurrent: number; ticketsSold: number };
type Sprays = {
  totals: { count: number; grossKobo: number; vatKobo: number; feeKobo: number; reserveKobo: number; platformKobo: number; hostKobo: number; refundedKobo: number };
  byTier: { tier: string; count: number; grossKobo: number }[];
  byDay: { day: string; count: number; grossKobo: number }[];
  topRooms: { roomId: string; title: string; count: number; grossKobo: number }[];
  topHosts: { hostId: string; username: string; count: number; grossKobo: number }[];
};
type Finance = {
  tickets: { status: string; count: number; grossKobo: number; platformKobo: number; hostKobo: number }[];
  payouts: { status: string; count: number; amountKobo: number }[];
  alerts: { id: string; kind: string; reference: string | null; error: string | null }[];
};

const MONEY_ROLES = ["super_admin", "finance_manager"];
const MOD_ROLES = ["super_admin", "content_moderator"];
const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: kobo % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
const ymd = (d: Date) => format(d, "yyyy-MM-dd");
const TIER_LABEL: Record<string, string> = { note: "Note", bundle: "Bundle", bag: "Money bag", rain: "Rain" };

const panel = "rounded-xl border border-slate-700 bg-slate-800/50";
const th = "px-2.5 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-400";
const td = "px-2.5 py-2 text-sm text-slate-200";
const num = "px-2.5 py-2 text-right text-sm tabular-nums text-slate-200";

function Msg({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "error" }) {
  return <p role={tone === "error" ? "alert" : "status"} className={`py-8 text-center text-sm ${tone === "error" ? "text-red-400" : "text-slate-400"}`}>{children}</p>;
}

function Status({ paused, label }: { paused: boolean; label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2" data-testid={`status-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      {paused ? <PauseIcon className="h-4 w-4 shrink-0 text-amber-400" aria-hidden /> : <PlayIcon className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden />}
      <span className="text-sm text-slate-300">{label}</span>
      <span className={`text-sm font-semibold ${paused ? "text-amber-300" : "text-emerald-300"}`}>{paused ? "Paused" : "Running"}</span>
    </div>
  );
}

function useAction(invalidate: string[]) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (a: { method: string; url: string; body?: unknown; done: string }) => {
      const res = await apiRequest(a.method, a.url, a.body);
      return { json: await res.json().catch(() => ({})), done: a.done };
    },
    onSuccess: ({ json, done }) => {
      toast({ title: json?.changed === false ? "Nothing changed, it was already in that state" : done });
      for (const k of invalidate) void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith(k) });
    },
  });
}

const errText = (e: unknown) => {
  const m = e instanceof Error ? e.message : "";
  if (m.includes("SUPER_ADMIN_ONLY") || m.startsWith("403")) return "Your role cannot do this.";
  if (m.includes("REASON_REQUIRED")) return "Add a reason of at least 3 characters.";
  return "That did not work. Check the current state before trying again.";
};

/** Reason plus the option to end the host's live rooms too. */
function FreezeHostDialog({ host, busy, error, onConfirm, onClose }: { host: { id: string; name: string } | null; busy: boolean; error: string | null; onConfirm: (reason: string, endLiveRooms: boolean) => void; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [endRooms, setEndRooms] = useState(false);
  const ok = reason.trim().length >= 3;
  return (
    <Dialog open={!!host} onOpenChange={(o) => { if (!o) { setReason(""); setEndRooms(false); onClose(); } }}>
      <DialogContent className="border-slate-700 bg-slate-800 text-white sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Freeze {host?.name}</DialogTitle>
          <DialogDescription className="text-slate-400">
            Stops new sprays and new ticket sales for this host and holds their payouts that have not been sent. Money already paid out is not touched.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); if (ok && !busy) onConfirm(reason.trim(), endRooms); }} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="freeze-reason" className="text-slate-300">Reason (recorded in the audit log)</Label>
            <Textarea id="freeze-reason" rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus className="border-slate-600 bg-slate-700 text-white" data-testid="input-freeze-reason" />
          </div>
          <div className="flex items-start gap-3">
            <Checkbox id="freeze-end" checked={endRooms} onCheckedChange={(v) => setEndRooms(v === true)} className="mt-0.5" data-testid="check-freeze-end-rooms" />
            <Label htmlFor="freeze-end" className="text-sm font-normal leading-snug text-slate-300">Also end their live rooms now. This cuts any stream in progress.</Label>
          </div>
          {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="ghost" onClick={onClose} className="min-h-[44px] text-slate-300">Cancel</Button>
            <Button type="submit" disabled={!ok || busy} className="min-h-[44px] bg-red-600 hover:bg-red-700" data-testid="button-freeze-confirm">
              {busy && <Loader2Icon className="mr-2 h-4 w-4 animate-spin" aria-hidden />}Freeze host
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LiveTab({ canFreeze }: { canFreeze: boolean }) {
  const { data, isLoading, error, refetch } = useQuery<{ rooms: LiveRoom[] }>({ queryKey: ["/api/admin/rooms/live"], refetchInterval: 15_000 });
  const act = useAction(["/api/admin/rooms"]);
  const [ending, setEnding] = useState<LiveRoom | null>(null);
  const [freezing, setFreezing] = useState<LiveRoom | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (isLoading) return <Msg>Loading live rooms...</Msg>;
  if (error) return <Msg tone="error">Could not load live rooms. <button className="underline" onClick={() => refetch()}>Try again</button></Msg>;
  const rooms = data?.rooms ?? [];
  return (
    <section aria-labelledby="live-h">
      <h2 id="live-h" className="mb-1 text-lg font-semibold text-white">Live now</h2>
      <p className="mb-4 text-sm text-slate-400">Refreshes every 15 seconds. Ending a room cuts the stream and tells everyone inside.</p>
      {rooms.length === 0 ? <Msg>No rooms are live right now.</Msg> : (
        <ul className={`${panel} divide-y divide-slate-700`} data-testid="live-list">
          {rooms.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4" data-testid={`live-room-${r.id}`}>
              <div className="min-w-0 flex-1 basis-56">
                <p className="truncate font-medium text-white">{r.title}</p>
                <p className="mt-0.5 text-sm text-slate-400">
                  Host {r.hostUsername} · {r.ageLimit} · {r.members} {r.members === 1 ? "person" : "people"} inside{r.ticketed ? " · ticketed" : ""}
                </p>
                {r.hostFrozen && <p className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-amber-300"><LockIcon className="h-3.5 w-3.5" aria-hidden />Host frozen</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => { setErr(null); setEnding(r); }} className="min-h-[44px] border-slate-600 text-slate-100" data-testid={`button-end-${r.id}`}>End room</Button>
                {canFreeze && !r.hostFrozen && (
                  <Button variant="outline" onClick={() => { setErr(null); setFreezing(r); }} className="min-h-[44px] border-red-500/60 text-red-300 hover:bg-red-950/40" data-testid={`button-freeze-${r.id}`}>Freeze host</Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <ReasonDialog
        open={!!ending} title={`End "${ending?.title ?? ""}"`} description="This cuts the stream now and cannot be undone. People inside are told the room has ended."
        confirmLabel="End room" destructive busy={act.isPending} error={err} onClose={() => setEnding(null)}
        onConfirm={(reason) => act.mutate({ method: "POST", url: `/api/admin/rooms/${ending!.id}/end`, body: { reason }, done: "Room ended" }, { onSuccess: () => setEnding(null), onError: (e) => setErr(errText(e)) })}
      />
      <FreezeHostDialog
        host={freezing ? { id: freezing.hostId, name: freezing.hostUsername } : null} busy={act.isPending} error={err} onClose={() => setFreezing(null)}
        onConfirm={(reason, endLiveRooms) => act.mutate({ method: "POST", url: `/api/admin/rooms/hosts/${freezing!.hostId}/freeze`, body: { reason, endLiveRooms }, done: "Host frozen" }, { onSuccess: () => setFreezing(null), onError: (e) => setErr(errText(e)) })}
      />
    </section>
  );
}

function ReportedTab() {
  const { data, isLoading, error, refetch } = useQuery<{ rooms: ReportedRoom[] }>({ queryKey: ["/api/admin/rooms/reported"] });
  if (isLoading) return <Msg>Loading reported rooms...</Msg>;
  if (error) return <Msg tone="error">Could not load reported rooms. <button className="underline" onClick={() => refetch()}>Try again</button></Msg>;
  const rooms = data?.rooms ?? [];
  return (
    <section aria-labelledby="rep-h">
      <h2 id="rep-h" className="mb-1 text-lg font-semibold text-white">Reported rooms</h2>
      <p className="mb-4 text-sm text-slate-400">Rooms with reports still waiting for a decision, newest first. End a live one from the Live now tab.</p>
      {rooms.length === 0 ? <Msg>No reports are waiting.</Msg> : (
        <ul className={`${panel} divide-y divide-slate-700`} data-testid="reported-list">
          {rooms.map((r) => (
            <li key={r.roomId} className="p-4">
              <p className="font-medium text-white">{r.title} <span className="ml-1 text-sm font-normal text-slate-400">{r.status} · {r.ageLimit} · host {r.host?.username ?? r.host?.displayName ?? "unknown"}</span></p>
              <ul className="mt-2 space-y-1">
                {r.reports.map((p) => (
                  <li key={p.id} className="text-sm text-slate-300"><span className="font-medium text-slate-100">{p.reason}</span>{p.description ? `: ${p.description}` : ""}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-2.5">
      <dt className={`text-sm ${strong ? "font-medium text-white" : "text-slate-300"}`}>{label}</dt>
      <dd className={`tabular-nums ${strong ? "text-base font-semibold text-white" : "text-sm text-slate-200"}`}>{value}</dd>
    </div>
  );
}

function SmallTable({ caption, head, rows, empty = "Nothing in this range." }: { caption: string; head: string[]; rows: (string | number)[][]; empty?: string }) {
  return (
    <div className={`${panel} overflow-x-auto`}>
      <table className="w-full">
        <caption className="px-4 pt-3 text-left text-sm font-medium text-white">{caption}</caption>
        <thead><tr>{head.map((h, i) => <th key={h} className={`${th} ${i > 0 ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-slate-700/60">
          {rows.length === 0 ? <tr><td className={`${td} text-slate-400`} colSpan={head.length}>{empty}</td></tr> : rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} className={j === 0 ? `${td} max-w-[7.5rem] truncate sm:max-w-[14rem]` : num}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MoneyTab() {
  const [range, setRange] = useState<{ from?: Date; to?: Date }>(() => ({ from: new Date(Date.now() - 30 * 864e5), to: new Date() }));
  const qs = useMemo(() => `from=${range.from ? ymd(range.from) : ymd(new Date(Date.now() - 30 * 864e5))}&to=${range.to ? ymd(range.to) : ymd(new Date())}`, [range]);
  const sprays = useQuery<Sprays>({ queryKey: [`/api/admin/rooms/sprays?${qs}`] });
  const overview = useQuery<Overview>({ queryKey: [`/api/admin/rooms/overview?${qs}`] });
  const finance = useQuery<Finance>({ queryKey: ["/api/admin/finance/room-tickets"] });
  const s = sprays.data;
  return (
    <section aria-labelledby="money-h" className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="money-h" className="text-lg font-semibold text-white">Money</h2>
          <p className="text-sm text-slate-400">Days are in UTC. Sales count sprays that were delivered.</p>
        </div>
        <AdminDateRangePicker from={range.from} to={range.to} onChange={setRange} className="min-h-[44px] border-slate-600 bg-slate-800 text-slate-100" />
      </div>

      {(sprays.error || overview.error) && <Msg tone="error">Could not load this range. Pick a range of up to 366 days, or try again.</Msg>}
      {sprays.isLoading && <Msg>Loading...</Msg>}

      {s && (
        <>
          <dl className={`${panel} divide-y divide-slate-700/60`} data-testid="spray-totals">
            <Row label={`Sprays delivered (${s.totals.count})`} value={naira(s.totals.grossKobo)} strong />
            <Row label="VAT" value={naira(s.totals.vatKobo)} />
            <Row label="Card fees" value={naira(s.totals.feeKobo)} />
            <Row label="Fraud reserve" value={naira(s.totals.reserveKobo)} />
            <Row label="Platform share" value={naira(s.totals.platformKobo)} />
            <Row label="Host share" value={naira(s.totals.hostKobo)} />
            <Row label="Reversed and refunded" value={naira(s.totals.refundedKobo)} />
          </dl>
          {overview.data && (
            <p className="text-sm text-slate-400" data-testid="overview-line">
              In this range: {overview.data.roomsCreated} rooms created, {overview.data.roomsStarted} started by {overview.data.uniqueHosts} hosts, busiest room {overview.data.peakConcurrent} people, {overview.data.ticketsSold} tickets sold.
            </p>
          )}
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <SmallTable caption="By tier" head={["Tier", "Sprays", "Amount"]} rows={s.byTier.map((t) => [TIER_LABEL[t.tier] ?? t.tier, t.count, naira(t.grossKobo)])} />
            <SmallTable caption="By day (UTC)" head={["Day", "Sprays", "Amount"]} rows={s.byDay.map((d) => [d.day, d.count, naira(d.grossKobo)])} />
            <SmallTable caption="Top rooms" head={["Room", "Sprays", "Amount"]} rows={s.topRooms.map((r) => [r.title, r.count, naira(r.grossKobo)])} />
            <SmallTable caption="Top hosts" head={["Host", "Sprays", "Amount"]} rows={s.topHosts.map((h) => [h.username, h.count, naira(h.grossKobo)])} />
          </div>
        </>
      )}

      <div className="space-y-4">
        <h3 className="text-base font-semibold text-white">Tickets and payouts</h3>
        {finance.isLoading && <Msg>Loading...</Msg>}
        {finance.error && <Msg tone="error">Could not load ticket totals.</Msg>}
        {finance.data && (
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <SmallTable caption="Ticket sales (all time)" head={["Status", "Tickets", "Gross"]} rows={finance.data.tickets.map((t) => [t.status, t.count, naira(t.grossKobo)])} empty="No ticket sales yet." />
            <SmallTable caption="Host payouts (all time)" head={["Status", "Payouts", "Amount"]} rows={finance.data.payouts.map((p) => [p.status, p.count, naira(p.amountKobo)])} empty="No payouts yet." />
          </div>
        )}
        {finance.data && finance.data.alerts.length > 0 && (
          <div className={`${panel} p-4`} data-testid="finance-alerts">
            <p className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-300"><AlertTriangleIcon className="h-4 w-4" aria-hidden />{finance.data.alerts.length} items need a person</p>
            <ul className="space-y-1.5">
              {finance.data.alerts.slice(0, 10).map((a) => <li key={a.id} className="break-words text-sm text-slate-300"><span className="font-medium text-slate-100">{a.kind.replace(/_/g, " ")}</span>{a.reference ? ` ${a.reference}` : ""}{a.error ? `: ${a.error}` : ""}</li>)}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

function ControlsTab({ isSuper }: { isSuper: boolean }) {
  const { data, isLoading, error, refetch } = useQuery<Controls>({ queryKey: ["/api/admin/rooms/controls"] });
  const act = useAction(["/api/admin/rooms"]);
  const [toggle, setToggle] = useState<{ key: "sprays_paused" | "tickets_paused"; on: boolean } | null>(null);
  const [unfreeze, setUnfreeze] = useState<{ hostId: string; username: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (isLoading) return <Msg>Loading controls...</Msg>;
  if (error || !data) return <Msg tone="error">Could not load the controls. <button className="underline" onClick={() => refetch()}>Try again</button></Msg>;

  const items = [
    { key: "sprays_paused" as const, label: "Pause all spraying", paused: data.spraysPaused, help: "No new sprays anywhere. A spray that is already paid still arrives." },
    { key: "tickets_paused" as const, label: "Pause all ticket sales", paused: data.ticketsPaused, help: "No new ticket purchases anywhere. Tickets already bought stay valid." },
  ];
  return (
    <section aria-labelledby="ctl-h" className="space-y-6">
      <div>
        <h2 id="ctl-h" className="text-lg font-semibold text-white">Controls</h2>
        <p className="mt-2 flex items-start gap-2 text-sm text-slate-300" data-testid="settled-warning">
          <ShieldIcon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
          <span>A pause stops new money only. Money already settled to a bank cannot be recalled here.</span>
        </p>
      </div>

      <ul className={`${panel} divide-y divide-slate-700`}>
        {items.map((i) => (
          <li key={i.key} className="flex items-center justify-between gap-4 p-4" data-testid={`control-${i.key}`}>
            <div className="min-w-0">
              <p className="font-medium text-white">{i.label}</p>
              <p className="mt-0.5 text-sm text-slate-400">{i.help}</p>
              <p className={`mt-1 text-sm font-semibold ${i.paused ? "text-amber-300" : "text-emerald-300"}`}>{i.paused ? "Paused" : "Running"}</p>
              {i.paused && !isSuper && <p className="mt-1 text-xs text-slate-500">Only a super-admin can resume this.</p>}
            </div>
            <Switch
              checked={i.paused} disabled={i.paused && !isSuper} aria-label={i.label}
              onCheckedChange={(on) => { setErr(null); setToggle({ key: i.key, on }); }} data-testid={`switch-${i.key}`}
            />
          </li>
        ))}
      </ul>

      <div>
        <h3 className="mb-2 text-base font-semibold text-white">Frozen hosts</h3>
        {data.frozenHosts.length === 0 ? <Msg>No hosts are frozen.</Msg> : (
          <ul className={`${panel} divide-y divide-slate-700`} data-testid="frozen-list">
            {data.frozenHosts.map((h) => (
              <li key={h.hostId} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="font-medium text-white">{h.username}</p>
                  <p className="mt-0.5 break-words text-sm text-slate-400">{h.reason} · since {format(new Date(h.frozenAt), "d MMM yyyy, HH:mm")}</p>
                </div>
                <Button variant="outline" disabled={!isSuper} onClick={() => { setErr(null); setUnfreeze(h); }} className="min-h-[44px] border-slate-600 text-slate-100" data-testid={`button-unfreeze-${h.hostId}`}>Unfreeze</Button>
              </li>
            ))}
          </ul>
        )}
        {!isSuper && data.frozenHosts.length > 0 && <p className="mt-2 text-xs text-slate-500">Only a super-admin can unfreeze a host. Unfreezing does not release payouts; release those room by room in Finance.</p>}
      </div>

      <ReasonDialog
        open={!!toggle} title={toggle?.on ? (toggle.key === "sprays_paused" ? "Pause all spraying" : "Pause all ticket sales") : "Resume"}
        description={toggle?.on ? "New money stops within a few seconds. Money already settled to a bank is not affected." : "New money starts again for everyone within a few seconds."}
        confirmLabel={toggle?.on ? "Pause" : "Resume"} destructive={toggle?.on} busy={act.isPending} error={err} minLength={3} onClose={() => setToggle(null)}
        onConfirm={(reason) => act.mutate({ method: "POST", url: `/api/admin/rooms/controls/${toggle!.key}`, body: { on: toggle!.on, reason }, done: toggle!.on ? "Paused" : "Resumed" }, { onSuccess: () => setToggle(null), onError: (e) => setErr(errText(e)) })}
      />
      <ReasonDialog
        open={!!unfreeze} title={`Unfreeze ${unfreeze?.username ?? ""}`} description="They can receive sprays and sell tickets again. Held payouts stay held until you release them."
        confirmLabel="Unfreeze" busy={act.isPending} error={err} minLength={3} onClose={() => setUnfreeze(null)}
        onConfirm={(reason) => act.mutate({ method: "POST", url: `/api/admin/rooms/hosts/${unfreeze!.hostId}/unfreeze`, body: { reason }, done: "Host unfrozen" }, { onSuccess: () => setUnfreeze(null), onError: (e) => setErr(errText(e)) })}
      />
    </section>
  );
}

export default function AdminRooms() {
  const me = useQuery<Me>({ queryKey: ["/api/admin/me"], retry: false });
  const role = me.data?.role ?? "";
  const canMoney = MONEY_ROLES.includes(role);
  const canMod = MOD_ROLES.includes(role);
  const controls = useQuery<Controls>({ queryKey: ["/api/admin/rooms/controls"], enabled: canMoney });
  const tabs = ([
    canMod && { id: "live" as const, label: "Live now" },
    canMod && { id: "reported" as const, label: "Reported" },
    canMoney && { id: "money" as const, label: "Money" },
    canMoney && { id: "controls" as const, label: "Controls" },
  ].filter(Boolean)) as { id: Tab; label: string }[];
  const [picked, setPicked] = useState<Tab | null>(null);
  const tab = picked && tabs.some((t) => t.id === picked) ? picked : tabs[0]?.id;

  return (
    <AdminLayout>
      <div className="mx-auto w-full max-w-5xl">
        <h1 className="text-2xl font-bold text-white" data-testid="heading-admin-rooms">Rooms</h1>
        <p className="mt-1 text-sm text-slate-400">Live rooms, spray and ticket money, and the switches that stop new money.</p>

        {canMoney && controls.data && (
          <div className={`${panel} mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3`} data-testid="status-strip">
            <Status paused={controls.data.spraysPaused} label="Spraying" />
            <Status paused={controls.data.ticketsPaused} label="Ticket sales" />
            <span className="text-sm text-slate-300" data-testid="status-frozen-hosts">
              <span className="font-semibold text-white">{controls.data.frozenHosts.length}</span> frozen {controls.data.frozenHosts.length === 1 ? "host" : "hosts"}
            </span>
          </div>
        )}

        {me.isLoading && <Msg>Loading...</Msg>}
        {!me.isLoading && tabs.length === 0 && <Msg>Your role does not have access to Rooms.</Msg>}

        {tabs.length > 0 && (
          <>
            <div role="tablist" aria-label="Rooms sections" className="mt-6 flex gap-1 overflow-x-auto border-b border-slate-700">
              {tabs.map((t) => (
                <button
                  key={t.id} role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} data-testid={`tab-${t.id}`}
                  onClick={() => setPicked(t.id)}
                  className={`min-h-[44px] shrink-0 whitespace-nowrap border-b-2 px-4 text-sm font-medium transition-colors ${tab === t.id ? "border-purple-400 text-white" : "border-transparent text-slate-400 hover:text-slate-200"}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="mt-6">
              {tab === "live" && <LiveTab canFreeze={canMoney} />}
              {tab === "reported" && <ReportedTab />}
              {tab === "money" && <MoneyTab />}
              {tab === "controls" && <ControlsTab isSuper={role === "super_admin"} />}
            </div>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
