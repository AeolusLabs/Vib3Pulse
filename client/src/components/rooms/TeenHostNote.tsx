import { Button } from "@/components/ui/button";
import { InfoIcon } from "@/components/ui/icons";
import { TEEN_HOST_NOTE } from "@/lib/minorsRoomUi";

/** The calm one-time note a host under 18 sees when creating a room. */
export default function TeenHostNote({ onDismiss }: { onDismiss(): void }) {
  return (
    <div role="note" className="flex items-start gap-3 rounded-lg border bg-muted p-3 text-sm" data-testid="text-teen-host-note">
      <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
      <p className="flex-1">{TEEN_HOST_NOTE}</p>
      <Button type="button" variant="ghost" className="min-h-[44px] shrink-0" onClick={onDismiss} data-testid="button-teen-note-dismiss">Got it</Button>
    </div>
  );
}
