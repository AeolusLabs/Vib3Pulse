import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2Icon, ShieldIcon } from "@/components/ui/icons";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { naira } from "@/components/admin/charts/tokens";
import { SPRAY_CATALOGUE, sprayBreakdown, ticketBreakdown, validateRate, type RateKey, type Rates, type SprayTier } from "@shared/money";

// The Rates tab: the percentages that split every spray and ticket. Everyone with money access can read them and the history;
// only a super-admin edits. The screen says plainly that a change applies to new records only, and the edit dialog previews what
// the change does to a real example using the same shared maths the server uses, so nothing is a surprise after saving.
// VAT and card fees are not rates here: the tax rate and the provider's fees are not ours to set.

type RateChange = { id: string; key: RateKey; before: number; after: number; reason: string; adminName: string; at: string };
type RatesData = { rates: Rates; defaults: Rates; limits: Record<RateKey, { min: number; max: number }>; changes: RateChange[] };

const TICKET_REF_KOBO = 500000; // the example ticket price in previews

type Row = { key: RateKey; label: string; help: string };
const tierRow = (tier: SprayTier): Row => ({
  key: `spray_platform_${tier}` as RateKey,
  label: `${SPRAY_CATALOGUE[tier].label} (${naira(SPRAY_CATALOGUE[tier].kobo)})`,
  help: "",
});
const GROUPS: { title: string; note: string; rows: Row[] }[] = [
  { title: "Sprays: platform share", note: "One rate per tier. Percent of what is left after VAT, card fees and the fraud reserve.", rows: (["note", "bundle", "bag", "rain"] as SprayTier[]).map(tierRow) },
  { title: "Tickets: platform share", note: "Percent of what is left after VAT, card fees and the fraud reserve.", rows: [{ key: "ticket_platform", label: "Ticket platform share", help: "Applies to every paid room ticket." }] },
  {
    title: "Fraud reserve", note: "Held back from each payment for chargebacks. Percent of the price.", rows: [
      { key: "spray_reserve", label: "Fraud reserve on sprays", help: "Taken from every spray." },
      { key: "ticket_reserve", label: "Fraud reserve on tickets", help: "Taken from every ticket." },
    ],
  },
  { title: "Stage guests", note: "When someone on stage is sprayed, the host and that guest split what the platform leaves.", rows: [{ key: "stage_guest_host", label: "Host's share of a stage-guest spray", help: "Percent of what is left after the platform share. The guest gets the rest." }] },
];
const LABEL: Record<string, string> = Object.fromEntries(GROUPS.flatMap((g) => g.rows.map((r) => [r.key, r.label])));

/** What a change does to a real example, with the shared maths: [what the example is, host before/after, platform before/after]. */
function preview(key: RateKey, now: Rates, next: number) {
  const after: Rates = { ...now, [key]: next };
  if (key === "ticket_platform" || key === "ticket_reserve") {
    const b = ticketBreakdown(TICKET_REF_KOBO, now), a = ticketBreakdown(TICKET_REF_KOBO, after);
    return { example: `a ${naira(TICKET_REF_KOBO)} ticket`, host: [b.host, a.host], platform: [b.platform, a.platform], guest: null as null | number[] };
  }
  if (key === "stage_guest_host") {
    const b = sprayBreakdown("bundle", true, now), a = sprayBreakdown("bundle", true, after);
    return { example: `a ${naira(SPRAY_CATALOGUE.bundle.kobo)} Bundle sprayed at a stage guest`, host: [b.host, a.host], platform: [b.platform, a.platform], guest: [b.guest ?? 0, a.guest ?? 0] };
  }
  const tier: SprayTier = key === "spray_reserve" ? "note" : (key.replace("spray_platform_", "") as SprayTier);
  const b = sprayBreakdown(tier, false, now), a = sprayBreakdown(tier, false, after);
  return { example: `a ${naira(SPRAY_CATALOGUE[tier].kobo)} ${SPRAY_CATALOGUE[tier].label}`, host: [b.host, a.host], platform: [b.platform, a.platform], guest: null as null | number[] };
}

