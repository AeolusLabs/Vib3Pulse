import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import AdminLayout from "./AdminLayout";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Metrics = {
  days: number;
  eventsCreated: { public: number; private: number };
  queue: { size: number; slaHours: number; slaBreached: number };
  medianTimeToReviewHours: number | null; reviewedCount: number; takedowns: number;
  reportsPerDay: Array<{ day: string; n: number }>;
  bans: { active: number; newInPeriod: number };
  autoFlagPrecision: { flaggedLaterApproved: number; flaggedLaterRejected: number; precision: number | null };
};

const Stat = ({ label, value, hint, testId, tone }: { label: string; value: React.ReactNode; hint?: string; testId: string; tone?: string }) => (
  <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4" data-testid={testId}>
    <p className="text-xs text-slate-400">{label}</p>
    <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone ?? "text-white"}`}>{value}</p>
    {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
  </div>
);

export default function AdminSocialMetrics() {
  const [days, setDays] = useState("30");
  const { data, isLoading, isError } = useQuery<Metrics>({ queryKey: [`/api/admin/social/metrics?days=${days}`] });
  const maxReports = Math.max(1, ...(data?.reportsPerDay.map((d) => d.n) ?? [1]));
  const median = data?.medianTimeToReviewHours;
  return (
    <AdminLayout>
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white" data-testid="heading-social-metrics">Social events</h1>
            <p className="text-sm text-slate-400">How hosting and moderation are going.</p>
          </div>
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-36 border-slate-600 bg-slate-800 text-slate-200" data-testid="select-days"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="7">Last 7 days</SelectItem><SelectItem value="30">Last 30 days</SelectItem><SelectItem value="90">Last 90 days</SelectItem></SelectContent>
          </Select>
        </div>
        {isLoading && <p className="text-slate-400">Loading…</p>}
        {isError && <p className="text-slate-400">Couldn't load metrics.</p>}
        {data && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat testId="stat-created-public" label="Public events created" value={data.eventsCreated.public} />
              <Stat testId="stat-created-private" label="Private events created" value={data.eventsCreated.private} />
              <Stat testId="stat-queue" label="Queue size" value={data.queue.size} hint={data.queue.slaBreached > 0 ? `${data.queue.slaBreached} past the ${data.queue.slaHours}h target` : `Target: ${data.queue.slaHours}h`} tone={data.queue.slaBreached > 0 ? "text-amber-300" : undefined} />
              <Stat testId="stat-median" label="Median time to review" value={median == null ? "—" : median < 1 ? `${Math.round(median * 60)}m` : `${median}h`} hint={`${data.reviewedCount} reviewed`} />
              <Stat testId="stat-takedowns" label="Takedowns" value={data.takedowns} hint="hidden, rejected or removed" />
              <Stat testId="stat-bans" label="Active host bans" value={data.bans.active} hint={`${data.bans.newInPeriod} new in period`} />
              <Stat testId="stat-precision" label="Auto-flag precision" value={data.autoFlagPrecision.precision === null ? "—" : `${data.autoFlagPrecision.precision}%`} hint={`${data.autoFlagPrecision.flaggedLaterRejected} rejected · ${data.autoFlagPrecision.flaggedLaterApproved} approved after flagging`} />
              <Stat testId="stat-reports" label="Reports" value={data.reportsPerDay.reduce((s, d) => s + d.n, 0)} hint="on social events" />
            </div>
            <section className="mt-6 rounded-xl border border-slate-700 bg-slate-800/50 p-4">
              <h2 className="mb-3 text-sm font-semibold text-white">Reports per day</h2>
              {data.reportsPerDay.length === 0 ? <p className="text-sm text-slate-400">No reports in this period.</p> : (
                <ul className="space-y-1.5" data-testid="reports-per-day">
                  {data.reportsPerDay.map((d) => (
                    <li key={d.day} className="flex items-center gap-3 text-xs"><span className="w-20 shrink-0 text-slate-400">{d.day}</span><span className="h-3 rounded bg-purple-500/70" style={{ width: `${(d.n / maxReports) * 100}%`, minWidth: 4 }} /><span className="text-slate-200">{d.n}</span></li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
