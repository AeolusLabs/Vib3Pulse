import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CheckIcon, Loader2Icon, SearchIcon, XIcon } from "@/components/ui/icons";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// Spray hosts (finance roles): who can take spray money and who is stuck. One support action: reset the payout link, which keeps the
// bank account but makes the host relink it and pass the name check again. Never shows a legal name or a full account number.

interface Host { id: string; username: string; idVerified: boolean; hasName: boolean; bankName: string | null; last4: string | null; linked: boolean; payable: boolean; sprayRooms: number }
const FILTERS = [{ id: "stuck", label: "Stuck" }, { id: "spraying", label: "Spray on" }, { id: "ready", label: "Ready" }, { id: "all", label: "All" }] as const;
const th = "whitespace-nowrap bg-slate-800 px-2.5 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-400";
const td = "px-2.5 py-2 text-sm text-slate-200";

function Check({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return (
    <span className={`inline-flex items-center gap-1 ${ok ? "text-slate-200" : "text-slate-500"}`}>
      {ok ? <CheckIcon className="h-4 w-4 text-emerald-400" aria-hidden /> : <XIcon className="h-4 w-4" aria-hidden />}{ok ? yes : no}
    </span>
  );
}

export default function SprayHostsTab() {
  const { toast } = useToast();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("stuck");
  const [q, setQ] = useState("");
  const [target, setTarget] = useState<Host | null>(null);
  const [reason, setReason] = useState("");
  const url = `/api/admin/rooms/spray-hosts?filter=${filter}&q=${encodeURIComponent(q.trim())}`;
  const { data, isLoading, isError } = useQuery<{ hosts: Host[] }>({ queryKey: [url] });
  const reset = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/rooms/spray-hosts/${encodeURIComponent(target!.id)}/reset-payout`, { reason: reason.trim() });
      return res.json();
    },
    onSuccess: () => { toast({ title: "Payout link reset", description: `${target!.username} must relink their bank account.` }); setTarget(null); setReason(""); void queryClient.invalidateQueries({ queryKey: [url] }); },
    onError: (e: Error) => toast({ title: "Couldn't reset", description: e.message, variant: "destructive" }),
  });

  return (
    <section className="space-y-4" data-testid="spray-hosts">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filter" className="flex gap-1">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}
              className={`min-h-[44px] rounded-full border px-4 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-400 ${filter === f.id ? "border-purple-400 bg-purple-500/15 text-white" : "border-slate-600 text-slate-300"}`} data-testid={`hosts-filter-${f.id}`}>{f.label}</button>
          ))}
        </div>
        <label className="flex min-h-[44px] flex-1 items-center gap-2 rounded-full border border-slate-600 bg-slate-800/50 px-4 sm:max-w-xs">
          <SearchIcon className="h-4 w-4 text-slate-400" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Username" aria-label="Search by username" className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-slate-500" data-testid="hosts-search" />
        </label>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-700 bg-slate-800/50">
        <table className="w-full min-w-[640px]">
          <thead><tr><th className={th}>Host</th><th className={th}>ID</th><th className={th}>Name for payouts</th><th className={th}>Bank</th><th className={th}>Can be paid</th><th className={th}>Spray rooms</th><th className={th}><span className="sr-only">Action</span></th></tr></thead>
          <tbody className="divide-y divide-slate-700">
            {(data?.hosts ?? []).map((h) => (
              <tr key={h.id} data-testid={`host-row-${h.username}`}>
                <td className={`${td} font-medium text-white`}>{h.username}</td>
                <td className={td}><Check ok={h.idVerified} yes="Verified" no="Not yet" /></td>
                <td className={td}><Check ok={h.hasName} yes="On file" no="None" /></td>
                <td className={td}>{h.linked ? `${h.bankName ?? "Bank"} ••${h.last4 ?? "----"}` : <span className="text-slate-500">None</span>}</td>
                <td className={td}><Check ok={h.payable} yes="Yes" no="No" /></td>
                <td className={`${td} tabular-nums`}>{h.sprayRooms}</td>
                <td className={td}>{h.linked && <Button variant="outline" size="sm" className="min-h-[44px] border-slate-600 text-slate-200" onClick={() => { setTarget(h); setReason(""); }} data-testid={`host-reset-${h.username}`}>Reset payout link</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {isLoading && <p className="flex items-center gap-2 p-4 text-sm text-slate-400"><Loader2Icon className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />Loading</p>}
        {isError && <p role="alert" className="p-4 text-sm text-red-300">Couldn't load the hosts.</p>}
        {data && data.hosts.length === 0 && <p className="p-4 text-sm text-slate-400">No hosts match.</p>}
      </div>

      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent className="border-slate-700 bg-slate-800 text-white sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset {target?.username}'s payout link</DialogTitle>
            <DialogDescription className="text-slate-300">Their bank account stays saved, but spray and ticket money waits until they relink it and pass the name check again. Refused while a payout is being sent.</DialogDescription>
          </DialogHeader>
          <label className="space-y-1 text-sm text-slate-300">Reason (kept in the audit log)
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="min-h-[44px] border-slate-600 bg-slate-700/50 text-white" data-testid="host-reset-reason" />
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" className="min-h-[44px] text-slate-300" onClick={() => setTarget(null)}>Cancel</Button>
            <Button type="button" className="min-h-[44px] bg-red-600 hover:bg-red-700" disabled={reason.trim().length < 3 || reset.isPending} onClick={() => reset.mutate()} data-testid="host-reset-confirm">
              {reset.isPending && <Loader2Icon className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}Reset link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
