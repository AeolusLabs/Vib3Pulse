import { AlertTriangleIcon, CheckCircleIcon, ClockIcon, EyeOffIcon, ShieldCheckIcon, SparklesIcon, XIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

// One flat chip family for every status in the organiser pages. State is carried by the icon
// and the word, never colour alone. Flat tints only: no gradients (see PRODUCT.md anti-references).
const KINDS = {
  live: { label: "Live", icon: CheckCircleIcon, tone: "text-emerald-700 bg-emerald-500/10 dark:text-emerald-400" },
  draft: { label: "Draft", icon: EyeOffIcon, tone: "text-muted-foreground bg-muted" },
  ended: { label: "Ended", icon: ClockIcon, tone: "text-muted-foreground bg-muted" },
  review: { label: "In review", icon: ClockIcon, tone: "text-amber-700 bg-amber-500/10 dark:text-amber-400" },
  rejected: { label: "Rejected", icon: XIcon, tone: "text-red-700 bg-red-500/10 dark:text-red-400" },
  flagged: { label: "Flagged", icon: AlertTriangleIcon, tone: "text-orange-700 bg-orange-500/10 dark:text-orange-400" },
  promoted: { label: "Promoted", icon: SparklesIcon, tone: "text-primary bg-primary/10 ring-1 ring-inset ring-primary/30" },
  verified: { label: "Verified", icon: ShieldCheckIcon, tone: "text-sky-700 bg-sky-500/10 dark:text-sky-400" },
  active: { label: "Active", icon: CheckCircleIcon, tone: "text-emerald-700 bg-emerald-500/10 dark:text-emerald-400" },
  inactive: { label: "Inactive", icon: EyeOffIcon, tone: "text-muted-foreground bg-muted" },
} as const;

export type StatusKind = keyof typeof KINDS;

export function StatusChip({ kind, label, className }: { kind: StatusKind; label?: string; className?: string }) {
  const k = KINDS[kind];
  const Icon = k.icon;
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-5", k.tone, className)}
      data-status={kind}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {label ?? k.label}
    </span>
  );
}
