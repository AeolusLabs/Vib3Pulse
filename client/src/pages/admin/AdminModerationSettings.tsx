import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import AdminLayout from "./AdminLayout";
import ReasonDialog from "@/components/admin/ReasonDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { LockIcon } from "@/components/ui/icons";

type Setting = { key: string; label: string; help: string; kind: "int" | "list"; value: number | string[]; default: number | string[]; min?: number; max?: number; superOnly: boolean; editable: boolean; updatedBy: string | null; updatedAt: string | null };

// Thresholds live in the database, not the code, so changing one needs no deploy. Every change asks
// for a reason and is written to the audit log with the before and after values.
export default function AdminModerationSettings() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ settings: Setting[] }>({ queryKey: ["/api/admin/moderation/config"] });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<{ key: string; value: unknown } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async ({ key, value, reason }: { key: string; value: unknown; reason: string }) => (await apiRequest("PUT", `/api/admin/moderation/config/${key}`, { value, reason })).json(),
    onSuccess: (_j, v) => { setSaving(null); setErr(null); setDraft((d) => { const n = { ...d }; delete n[v.key]; return n; }); qc.invalidateQueries({ queryKey: ["/api/admin/moderation/config"] }); toast({ title: "Setting saved", description: "Recorded in the audit log." }); },
    onError: (e: Error) => setErr(e.message),
  });

  const shown = (s: Setting) => draft[s.key] ?? (s.kind === "list" ? (s.value as string[]).join("\n") : String(s.value));
  const parsed = (s: Setting): unknown => (s.kind === "list" ? shown(s).split("\n").map((x) => x.trim()).filter(Boolean) : Number(shown(s)));
  const changed = (s: Setting) => draft[s.key] !== undefined && JSON.stringify(parsed(s)) !== JSON.stringify(s.value);

  return (
    <AdminLayout>
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-bold text-white" data-testid="heading-mod-settings">Moderation settings</h1>
        <p className="mb-6 text-sm text-slate-400">Limits and thresholds for social events. Changes apply immediately and are audit-logged.</p>
        {isLoading && <p className="text-slate-400">Loading…</p>}
        <ul className="space-y-3">
          {data?.settings.map((s) => (
            <li key={s.key} className="rounded-xl border border-slate-700 bg-slate-800/50 p-4" data-testid={`setting-${s.key}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-white">{s.label}{s.superOnly && <LockIcon className="ml-1.5 inline h-3.5 w-3.5 text-slate-500" aria-label="Super-admin only" />}</p>
                  <p className="text-xs text-slate-400">{s.help}</p>
                </div>
                <p className="shrink-0 text-xs text-slate-500">Default: {Array.isArray(s.default) ? `${s.default.length} entries` : String(s.default)}</p>
              </div>
              <div className="mt-3 flex items-start gap-2">
                {s.kind === "int" ? (
                  <Input type="number" inputMode="numeric" min={s.min} max={s.max} value={shown(s)} disabled={!s.editable} onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })} className="w-32 border-slate-600 bg-slate-900 text-white" data-testid={`input-${s.key}`} />
                ) : (
                  <Textarea rows={5} value={shown(s)} disabled={!s.editable} onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })} className="border-slate-600 bg-slate-900 font-mono text-xs text-white" aria-label="One entry per line" data-testid={`input-${s.key}`} />
                )}
                <Button size="sm" className="bg-purple-600 hover:bg-purple-700" disabled={!s.editable || !changed(s)} onClick={() => setSaving({ key: s.key, value: parsed(s) })} data-testid={`save-${s.key}`}>Save</Button>
              </div>
              {s.kind === "list" && <p className="mt-1 text-xs text-slate-500">One entry per line.</p>}
              {!s.editable && <p className="mt-2 text-xs text-slate-500">Only a super-admin can change this.</p>}
              {s.updatedAt && <p className="mt-2 text-xs text-slate-500">Last changed by {s.updatedBy ?? "an admin"} on {new Date(s.updatedAt).toLocaleString()}</p>}
            </li>
          ))}
        </ul>
      </div>
      {saving && <ReasonDialog open title="Change setting" description="Say why. This is saved in the audit log with the old and new values." confirmLabel="Save change" busy={save.isPending} error={err} onConfirm={(reason) => save.mutate({ ...saving, reason })} onClose={() => { setSaving(null); setErr(null); }} />}
    </AdminLayout>
  );
}
