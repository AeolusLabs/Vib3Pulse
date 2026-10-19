import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Loader2Icon } from "@/components/ui/icons";
import { endRoomCopy, settingsErrorMessage } from "@/lib/hostControls";

export interface EndRoomDialogProps {
  /** Everyone in the room, the host included. */
  count: number;
  /** POST /api/rooms/:id/end. Null when ended (room:ended then closes the room for everyone), else the server's message. */
  onEnd(): Promise<string | null>;
}

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

/** The End room button and its confirmation. Radix puts focus back on the button when the dialog closes. */
export default function EndRoomDialog({ count, onEnd }: EndRoomDialogProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = endRoomCopy(count);
  const end = async () => {
    setBusy(true);
    setError(null);
    const err = await onEnd();
    setBusy(false);
    if (err !== null) { setError(settingsErrorMessage(err, "Couldn't end the room. Try again.")); return; }
    setOpen(false);
    void queryClient.invalidateQueries({ queryKey: ["/api/rooms"] }); // the room is gone from every Rooms list
  };
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!busy) { setOpen(o); setError(null); } }}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" className={`min-h-[48px] w-full rounded-full border-destructive font-semibold text-destructive [@media(hover:hover)_and_(pointer:fine)]:hover:bg-destructive/10 ${FOCUS}`} data-testid="button-end-room">{copy.confirm}</Button>
      </AlertDialogTrigger>
      <AlertDialogContent data-testid="end-room-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription data-testid="end-room-body">{copy.body}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p role="alert" className="text-sm font-medium text-destructive" data-testid="end-room-error">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-[44px]" disabled={busy}>{copy.cancel}</AlertDialogCancel>
          {/* A plain button, not AlertDialogAction: the dialog stays open until the server answers, so a refusal shows here. */}
          <Button variant="destructive" className="min-h-[44px]" disabled={busy} onClick={() => void end()} data-testid="button-confirm-end">
            {busy && <Loader2Icon className="mr-2 h-4 w-4 motion-safe:animate-spin" aria-hidden />}{copy.confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
