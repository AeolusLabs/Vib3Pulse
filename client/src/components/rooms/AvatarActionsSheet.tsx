import { useDirectMessage, DmHandled } from "@/hooks/useDirectMessage";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import RoomSheetContent from "@/components/rooms/shell/RoomSheetContent";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import HostAvatar from "@/components/rooms/HostAvatar";
import ProfilePeekSheet from "@/components/rooms/ProfilePeekSheet";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ROOM_REACTIONS } from "@shared/rooms";
import type { RoomMemberView } from "@/lib/roomReducer";
import type { ModAction } from "@/hooks/useRoomSocket";
import { BanIcon, FlagIcon, MessageCircleIcon, SendIcon, UserIcon, UserXIcon, VolumeXIcon } from "@/components/ui/icons";

export interface AvailableActions { interact: boolean; dm: boolean; invite: boolean }

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomId: string;
  target: RoomMemberView | null;
  you: { userId: string | null; role: "host" | "cohost" | "guest" } | null;
  /** Id of a room the viewer hosts that could take an invite (null when there isn't one). */
  myRoomId: string | null;
  onInteract: (targetId: string, kind: "wave" | "reaction", emoji?: string) => void;
  onMod: (action: ModAction, targetId: string) => void;
  locallyMuted: boolean;
  onToggleLocalMute: (userId: string) => void;
  /** Voice: the guests currently on the mic, and whether voice is on. Host and co-host can give the mic to anyone present. */
  voiceOn?: boolean;
  stage?: string[];
  onStage?: (action: "accept" | "remove", targetId: string) => void;
  /** Whether the "View profile" row shows. True for everyone in this phase; anonymous guests will be false later. */
  canViewProfile?: boolean;
  /** Opened from another sheet (People): where focus goes when this closes. Null keeps Radix's default (the avatar tapped). */
  returnFocusTo?: () => HTMLElement | null;
}

const REPORT_REASONS = ["Harassment or abuse", "Hate", "Sexual content", "Spam", "Seems underage", "Something else"];
const nameOf = (m: RoomMemberView) => m.displayName || m.organizationName || m.username || "Guest";

/**
 * What you can do to someone in the room. The list of social actions comes from the server (it knows ages, follows and
 * privacy settings; the client doesn't and shouldn't), and the server re-checks every action again when it is used.
 */
