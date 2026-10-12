import { format } from "date-fns";
import { Check, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { LogEntry } from "./scannerApi";

const row = {
  admit: { Icon: Check, tone: "text-emerald-600 dark:text-emerald-400", verb: "admitted" },
  undo: { Icon: TriangleAlert, tone: "text-amber-600 dark:text-amber-400", verb: "check-in undone" },
  reject: { Icon: X, tone: "text-destructive", verb: "" },
} as const;

/** Recent door activity, newest first. Admits from every device on this door, plus this phone's rejected scans. */
export default function DoorLog({ open, onOpenChange, entries, canUndo, onUndo, loading }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: LogEntry[];
  canUndo: (entry: LogEntry) => boolean;
  onUndo: (entry: LogEntry) => void;
  loading?: boolean;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[88vh] overflow-y-auto rounded-t-2xl px-4 pb-6" data-testid="sheet-door-log">
        <SheetHeader className="text-left">
          <SheetTitle className="font-serif text-2xl">Door log</SheetTitle>
          <SheetDescription>Latest check-ins at this door. A wrong admit can be undone.</SheetDescription>
        </SheetHeader>
        {entries.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground" data-testid="log-empty">{loading ? "Loading…" : "No scans yet."}</p>
        ) : (
          <ul className="mt-2 flex flex-col">
            {entries.map((e) => {
              const r = row[e.action];
              return (
                <li key={e.id} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2.5 border-b py-2.5" data-testid="log-row" data-action={e.action}>
                  <r.Icon className={`h-[22px] w-[22px] ${r.tone}`} />
                  <span className="min-w-0">
                    <b className="block truncate font-semibold leading-tight">{e.holderName}</b>
                    <small className="block truncate text-[13px] text-muted-foreground">
                      {e.detail ?? [e.tierName, r.verb, e.actorName ? `by ${e.actorName}` : ""].filter(Boolean).join(" · ")}
                    </small>
                  </span>
                  <span className="flex flex-col items-end gap-1">
                    <time className="text-[13px] text-muted-foreground">{format(new Date(e.createdAt), "HH:mm")}</time>
                    {canUndo(e) && (
                      <Button variant="outline" size="sm" className="h-9 text-xs" onClick={() => onUndo(e)} data-testid="button-log-undo">Undo</Button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </SheetContent>
    </Sheet>
  );
}
