import { useRef, useState } from "react";
import StartRoomFlow from "@/components/rooms/create/StartRoomFlow";
import { Button } from "@/components/ui/button";
import { PlusIcon } from "@/components/ui/icons";

/**
 * THE create-room entry for the Rooms home. Prop-less on purpose: RoomsPage renders it and knows nothing about what opens.
 * Opens the quick start sheet and the create-room wizard (task 3.3); focus comes back to this button when they close.
 */
export default function StartRoomButton({ variant = "primary" }: { variant?: "primary" | "quiet" }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      {variant === "primary" ? (
        <Button ref={btn} onClick={() => setOpen(true)} className="h-12 rounded-full px-6" data-testid="button-new-room"><PlusIcon className="mr-2 h-4 w-4" />Start a room</Button>
      ) : (
        <Button ref={btn} variant="outline" onClick={() => setOpen(true)} className="h-11 rounded-full px-6" data-testid="button-new-room-empty">Start a room</Button>
      )}
      <StartRoomFlow open={open} onOpenChange={setOpen} returnFocusTo={() => btn.current} />
    </>
  );
}