export default function AvatarActionsSheet({ open, onOpenChange, roomId, target, you, myRoomId, onInteract, onMod, locallyMuted, onToggleLocalMute, voiceOn, stage = [], onStage, canViewProfile = true, returnFocusTo }: Props) {
  const { toast } = useToast();
  const [peeking, setPeeking] = useState(false);
  const [picking, setPicking] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState(REPORT_REASONS[0]);
  const [confirm, setConfirm] = useState<null | "block" | "ban">(null);
  const self = !!target && target.userId === you?.userId;

  const { data: actions } = useQuery<{ actions: AvailableActions }>({
    queryKey: ["room-actions", roomId, target?.userId],
    queryFn: async () => {
      const r = await fetch(`/api/rooms/${roomId}/members/${target!.userId}/actions`, { credentials: "include" });
      if (!r.ok) return { actions: { interact: false, dm: false, invite: false } };
      return r.json();
    },
    enabled: open && !!target && !self,
    staleTime: 0,          // re-asked every time the sheet opens, so a privacy change applies at once
    gcTime: 0,
  });
  const a = actions?.actions;

  const close = () => { setPeeking(false); setPicking(false); setReporting(false); onOpenChange(false); };

  const dm = useDirectMessage();
  const message = useMutation({
    mutationFn: async () => {
      const c = await dm.start(target!.userId); // age-group warning / restrictions handled inside
      if (!c) throw new DmHandled();
      return c;
    },
    onSuccess: (c: { id: string }) => { close(); window.open(`/messages/${c.id}`, "_blank", "noopener"); }, // new tab: leaving this page would take you out of the room
    onError: (e: any) => { if (!(e instanceof DmHandled)) toast({ title: "Can't message them", description: e?.message, variant: "destructive" }); },
  });
  const invite = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/rooms/${myRoomId}/invite/${target!.userId}`),
    onSuccess: () => { toast({ title: "Invite sent" }); close(); },
    onError: (e: any) => toast({ title: "Couldn't invite", description: e?.message, variant: "destructive" }),
  });
  const report = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/rooms/${roomId}/report`, { reason, type: "room_user", targetUserId: target!.userId }),
    onSuccess: () => { toast({ title: "Report sent", description: "Thanks. Our team will look at it." }); close(); },
    onError: (e: any) => toast({ title: "Couldn't send report", description: e?.message, variant: "destructive" }),
  });
  const block = useMutation({
    mutationFn: async () => apiRequest("PUT", `/api/blocks/${target!.userId}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/blocks"] }); if (!locallyMuted) onToggleLocalMute(target!.userId); toast({ title: "Blocked" }); close(); },
    onError: (e: any) => toast({ title: "Couldn't block", description: e?.message, variant: "destructive" }),
  });

  if (!target) return null;
  const canModerate = !self && !!you && ((you.role === "host" && target.role !== "host") || (you.role === "cohost" && target.role === "guest"));
  const rowCls = "flex min-h-[44px] w-full items-center justify-start gap-3 rounded-lg px-3 text-sm";

  return (
    <>
      {dm.dialog}
      <Sheet open={open && !peeking} onOpenChange={(o) => { if (!o) close(); else onOpenChange(true); }}>
        <RoomSheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-2xl" returnFocusTo={peeking ? undefined : returnFocusTo} data-testid="avatar-actions-sheet">
          <SheetHeader className="flex-row items-center gap-3 space-y-0 pr-10 text-left">
            <HostAvatar person={target} className="h-14 w-14" />
            <div className="min-w-0">
              <SheetTitle className="truncate">{nameOf(target)}{self ? " (you)" : ""}</SheetTitle>
              <SheetDescription>{target.role === "host" ? "Host" : target.role === "cohost" ? "Co-host" : "Guest"}{target.username ? ` · @${target.username}` : ""}</SheetDescription>
            </div>
          </SheetHeader>

          <div className="mt-3 space-y-1">
            {canViewProfile && (
              <Button variant="ghost" className={rowCls} onClick={() => setPeeking(true)} data-testid="action-profile"><UserIcon className="h-4 w-4" />{self ? "View my profile" : "View profile"}</Button>
            )}

            {!self && a?.interact && (
              <>
                <Button variant="ghost" className={rowCls} onClick={() => { onInteract(target.userId, "wave"); close(); }} data-testid="action-wave"><span aria-hidden>👋</span>Wave</Button>
                <Button variant="ghost" className={rowCls} onClick={() => setPicking((p) => !p)} aria-expanded={picking} data-testid="action-private-reaction"><span aria-hidden>💌</span>Send a private reaction</Button>
                {picking && (
                  <div className="flex flex-wrap gap-1 px-3" role="group" aria-label="Private reaction">
                    {ROOM_REACTIONS.map((e) => (
                      <button key={e} type="button" className="flex h-11 w-11 items-center justify-center rounded-full border text-xl" aria-label={`Send ${e}`} onClick={() => { onInteract(target.userId, "reaction", e); close(); }}>{e}</button>
                    ))}
                  </div>
                )}
              </>
            )}
            {!self && a?.dm && <Button variant="ghost" className={rowCls} disabled={message.isPending} onClick={() => message.mutate()} data-testid="action-message"><MessageCircleIcon className="h-4 w-4" />Message</Button>}
            {!self && a?.invite && myRoomId && <Button variant="ghost" className={rowCls} disabled={invite.isPending} onClick={() => invite.mutate()} data-testid="action-invite"><SendIcon className="h-4 w-4" />Invite to my room</Button>}

            {!self && (
              <>
                <Button variant="ghost" className={rowCls} onClick={() => onToggleLocalMute(target.userId)} aria-pressed={locallyMuted} data-testid="action-local-mute"><VolumeXIcon className="h-4 w-4" />{locallyMuted ? "Unmute for me" : "Mute for me"}</Button>
                <Button variant="ghost" className={rowCls} onClick={() => setReporting((r) => !r)} aria-expanded={reporting} data-testid="action-report"><FlagIcon className="h-4 w-4" />Report</Button>
                {reporting && (
                  <div className="space-y-2 px-3 pb-2">
                    <Select value={reason} onValueChange={setReason}>
                      <SelectTrigger aria-label="Reason" className="min-h-[44px]"><SelectValue /></SelectTrigger>
                      <SelectContent>{REPORT_REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
                    </Select>
                    <Button className="min-h-[44px] w-full" disabled={report.isPending} onClick={() => report.mutate()} data-testid="button-send-report">Send report</Button>
                  </div>
                )}
                <Button variant="ghost" className={`${rowCls} text-destructive`} onClick={() => setConfirm("block")} data-testid="action-block"><UserXIcon className="h-4 w-4" />Block</Button>
              </>
            )}

            {canModerate && (
              <div className="mt-2 space-y-1 border-t pt-2" data-testid="mod-actions">
                <p className="px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Host controls</p>
                {voiceOn && onStage && target.role === "guest" && (stage.includes(target.userId)
                  ? <Button variant="ghost" className={rowCls} onClick={() => { onStage("remove", target.userId); close(); }} data-testid="action-take-mic"><VolumeXIcon className="h-4 w-4" />Take mic away</Button>
                  : <Button variant="ghost" className={rowCls} onClick={() => { onStage("accept", target.userId); close(); }} data-testid="action-give-mic"><span aria-hidden>🎤</span>Give speaking rights</Button>)}
                <Button variant="ghost" className={rowCls} onClick={() => { onMod(target.muted ? "unmute" : "mute", target.userId); close(); }} data-testid="action-mod-mute"><VolumeXIcon className="h-4 w-4" />{target.muted ? "Let them chat again" : "Mute chat"}</Button>
                <Button variant="ghost" className={rowCls} onClick={() => { onMod("kick", target.userId); close(); }} data-testid="action-mod-kick"><UserXIcon className="h-4 w-4" />Remove from room</Button>
                <Button variant="ghost" className={`${rowCls} text-destructive`} onClick={() => setConfirm("ban")} data-testid="action-mod-ban"><BanIcon className="h-4 w-4" />Ban from room</Button>
              </div>
            )}
          </div>
        </RoomSheetContent>
      </Sheet>

      <ProfilePeekSheet open={peeking} onOpenChange={setPeeking} member={target} canViewProfile={canViewProfile} />

      <AlertDialog open={confirm !== null} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "ban" ? `Ban ${nameOf(target)} from this room?` : `Block ${nameOf(target)}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "ban" ? "They'll be removed now and can't come back to this room." : "You won't see each other's rooms or be able to message each other. You can unblock them in Account settings."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="button-confirm-action" onClick={() => { if (confirm === "ban") { onMod("ban", target.userId); close(); } else block.mutate(); setConfirm(null); }}>
              {confirm === "ban" ? "Ban" : "Block"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
