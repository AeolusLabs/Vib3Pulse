import { useQuery } from "@tanstack/react-query";
import AdminLayout from "./AdminLayout";
import { apiRequest } from "@/lib/queryClient";
import { AlertTriangleIcon } from "@/components/ui/icons";

interface SosAlert {
  id: string;
  username: string;
  latitude: number | null;
  longitude: number | null;
  status: "active" | "safe" | "false_alarm";
  createdAt: string;
}

const STATUS_LABEL: Record<string, { label: string; class: string }> = {
  active:      { label: "Notified",     class: "text-amber-600 dark:text-amber-400" },
  safe:        { label: "Acknowledged", class: "text-green-600 dark:text-green-400" },
  false_alarm: { label: "False Alarm",  class: "text-slate-400" },
};

function formatLocation(lat: number | null, lon: number | null) {
  if (!lat || !lon) return "Unknown";
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString();
}

export default function AdminSOS() {
  const { data, isLoading } = useQuery<{ alerts: SosAlert[] }>({
    queryKey: ["/api/admin/safety-alerts"],
    queryFn: () => apiRequest("GET", "/api/admin/safety-alerts").then(r => r.json()),
    refetchInterval: 30_000,
  });

  const alerts = data?.alerts ?? [];

  return (
    <AdminLayout>
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <AlertTriangleIcon className="w-6 h-6 text-amber-400" />
            SOS Alerts
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            This is monitoring only — admins do not respond.
          </p>
        </div>

        <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
          {isLoading ? (
            <div className="text-slate-400 text-sm p-6">Loading…</div>
          ) : alerts.length === 0 ? (
            <div className="text-slate-400 text-sm p-6">No SOS alerts on record.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400 text-xs uppercase tracking-wide">
                  <th className="text-left px-4 py-3">User</th>
                  <th className="text-left px-4 py-3">Location</th>
                  <th className="text-left px-4 py-3">Triggered</th>
                  <th className="text-left px-4 py-3">Buddy Status</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((alert) => {
                  const s = STATUS_LABEL[alert.status] ?? { label: alert.status, class: "text-slate-400" };
                  return (
                    <tr key={alert.id} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                      <td className="px-4 py-3 text-white font-medium">@{alert.username}</td>
                      <td className="px-4 py-3 text-slate-300 font-mono text-xs">
                        {formatLocation(alert.latitude, alert.longitude)}
                      </td>
                      <td className="px-4 py-3 text-slate-300">{formatTime(alert.createdAt)}</td>
                      <td className={`px-4 py-3 font-medium ${s.class}`}>{s.label}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </AdminLayout>
  );
}