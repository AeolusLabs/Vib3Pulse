import { useEffect, useMemo, useState } from "react";
import type { Venue } from "@shared/schema";
import { getOpenStatus } from "@/lib/openingHours";

// Status line for a venue's structured hours; renders nothing when there are none.
export function OpenNowStatus({ openingHours, className = "" }: { openingHours: Venue["openingHours"]; className?: string }) {
  // Re-evaluate each minute so a page left open flips at closing time.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!openingHours) return;
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, [openingHours]);

  const status = useMemo(() => getOpenStatus(openingHours, now), [openingHours, now]);
  if (status.state === "unknown") return null;

  const open = status.state === "open";
  return (
    <p className={`flex items-center gap-2 text-sm ${className}`} data-testid="text-open-status">
      {open && <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" aria-hidden="true" />}
      <span className={open ? "font-medium text-emerald-600 dark:text-emerald-400" : "font-medium text-muted-foreground"}>{status.label}</span>
      {status.detail && (
        <span className="text-muted-foreground">{open ? status.detail : `· ${status.detail}`}</span>
      )}
    </p>
  );
}
