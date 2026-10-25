import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import AdminDateRangePicker from "@/components/admin/AdminDateRangePicker";
import { StackedBar, type SplitPart } from "@/components/admin/charts/BarCharts";
import { SERIES, naira } from "@/components/admin/charts/tokens";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { AlertTriangleIcon, CheckCheckIcon, CheckIcon, ClockIcon, CopyIcon, DownloadIcon, Loader2Icon, RefreshCwIcon, SearchIcon, ShieldCheckIcon, XIcon } from "@/components/ui/icons";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { buildTxQuery, csvErrorMessage, csvUrl, funnelBuckets, mismatchBanner, STATUS_CHOICES, statusLabel, type StatusIcon, type TxFilters } from "@/lib/adminSprayUi";
import type { AttentionItem, LedgerDetail, LedgerRow, OutcomesResponse, ProviderCheckResult } from "@shared/sprayLedger";

// Spray money ledger (finance roles). Read-only: the only things that leave the system are the CSV export and the Paystack look-up,
// and the server audits both. Money is whole naira with a thousands separator (naira helper) and tabular numerals.

const BASE = "/api/admin/rooms/sprays";
const panel = "rounded-xl border border-slate-700 bg-slate-800/50";
const th = "sticky top-0 z-10 whitespace-nowrap bg-slate-800 px-2.5 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-400";
const td = "px-2.5 py-2 text-sm text-slate-200";
const ymd = (d: Date) => format(d, "yyyy-MM-dd");
const TIER_LABEL: Record<string, string> = { note: "Note", bundle: "Bundle", bag: "Money bag", rain: "Rain" };
const when = (iso: string | null) => (iso ? format(new Date(iso), "d MMM, HH:mm") : "time not recorded");
const whenSec = (iso: string | null) => (iso ? format(new Date(iso), "d MMM, HH:mm:ss") : "time not recorded");

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message || `Request failed (${res.status})`);
  }
  return res.json();
}

function Msg({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "error" }) {
  return <p role={tone === "error" ? "alert" : "status"} className={`py-6 text-center text-sm ${tone === "error" ? "text-red-400" : "text-slate-400"}`}>{children}</p>;
}

const ICONS: Record<StatusIcon, typeof CheckIcon> = { clock: ClockIcon, check: CheckIcon, "check-check": CheckCheckIcon, undo: RefreshCwIcon, x: XIcon, alert: AlertTriangleIcon };
const TONE: Record<string, string> = {
  neutral: "border-slate-600 text-slate-300", good: "border-emerald-500/50 text-emerald-300", warn: "border-amber-500/50 text-amber-300", bad: "border-red-500/50 text-red-300",
};

