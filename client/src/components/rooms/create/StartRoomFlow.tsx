// The whole "Start a room" entry: the quick start sheet first, the full wizard from its last two rows.
// One component so a page (or StartRoomButton from task 3.5) mounts a single thing with one open flag.
import { useState } from "react";
import type { WizardState } from "@/lib/createRoomRules";
import type { RoomLink } from "@/lib/createRoomWizardUi";
import QuickStartSheet from "./QuickStartSheet";
import CreateRoomWizard from "./CreateRoomWizard";

interface Props {
  open: boolean;
  onOpenChange(o: boolean): void;
  /** Event and venue pages pass their id; such a room always goes through the full wizard so the link is visible. */
  link?: RoomLink;
}

export default function StartRoomFlow({ open, onOpenChange, link }: Props) {
  const [wizard, setWizard] = useState<{ defaults?: Partial<WizardState> } | null>(null);
  const linked = !!(link?.eventId || link?.venueId);
  return (
    <>
      <QuickStartSheet open={open && !linked} onOpenChange={onOpenChange} onCustomize={(defaults) => setWizard({ defaults })} />
      <CreateRoomWizard
        open={!!wizard || (open && linked)}
        onOpenChange={(o) => { if (!o) { setWizard(null); if (linked) onOpenChange(false); } }}
        defaults={wizard?.defaults}
        link={link}
      />
    </>
  );
}
