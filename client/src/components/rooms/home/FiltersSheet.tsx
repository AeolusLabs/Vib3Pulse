import { useEffect, useState } from "react";
import { Sheet, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import RoomSheetContent from "@/components/rooms/shell/RoomSheetContent";
import { ROOM_KINDS, type RoomKind } from "@shared/rooms";
import { KIND_LABEL } from "@/lib/roomsApi";
import { NO_FILTERS, type HomeFilters, type PriceFilter } from "@/lib/roomsHome";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: HomeFilters;
  onApply: (next: HomeFilters) => void;
  /** Free or paid is offered only while the paidRooms flag is on (GET /api/rooms/config). */
  paidRoomsOn: boolean;
  returnFocusTo?: () => HTMLElement | null;
}

const chip = "min-h-[44px] rounded-full border px-4 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary";
const on = "border-primary bg-primary text-primary-foreground";
const off = "border-border text-muted-foreground hover:text-foreground";

/** Edits a draft, so nothing changes in the list until Show rooms. */
export default function FiltersSheet({ open, onOpenChange, value, onApply, paidRoomsOn, returnFocusTo }: Props) {
  const [draft, setDraft] = useState<HomeFilters>(value);
  useEffect(() => { if (open) setDraft(value); }, [open, value]);
  const toggleKind = (k: RoomKind) => setDraft((d) => ({ ...d, kinds: d.kinds.includes(k) ? d.kinds.filter((x) => x !== k) : [...d.kinds, k] }));
  const prices: { v: PriceFilter; label: string }[] = [{ v: "any", label: "Any" }, { v: "free", label: "Free" }, { v: "paid", label: "Paid" }];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <RoomSheetContent side="bottom" returnFocusTo={returnFocusTo} className="max-h-[85vh] overflow-y-auto rounded-t-3xl" data-testid="sheet-room-filters">
        <SheetHeader className="pr-12 text-left">
          <SheetTitle className="font-sans text-lg font-semibold">Filters</SheetTitle>
          <SheetDescription>Narrow the list. Rooms you cannot join never show up either way.</SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-6">
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Kind of room</legend>
            <div className="flex flex-wrap gap-2">
              {ROOM_KINDS.map((k) => (
                <button key={k} type="button" aria-pressed={draft.kinds.includes(k)} onClick={() => toggleKind(k)} className={`${chip} ${draft.kinds.includes(k) ? on : off}`} data-testid={`filter-kind-${k}`}>{KIND_LABEL[k]}</button>
              ))}
            </div>
          </fieldset>
          <div>
            <button type="button" aria-pressed={draft.friendsInside} onClick={() => setDraft((d) => ({ ...d, friendsInside: !d.friendsInside }))} className={`${chip} ${draft.friendsInside ? on : off}`} data-testid="filter-friends-inside">Friends inside</button>
            <p className="mt-1 text-xs text-muted-foreground">Only rooms with someone you follow in them.</p>
          </div>
          {paidRoomsOn && (
            <fieldset>
              <legend className="mb-2 text-sm font-medium">Price</legend>
              <div className="flex flex-wrap gap-2">
                {prices.map((p) => (
                  <button key={p.v} type="button" aria-pressed={draft.price === p.v} onClick={() => setDraft((d) => ({ ...d, price: p.v }))} className={`${chip} ${draft.price === p.v ? on : off}`} data-testid={`filter-price-${p.v}`}>{p.label}</button>
                ))}
              </div>
            </fieldset>
          )}
        </div>
        <SheetFooter className="mt-6 flex-row gap-2 sm:justify-between">
          <Button type="button" variant="ghost" className="h-11 rounded-full" onClick={() => setDraft(NO_FILTERS)} data-testid="button-filters-clear">Clear</Button>
          <Button type="button" className="h-11 flex-1 rounded-full sm:flex-none" onClick={() => { onApply(draft); onOpenChange(false); }} data-testid="button-filters-apply">Show rooms</Button>
        </SheetFooter>
      </RoomSheetContent>
    </Sheet>
  );
}
