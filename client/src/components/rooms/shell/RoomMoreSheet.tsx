import type { ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import RoomSheetContent from "@/components/rooms/shell/RoomSheetContent";
import { CheckIcon, EyeIcon, FlagIcon, LogOutIcon, SettingsIcon, Share2Icon, ShieldIcon, XIcon } from "@/components/ui/icons";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { reportErrorToast, roomSafetyRules, type SafetyTone } from "@/lib/roomShell";

export interface RoomMoreSheetProps {
  open: boolean;
  onOpenChange(o: boolean): void;
  roomId: string;
  isHost: boolean;
  /** Share room is offered (false for invite-only rooms: their link carries a private token). */
  canShare: boolean;
  onShare(): void;
  onSafety(): void;
  onReport(): void;
  onLeave(): void;
  /** Host and co-host: opens the Controls sheet. Omit for everyone else. */
  onControls?: () => void;
  /** Line under the title, e.g. "13+ room". */
  subtitle?: string;
}

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const SHEET = "max-h-[84dvh] overflow-y-auto rounded-t-3xl pb-[calc(20px+env(safe-area-inset-bottom,0px))] sm:mx-auto sm:max-w-lg";

function Row({ icon, label, sub, onClick, warn, testid }: { icon: ReactNode; label: string; sub?: string; onClick(): void; warn?: boolean; testid: string }) {
  return (
    <button type="button" onClick={onClick} className={`flex min-h-[48px] w-full items-center gap-3 rounded-2xl border bg-muted px-3.5 py-1.5 text-left font-medium [@media(hover:hover)_and_(pointer:fine)]:hover:border-primary motion-safe:transition-transform motion-safe:active:scale-[0.98] ${warn ? "text-destructive" : ""} ${FOCUS}`} data-testid={testid}>
      <span className="shrink-0" aria-hidden>{icon}</span>
      <span className="min-w-0">
        <span className="block">{label}</span>
        {sub && <span className="block text-[12.5px] font-normal leading-tight text-muted-foreground">{sub}</span>}
      </span>
    </button>
  );
}

/** The room's options. Each row closes this sheet first, then the page does the thing (some open another sheet). */
export default function RoomMoreSheet({ open, onOpenChange, roomId, isHost, canShare, onShare, onSafety, onReport, onLeave, onControls, subtitle }: RoomMoreSheetProps) {
  const then = (fn: () => void) => () => { onOpenChange(false); fn(); };
  const ic = "h-5 w-5";
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <RoomSheetContent side="bottom" className={SHEET} data-testid="room-more-sheet" data-room-id={roomId}>
        <SheetHeader className="pr-10 text-left">
          <SheetTitle className="font-sans text-lg font-semibold">Room options</SheetTitle>
          <SheetDescription>{subtitle ?? "What you can do here"}</SheetDescription>
        </SheetHeader>
        <div className="mt-3 grid gap-1.5">
          {onControls && <Row icon={<SettingsIcon className={ic} />} label="Controls" sub={isHost ? "Mic, live video, invite link, end the room" : "Mic and live video"} onClick={then(onControls)} testid="more-controls" />}
          {canShare && <Row icon={<Share2Icon className={ic} />} label="Share room" sub="Copy the link to bring your crew" onClick={then(onShare)} testid="more-share" />}
          <Row icon={<ShieldIcon className={ic} />} label="Room safety" sub="Age rules and how to report" onClick={then(onSafety)} testid="more-safety" />
          {!isHost && <Row icon={<FlagIcon className={ic} />} label="Report this room" onClick={then(onReport)} warn testid="more-report" />}
          <Row icon={<LogOutIcon className={ic} />} label={isHost ? "Leave (the room ends shortly after)" : "Leave quietly"} onClick={then(onLeave)} testid="more-leave" />
        </div>
      </RoomSheetContent>
    </Sheet>
  );
}

