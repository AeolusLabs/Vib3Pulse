import { Bookmark } from "lucide-react";
import { useIsVenueSaved, useToggleSaveVenue } from "@/hooks/use-saved-venues";

// Same cell styling as VenueActions in VenueSections.tsx so it drops into that grid.
const cell =
  "flex flex-col items-center justify-center gap-1.5 min-h-[64px] rounded-xl border bg-card text-sm font-medium transition-[transform,border-color] duration-150 ease-out active:scale-[0.97] hover-elevate";

export function SaveVenueButton({ venueId, className = "" }: { venueId: string; className?: string }) {
  const { saved } = useIsVenueSaved(venueId);
  const { toggle, isPending } = useToggleSaveVenue(venueId);
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={isPending}
      aria-pressed={saved}
      className={`${cell} ${className}`}
      data-testid="button-save-venue"
    >
      <Bookmark className={`h-5 w-5 ${saved ? "fill-current text-primary" : ""}`} />
      {saved ? "Saved" : "Save"}
    </button>
  );
}
