import { useRef, useState } from "react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import HostAvatar from "@/components/rooms/HostAvatar";
import { ROOM_REPORT_REASONS } from "@/components/rooms/shell/RoomMoreSheet";
import { BanIcon, ChevronDownIcon, FlagIcon, UserXIcon, VolumeXIcon } from "@/components/ui/icons";
import { apiRequest } from "@/lib/queryClient";
import { reportErrorToast, orderPeople } from "@/lib/roomShell";
import { CONTROLS_COPY, personActions, type ControlsRole } from "@/lib/hostControls";
import type { ModAction } from "@/hooks/useRoomSocket";
import type { RoomMemberView } from "@/lib/roomReducer";

export interface PeoplePanelProps {
  roomId: string;
  /** Invite token from the URL (private rooms); the report passes it through like the room report does. */
  inviteToken?: string;
  role: ControlsRole;
  selfId: string | null;
  members: RoomMemberView[];
  memberCount: number;
  stage: string[];
  /** The existing moderation over the room socket (room:mod). False when the socket is down. */
  onMod(action: ModAction, targetId: string): boolean;
  onNotice(message: string): void;
}

const nameOf = (m: RoomMemberView) => m.displayName || m.organizationName || m.username || "Guest";
const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const ACTION = `flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-medium [@media(hover:hover)_and_(pointer:fine)]:hover:bg-background ${FOCUS}`;

/**
 * Moderation: mute in chat, remove for 10 minutes, ban, report. The same socket actions and report endpoint as the avatar
 * sheet; the server re-checks each one (a co-host can only act on guests, nobody on the host).
 */
export default function PeoplePanel({ roomId, inviteToken, role, selfId, members, memberCount, stage, onMod, onNotice }: PeoplePanelProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [reportingId, setReportingId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [banTarget, setBanTarget] = useState<RoomMemberView | null>(null);
  const banned = useRef(false);
  const listRef = useRef<HTMLUListElement>(null);
  const onMic = new Set(stage);
  const people = orderPeople(members, stage).filter((m) => m.userId !== selfId);

  const mod = (action: ModAction, m: RoomMemberView) => {
    if (!onMod(action, m.userId)) { onNotice(CONTROLS_COPY.sendFailed); return false; }
    if (action === "kick" || action === "ban") { setOpenId(null); listRef.current?.focus(); } // their row goes when room:left arrives
    return true;
  };

  const report = async (m: RoomMemberView, reason: string) => {
    setSending(true);
    try {
      await apiRequest("POST", `/api/rooms/${roomId}/report${inviteToken ? `?token=${encodeURIComponent(inviteToken)}` : ""}`, { reason, type: "room_user", targetUserId: m.userId });
      onNotice("Report sent. Thanks, our team will look at it.");
      setReportingId(null);
    } catch (e) {
      onNotice(reportErrorToast((e as Error)?.message).title);
    } finally {
      setSending(false);
    }
  };

  if (people.length === 0) {
    return <p className="rounded-2xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground" data-testid="people-empty">{CONTROLS_COPY.peopleEmpty}</p>;
  }

  return (
    <div className="space-y-2" data-testid="people-panel">
      <ul ref={listRef} tabIndex={-1} className="grid gap-1.5 outline-none" aria-label="People in the room">
        {people.map((m) => {
          const name = nameOf(m);
          const tag = m.role === "host" ? "Host" : m.role === "cohost" ? "Co-host" : onMic.has(m.userId) ? "On the mic" : "Guest";
          const actions = personActions(role, m, selfId);
          const open = openId === m.userId;
          const regionId = `people-actions-${m.userId}`;
          return (
            <li key={m.userId} className="rounded-2xl border bg-muted" data-testid={`people-row-${m.userId}`}>
              <button
                type="button" aria-expanded={open} aria-controls={regionId}
                onClick={() => { setOpenId(open ? null : m.userId); setReportingId(null); }}
                className={`flex min-h-[56px] w-full items-center gap-3 rounded-2xl px-3 py-1.5 text-left ${FOCUS}`}
                data-testid={`people-toggle-${m.userId}`}
              >
                <HostAvatar person={m} className="h-9 w-9 shrink-0 rounded-full" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{name}</span>
                  <span className="block text-xs text-muted-foreground">{tag}{m.muted ? " · Chat muted" : ""}</span>
                </span>
                <ChevronDownIcon className={`h-4 w-4 shrink-0 text-muted-foreground motion-safe:transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
              </button>
              {open && (
                <div id={regionId} role="group" aria-label={`Actions for ${name}`} className="space-y-0.5 px-2 pb-2">
                  {actions.includes("mute") && <button type="button" className={ACTION} onClick={() => mod("mute", m)} data-testid={`people-mute-${m.userId}`}><VolumeXIcon className="h-4 w-4" aria-hidden />Mute in chat</button>}
                  {actions.includes("unmute") && <button type="button" className={ACTION} onClick={() => mod("unmute", m)} data-testid={`people-unmute-${m.userId}`}><VolumeXIcon className="h-4 w-4" aria-hidden />Let them chat again</button>}
                  {actions.includes("kick") && <button type="button" className={ACTION} onClick={() => mod("kick", m)} data-testid={`people-kick-${m.userId}`}><UserXIcon className="h-4 w-4" aria-hidden />{CONTROLS_COPY.kick}</button>}
                  {actions.includes("ban") && <button type="button" className={`${ACTION} text-destructive`} onClick={() => setBanTarget(m)} data-testid={`people-ban-${m.userId}`}><BanIcon className="h-4 w-4" aria-hidden />{CONTROLS_COPY.ban}</button>}
                  {actions.includes("report") && (
                    <button type="button" className={ACTION} aria-expanded={reportingId === m.userId} onClick={() => setReportingId(reportingId === m.userId ? null : m.userId)} data-testid={`people-report-${m.userId}`}>
                      <FlagIcon className="h-4 w-4" aria-hidden />{CONTROLS_COPY.report}
                    </button>
                  )}
                  {reportingId === m.userId && (
                    <div role="group" aria-label="Reason" className="grid gap-1 px-1 pt-1">
                      {ROOM_REPORT_REASONS.map((r) => (
                        <button key={r} type="button" disabled={sending} onClick={() => void report(m, r)} className={`min-h-[44px] rounded-xl border bg-background px-3 text-left text-sm disabled:opacity-60 ${FOCUS}`}>{r}</button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {memberCount > members.length && <p className="px-2 text-xs text-muted-foreground">+{memberCount - members.length} more</p>}

      <AlertDialog open={banTarget !== null} onOpenChange={(o) => { if (!o) setBanTarget(null); }}>
        <AlertDialogContent onCloseAutoFocus={(e) => { if (banned.current) { banned.current = false; e.preventDefault(); listRef.current?.focus(); } }}>
          <AlertDialogHeader>
            <AlertDialogTitle>{banTarget ? `Ban ${nameOf(banTarget)} from this room?` : "Ban from this room?"}</AlertDialogTitle>
            <AlertDialogDescription>They'll be removed now and can't come back to this room.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-[44px]">Cancel</AlertDialogCancel>
            <Button variant="destructive" className="min-h-[44px]" onClick={() => { if (banTarget && mod("ban", banTarget)) banned.current = true; setBanTarget(null); }} data-testid="button-confirm-ban">Ban</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
