import { useEffect, useReducer, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { BanIcon, BellIcon, CheckIcon, ClockIcon, LockIcon, Share2Icon, UserXIcon, UsersIcon } from "@/components/ui/icons";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { DENIED_MESSAGE, formatWhen } from "@/lib/roomsApi";
import { shareRoomUrl } from "@/lib/roomShell";
import { STATE_TITLE, countdownTickMs, formatCountdown, initialReminder, kickedBody, msUntil, recapLines, reminderFromResponse, reminderReducer, reminderRequest, stateForCode, type RoomStateKind } from "@/lib/roomStates";

const ICON: Record<RoomStateKind, typeof UsersIcon> = { full: UsersIcon, kicked: UserXIcon, banned: BanIcon, ended: CheckIcon, locked: LockIcon, notlive: ClockIcon };

const back = <Button asChild variant="outline" className="min-h-[44px]"><Link href="/rooms">Back to Rooms</Link></Button>;

/** Same card as the page's other panels: a heading, one sentence, one primary action. */
function Shell({ icon: Icon, title, body, children }: { icon: typeof UsersIcon; title: string; body?: string; children?: React.ReactNode }) {
  return (
    <Card className="mx-auto max-w-md space-y-3 rounded-2xl p-8 text-center" role="status" data-testid="room-panel">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground" aria-hidden><Icon className="h-7 w-7" /></div>
      <h1 className="font-serif text-2xl font-bold">{title}</h1>
      {body && <p className="text-sm text-muted-foreground">{body}</p>}
      {children}
    </Card>
  );
}

interface CodeProps {
  code: string;
  kickRemainingMs?: number | null;
  room?: { startedAt?: string | null; endedAt?: string | null; peakCount?: number | null } | null;
  onRetry: () => void;
}

/** Full, removed, banned, ended, locked, not live. Returns null for any other code so the caller keeps its own screen (age, minors' room). */
export function RoomCodePanel({ code, kickRemainingMs, room, onRetry }: CodeProps) {
  const kind = stateForCode(code);
  if (!kind) return null;
  // The ended title already says it; the recap follows.
  const body = kind === "ended" ? undefined : kind === "kicked" ? kickedBody(kickRemainingMs) : DENIED_MESSAGE[code];
  const retry = <Button className="min-h-[44px]" onClick={onRetry}>Try again</Button>;
  const action = kind === "full" || kind === "locked" ? retry : back;
  if (kind === "ended") {
    const recap = recapLines(room ?? {});
    return (
      <Shell icon={ICON[kind]} title={STATE_TITLE[kind]} body={body}>
        {recap.length > 0 && <ul className="space-y-1 rounded-xl border border-border p-3 text-sm" aria-label="Room recap" data-testid="room-recap">{recap.map((l) => <li key={l}>{l}</li>)}</ul>}
        {action}
      </Shell>
    );
  }
  return <Shell icon={ICON[kind]} title={STATE_TITLE[kind]} body={body}>{action}</Shell>;
}

/** A scheduled room: when it starts, a live countdown, Remind me (optimistic) and Share. */
export function NotStartedPanel({ room, hostName, canRemind = true, reminderSet = false }: { room: { id: string; title: string; visibility: string; scheduledFor: string | null }; hostName: string; canRemind?: boolean; reminderSet?: boolean }) {
  const { toast } = useToast();
  const [now, setNow] = useState(() => Date.now());
  const left = msUntil(room.scheduledFor, now);
  useEffect(() => {
    if (left === null) return;
    const t = setInterval(() => setNow(Date.now()), countdownTickMs(left));
    return () => clearInterval(t);
  }, [left === null ? null : countdownTickMs(left)]); // eslint-disable-line react-hooks/exhaustive-deps

  const [rem, dispatch] = useReducer(reminderReducer, reminderSet, initialReminder);
  const toggle = async () => {
    if (rem.pending) return;
    const want = !rem.on;
    dispatch({ type: "tap" });
    try {
      const { method, url } = reminderRequest(room.id, want);
      const res = await apiRequest(method, url);
      dispatch({ type: "ok", on: reminderFromResponse(await res.json().catch(() => null), want) });
    } catch {
      dispatch({ type: "fail" });
    }
  };

  const shareUrl = shareRoomUrl("", room);
  const share = async () => {
    const url = shareRoomUrl(window.location.origin, room);
    if (!url) return;
    try {
      if (navigator.share && window.matchMedia("(pointer: coarse)").matches) await navigator.share({ title: room.title, url });
      else { await navigator.clipboard.writeText(url); toast({ title: "Link copied" }); }
    } catch (e: unknown) {
      if ((e as { name?: string })?.name !== "AbortError") toast({ title: "Copy the link from your browser bar" });
    }
  };

  return (
    <Shell icon={ClockIcon} title="This room hasn't started" body={room.scheduledFor ? `Starts ${formatWhen(room.scheduledFor)} with ${hostName}.` : `${hostName} will start it soon.`}>
      {left !== null && <p className="font-serif text-4xl font-bold tabular-nums" data-testid="room-countdown" aria-live="off">{formatCountdown(left)}</p>}
      <div className="flex flex-wrap justify-center gap-2">
        {canRemind && (
          <Button className="min-h-[44px]" variant={rem.on ? "outline" : "default"} aria-pressed={rem.on} onClick={toggle} data-testid="button-remind">
            {rem.on ? <CheckIcon className="mr-2 h-4 w-4" aria-hidden /> : <BellIcon className="mr-2 h-4 w-4" aria-hidden />}
            Remind me
          </Button>
        )}
        {shareUrl && <Button className="min-h-[44px]" variant="outline" onClick={share}><Share2Icon className="mr-2 h-4 w-4" aria-hidden />Share</Button>}
      </div>
      {rem.error && <p className="text-sm text-destructive" role="alert">{rem.error}</p>}
    </Shell>
  );
}
