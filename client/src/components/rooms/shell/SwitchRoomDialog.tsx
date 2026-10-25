// "Leave [first room] and join this one?" Mounted once; the session only holds room ids, so titles come from the socket and the query cache.
import { useQueryClient } from "@tanstack/react-query";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useRoomSession } from "@/lib/roomSession";
import { switchCopy, titleOf } from "@/lib/miniBar";

export default function SwitchRoomDialog() {
  const s = useRoomSession();
  const qc = useQueryClient();
  const p = s.pendingSwitch;
  let fromTitle: string | null = null, toTitle: string | null = null;
  if (p) {
    const live = s.sock?.state.room;
    if (live && live.id === p.from) fromTitle = titleOf(live);
    const cached = qc.getQueriesData<{ room?: unknown } | null>({ queryKey: ["room", p.to] }).find(([, d]) => titleOf(d?.room));
    toTitle = titleOf(cached?.[1]?.room);
  }
  const copy = switchCopy(fromTitle, toTitle);
  return (
    <AlertDialog open={!!p} onOpenChange={(o) => { if (!o) s.cancelSwitch(); }}>
      <AlertDialogContent data-testid="dialog-room-switch">
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          {copy.description && <AlertDialogDescription>{copy.description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
          <AlertDialogAction className="min-h-11" onClick={s.confirmSwitch}>Confirm</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
