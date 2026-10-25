import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import AdminLayout from "./AdminLayout";
import { Button } from "@/components/ui/button";
import { Loader2Icon } from "@/components/ui/icons";
import DetailDrawer from "@/components/admin/age-review/DetailDrawer";
import HealthStrip from "@/components/admin/age-review/HealthStrip";
import StatusChip from "@/components/admin/age-review/StatusChip";
import { documentTypeLabel } from "@/lib/ageReview";
import { ReviewApiError, errText, listQueue, type QueueItem } from "@/lib/adminAgeReviewApi";
import { OFF_PANEL, QUEUE_FILTERS, canReview, isAgeReviewOff, canSecondApprove, canSeeHealth, methodLabel } from "@/lib/adminAgeReviewUi";

type Tab = "queue" | "second" | "health";
type Me = { role: string; displayName?: string; username?: string };

const TAB_LABEL: Record<Tab, string> = { queue: "Queue", second: "Second approvals", health: "Health" };
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

function QueueTable({ status, openId, onOpen }: { status: string; openId: string | null; onOpen: (id: string) => void }) {
  // Refresh every 20 s, but not while a detail is open (it would move rows under the reviewer).
  const q = useInfiniteQuery({
    queryKey: ["age-review-queue", status],
    queryFn: ({ pageParam }) => listQueue(status, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (l) => l.nextCursor ?? undefined,
    refetchInterval: openId ? false : 20_000,
    retry: false,
  });
  const rows: QueueItem[] = q.data?.pages.flatMap((p) => p.items) ?? [];

  if (q.isLoading) return <p role="status" className="py-10 text-center text-sm text-slate-400">Loading the queue</p>;
  if (q.error && q.error instanceof ReviewApiError && isAgeReviewOff(q.error)) {
    return (
      <div role="status" className="mx-auto max-w-md rounded-xl border border-slate-700 bg-slate-800/50 p-8 text-center" data-testid="age-review-off">
        <p className="font-medium text-white">{OFF_PANEL.title}</p>
        <p className="mt-1 text-sm text-slate-400">{OFF_PANEL.body}</p>
      </div>
    );
  }
  if (q.error) return <p role="alert" className="py-10 text-center text-sm text-red-400">{errText(q.error)}</p>;
  if (rows.length === 0) return <p role="status" className="py-10 text-center text-sm text-slate-400">Nothing waiting here.</p>;

  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full min-w-[40rem] text-sm">
          <caption className="sr-only">Age review requests, oldest first</caption>
          <thead className="text-left text-xs text-slate-400">
            <tr>
              {["Requested", "Method", "Status", "Name", "Age", "Document"].map((h) => <th key={h} scope="col" className="px-3 py-2.5 font-medium">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-700/60 hover:bg-slate-800/60">
                <td className="px-3 py-1 tabular-nums text-slate-300">
                  <button type="button" onClick={() => onOpen(r.id)} className="min-h-[44px] rounded text-left underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-400" data-testid={`open-review-${r.id}`}>
                    {fmt(r.submittedAt ?? r.createdAt)}<span className="sr-only">, open {r.displayName}</span>
                  </button>
                </td>
                <td className="px-3 py-1"><span className="rounded-full border border-slate-600 px-2.5 py-1 text-xs text-slate-200">{methodLabel(r.method)}</span></td>
                <td className="px-3 py-1">
                  <div className="flex flex-col items-start gap-1">
                    <StatusChip status={r.status} />
                    {r.awaitingSecondApproval && r.status !== "pending_second_approval" && <span className="text-xs text-amber-300">Waiting for second approval</span>}
                    {r.needsMore && <span className="text-xs text-slate-400">More photos asked</span>}
                  </div>
                </td>
                <td className="px-3 py-1 text-white">{r.displayName}</td>
                <td className="px-3 py-1 tabular-nums text-slate-300">{r.registeredAge ?? "Unknown"}</td>
                <td className="px-3 py-1 text-slate-300">{documentTypeLabel(r.documentType)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {q.hasNextPage && (
        <div className="mt-3 text-center">
          <Button variant="outline" className="min-h-[44px] border-slate-600 text-slate-200" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            {q.isFetchingNextPage && <Loader2Icon className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}Load more
          </Button>
        </div>
      )}
    </div>
  );
}

export default function AdminAgeReviews() {
  const { data: me } = useQuery<Me>({ queryKey: ["/api/admin/me"], retry: false });
  const role = me?.role ?? "";
  const [tab, setTab] = useState<Tab>("queue");
  const [filter, setFilter] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const tabs: Tab[] = ["queue", ...(canSecondApprove(role) ? (["second"] as Tab[]) : []), ...(canSeeHealth(role) ? (["health"] as Tab[]) : [])];

  return (
    <AdminLayout>
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl font-bold text-white">Age reviews</h1>
          <p className="mt-1 max-w-[65ch] text-sm text-slate-400">Compare each document with the birthdate the user registered. Images stay hidden until you press Reveal, and hide again after 30 seconds.</p>
        </div>

        {me && !canReview(role) ? (
          <p role="alert" className="text-sm text-red-400">Your role cannot review ages.</p>
        ) : (
          <>
            <div role="tablist" aria-label="Age review sections" className="flex flex-wrap gap-2">
              {tabs.map((t) => (
                <button
                  key={t} role="tab" id={`tab-${t}`} aria-selected={tab === t} aria-controls={`panel-${t}`} onClick={() => setTab(t)}
                  className={`min-h-[44px] rounded-full border px-4 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-400 ${tab === t ? "border-purple-400 bg-purple-500/15 text-white" : "border-slate-700 text-slate-300 hover:border-slate-500"}`}
                >{TAB_LABEL[t]}</button>
              ))}
            </div>

            <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="space-y-4">
              {tab === "queue" && (
                <>
                  <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-2">
                    {QUEUE_FILTERS.map((f) => (
                      <button key={f.value} type="button" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}
                        className={`min-h-[44px] rounded-full border px-3 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-400 ${filter === f.value ? "border-purple-400 text-white" : "border-slate-700 text-slate-400 hover:text-slate-200"}`}>{f.label}</button>
                    ))}
                  </div>
                  <QueueTable key={`${filter}-${version}`} status={filter} openId={openId} onOpen={setOpenId} />
                </>
              )}
              {tab === "second" && <QueueTable key={`second-${version}`} status="pending_second_approval" openId={openId} onOpen={setOpenId} />}
              {tab === "health" && <HealthStrip role={role} />}
            </div>
          </>
        )}
      </div>

      <DetailDrawer id={openId} role={role} reviewer={me?.displayName || me?.username || "reviewer"} onClose={() => setOpenId(null)} onChanged={() => setVersion((v) => v + 1)} />
    </AdminLayout>
  );
}
