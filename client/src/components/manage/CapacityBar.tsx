import { cn } from "@/lib/utils";

// Sold-of-capacity bar. The fill grows with scaleX (transform) rather than width.
export function CapacityBar({ sold, total, label = "Tickets sold", className }: { sold: number; total: number; label?: string; className?: string }) {
  const pct = total > 0 ? Math.min(100, (sold / total) * 100) : 0;
  const full = total > 0 && sold >= total;
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-semibold tabular-nums">
          {sold}
          {total > 0 && <span className="font-normal text-muted-foreground"> / {total}</span>}
          {full && <span className="ml-1.5 font-medium text-emerald-600 dark:text-emerald-400">Sold out</span>}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total || undefined}
        aria-valuenow={sold}
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full w-full origin-left rounded-full transition-transform duration-500 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
            full ? "bg-emerald-500" : "bg-primary",
          )}
          style={{ transform: `scaleX(${pct / 100})` }}
        />
      </div>
    </div>
  );
}