const TONE: Record<SafetyTone, { cls: string; icon: ReactNode }> = {
  ok: { cls: "text-primary", icon: <CheckIcon className="mt-0.5 h-[18px] w-[18px]" /> },
  no: { cls: "text-destructive", icon: <XIcon className="mt-0.5 h-[18px] w-[18px]" /> },
  eye: { cls: "text-muted-foreground", icon: <EyeIcon className="mt-0.5 h-[18px] w-[18px]" /> },
};

/** Plain rules for this room, adapted to its age limit. */
export function RoomSafetySheet({ open, onOpenChange, ageLimit, ageLabel, returnFocusTo }: { open: boolean; onOpenChange(o: boolean): void; ageLimit: string; ageLabel: string; /** Opened from Room options: focus goes back to the button that opened that. */ returnFocusTo?: () => HTMLElement | null }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <RoomSheetContent side="bottom" className={SHEET} returnFocusTo={returnFocusTo} data-testid="room-safety-sheet">
        <SheetHeader className="pr-10 text-left">
          <SheetTitle className="font-sans text-lg font-semibold">Room safety</SheetTitle>
          <SheetDescription>{ageLabel} room</SheetDescription>
        </SheetHeader>
        <ul className="mt-3 grid gap-2.5 text-[14.5px]">
          {roomSafetyRules(ageLimit).map((r) => (
            <li key={r.text} className={`grid grid-cols-[20px_minmax(0,1fr)] gap-2.5 ${TONE[r.tone].cls}`}>
              <span aria-hidden>{TONE[r.tone].icon}</span><span className="text-foreground">{r.text}</span>
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => onOpenChange(false)} className={`mt-4 min-h-[48px] w-full rounded-2xl bg-primary px-4 font-semibold text-primary-foreground ${FOCUS}`} data-testid="button-safety-done">Got it</button>
      </RoomSheetContent>
    </Sheet>
  );
}

export const ROOM_REPORT_REASONS = ["Harassment or abuse", "Hate", "Sexual content", "Seems underage", "Spam", "Something else"] as const;

/** One tap per reason. The server attaches the last chat lines, so nothing else is asked for. */
export function RoomReportSheet({ open, onOpenChange, roomId, inviteToken, returnFocusTo }: { open: boolean; onOpenChange(o: boolean): void; roomId: string; inviteToken?: string; returnFocusTo?: () => HTMLElement | null }) {
  const { toast } = useToast();
  const send = useMutation({
    mutationFn: (reason: string) => apiRequest("POST", `/api/rooms/${roomId}/report${inviteToken ? `?token=${encodeURIComponent(inviteToken)}` : ""}`, { reason, type: "room" }),
    onSuccess: () => { toast({ title: "Report sent", description: "Thanks. Our team will look at it." }); onOpenChange(false); },
    onError: (e: any) => {
      const t = reportErrorToast(e?.message);
      const repeat = t.title !== "Couldn't send report"; // already reported: nothing went wrong, just close
      toast({ ...t, variant: repeat ? undefined : "destructive" });
      if (repeat) onOpenChange(false);
    },
  });
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <RoomSheetContent side="bottom" className={SHEET} returnFocusTo={returnFocusTo} data-testid="room-report-sheet">
        <SheetHeader className="pr-10 text-left">
          <SheetTitle className="font-sans text-lg font-semibold">Report this room</SheetTitle>
          <SheetDescription>What's wrong? Our team gets the last few chat lines with your report.</SheetDescription>
        </SheetHeader>
        <div className="mt-3 grid gap-1.5" role="group" aria-label="Reason">
          {ROOM_REPORT_REASONS.map((r) => (
            <button key={r} type="button" disabled={send.isPending} onClick={() => send.mutate(r)} className={`min-h-[48px] w-full rounded-2xl border bg-muted px-3.5 text-left font-medium disabled:opacity-60 [@media(hover:hover)_and_(pointer:fine)]:hover:border-primary ${FOCUS}`} data-testid={`report-reason-${r.split(" ")[0].toLowerCase()}`}>{r}</button>
          ))}
        </div>
      </RoomSheetContent>
    </Sheet>
  );
}
