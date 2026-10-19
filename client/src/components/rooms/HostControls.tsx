import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Link2Icon, Loader2Icon, PlayIcon, UserPlusIcon } from "@/components/ui/icons";
import AdultInviteSheet from "@/components/rooms/AdultInviteSheet";
import { INVITE_SHEET_TITLE, showAdultInvite } from "@/lib/minorsRoomUi";
import type { RoomView } from "@/lib/roomsApi";
import type { AdultInvite } from "@/lib/minorsRoomApi";

interface Props {
  room: RoomView;
  /** Called after start / end / settings change so the page can reload the room. */
  onChanged: () => void;
  /** Only the host sees the adult invite entry. */
  isHost: boolean;
  /** Invites taken back this session, kept by the page so they outlive this component (the Controls sheet unmounts on close). */
  revokedInvites: Map<string, AdultInvite>;
  onRevokedInvitesChange(next: Map<string, AdultInvite>): void;
  /** Inside the live room's Controls sheet, which has its own End room confirmation: leave this block's End button out. */
  endElsewhere?: boolean;
  /** A paid room: a scheduled one is cancelled from the Tickets sheet (POST /cancel refunds every ticket), not from here. */
  ticketed?: boolean;
}

export default function HostControls({ room, onChanged, isHost, revokedInvites, onRevokedInvitesChange, endElsewhere = false, ticketed = false }: Props) {
  const { toast } = useToast();
  const [adultsOpen, setAdultsOpen] = useState(false);
  const adultsBtn = useRef<HTMLButtonElement>(null);
  const done = () => { queryClient.invalidateQueries({ queryKey: ["/api/rooms"] }); onChanged(); };
  const fail = (title: string) => (e: any) => toast({ title, description: e?.message, variant: "destructive" });

  const start = useMutation({ mutationFn: () => apiRequest("POST", `/api/rooms/${room.id}/start`), onSuccess: done, onError: fail("Couldn't start the room") });
  const end = useMutation({ mutationFn: () => apiRequest("POST", `/api/rooms/${room.id}/end`), onSuccess: done, onError: fail("Couldn't end the room") });
  const direct = useMutation({
    mutationFn: (allow: boolean) => apiRequest("PATCH", `/api/rooms/${room.id}`, { noDirectInteractions: !allow }),
    onSuccess: done, onError: fail("Couldn't change that"),
  });

  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); toast({ title: `${what} copied` }); }
    catch { toast({ title: "Couldn't copy", description: text, variant: "destructive" }); }
  };
  const newInvite = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/rooms/${room.id}/invite-token`)).json() as Promise<{ inviteLink: string }>,
    onSuccess: (r) => copy(`${window.location.origin}${r.inviteLink}`, "New invite link"),
    onError: fail("Couldn't make an invite link"),
  });

  return (
    <section aria-label="Host controls" className="space-y-3 rounded-2xl border p-3" data-testid="host-controls">
      <h2 className="text-sm font-semibold">Host controls</h2>
      <div className="flex flex-wrap gap-2">
        {room.status === "scheduled" && (
          <Button className="min-h-[44px]" disabled={start.isPending} onClick={() => start.mutate()} data-testid="button-start-room">
            {start.isPending ? <Loader2Icon className="mr-2 h-4 w-4 animate-spin" /> : <PlayIcon className="mr-2 h-4 w-4" />}Go live
          </Button>
        )}
        {room.visibility === "invite" ? (
          <Button variant="outline" className="min-h-[44px]" disabled={newInvite.isPending} onClick={() => newInvite.mutate()} data-testid="button-new-invite"><Link2Icon className="mr-2 h-4 w-4" />New invite link</Button>
        ) : (
          <Button variant="outline" className="min-h-[44px]" onClick={() => copy(`${window.location.origin}/rooms/${room.id}`, "Room link")} data-testid="button-copy-room-link"><Link2Icon className="mr-2 h-4 w-4" />Copy room link</Button>
        )}
        {showAdultInvite({ isHost, minorsRoom: room.minorsRoom }) && room.status !== "ended" && (
          <Button ref={adultsBtn} variant="outline" className="min-h-[44px]" onClick={() => setAdultsOpen(true)} data-testid="button-invite-adult"><UserPlusIcon className="mr-2 h-4 w-4" aria-hidden />{INVITE_SHEET_TITLE}</Button>
        )}
        {room.status !== "ended" && !endElsewhere && !(ticketed && room.status === "scheduled") && (
          <AlertDialog>
            <AlertDialogTrigger asChild><Button variant="destructive" className="min-h-[44px]" data-testid="button-end-room">{room.status === "live" ? "End room" : "Cancel room"}</Button></AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{room.status === "live" ? "End this room for everyone?" : "Cancel this room?"}</AlertDialogTitle>
                <AlertDialogDescription>{room.status === "live" ? "Everyone is sent out and the room closes." : "It won't start."}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it</AlertDialogCancel>
                <AlertDialogAction onClick={() => end.mutate()} data-testid="button-confirm-end">{room.status === "live" ? "End room" : "Cancel room"}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
      {room.status !== "ended" && (
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="host-direct" className="text-sm">Allow waves and private reactions</Label>
          <Switch id="host-direct" checked={!room.noDirectInteractions} disabled={direct.isPending} onCheckedChange={(v) => direct.mutate(v)} data-testid="switch-host-direct" />
        </div>
      )}
      {showAdultInvite({ isHost, minorsRoom: room.minorsRoom }) && <AdultInviteSheet open={adultsOpen} onOpenChange={setAdultsOpen} roomId={room.id} revoked={revokedInvites} onRevokedChange={onRevokedInvitesChange} returnFocusTo={() => adultsBtn.current} />}
    </section>
  );
}
