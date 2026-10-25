import { AlertTriangleIcon, CheckCircleIcon, ClockIcon, EyeIcon, UsersIcon, XIcon } from "@/components/ui/icons";
import { statusMeta, type StatusTone } from "@/lib/adminAgeReviewUi";

const ICON = { clock: ClockIcon, eye: EyeIcon, check: CheckCircleIcon, x: XIcon, alert: AlertTriangleIcon, users: UsersIcon } as const;
const TONE: Record<StatusTone, string> = {
  wait: "border-amber-500/60 text-amber-300",
  work: "border-purple-400/60 text-purple-300",
  good: "border-emerald-500/60 text-emerald-300",
  bad: "border-red-500/60 text-red-300",
  idle: "border-slate-600 text-slate-300",
};

/** An icon and words together, so the status never relies on colour alone. */
export default function StatusChip({ status }: { status: string }) {
  const m = statusMeta(status);
  const Icon = ICON[m.icon];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium ${TONE[m.tone]}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden />{m.label}
    </span>
  );
}
