// The docked bar for a room the user is still in while they use the rest of the app. Mounted once (App.tsx).
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { InfoIcon, LogOutIcon, MaximizeIcon, MicIcon, VolumeXIcon } from "@/components/ui/icons";
import { useRoomSession } from "@/lib/roomSession";
import { HOST_LEAVE_CONFIRM } from "@/lib/roomSessionRules";
import { LOCK_SCREEN_HELP, leaveFromBar, matchLine, miniBarVisible, showMute, titleOf } from "@/lib/miniBar";
import { setMediaSession } from "@/lib/mediaSession";

const BTN = "flex h-11 w-11 flex-none items-center justify-center rounded-full text-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary";

export default function RoomMiniBar() {
  const s = useRoomSession();
  const [path, navigate] = useLocation();
  const [help, setHelp] = useState(false);
  const [confirmHostLeave, setConfirmHostLeave] = useState(false);
  const shown = miniBarVisible(s.active, s.expanded, path) && !!s.sock;

  // A confirm left open must not reappear when the bar next shows.
  useEffect(() => { if (!shown) setConfirmHostLeave(false); }, [shown]);

  const st = s.sock?.state;
  const title = titleOf(st?.room) ?? "Live room";
  const host = st?.members.find((m) => m.role === "host");
  const hostName = host ? host.displayName || host.organizationName || host.username || "" : "";
  const canPublish = !!s.voice?.canPublish;
  const micOn = !!s.voice?.micOn;
  const speaking = (s.voice?.activeSpeakers.length ?? 0) > 0;
  const match = matchLine(st?.game ?? null);
  const isHost = st?.you?.role === "host";

  // Reserve space for the bar so no page content sits under it.
  useEffect(() => {
    if (!shown) return;
    document.documentElement.dataset.roomMinibar = "on";
    return () => { delete document.documentElement.dataset.roomMinibar; };
  }, [shown]);

  const latest = useRef({ toggle: () => {}, leave: () => {} });
  latest.current = {
    toggle: () => { if (canPublish) void s.voice?.toggleMic(); },
    leave: () => requestLeave(),
  };
  useEffect(() => {
    if (!shown) return;
    return setMediaSession({ title, host: hostName, muted: !micOn, onToggleMute: () => latest.current.toggle(), onLeave: () => latest.current.leave() });
  }, [shown, title, hostName, micOn]);

  if (!shown || !s.active) return null;
  const roomId = s.active.roomId;

  function requestLeave() {
    if (leaveFromBar(isHost, st?.phase === "live") === "confirm") setConfirmHostLeave(true);
    else s.leave();
  }

  return (
    <>
      <div
        className="room-minibar fixed inset-x-0 z-40 px-2 md:inset-x-auto md:right-4 md:w-[400px] md:px-0"
        role="region"
        aria-label="Your live room"
        data-testid="room-minibar"
      >
        <div className="rounded-xl border bg-card text-card-foreground shadow-lg">
          <div className="flex items-center gap-1 pl-3 pr-1">
            <span className="relative flex h-3 w-3 flex-none items-center justify-center" role="img" aria-label={speaking ? "Someone is speaking" : "Quiet"}>
              <span className={`room-minibar-dot absolute inset-0 rounded-full bg-primary ${speaking ? "is-speaking" : "opacity-40"}`} />
            </span>
            <button type="button" onClick={() => navigate(`/rooms/${roomId}`)} className="min-h-11 min-w-0 flex-1 truncate px-2 text-left text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" aria-label={`Open ${title}`} data-testid="room-minibar-open">{title}</button>
            {showMute(canPublish) && (
              <button type="button" className={BTN} onClick={() => void s.voice?.toggleMic()} aria-label={micOn ? "Mute" : "Unmute"} aria-pressed={!micOn} data-testid="room-minibar-mute">
                {micOn ? <MicIcon size={20} /> : <VolumeXIcon size={20} />}
              </button>
            )}
            <button type="button" className={BTN} onClick={() => navigate(`/rooms/${roomId}`)} aria-label="Expand room" data-testid="room-minibar-expand"><MaximizeIcon size={20} /></button>
            <button type="button" className={BTN} onClick={requestLeave} aria-label="Leave room" data-testid="room-minibar-leave"><LogOutIcon size={20} /></button>
          </div>
          <div className="flex h-7 items-center gap-1 pl-8 pr-1">
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" data-testid="room-minibar-sub">{[hostName && `Hosted by ${hostName}`, match].filter(Boolean).join(" · ") || "Live now"}</span>
            <button type="button" className={`${BTN} -my-2`} onClick={() => setHelp((v) => !v)} aria-label="Phone limits" aria-expanded={help} data-testid="room-minibar-info"><InfoIcon size={18} /></button>
          </div>
          {help && <p className="border-t px-3 py-2 text-xs text-muted-foreground" data-testid="room-minibar-help">{LOCK_SCREEN_HELP}</p>}
        </div>
      </div>
      <AlertDialog open={confirmHostLeave} onOpenChange={setConfirmHostLeave}>
        <AlertDialogContent data-testid="dialog-minibar-host-leave">
          <AlertDialogHeader>
            <AlertDialogTitle>Leave this room?</AlertDialogTitle>
            <AlertDialogDescription>{HOST_LEAVE_CONFIRM}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">Stay</AlertDialogCancel>
            <AlertDialogAction className="min-h-11" onClick={() => s.leave()}>Leave</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