const pct = (n: number) => `${n}%`;
const panel = "rounded-xl border border-slate-700 bg-slate-800/50";

function EditDialog({ row, data, onClose }: { row: Row | null; data: RatesData; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const key = row?.key;
  const lim = key ? data.limits[key] : null;
  const num = text.trim() === "" ? NaN : Number(text);
  const check = key && lim ? (Number.isNaN(num) ? { ok: false as const, reason: "Enter a number" } : validateRate(key, num)) : { ok: false as const, reason: "" };
  const unchanged = key !== undefined && check.ok && check.value === data.rates[key];
  const canSave = check.ok && !unchanged && reason.trim().length >= 3;
  const save = useMutation({
    mutationFn: async () => (await apiRequest("PUT", `/api/admin/rooms/rates/${key}`, { value: num, reason: reason.trim() })).json(),
    onSuccess: (j) => {
      toast({ title: j?.changed === false ? "Nothing changed, it was already that value" : "Rate saved. New sprays and tickets use it from now." });
      void qc.invalidateQueries({ queryKey: ["/api/admin/rooms/rates"] });
      void qc.invalidateQueries({ queryKey: ["/api/admin/rooms/controls"] });
      setText(""); setReason(""); setErr(null); onClose();
    },
    onError: (e: Error) => setErr(e.message.includes("403") ? "Only a super-admin can change rates." : e.message.includes("BAD_VALUE") ? "That value is not allowed." : "That did not work. Check the rate before trying again."),
  });
  const p = key && check.ok && !unchanged ? preview(key, data.rates, check.value) : null;
  return (
    <Dialog open={!!row} onOpenChange={(o) => { if (!o) { setText(""); setReason(""); setErr(null); onClose(); } }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto border-slate-700 bg-slate-800 text-white sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{row?.label}</DialogTitle>
          <DialogDescription className="text-slate-400">Now {key ? pct(data.rates[key]) : ""}. Default {key ? pct(data.defaults[key]) : ""}. Allowed {lim ? `${lim.min} to ${lim.max}` : ""} percent, up to 2 decimals.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); if (canSave && !save.isPending) save.mutate(); }} className="space-y-4" data-testid="rate-edit-form">
          <div className="space-y-2">
            <Label htmlFor="rate-value" className="text-slate-300">New rate (percent)</Label>
            <Input id="rate-value" type="number" inputMode="decimal" step="0.01" min={lim?.min} max={lim?.max} value={text} onChange={(e) => setText(e.target.value)} autoFocus
              className="min-h-[44px] border-slate-600 bg-slate-700 text-white" data-testid="input-rate-value" aria-invalid={text !== "" && !check.ok} aria-describedby="rate-value-msg" />
            <p id="rate-value-msg" className={`text-sm ${text !== "" && !check.ok ? "text-red-400" : "text-slate-400"}`} role={text !== "" && !check.ok ? "alert" : undefined}>
              {text !== "" && !check.ok ? check.reason : unchanged ? "That is the current value." : " "}
            </p>
          </div>
          {p && (
            <div className="rounded-lg border border-slate-600 bg-slate-900/60 p-3 text-sm text-slate-300" data-testid="rate-preview">
              <p className="mb-1 font-medium text-white">What this does to {p.example}</p>
              <p>Host gets <b className="text-white">{naira(p.host[0])}</b> now, <b className="text-white">{naira(p.host[1])}</b> after.</p>
              <p>Platform keeps <b className="text-white">{naira(p.platform[0])}</b> now, <b className="text-white">{naira(p.platform[1])}</b> after.</p>
              {p.guest && <p>Stage guest gets <b className="text-white">{naira(p.guest[0])}</b> now, <b className="text-white">{naira(p.guest[1])}</b> after.</p>}
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="rate-reason" className="text-slate-300">Reason (recorded in the audit log)</Label>
            <Textarea id="rate-reason" rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} className="border-slate-600 bg-slate-700 text-white" data-testid="input-rate-reason" />
          </div>
          <p className="text-xs text-slate-400">Applies to new sprays and tickets from now. Existing records keep their original split.</p>
          {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="ghost" onClick={onClose} className="min-h-[44px] text-slate-300">Cancel</Button>
            <Button type="submit" disabled={!canSave || save.isPending} className="min-h-[44px] bg-purple-600 hover:bg-purple-700" data-testid="button-rate-save">
              {save.isPending && <Loader2Icon className="mr-2 h-4 w-4 animate-spin" aria-hidden />}Save rate
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function RoomRatesTab({ isSuper }: { isSuper: boolean }) {
  const { data, isLoading, error, refetch } = useQuery<RatesData>({ queryKey: ["/api/admin/rooms/rates"] });
  const [editing, setEditing] = useState<Row | null>(null);
  if (isLoading) return <p role="status" className="py-8 text-center text-sm text-slate-400">Loading rates...</p>;
  if (error || !data) return <p role="alert" className="py-8 text-center text-sm text-red-400">Could not load the rates. <button className="underline" onClick={() => refetch()}>Try again</button></p>;
  return (
    <section aria-labelledby="rates-h" className="space-y-6">
      <div>
        <h2 id="rates-h" className="text-lg font-semibold text-white">Rates</h2>
        <p className="mt-2 flex items-start gap-2 text-sm text-slate-300" data-testid="rates-notice">
          <ShieldIcon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
          <span>Applies to new sprays and tickets from now. Existing records keep their original split.</span>
        </p>
        <p className="mt-1 text-sm text-slate-400">VAT (7.5%) and card fees are fixed and are not shown here. {isSuper ? "Pick Edit on a rate to change it." : "Only a super-admin can change rates."}</p>
      </div>

      <div className="space-y-5" data-testid="rates-form">
        {GROUPS.map((g) => (
          <div key={g.title}>
            <h3 className="text-base font-semibold text-white">{g.title}</h3>
            <p className="mb-2 text-sm text-slate-400">{g.note}</p>
            <ul className={`${panel} divide-y divide-slate-700`}>
              {g.rows.map((r) => {
                const changed = data.rates[r.key] !== data.defaults[r.key];
                return (
                  <li key={r.key} className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4" data-testid={`rate-row-${r.key}`}>
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="font-medium text-white">{r.label}</p>
                      {r.help && <p className="mt-0.5 text-sm text-slate-400">{r.help}</p>}
                      <p className="mt-1 text-xs text-slate-400">Default {pct(data.defaults[r.key])}, allowed {data.limits[r.key].min} to {data.limits[r.key].max}{changed && <span className="ml-2 font-semibold text-amber-300">Changed from default</span>}</p>
                    </div>
                    <p className="text-2xl font-semibold tabular-nums text-white" data-testid={`rate-value-${r.key}`}>{pct(data.rates[r.key])}</p>
                    {isSuper && <Button variant="outline" onClick={() => setEditing(r)} className="min-h-[44px] border-slate-600 text-slate-100" data-testid={`button-edit-${r.key}`}>Edit</Button>}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <div>
        <h3 className="text-base font-semibold text-white">Change history</h3>
        <p className="mb-2 text-sm text-slate-400">Every change, newest first. Nothing here can be edited or removed.</p>
        {data.changes.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400" data-testid="rates-history">No changes yet. Every rate is at its default.</p>
        ) : (
          <ul className={`${panel} divide-y divide-slate-700`} data-testid="rates-history">
            {data.changes.map((c) => (
              <li key={c.id} className="p-4">
                <p className="text-sm text-white"><span className="font-medium">{LABEL[c.key] ?? c.key}</span>: <span className="tabular-nums">{pct(c.before)}</span> to <span className="font-semibold tabular-nums">{pct(c.after)}</span></p>
                <p className="mt-0.5 text-xs text-slate-400">{c.adminName}, {format(new Date(c.at), "d MMM yyyy, HH:mm")}</p>
                <p className="mt-1 break-words text-sm text-slate-300">{c.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <EditDialog row={editing} data={data} onClose={() => setEditing(null)} />
    </section>
  );
}