/** Icon plus word: status never depends on colour. */
function StatusChip({ status }: { status: string }) {
  const m = statusLabel(status);
  const Icon = ICONS[m.icon];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${TONE[m.tone]}`} data-testid={`status-chip-${status}`}>
      <Icon size={12} aria-hidden />{m.label}
    </span>
  );
}

// ------------------------------------------------------------------ attention
function AttentionPanel({ onOpen }: { onOpen: (id: string) => void }) {
  const q = useQuery<{ items: AttentionItem[]; capped: boolean }>({ queryKey: [`${BASE}/attention`], queryFn: () => getJson(`${BASE}/attention`), refetchInterval: 30_000 });
  return (
    <section className={`${panel} p-4`} aria-labelledby="attn-h" data-testid="spray-attention">
      <h3 id="attn-h" className="flex items-center gap-2 text-base font-semibold text-white"><AlertTriangleIcon size={16} className="text-amber-400" aria-hidden />Needs attention</h3>
      {q.isLoading && <Msg>Loading...</Msg>}
      {q.error && <Msg tone="error">Could not load the items that need attention. <button className="underline" onClick={() => q.refetch()}>Try again</button></Msg>}
      {q.data && q.data.items.length === 0 && <Msg>Nothing is stuck. Every spray is where it should be.</Msg>}
      {q.data && q.data.items.length > 0 && (
        <>
          <ul className="mt-2 divide-y divide-slate-700/60">
            {q.data.items.map((i) => (
              <li key={i.tx.id}>
                <button type="button" onClick={() => onOpen(i.tx.id)} className="flex min-h-[44px] w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-1 py-2 text-left hover:bg-slate-700/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400" data-testid={`attention-${i.tx.id}`}>
                  <StatusChip status={i.tx.status} />
                  <span className="min-w-0 flex-1 basis-48 text-sm text-slate-200">{i.why}<span className="text-slate-400"> · {i.ageMinutes} min · {i.tx.roomTitle}</span></span>
                  <span className="text-sm tabular-nums text-slate-200">{naira(i.tx.amountKobo)}</span>
                </button>
              </li>
            ))}
          </ul>
          {q.data.capped && <p className="mt-2 text-xs text-slate-400">Showing the oldest 200. Resolve these to see the rest.</p>}
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ outcomes
function OutcomesPanel({ from, to }: { from: string; to: string }) {
  const qs = `from=${from}&to=${to}`;
  const q = useQuery<OutcomesResponse>({ queryKey: [`${BASE}/outcomes?${qs}`], queryFn: () => getJson(`${BASE}/outcomes?${qs}`), placeholderData: (p) => p });
  const f = useMemo(() => funnelBuckets(q.data), [q.data]);
  const parts: SplitPart[] = f.parts.map((p, i) => ({ id: p.key, label: p.label, value: p.count, valueLabel: `${p.count.toLocaleString("en-NG")} · ${naira(p.kobo)}`, color: SERIES[i % SERIES.length] }));
  return (
    <section className={`${panel} p-4`} aria-labelledby="out-h" data-testid="spray-outcomes">
      <h3 id="out-h" className="text-base font-semibold text-white">Outcomes</h3>
      <p className="mb-3 mt-0.5 text-sm text-slate-400">Every spray started in the range, by where it is now. The groups add up to the total.</p>
      {q.isLoading && <Msg>Loading...</Msg>}
      {q.error && <Msg tone="error">Could not load outcomes. <button className="underline" onClick={() => q.refetch()}>Try again</button></Msg>}
      {q.data && (f.total.count === 0 ? <Msg>No sprays were started in this range.</Msg> : (
        <div className="space-y-4">
          <StackedBar parts={parts} total={f.total.count} totalLabel={`${f.total.count.toLocaleString("en-NG")} sprays`} ariaLabel="Sprays by where they ended" testId="spray-outcomes-bar" />
          <div className="overflow-x-auto">
            <table className="w-full">
              <caption className="sr-only">Sprays by outcome, with counts and naira</caption>
              <thead><tr><th scope="col" className="px-2.5 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-400">Outcome</th><th scope="col" className="px-2.5 py-2 text-right text-xs font-medium uppercase tracking-wide text-slate-400">Sprays</th><th scope="col" className="px-2.5 py-2 text-right text-xs font-medium uppercase tracking-wide text-slate-400">Amount</th></tr></thead>
              <tbody className="divide-y divide-slate-700/60">
                {f.parts.map((p) => <tr key={p.key}><th scope="row" className={`${td} text-left font-normal`}>{p.label}</th><td className={`${td} text-right tabular-nums`}>{p.count.toLocaleString("en-NG")}</td><td className={`${td} text-right tabular-nums`}>{naira(p.kobo)}</td></tr>)}
                <tr><th scope="row" className={`${td} text-left font-semibold text-white`}>Started (total)</th><td className={`${td} text-right font-semibold tabular-nums text-white`}>{f.total.count.toLocaleString("en-NG")}</td><td className={`${td} text-right font-semibold tabular-nums text-white`}>{naira(f.total.kobo)}</td></tr>
              </tbody>
            </table>
          </div>
          {!f.reconciles && <p role="alert" className="text-sm text-amber-300">The groups do not add up to the total. Refresh; if it persists, tell engineering.</p>}
        </div>
      ))}
    </section>
  );
}

// ------------------------------------------------------------------ detail drawer
function KV({ k, v, strong }: { k: string; v: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-3 py-2">
      <dt className={`text-sm ${strong ? "font-medium text-white" : "text-slate-300"}`}>{k}</dt>
      <dd className={`min-w-0 break-words text-right tabular-nums ${strong ? "text-base font-semibold text-white" : "text-sm text-slate-200"}`}>{v}</dd>
    </div>
  );
}

function PaystackCheck({ id }: { id: string }) {
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: async () => (await apiRequest("POST", `${BASE}/transactions/${id}/paystack-check`, {})).json() as Promise<ProviderCheckResult>,
    onError: (e) => {
      const m = e instanceof Error ? e.message : "";
      setErr(m.includes("could not be reached") ? "Paystack could not be reached. Try again." : m.includes("Too many") ? m : "The check did not work. Try again.");
    },
    onSuccess: () => setErr(null),
  });
  const r = run.data;
  const banner = r ? mismatchBanner(r) : null;
  const p = r?.provider;
  return (
    <section className="space-y-3" aria-labelledby="ps-h">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="ps-h" className="text-sm font-semibold text-white">Check with Paystack</h4>
        <Button variant="outline" disabled={run.isPending} onClick={() => { setErr(null); setConfirm(true); }} className="min-h-[44px] border-slate-600 text-slate-100" data-testid="button-paystack-check">
          {run.isPending ? <Loader2Icon className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <ShieldCheckIcon size={16} className="mr-2" aria-hidden />}Check with Paystack
        </Button>
      </div>
      {err && <p role="alert" className="text-sm text-red-400" data-testid="paystack-error">{err}</p>}
      {r && banner && (
        <div className="space-y-3" data-testid="paystack-result">
          <div role="status" className={`rounded-lg border p-3 ${banner.verdict === "MATCH" ? "border-emerald-500/50" : "border-red-500/60"}`} data-testid={`paystack-${banner.verdict.toLowerCase()}`}>
            <p className={`flex items-center gap-2 text-sm font-bold ${banner.verdict === "MATCH" ? "text-emerald-300" : "text-red-300"}`}>
              {banner.verdict === "MATCH" ? <CheckCircleMark /> : <AlertTriangleIcon size={16} aria-hidden />}{banner.verdict}
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-slate-200">{banner.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <caption className="sr-only">Our record next to Paystack's</caption>
              <thead><tr><th scope="col" className="px-2.5 py-2 text-left text-xs font-medium uppercase text-slate-400"><span className="sr-only">Field</span></th><th scope="col" className="px-2.5 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-400">Ours</th><th scope="col" className="px-2.5 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-400">Paystack</th></tr></thead>
              <tbody className="divide-y divide-slate-700/60">
                <tr><th scope="row" className={`${td} text-left font-normal text-slate-400`}>Status</th><td className={td}>{statusLabel(r.ours.status).label}</td><td className={td}>{p ? p.status : "No record"}</td></tr>
                <tr><th scope="row" className={`${td} text-left font-normal text-slate-400`}>Amount</th><td className={`${td} tabular-nums`}>{naira(r.ours.amountKobo)}</td><td className={`${td} tabular-nums`}>{p ? naira(p.amountKobo) : "-"}</td></tr>
                <tr><th scope="row" className={`${td} text-left font-normal text-slate-400`}>Paid at</th><td className={td}>-</td><td className={td}>{p?.paidAt ? whenSec(p.paidAt) : "-"}</td></tr>
                <tr><th scope="row" className={`${td} text-left font-normal text-slate-400`}>Paystack fee</th><td className={td}>-</td><td className={`${td} tabular-nums`}>{p?.feeKobo != null ? naira(p.feeKobo) : "-"}</td></tr>
                <tr><th scope="row" className={`${td} text-left font-normal text-slate-400`}>Refunded</th><td className={td}>-</td><td className={`${td} tabular-nums`}>{p ? (p.refunded ? `Yes, ${naira(p.refundedKobo)}` : "No") : "-"}</td></tr>
                <tr><th scope="row" className={`${td} text-left font-normal text-slate-400`}>Split</th><td className={td}>-</td><td className={td}>{p?.split?.subaccountLast4?.length ? `Subaccount ending ${p.split.subaccountLast4.join(", ")}` : "-"}</td></tr>
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-400">Checked {whenSec(r.checkedAt)}</p>
        </div>
      )}
      <Dialog open={confirm} onOpenChange={(o) => !o && setConfirm(false)}>
        <DialogContent className="border-slate-700 bg-slate-800 text-white sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Check with Paystack</DialogTitle>
            <DialogDescription className="text-slate-300">Looks up this charge on Paystack. Read-only: nothing is changed or refunded.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="ghost" onClick={() => setConfirm(false)} className="min-h-[44px] text-slate-300">Cancel</Button>
            <Button disabled={run.isPending} onClick={() => { setConfirm(false); run.mutate(); }} className="min-h-[44px] bg-purple-600 hover:bg-purple-700" data-testid="button-paystack-confirm">Look it up</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
const CheckCircleMark = () => <CheckIcon size={16} aria-hidden />;

function Party({ label, name }: { label: string; name: string }) {
  return <KV k={label} v={name} />;
}

function DetailBody({ id, onFilter }: { id: string; onFilter: (patch: Partial<TxFilters>) => void }) {
  const { toast } = useToast();
  const q = useQuery<LedgerDetail>({ queryKey: [`${BASE}/transactions/${id}`], queryFn: () => getJson(`${BASE}/transactions/${id}`) });
  if (q.isLoading) return <Msg>Loading...</Msg>;
  if (q.error || !q.data) return <Msg tone="error">Could not load this transaction. <button className="underline" onClick={() => q.refetch()}>Try again</button></Msg>;
  const { tx, timeline, synthetic, siblings } = q.data;
  const parts = [
    ["VAT", tx.vatKobo], ["Card fee", tx.feeKobo], ["Fraud reserve", tx.reserveKobo], ["Platform", tx.platformKobo], ["Host", tx.hostKobo], ["Recipient (stage guest)", tx.guestKobo ?? 0],
  ] as const;
  const sum = parts.reduce((a, [, v]) => a + v, 0);
  const copy = async () => {
    try { await navigator.clipboard.writeText(tx.providerRef); toast({ title: "Reference copied" }); } catch { toast({ title: "Could not copy. Select the reference and copy it." }); }
  };
  return (
    <div className="space-y-6 pb-8">
      <div className="flex flex-wrap items-center gap-3">
        <StatusChip status={tx.status} />
        <span className="text-lg font-semibold tabular-nums text-white">{naira(tx.amountKobo)}</span>
        <span className="text-sm text-slate-300">{TIER_LABEL[tx.tier] ?? tx.tier}</span>
      </div>
      <p className="text-sm text-slate-200" data-testid="detail-ended-as">{tx.endedAs}</p>

      <section aria-labelledby="parties-h">
        <h4 id="parties-h" className="mb-1 text-sm font-semibold text-white">Parties</h4>
        <dl className={`${panel} divide-y divide-slate-700/60`}>
          <Party label="Room" name={tx.roomTitle} />
          <Party label="Host" name={tx.hostUsername} />
          <Party label="Payer" name={tx.payerUsername} />
          <Party label="Recipient" name={tx.recipientUsername} />
          {tx.hostSubaccountLast4 && <KV k="Host payout account" v={`ending ${tx.hostSubaccountLast4}`} />}
          {tx.recipientSubaccountLast4 && <KV k="Recipient payout account" v={`ending ${tx.recipientSubaccountLast4}`} />}
        </dl>
        <div className="mt-2 flex flex-wrap gap-2">
          {([["Room", { roomId: tx.roomId }], ["Host", { hostId: tx.hostId }], ["Payer", { payerId: tx.payerId }], ["Recipient", { recipientId: tx.recipientId }]] as const).map(([l, patch]) => (
            <Button key={l} variant="outline" size="sm" onClick={() => onFilter(patch)} className="min-h-[44px] border-slate-600 text-slate-200" data-testid={`filter-by-${l.toLowerCase()}`}>All for this {l.toLowerCase()}</Button>
          ))}
        </div>
      </section>

      <section aria-labelledby="split-h">
        <h4 id="split-h" className="mb-1 text-sm font-semibold text-white">Where the money went</h4>
        <dl className={`${panel} divide-y divide-slate-700/60`} data-testid="detail-split">
          {parts.map(([k, v]) => <KV key={k} k={k} v={naira(v)} />)}
          <KV k="Total" v={naira(sum)} strong />
        </dl>
        {sum !== tx.amountKobo && <p role="alert" className="mt-1 text-sm text-amber-300">The parts add to {naira(sum)} but the spray was {naira(tx.amountKobo)}.</p>}
      </section>

      <section aria-labelledby="ref-h">
        <h4 id="ref-h" className="mb-1 text-sm font-semibold text-white">Paystack reference</h4>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 break-all rounded bg-slate-900 px-2 py-1 text-sm text-slate-100" data-testid="detail-ref">{tx.providerRef}</code>
          <Button variant="outline" onClick={copy} aria-label="Copy the Paystack reference" className="min-h-[44px] min-w-[44px] border-slate-600 text-slate-100" data-testid="button-copy-ref"><CopyIcon size={16} aria-hidden /><span className="ml-2">Copy</span></Button>
        </div>
        {tx.batchId && <p className="mt-1 text-xs text-slate-400">This is one share of a team spray. The reference is the one charge for the whole team.</p>}
      </section>

      <PaystackCheck key={id} id={id} />

      {siblings.length > 0 && (
        <section aria-labelledby="sib-h">
          <h4 id="sib-h" className="mb-1 text-sm font-semibold text-white">Other shares of this team spray</h4>
          <ul className={`${panel} divide-y divide-slate-700/60`} data-testid="detail-siblings">
            {siblings.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm text-slate-200"><StatusChip status={s.status} /><span className="min-w-0 flex-1">{s.payerUsername} to {s.recipientUsername}</span><span className="tabular-nums">{naira(s.amountKobo)}</span></li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="tl-h">
        <h4 id="tl-h" className="mb-1 text-sm font-semibold text-white">Timeline</h4>
        {synthetic && <p className="mb-2 text-sm text-amber-300" data-testid="detail-synthetic">Synthetic timeline (older record)</p>}
        <div className={`${panel} overflow-x-auto`}>
          <table className="w-full" data-testid="detail-timeline">
            <caption className="sr-only">Status changes for this spray</caption>
            <thead><tr>{["Time", "Change", "Source", "Detail"].map((h) => <th key={h} scope="col" className="px-2.5 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-400">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-700/60">
              {timeline.map((e, i) => (
                <tr key={i}>
                  <td className={`${td} whitespace-nowrap tabular-nums`}>{whenSec(e.at)}</td>
                  <td className={`${td} whitespace-nowrap`}>{e.fromStatus ? statusLabel(e.fromStatus).label : "Start"} to {statusLabel(e.toStatus).label}</td>
                  <td className={td}>{e.source}</td>
                  <td className={`${td} break-words`}>{e.detail ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ the tab
type Page = { rows: LedgerRow[]; nextCursor: string | null };

export default function SprayTransactionsTab() {
  const { toast } = useToast();
  const [range, setRange] = useState<{ from?: Date; to?: Date }>(() => ({ from: new Date(Date.now() - 7 * 864e5), to: new Date() }));
  const [status, setStatus] = useState<string | undefined>();
  const [ids, setIds] = useState<Pick<TxFilters, "roomId" | "hostId" | "payerId" | "recipientId">>({});
  const [q, setQ] = useState("");
  const [qDraft, setQDraft] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const filters: TxFilters = {
    from: range.from ? ymd(range.from) : ymd(new Date(Date.now() - 7 * 864e5)),
    to: range.to ? ymd(range.to) : ymd(new Date()),
    status, q: q || undefined, ...ids,
  };
  const key = buildTxQuery(filters);

  const list = useInfiniteQuery<Page>({
    queryKey: [`${BASE}/transactions`, key],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => getJson<Page>(`${BASE}/transactions?${buildTxQuery(filters, { cursor: pageParam as string | null, limit: 50 })}`),
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: (p) => p,
    // Live view: only while the newest page is what is on screen and nobody is reading a detail.
    refetchInterval: (query) => ((query.state.data?.pages.length ?? 1) <= 1 && !openId ? 15_000 : false),
  });
  const rows = list.data?.pages.flatMap((p) => p.rows) ?? [];

  useEffect(() => { setExportErr(null); }, [key]);

  const open = (id: string, el?: HTMLElement | null) => { triggerRef.current = el ?? (document.activeElement as HTMLElement | null); setOpenId(id); };
  const patchFilters = (patch: Partial<TxFilters>) => { setIds((cur) => ({ ...cur, ...patch })); setOpenId(null); };
  const activeCount = [status, q, ...Object.values(ids)].filter(Boolean).length;
  const clear = () => { setStatus(undefined); setQ(""); setQDraft(""); setIds({}); };

  const exportCsv = async () => {
    setExporting(true); setExportErr(null);
    try {
      const res = await fetch(csvUrl(filters), { credentials: "include" });
      if (!res.ok) { setExportErr(csvErrorMessage(res.status, await res.json().catch(() => null))); return; }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "spray-transactions.csv";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast({ title: "Export downloaded" });
    } catch { setExportErr(csvErrorMessage(0, null)); } finally { setExporting(false); }
  };

  const idFields: { k: keyof typeof ids; label: string }[] = [{ k: "roomId", label: "Room ID" }, { k: "hostId", label: "Host ID" }, { k: "payerId", label: "Payer ID" }, { k: "recipientId", label: "Recipient ID" }];

  return (
    <section aria-labelledby="tx-h" className="space-y-6" data-testid="spray-transactions">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="tx-h" className="text-lg font-semibold text-white">Transactions</h2>
          <p className="text-sm text-slate-400">Every spray and team-spray share, where it ended, and what the timeline says. Days are in UTC.</p>
        </div>
        <AdminDateRangePicker from={range.from} to={range.to} onChange={setRange} className="min-h-[44px] border-slate-600 bg-slate-800 text-slate-100" />
      </div>

      <AttentionPanel onOpen={(id) => open(id)} />
      <OutcomesPanel from={filters.from!} to={filters.to!} />

      <div className={`${panel} space-y-4 p-4`}>
        <form role="search" className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); setQ(qDraft.trim()); }}>
          <div className="min-w-0 flex-1 basis-60">
            <Label htmlFor="tx-q" className="text-slate-300">Search</Label>
            <Input id="tx-q" value={qDraft} onChange={(e) => setQDraft(e.target.value)} maxLength={64} placeholder="Paystack reference or username" className="mt-1 min-h-[44px] border-slate-600 bg-slate-700/50 text-white" data-testid="input-tx-search" />
          </div>
          <Button type="submit" className="min-h-[44px] bg-purple-600 hover:bg-purple-700" data-testid="button-tx-search"><SearchIcon size={16} className="mr-2" aria-hidden />Search</Button>
          {activeCount > 0 && <Button type="button" variant="ghost" onClick={clear} className="min-h-[44px] text-slate-300" data-testid="button-tx-clear">Clear filters ({activeCount})</Button>}
        </form>

        <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-2">
          {STATUS_CHOICES.map((s) => {
            const Icon = ICONS[s.icon];
            const on = status === s.value;
            return (
              <button key={s.value} type="button" aria-pressed={on} onClick={() => setStatus(on ? undefined : s.value)} data-testid={`filter-status-${s.value}`}
                className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 ${on ? "border-purple-400 bg-purple-500/20 text-white" : "border-slate-600 text-slate-300 hover:text-white"}`}>
                <Icon size={14} aria-hidden />{s.label}{on && <span className="sr-only"> (selected)</span>}
              </button>
            );
          })}
        </div>

        <details className="text-sm">
          <summary className="min-h-[44px] cursor-pointer py-3 text-slate-300">Filter by room, host, payer or recipient ID{Object.values(ids).some(Boolean) ? " (set)" : ""}</summary>
          <div className="grid gap-3 sm:grid-cols-2">
            {idFields.map((f) => (
              <div key={f.k}>
                <Label htmlFor={`tx-${f.k}`} className="text-slate-300">{f.label}</Label>
                <Input id={`tx-${f.k}`} value={ids[f.k] ?? ""} maxLength={64} onChange={(e) => setIds((c) => ({ ...c, [f.k]: e.target.value.trim() || undefined }))} className="mt-1 min-h-[44px] border-slate-600 bg-slate-700/50 text-white" data-testid={`input-tx-${f.k}`} />
              </div>
            ))}
          </div>
        </details>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-slate-400" aria-live="polite">{list.isFetching && !list.isFetchingNextPage ? "Refreshing..." : `${rows.length}${list.hasNextPage ? "+" : ""} ${rows.length === 1 ? "spray" : "sprays"} shown`}</p>
          <Button variant="outline" onClick={exportCsv} disabled={exporting} className="min-h-[44px] border-slate-600 text-slate-100" data-testid="button-export-csv">
            {exporting ? <Loader2Icon className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <DownloadIcon size={16} className="mr-2" aria-hidden />}Export CSV
          </Button>
        </div>
        {exportErr && <p role="alert" className="text-sm text-red-400" data-testid="export-error">{exportErr}</p>}
      </div>

      {list.error && !list.data && <Msg tone="error">Could not load transactions. <button className="underline" onClick={() => list.refetch()}>Try again</button></Msg>}
      {list.isLoading && <Msg>Loading...</Msg>}
      {list.data && (
        <div className={`${panel} max-h-[70vh] overflow-auto`} tabIndex={0} aria-label="Transactions table, scrolls inside this box" data-testid="tx-table-wrap">
          <table className="w-full min-w-[56rem]">
            <caption className="sr-only">Spray transactions, newest first</caption>
            <thead>
              <tr>
                {["Time", "Status", "Room", "Host", "Payer to recipient", "Tier"].map((h) => <th key={h} scope="col" className={th}>{h}</th>)}
                <th scope="col" className={`${th} text-right`}>Amount</th>
                <th scope="col" className={th}>Where it ended</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/60">
              {rows.length === 0 ? (
                <tr><td colSpan={8} className={`${td} py-8 text-center text-slate-400`}>{activeCount > 0 ? "No sprays match these filters." : "No sprays in this range."}</td></tr>
              ) : rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-700/30" data-testid={`tx-row-${r.id}`}>
                  <td className={`${td} whitespace-nowrap tabular-nums`}>
                    <button type="button" onClick={(e) => open(r.id, e.currentTarget)} className="inline-flex min-h-[44px] items-center rounded px-1 text-left underline decoration-slate-500 underline-offset-2 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400" aria-label={`Open details, ${when(r.createdAt)}, ${r.payerUsername} to ${r.recipientUsername}, ${naira(r.amountKobo)}`}>{when(r.createdAt)}</button>
                  </td>
                  <td className={td}><StatusChip status={r.status} /></td>
                  <td className={`${td} max-w-[12rem] truncate`} title={r.roomTitle}>{r.roomTitle}</td>
                  <td className={td}>{r.hostUsername}</td>
                  <td className={`${td} whitespace-nowrap`}>{r.payerUsername} to {r.recipientUsername}{r.kind === "team_share" && <span className="ml-1 text-xs text-slate-400">(team)</span>}</td>
                  <td className={td}>{TIER_LABEL[r.tier] ?? r.tier}</td>
                  <td className={`${td} text-right tabular-nums`}>{naira(r.amountKobo)}</td>
                  <td className={`${td} min-w-[10rem]`}>{r.endedAs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.error && list.data && <Msg tone="error">Could not refresh. Showing the last load. <button className="underline" onClick={() => list.refetch()}>Try again</button></Msg>}
      {list.hasNextPage && (
        <div className="text-center">
          <Button variant="outline" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage} className="min-h-[44px] border-slate-600 text-slate-100" data-testid="button-tx-more">
            {list.isFetchingNextPage && <Loader2Icon className="mr-2 h-4 w-4 animate-spin" aria-hidden />}Load more
          </Button>
        </div>
      )}

      <Sheet open={!!openId} onOpenChange={(o) => { if (!o) setOpenId(null); }}>
        <SheetContent side="right" className="w-full overflow-y-auto border-slate-700 bg-slate-900 text-white sm:max-w-xl"
          onCloseAutoFocus={(e) => { e.preventDefault(); triggerRef.current?.focus(); }} data-testid="tx-drawer">
          <SheetHeader className="mb-4 text-left">
            <SheetTitle className="text-white">Spray details</SheetTitle>
            <SheetDescription className="text-slate-400">Read-only. Nothing here changes any money.</SheetDescription>
          </SheetHeader>
          {openId && <DetailBody key={openId} id={openId} onFilter={patchFilters} />}
        </SheetContent>
      </Sheet>
    </section>
  );
}
