// Owner rule 2026-10-22: spray purchases are never refunded, so every place a spray can be started says so, in plain sight.
// Plain text at 14 px, normal contrast, in the flow (not a tooltip, not behind a tap). Words, not an icon, carry the meaning.
import { SPRAY_COPY } from "@/lib/sprayUi";

export default function NonRefundableNotice() {
  return (
    <p role="note" className="rounded-xl border border-border bg-muted px-3 py-2 text-sm font-medium text-foreground" data-testid="spray-nonrefundable">
      {SPRAY_COPY.nonRefundable}
    </p>
  );
}
