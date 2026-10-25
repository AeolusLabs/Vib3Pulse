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
import { DayColumnChart, DayLineChart, type DayPoint } from "@/components/admin/charts/DayCharts";
import { RankedBars, StackedBar, type BarRow, type SplitPart } from "@/components/admin/charts/BarCharts";
import { StatTile, pctChange } from "@/components/admin/charts/StatTile";
import { COLOR_MONEY, COLOR_USAGE, SERIES, compactCount, compactNaira, daysBetween, naira } from "@/components/admin/charts/tokens";
import RoomRatesTab from "./RoomRatesTab";
import SprayTransactionsTab from "./SprayTransactionsTab";
import { BLOCK_CONFIRM, RESUME_DISABLED_REASON, appliedText, canBlock, canEndRoom, canResume, canSeeLive, canSeeTransactions } from "@/lib/adminSprayUi";

// Rooms admin (rooms admin plan, task 6). One screen for what an admin needs when something looks wrong: who is live right now,
// where the money went, and the switches that stop new money. A pause or freeze stops NEW money only; money already settled to a
// bank cannot be recalled from here. Every action asks for a reason and is audit-logged by the server.

type Tab = "live" | "reported" | "money" | "transactions" | "rates" | "controls";
type Me = { role: string };
type LiveRoom = { id: string; title: string; hostId: string; hostUsername: string; ageLimit: string; members: number; startedAt: string | null; ticketed: boolean; hostFrozen: boolean };
type ReportedRoom = { roomId: string; title: string; status: string; ageLimit: string; hostId: string; host: { username?: string; displayName?: string } | null; reports: { id: string; reason: string; description?: string | null }[] };
type SprayStatusInfo = { platformFlag: boolean; paused: boolean; pausedInfo?: { reason: string; byName: string | null; at: string } | null; frozenHosts: number; liveRoomsSprayOn: number; blockedRooms: { roomId: string; title: string; reason: string | null; byAdminId: string | null; byAdminName?: string | null; at: string | null }[] };
type Controls = { spraysPaused: boolean; ticketsPaused: boolean; frozenHosts: { hostId: string; username: string; reason: string; frozenAt: string }[] };
type Overview = {
  roomsCreated: number; roomsStarted: number; uniqueHosts: number; peakConcurrent: number; ticketsSold: number;
  byDay: { day: string; roomsStarted: number; peakConcurrent: number; ticketsSold: number }[];
  previous: { roomsStarted: number; uniqueHosts: number; ticketsSold: number };
};
type Sprays = {
  totals: { count: number; grossKobo: number; vatKobo: number; feeKobo: number; reserveKobo: number; platformKobo: number; hostKobo: number; guestKobo: number; refundedKobo: number };
  uniquePayers: number;
  previous: { count: number; grossKobo: number; uniquePayers: number; refundedKobo: number };
  byTier: { tier: string; count: number; grossKobo: number }[];
  byDay: { day: string; count: number; grossKobo: number }[];
  topRooms: { roomId: string; title: string; count: number; grossKobo: number }[];
  topHosts: { hostId: string; username: string; count: number; grossKobo: number }[];
};
type TicketSales = {
  totals: { count: number; grossKobo: number; vatKobo: number; feeKobo: number; reserveKobo: number; platformKobo: number; hostKobo: number; refundedCount: number; refundedKobo: number };
  uniqueBuyers: number;
  previous: { count: number; grossKobo: number; uniqueBuyers: number; refundedKobo: number };
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
      toast({ title: json?.changed === false ? "Nothing changed, it was already in that state" : done === "Applied" ? appliedText(json) : done });
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
function FreezeHostDialog({ host, canEndRooms, busy, error, onConfirm, onClose }: { host: { id: string; name: string } | null; canEndRooms: boolean; busy: boolean; error: string | null; onConfirm: (reason: string, endLiveRooms: boolean) => void; onClose: () => void }) {
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
        <form onSubmit={(e) => { e.preventDefault(); if (ok && !busy) onConfirm(reason.trim(), canEndRooms && endRooms); }} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="freeze-reason" className="text-slate-300">Reason (recorded in the audit log)</Label>
            <Textarea id="freeze-reason" rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus className="border-slate-600 bg-slate-700 text-white" data-testid="input-freeze-reason" />
          </div>
          {canEndRooms && <div className="flex items-start gap-3">
            <Checkbox id="freeze-end" checked={endRooms} onCheckedChange={(v) => setEndRooms(v === true)} className="mt-0.5" data-testid="check-freeze-end-rooms" />
            <Label htmlFor="freeze-end" className="text-sm font-normal leading-snug text-slate-300">Also end their live rooms now. This cuts any stream in progress.</Label>
          </div>}
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

function LiveTab({ canFreeze, canEndRooms, role }: { canFreeze: boolean; canEndRooms: boolean; role: string }) {
  const { data, isLoading, error, refetch } = useQuery<{ rooms: LiveRoom[] }>({ queryKey: ["/api/admin/rooms/live"], refetchInterval: 15_000 });
  const act = useAction(["/api/admin/rooms"]);
  const [ending, setEnding] = useState<LiveRoom | null>(null);
  const [freezing, setFreezing] = useState<LiveRoom | null>(null);
  const [blocking, setBlocking] = useState<{ room: LiveRoom; on: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // The live list does not carry the block flag; the spray-status list (finance roles) does.
  const mayBlock = canBlock(role);
  const status = useQuery<SprayStatusInfo>({ queryKey: ["/api/admin/rooms/spray-status"], enabled: mayBlock, refetchInterval: 15_000 });
  const blockedIds = new Set((status.data?.blockedRooms ?? []).map((b) => b.roomId));

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
                {blockedIds.has(r.id) && <p className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-amber-300" data-testid={`chip-spray-blocked-${r.id}`}><PauseIcon className="h-3.5 w-3.5" aria-hidden />Spray blocked</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                {canEndRoom(role) && <Button variant="outline" onClick={() => { setErr(null); setEnding(r); }} className="min-h-[44px] border-slate-600 text-slate-100" data-testid={`button-end-${r.id}`}>End room</Button>}
                {mayBlock && !status.data && (
                  <p className="self-center text-sm text-slate-400" data-testid={`block-unknown-${r.id}`}>{status.isError ? "Block state unavailable" : "Checking block state..."}</p>
                )}
                {mayBlock && status.data && (blockedIds.has(r.id) ? (
                  <div className="flex flex-col items-start gap-1">
                    <Button variant="outline" disabled={!canResume(role)} aria-describedby={canResume(role) ? undefined : `unblock-why-${r.id}`} onClick={() => { setErr(null); setBlocking({ room: r, on: false }); }} className="min-h-[44px] border-slate-600 text-slate-100" data-testid={`button-unblock-${r.id}`}>Unblock spray</Button>
                    {!canResume(role) && <p id={`unblock-why-${r.id}`} className="text-xs text-slate-400">{RESUME_DISABLED_REASON}</p>}
                  </div>
                ) : (
                  <Button variant="outline" onClick={() => { setErr(null); setBlocking({ room: r, on: true }); }} className="min-h-[44px] border-amber-500/60 text-amber-300 hover:bg-amber-950/40" data-testid={`button-block-${r.id}`}>Block spray</Button>
                ))}
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
      <ReasonDialog
        open={!!blocking} minLength={3} maxLength={300}
        title={blocking?.on ? `Block spray in "${blocking.room.title}"` : `Unblock spray in "${blocking?.room.title ?? ""}"`}
        description={blocking?.on ? BLOCK_CONFIRM : "Spraying can start again in this room if the host has it on."}
        confirmLabel={blocking?.on ? "Block spray" : "Unblock spray"} destructive={blocking?.on} busy={act.isPending} error={err} onClose={() => setBlocking(null)}
        onConfirm={(reason) => act.mutate({ method: "POST", url: `/api/admin/rooms/${blocking!.room.id}/spray-block`, body: { on: blocking!.on, reason }, done: blocking!.on ? "Spray blocked" : "Spray unblocked" }, { onSuccess: () => setBlocking(null), onError: (e) => setErr(errText(e)) })}
      />
      <FreezeHostDialog
        host={freezing ? { id: freezing.hostId, name: freezing.hostUsername } : null} canEndRooms={canEndRooms} busy={act.isPending} error={err} onClose={() => setFreezing(null)}
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

function Panel({ title, note, children, testId }: { title: string; note?: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className={`${panel} min-w-0 p-4`} aria-label={title} data-testid={testId}>
      <h3 className="text-base font-semibold text-white">{title}</h3>
      {note && <p className="mb-3 mt-0.5 text-sm text-slate-400">{note}</p>}
      {!note && <div className="mb-3" />}
      {children}
    </section>
  );
}

function ViewToggle({ view, onChange }: { view: "charts" | "tables"; onChange: (v: "charts" | "tables") => void }) {
  return (
    <div role="group" aria-label="View" className="inline-flex overflow-hidden rounded-md border border-slate-600">
      {(["charts", "tables"] as const).map((v) => (
        <button key={v} type="button" aria-pressed={view === v} onClick={() => onChange(v)} data-testid={`view-${v}`}
          className={`min-h-[44px] px-4 text-sm font-medium transition-colors ${view === v ? "bg-slate-600 text-white" : "bg-slate-800 text-slate-300 hover:text-white"}`}>
          {v === "charts" ? "Charts" : "Tables"}
        </button>
      ))}
    </div>
  );
}

function MoneyTab() {
  const [range, setRange] = useState<{ from?: Date; to?: Date }>(() => ({ from: new Date(Date.now() - 30 * 864e5), to: new Date() }));
  const [view, setView] = useState<"charts" | "tables">("charts");
  const fromYmd = range.from ? ymd(range.from) : ymd(new Date(Date.now() - 30 * 864e5));
  const toYmd = range.to ? ymd(range.to) : ymd(new Date());
  const qs = `from=${fromYmd}&to=${toYmd}`;
  const sprays = useQuery<Sprays>({ queryKey: [`/api/admin/rooms/sprays?${qs}`], placeholderData: (prev) => prev });
  const overview = useQuery<Overview>({ queryKey: [`/api/admin/rooms/overview?${qs}`], placeholderData: (prev) => prev });
  const tickets = useQuery<TicketSales>({ queryKey: [`/api/admin/rooms/tickets?${qs}`], placeholderData: (prev) => prev });
  const finance = useQuery<Finance>({ queryKey: ["/api/admin/finance/room-tickets"] });
  const days = useMemo(() => daysBetween(fromYmd, toYmd), [fromYmd, toYmd]);
  const vs = `the previous ${days.length} days`;
  const s = sprays.data;
  const o = overview.data;
  const stale = sprays.isFetching || overview.isFetching || tickets.isFetching;
  const tk = tickets.data;

  const sprayDay = useMemo(() => new Map((s?.byDay ?? []).map((d) => [d.day, d])), [s]);
  const useDay = useMemo(() => new Map((o?.byDay ?? []).map((d) => [d.day, d])), [o]);
  const grossSeries: DayPoint[] = days.map((d) => {
    const r = sprayDay.get(d);
    return { day: d, value: r?.grossKobo ?? 0, tip: [{ label: "Gross", value: naira(r?.grossKobo ?? 0) }, { label: "Sprays", value: String(r?.count ?? 0) }] };
  });
  const usageTip = (d: string) => {
    const r = useDay.get(d);
    return [{ label: "Rooms started", value: String(r?.roomsStarted ?? 0) }, { label: "Peak attendance", value: String(r?.peakConcurrent ?? 0) }, { label: "Tickets sold", value: String(r?.ticketsSold ?? 0) }];
  };
  const startedSeries: DayPoint[] = days.map((d) => ({ day: d, value: useDay.get(d)?.roomsStarted ?? 0, tip: usageTip(d) }));
  const peakSeries: DayPoint[] = days.map((d) => ({ day: d, value: useDay.get(d)?.peakConcurrent ?? 0, tip: usageTip(d) }));

  const t = s?.totals;
  const avg = (gross: number, count: number) => (count > 0 ? Math.round(gross / count) : 0);
  const ticketDay = useMemo(() => new Map((tk?.byDay ?? []).map((d) => [d.day, d])), [tk]);
  const ticketSeries: DayPoint[] = days.map((d) => {
    const r = ticketDay.get(d);
    return { day: d, value: r?.grossKobo ?? 0, tip: [{ label: "Ticket sales", value: naira(r?.grossKobo ?? 0) }, { label: "Tickets", value: String(r?.count ?? 0) }] };
  });
  const tt = tk?.totals;
  // Sprays and tickets together: every figure is the sum of the stored splits, so the three headline numbers always add up.
  const room = s && tk && t && tt ? {
    gross: t.grossKobo + tt.grossKobo,
    host: t.hostKobo + tt.hostKobo,
    platform: t.platformKobo + tt.platformKobo,
    other: t.vatKobo + t.feeKobo + t.reserveKobo + t.guestKobo + tt.vatKobo + tt.feeKobo + tt.reserveKobo,
    prevGross: s.previous.grossKobo + tk.previous.grossKobo,
  } : null;
  const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 1000) / 10}% of sales` : "No sales in this range");
  const sourceParts = (sprayV: number, ticketV: number): SplitPart[] => [
    { id: "sprays", label: "Sprays", value: sprayV, valueLabel: naira(sprayV), color: SERIES[0] },
    { id: "tickets", label: "Tickets", value: ticketV, valueLabel: naira(ticketV), color: SERIES[1] },
  ];
  const ticketSplit: SplitPart[] = tt ? [
    { id: "host", label: "Host share", value: tt.hostKobo, valueLabel: naira(tt.hostKobo), color: SERIES[0] },
    { id: "platform", label: "Platform share", value: tt.platformKobo, valueLabel: naira(tt.platformKobo), color: SERIES[1] },
    { id: "vat", label: "VAT", value: tt.vatKobo, valueLabel: naira(tt.vatKobo), color: SERIES[2] },
    { id: "fees", label: "Card fees", value: tt.feeKobo, valueLabel: naira(tt.feeKobo), color: SERIES[3] },
    { id: "reserve", label: "Fraud reserve", value: tt.reserveKobo, valueLabel: naira(tt.reserveKobo), color: SERIES[4] },
  ] : [];
  const ticketRoomRows: BarRow[] = (tk?.topRooms ?? []).map((r) => ({ id: r.roomId, label: r.title, value: r.grossKobo, valueLabel: naira(r.grossKobo), sub: `${r.count} ${r.count === 1 ? "ticket" : "tickets"}` }));
  const ticketHostRows: BarRow[] = (tk?.topHosts ?? []).map((h) => ({ id: h.hostId, label: h.username, value: h.grossKobo, valueLabel: naira(h.grossKobo), sub: `${h.count} ${h.count === 1 ? "ticket" : "tickets"}` }));
  const ticketAvg = tt && tt.count > 0 ? Math.round(tt.grossKobo / tt.count) : 0;
  const ticketPrevAvg = tk && tk.previous.count > 0 ? Math.round(tk.previous.grossKobo / tk.previous.count) : 0;
  const ticketRefundShare = tt && tt.grossKobo + tt.refundedKobo > 0 ? (tt.refundedKobo / (tt.grossKobo + tt.refundedKobo)) * 100 : 0;
  const reversedShare = t && t.grossKobo + t.refundedKobo > 0 ? (t.refundedKobo / (t.grossKobo + t.refundedKobo)) * 100 : 0;
  const split: SplitPart[] = t ? [
    { id: "host", label: "Host share", value: t.hostKobo, valueLabel: naira(t.hostKobo), color: SERIES[0] },
    { id: "platform", label: "Platform share", value: t.platformKobo, valueLabel: naira(t.platformKobo), color: SERIES[1] },
    { id: "vat", label: "VAT", value: t.vatKobo, valueLabel: naira(t.vatKobo), color: SERIES[2] },
    { id: "fees", label: "Card fees", value: t.feeKobo, valueLabel: naira(t.feeKobo), color: SERIES[3] },
    { id: "reserve", label: "Fraud reserve", value: t.reserveKobo, valueLabel: naira(t.reserveKobo), color: SERIES[4] },
    { id: "guest", label: "Stage guests", value: t.guestKobo, valueLabel: naira(t.guestKobo), color: SERIES[5] },
  ] : [];
  const tierRows: BarRow[] = s ? ["note", "bundle", "bag", "rain"].map((k) => {
    const r = s.byTier.find((x) => x.tier === k);
    return { id: k, label: TIER_LABEL[k], value: r?.grossKobo ?? 0, valueLabel: naira(r?.grossKobo ?? 0), sub: `${r?.count ?? 0} ${(r?.count ?? 0) === 1 ? "spray" : "sprays"}` };
  }) : [];
  const roomRows: BarRow[] = (s?.topRooms ?? []).map((r) => ({ id: r.roomId, label: r.title, value: r.grossKobo, valueLabel: naira(r.grossKobo), sub: `${r.count} sprays` }));
  const hostRows: BarRow[] = (s?.topHosts ?? []).map((h) => ({ id: h.hostId, label: h.username, value: h.grossKobo, valueLabel: naira(h.grossKobo), sub: `${h.count} sprays` }));

  return (
    <section aria-labelledby="money-h" className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="money-h" className="text-lg font-semibold text-white">Money</h2>
          <p className="text-sm text-slate-400">Days are in UTC. Sales count sprays that were delivered. Changes compare with {vs}.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AdminDateRangePicker from={range.from} to={range.to} onChange={setRange} className="min-h-[44px] border-slate-600 bg-slate-800 text-slate-100" />
          <ViewToggle view={view} onChange={setView} />
        </div>
      </div>

      {(sprays.error || overview.error) && <Msg tone="error">Could not load this range. Pick a range of up to 366 days, or try again.</Msg>}
      {!s && sprays.isLoading && <Msg>Loading...</Msg>}

      {room && t && tt && s && (
        <div className={`space-y-6 transition-opacity ${stale ? "opacity-60" : ""}`} data-testid="room-earnings">
          <div className={`${panel} p-5`}>
            <StatTile hero testId="kpi-room-sales" label="Total room sales" value={naira(room.gross)} delta={{ pct: pctChange(room.gross, room.prevGross), upIsGood: true, vs }} note="Delivered sprays plus paid tickets" />
            <div className="mt-5 grid grid-cols-1 gap-x-6 gap-y-5 border-t border-slate-700/60 pt-5 sm:grid-cols-3">
              <StatTile testId="kpi-room-host" label="Host share" value={naira(room.host)} note={share(room.host, room.gross)} />
              <StatTile testId="kpi-room-platform" label="Platform share" value={naira(room.platform)} note={share(room.platform, room.gross)} />
              <StatTile testId="kpi-room-other" label="VAT, card fees, reserve and stage guests" value={naira(room.other)} note={share(room.other, room.gross)} />
            </div>
          </div>
          {view === "charts" ? (
            <div className="grid items-start gap-4 lg:grid-cols-2">
              <Panel title="Sales by source" note="Where the total came from." testId="chart-sales-by-source">
                <StackedBar parts={sourceParts(t.grossKobo, tt.grossKobo)} total={room.gross} totalLabel={naira(room.gross)} ariaLabel="Total room sales by source" testId="chart-sales-by-source-bar" />
              </Panel>
              <Panel title="Platform share by source" note="Where the platform's earnings came from." testId="chart-platform-by-source">
                <StackedBar parts={sourceParts(t.platformKobo, tt.platformKobo)} total={room.platform} totalLabel={naira(room.platform)} ariaLabel="Platform share by source" testId="chart-platform-by-source-bar" />
              </Panel>
            </div>
          ) : (
            <SmallTable caption="Earnings by source" head={["Source", "Sales", "Host share", "Platform share"]} rows={[
              ["Sprays", naira(t.grossKobo), naira(t.hostKobo), naira(t.platformKobo)],
              ["Tickets", naira(tt.grossKobo), naira(tt.hostKobo), naira(tt.platformKobo)],
              ["Total", naira(room.gross), naira(room.host), naira(room.platform)],
            ]} />
          )}
        </div>
      )}

      {s && t && (
        <div className={`space-y-6 transition-opacity ${stale ? "opacity-60" : ""}`} aria-busy={stale}>
          <h3 className="text-base font-semibold text-white">Sprays</h3>
          <div className={`${panel} p-5`} data-testid="spray-kpis">
            <StatTile large testId="kpi-gross" label="Gross sprayed" value={naira(t.grossKobo)} delta={{ pct: pctChange(t.grossKobo, s.previous.grossKobo), upIsGood: true, vs }} />
            <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-slate-700/60 pt-5 sm:grid-cols-4">
              <StatTile testId="kpi-count" label="Sprays" value={compactCount(t.count)} delta={{ pct: pctChange(t.count, s.previous.count), upIsGood: true, vs }} />
              <StatTile testId="kpi-average" label="Average spray" value={compactNaira(avg(t.grossKobo, t.count))} delta={{ pct: pctChange(avg(t.grossKobo, t.count), avg(s.previous.grossKobo, s.previous.count)), upIsGood: true, vs }} />
              <StatTile testId="kpi-payers" label="Unique spenders" value={compactCount(s.uniquePayers)} delta={{ pct: pctChange(s.uniquePayers, s.previous.uniquePayers), upIsGood: true, vs }} />
              <StatTile testId="kpi-reversed" label="Reversed share" value={`${Math.round(reversedShare * 10) / 10}%`} note={`${naira(t.refundedKobo)} reversed and refunded`} />
            </div>
          </div>

          {view === "charts" ? (
            <>
              <Panel title="Spray money per day" note="Gross of delivered sprays. Hover or use the arrow keys to read a day." testId="chart-gross-per-day">
                <DayLineChart data={grossSeries} color={COLOR_MONEY} formatTick={compactNaira} formatValue={compactNaira} ariaLabel={`Gross spray money per day, ${naira(t.grossKobo)} in total`} testId="chart-gross-line" />
              </Panel>
              <Panel title="Where each naira goes" note="One bar is the whole gross; each part is a share of it. Platform share is what the platform keeps." testId="chart-split">
                <StackedBar parts={split} total={t.grossKobo} totalLabel={naira(t.grossKobo)} ariaLabel="How the gross is split" testId="chart-split-bar" />
              </Panel>
              <div className="grid items-start gap-4 lg:grid-cols-2">
                <Panel title="By tier" note="Ordered by price, note to rain." testId="chart-tier"><RankedBars rows={tierRows} color={COLOR_MONEY} ariaLabel="Gross by spray tier" testId="chart-tier-bars" /></Panel>
                <Panel title="Top rooms" note="By gross, up to 10." testId="chart-rooms"><RankedBars rows={roomRows} color={COLOR_MONEY} ariaLabel="Top rooms by gross" testId="chart-rooms-bars" /></Panel>
              </div>
              <Panel title="Top hosts" note="By gross sprayed in their rooms, up to 10." testId="chart-hosts"><RankedBars rows={hostRows} color={COLOR_MONEY} ariaLabel="Top hosts by gross" testId="chart-hosts-bars" /></Panel>
            </>
          ) : (
            <div className="space-y-4" data-testid="money-tables">
              <dl className={`${panel} divide-y divide-slate-700/60`} data-testid="spray-totals">
                <Row label={`Sprays delivered (${t.count})`} value={naira(t.grossKobo)} strong />
                {split.map((p) => <Row key={p.id} label={p.label} value={p.valueLabel} />)}
                <Row label="Reversed and refunded" value={naira(t.refundedKobo)} />
              </dl>
              <div className="grid items-start gap-4 lg:grid-cols-2">
                <SmallTable caption="By tier" head={["Tier", "Sprays", "Amount"]} rows={s.byTier.map((x) => [TIER_LABEL[x.tier] ?? x.tier, x.count, naira(x.grossKobo)])} />
                <SmallTable caption="By day (UTC)" head={["Day", "Sprays", "Amount"]} rows={s.byDay.map((d) => [d.day, d.count, naira(d.grossKobo)])} />
                <SmallTable caption="Top rooms" head={["Room", "Sprays", "Amount"]} rows={s.topRooms.map((r) => [r.title, r.count, naira(r.grossKobo)])} />
                <SmallTable caption="Top hosts" head={["Host", "Sprays", "Amount"]} rows={s.topHosts.map((h) => [h.username, h.count, naira(h.grossKobo)])} />
              </div>
            </div>
          )}
        </div>
      )}

      {tk && tt && (
        <div className={`space-y-6 transition-opacity ${stale ? "opacity-60" : ""}`} data-testid="ticket-sales">
          <div>
            <h3 className="text-base font-semibold text-white">Ticket sales</h3>
            <p className="text-sm text-slate-400">Paid room tickets. A refunded ticket is not a sale. Each ticket keeps the split it was sold with.</p>
          </div>
          <div className={`${panel} p-5`}>
            <StatTile large testId="kpi-ticket-gross" label="Ticket sales" value={naira(tt.grossKobo)} delta={{ pct: pctChange(tt.grossKobo, tk.previous.grossKobo), upIsGood: true, vs }} />
            <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-slate-700/60 pt-5 sm:grid-cols-4">
              <StatTile testId="kpi-ticket-count" label="Tickets sold" value={compactCount(tt.count)} delta={{ pct: pctChange(tt.count, tk.previous.count), upIsGood: true, vs }} />
              <StatTile testId="kpi-ticket-average" label="Average ticket" value={compactNaira(ticketAvg)} delta={{ pct: pctChange(ticketAvg, ticketPrevAvg), upIsGood: true, vs }} />
              <StatTile testId="kpi-ticket-buyers" label="Unique buyers" value={compactCount(tk.uniqueBuyers)} delta={{ pct: pctChange(tk.uniqueBuyers, tk.previous.uniqueBuyers), upIsGood: true, vs }} />
              <StatTile testId="kpi-ticket-refunded" label="Refunded share" value={`${Math.round(ticketRefundShare * 10) / 10}%`} note={`${naira(tt.refundedKobo)} across ${tt.refundedCount} ${tt.refundedCount === 1 ? "ticket" : "tickets"}`} />
            </div>
          </div>
          {view === "charts" ? (
            <>
              <Panel title="Ticket sales per day" note="Gross of paid tickets. Hover or use the arrow keys to read a day." testId="chart-ticket-per-day">
                <DayLineChart data={ticketSeries} color={SERIES[1]} formatTick={compactNaira} formatValue={compactNaira} ariaLabel={`Ticket sales per day, ${naira(tt.grossKobo)} in total`} testId="chart-ticket-line" />
              </Panel>
              <Panel title="Where each ticket naira goes" note="One bar is the whole ticket gross. Platform share is what the platform keeps." testId="chart-ticket-split">
                <StackedBar parts={ticketSplit} total={tt.grossKobo} totalLabel={naira(tt.grossKobo)} ariaLabel="How ticket sales are split" testId="chart-ticket-split-bar" />
              </Panel>
              <div className="grid items-start gap-4 lg:grid-cols-2">
                <Panel title="Top rooms by ticket sales" note="Up to 10." testId="chart-ticket-rooms"><RankedBars rows={ticketRoomRows} color={SERIES[1]} ariaLabel="Top rooms by ticket sales" testId="chart-ticket-rooms-bars" empty="No ticket sales in this range." /></Panel>
                <Panel title="Top hosts by ticket sales" note="Up to 10." testId="chart-ticket-hosts"><RankedBars rows={ticketHostRows} color={SERIES[1]} ariaLabel="Top hosts by ticket sales" testId="chart-ticket-hosts-bars" empty="No ticket sales in this range." /></Panel>
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <dl className={`${panel} divide-y divide-slate-700/60`}>
                <Row label={`Tickets sold (${tt.count})`} value={naira(tt.grossKobo)} strong />
                {ticketSplit.map((p) => <Row key={p.id} label={p.label} value={p.valueLabel} />)}
                <Row label="Refunded" value={naira(tt.refundedKobo)} />
              </dl>
              <div className="grid items-start gap-4 lg:grid-cols-2">
                <SmallTable caption="Ticket sales by day (UTC)" head={["Day", "Tickets", "Amount"]} rows={tk.byDay.map((d) => [d.day, d.count, naira(d.grossKobo)])} empty="No ticket sales in this range." />
                <SmallTable caption="Top rooms" head={["Room", "Tickets", "Amount"]} rows={tk.topRooms.map((r) => [r.title, r.count, naira(r.grossKobo)])} empty="No ticket sales in this range." />
                <SmallTable caption="Top hosts" head={["Host", "Tickets", "Amount"]} rows={tk.topHosts.map((h) => [h.username, h.count, naira(h.grossKobo)])} empty="No ticket sales in this range." />
              </div>
            </div>
          )}
        </div>
      )}

      {o && (
        <div className={`space-y-6 transition-opacity ${stale ? "opacity-60" : ""}`}>
          <div>
            <h3 className="text-base font-semibold text-white">Rooms and attendance</h3>
            <p className="text-sm text-slate-400">A day's peak is the busiest room that started that day.</p>
          </div>
          <div className={`${panel} grid grid-cols-2 gap-x-6 gap-y-5 p-5 sm:grid-cols-4`} data-testid="usage-kpis">
            <StatTile testId="kpi-rooms-started" label="Rooms started" value={compactCount(o.roomsStarted)} delta={{ pct: pctChange(o.roomsStarted, o.previous.roomsStarted), upIsGood: true, vs }} />
            <StatTile testId="kpi-hosts" label="Active hosts" value={compactCount(o.uniqueHosts)} delta={{ pct: pctChange(o.uniqueHosts, o.previous.uniqueHosts), upIsGood: true, vs }} />
            <StatTile testId="kpi-peak" label="Busiest room" value={`${compactCount(o.peakConcurrent)} ${o.peakConcurrent === 1 ? "person" : "people"}`} />
            <StatTile testId="kpi-tickets" label="Tickets sold" value={compactCount(o.ticketsSold)} delta={{ pct: pctChange(o.ticketsSold, o.previous.ticketsSold), upIsGood: true, vs }} />
          </div>
          {view === "charts" ? (
            <div className="grid items-start gap-4 lg:grid-cols-2">
              <Panel title="Rooms started per day" testId="chart-rooms-started">
                <DayColumnChart data={startedSeries} color={COLOR_USAGE} formatTick={(n) => String(Math.round(n))} formatValue={(n) => String(n)} ariaLabel="Rooms started per day" testId="chart-rooms-started-cols" />
              </Panel>
              <Panel title="Peak attendance per day" testId="chart-peak">
                <DayColumnChart data={peakSeries} color={COLOR_USAGE} formatTick={(n) => String(Math.round(n))} formatValue={(n) => String(n)} ariaLabel="Peak attendance per day" testId="chart-peak-cols" />
              </Panel>
            </div>
          ) : (
            <SmallTable caption="Usage by day (UTC)" head={["Day", "Rooms started", "Peak attendance", "Tickets sold"]} rows={o.byDay.map((d) => [d.day, d.roomsStarted, d.peakConcurrent, d.ticketsSold])} empty="No rooms started in this range." />
          )}
        </div>
      )}

      <div className="space-y-4">
        <h3 className="text-base font-semibold text-white">Tickets and payouts</h3>
        {finance.isLoading && <Msg>Loading...</Msg>}
        {finance.error && <Msg tone="error">Could not load ticket totals.</Msg>}
        {finance.data && (
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <SmallTable caption="Ticket sales (all time)" head={["Status", "Tickets", "Gross"]} rows={finance.data.tickets.map((x) => [x.status, x.count, naira(x.grossKobo)])} empty="No ticket sales yet." />
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
  const [unblock, setUnblock] = useState<SprayStatusInfo["blockedRooms"][number] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const spray = useQuery<SprayStatusInfo>({ queryKey: ["/api/admin/rooms/spray-status"], refetchInterval: 15_000 });
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

      <section aria-labelledby="spray-status-h" className={`${panel} p-4`} data-testid="spray-status">
        <h3 id="spray-status-h" className="text-base font-semibold text-white">Spray status</h3>
        {spray.isLoading && <Msg>Loading...</Msg>}
        {spray.error && <Msg tone="error">Could not load the spray status. <button className="underline" onClick={() => spray.refetch()}>Try again</button></Msg>}
        {spray.data && (
          <>
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
              {([
                ["Platform switch", spray.data.platformFlag ? "On" : "Off"],
                ["Spraying", spray.data.paused ? "Paused" : "Running"],
                ["Frozen hosts", String(spray.data.frozenHosts)],
                ["Live rooms with spray on", String(spray.data.liveRoomsSprayOn)],
              ] as const).map(([k, v]) => (
                <div key={k}><dt className="text-xs uppercase tracking-wide text-slate-400">{k}</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums text-white" data-testid={`spray-status-${k.toLowerCase().replace(/\s+/g, "-")}`}>{v}</dd></div>
              ))}
            </dl>
            {spray.data.paused && (
              <p className="mt-3 break-words text-sm text-amber-300" data-testid="paused-info">
                {spray.data.pausedInfo
                  ? `Paused by ${spray.data.pausedInfo.byName ?? "an admin"} on ${format(new Date(spray.data.pausedInfo.at), "d MMM yyyy, HH:mm")}: ${spray.data.pausedInfo.reason}`
                  : "Paused. Who paused it and why was not recorded."}
              </p>
            )}
            <h4 className="mb-1 mt-4 text-sm font-semibold text-white">Rooms blocked by an admin</h4>
            {spray.data.blockedRooms.length === 0 ? <p className="text-sm text-slate-400">No rooms are blocked.</p> : (
              <ul className="divide-y divide-slate-700/60" data-testid="blocked-rooms">
                {spray.data.blockedRooms.map((b) => (
                  <li key={b.roomId} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="truncate font-medium text-white">{b.title}</p>
                      <p className="mt-0.5 break-words text-sm text-slate-400">{b.reason ?? "No reason recorded"} · by {b.byAdminName ?? "an admin"}{b.at ? ` · ${format(new Date(b.at), "d MMM yyyy, HH:mm")}` : ""}</p>
                    </div>
                    <span title={isSuper ? undefined : RESUME_DISABLED_REASON}>
                      <Button variant="outline" disabled={!isSuper} aria-describedby={isSuper ? undefined : `blocked-why-${b.roomId}`} onClick={() => { setErr(null); setUnblock(b); }} className="min-h-[44px] border-slate-600 text-slate-100" data-testid={`button-unblock-room-${b.roomId}`}>Unblock</Button>
                      {!isSuper && <span id={`blocked-why-${b.roomId}`} className="sr-only">{RESUME_DISABLED_REASON}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {!isSuper && spray.data.blockedRooms.length > 0 && <p className="mt-2 text-xs text-slate-400">{RESUME_DISABLED_REASON}</p>}
          </>
        )}
      </section>

      <ul className={`${panel} divide-y divide-slate-700`}>
        {items.map((i) => (
          <li key={i.key} className="flex items-center justify-between gap-4 p-4" data-testid={`control-${i.key}`}>
            <div className="min-w-0">
              <p className="font-medium text-white">{i.label}</p>
              <p className="mt-0.5 text-sm text-slate-400">{i.help}</p>
              <p className={`mt-1 text-sm font-semibold ${i.paused ? "text-amber-300" : "text-emerald-300"}`}>{i.paused ? "Paused" : "Running"}</p>
              {i.paused && !isSuper && <p className="mt-1 text-xs text-slate-400">Only a super-admin can resume this.</p>}
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
        {!isSuper && data.frozenHosts.length > 0 && <p className="mt-2 text-xs text-slate-400">Only a super-admin can unfreeze a host. Unfreezing does not release payouts; release those room by room in Finance.</p>}
      </div>

      <ReasonDialog
        open={!!toggle} title={toggle?.on ? (toggle.key === "sprays_paused" ? "Pause all spraying" : "Pause all ticket sales") : "Resume"}
        description={toggle?.on ? "New money stops within a few seconds. Money already settled to a bank is not affected." : "New money starts again for everyone within a few seconds."}
        confirmLabel={toggle?.on ? "Pause" : "Resume"} destructive={toggle?.on} busy={act.isPending} error={err} minLength={3} maxLength={300} onClose={() => setToggle(null)}
        onConfirm={(reason) => act.mutate({ method: "POST", url: `/api/admin/rooms/controls/${toggle!.key}`, body: { on: toggle!.on, reason }, done: toggle!.key === "sprays_paused" ? "Applied" : toggle!.on ? "Paused" : "Resumed" }, { onSuccess: () => setToggle(null), onError: (e) => setErr(errText(e)) })}
      />
      <ReasonDialog
        open={!!unblock} title={`Unblock spray in "${unblock?.title ?? ""}"`} description="Spraying can start again in this room if the host has it on."
        confirmLabel="Unblock spray" busy={act.isPending} error={err} minLength={3} maxLength={300} onClose={() => setUnblock(null)}
        onConfirm={(reason) => act.mutate({ method: "POST", url: `/api/admin/rooms/${unblock!.roomId}/spray-block`, body: { on: false, reason }, done: "Spray unblocked" }, { onSuccess: () => setUnblock(null), onError: (e) => setErr(errText(e)) })}
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
    canSeeLive(role) && { id: "live" as const, label: "Live now" },
    canMod && { id: "reported" as const, label: "Reported" },
    canMoney && { id: "money" as const, label: "Money" },
    canSeeTransactions(role) && { id: "transactions" as const, label: "Transactions" },
    canMoney && { id: "rates" as const, label: "Rates" },
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
              {tab === "live" && <LiveTab canFreeze={canMoney} canEndRooms={role === "super_admin"} role={role} />}
              {tab === "reported" && <ReportedTab />}
              {tab === "money" && <MoneyTab />}
              {tab === "transactions" && <SprayTransactionsTab />}
              {tab === "rates" && <RoomRatesTab isSuper={role === "super_admin"} />}
              {tab === "controls" && <ControlsTab isSuper={role === "super_admin"} />}
            </div>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
