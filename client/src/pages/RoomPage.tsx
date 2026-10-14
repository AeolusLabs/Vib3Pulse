import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import RoomScreen from "@/components/rooms/RoomScreen";
import RoomScene from "@/components/rooms/RoomScene";
import { RoomChat, ReactionBar } from "@/components/rooms/RoomChat";
import HostControls from "@/components/rooms/HostControls";
import AvatarActionsSheet from "@/components/rooms/AvatarActionsSheet";
import MemberListSheet from "@/components/rooms/MemberListSheet";
import HostAvatar from "@/components/rooms/HostAvatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useRoomSocket } from "@/hooks/useRoomSocket";
import { useRoomVoice } from "@/hooks/useRoomVoice";
import VoiceBar from "@/components/rooms/VoiceBar";
import StagePanel from "@/components/rooms/StagePanel";
import { DENIED_MESSAGE, KIND_LABEL, NOTICE_MESSAGE, VISIBILITY_LABEL, ageLimitLabel, fetchRooms, formatWhen, hostName, type RoomHostSummary, type RoomView } from "@/lib/roomsApi";
import type { RoomMemberView } from "@/lib/roomReducer";
import { AlertTriangleIcon, ArrowLeftIcon, UsersIcon } from "@/components/ui/icons";

interface RoomDetail {
  room: Omit<RoomView, "host" | "memberCount">;
  host: RoomHostSummary | null;
  canJoin: { ok: true } | { ok: false; code: string };
  memberCount: number;
  you: { role: "host" | "cohost" | "guest" } | null;
}

function Panel({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  return (
    <Card className="mx-auto max-w-md space-y-3 rounded-2xl p-8 text-center" role="status" data-testid="room-panel">
      <h1 className="font-serif text-2xl font-bold">{title}</h1>
      {body && <p className="text-sm text-muted-foreground">{body}</p>}
      {action}
    </Card>
  );
}

/** Keyed by room id: opening another room (a notification link, back/forward) must start from a clean slate, not inherit the old room's socket state. */
export default function RoomPage() {
  const { id } = useParams<{ id: string }>();
  return <RoomPageInner key={id} id={id} />;
}

function RoomPageInner({ id }: { id: string }) {
  const [, navigate] = useLocation();
  const { data: me } = useAuth();
  const token = useMemo(() => new URLSearchParams(window.location.search).get("token") ?? undefined, []);

  const { data: detail, isLoading, error, refetch } = useQuery<RoomDetail | null>({
    queryKey: ["room", id, token ?? ""],
    queryFn: async () => {
      const r = await fetch(`/api/rooms/${id}${token ? `?token=${encodeURIComponent(token)}` : ""}`, { credentials: "include" });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("Couldn't load the room");
      return r.json();
    },
    staleTime: 0,
    refetchInterval: (q) => (q.state.data?.room.status === "scheduled" ? 15_000 : false), // a waiting guest sees it go live
  });

  const sock = useRoomSocket(id, { inviteToken: token });
  const { state } = sock;
  const voice = useRoomVoice(id, { enabled: state.voiceEnabled && state.phase === "live", inviteToken: token });
  const room = detail?.room;
  const live = room?.status === "live";
  const canJoin = detail?.canJoin.ok === true;

  // Join as soon as we know the room is live and the door lets us in.
  useEffect(() => {
    if (live && canJoin && state.phase === "idle") sock.join();
  }, [live, canJoin, state.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const [hidden, setHidden] = useState<Set<string>>(new Set()); // people the viewer muted for themselves
  const toggleHidden = (uid: string) => setHidden((s) => { const n = new Set(s); n.has(uid) ? n.delete(uid) : n.add(uid); return n; });
  const [picked, setPicked] = useState<RoomMemberView | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const pick = (m: RoomMemberView) => { setPicked(m); setSheetOpen(true); };

  const { data: myLive } = useQuery<RoomView[]>({ queryKey: ["/api/rooms", "live"], queryFn: () => fetchRooms("live"), staleTime: 15_000, enabled: !!me });
  const myRoomId = myLive?.find((r) => r.hostId === me?.id && r.id !== id && r.visibility !== "invite")?.id ?? null;

  // Chat lines outlive the people who wrote them, so remember every name seen while they were in the room.
  const names = useRef(new Map<string, string>());
  state.members.forEach((m) => names.current.set(m.userId, m.displayName || m.organizationName || m.username || "Guest"));
  const nameOf = (uid: string) => names.current.get(uid) ?? (uid === detail?.host?.id ? hostName(detail.host) : "Someone");

  // A short spoken/visible line for the most recent private thing aimed at me, and for the last rejected action.
  const incoming = state.interactions.filter((i) => i.targetId === me?.id && !hidden.has(i.fromId)).slice(-1)[0];
  const [noticeText, setNoticeText] = useState<string | null>(null);
  useEffect(() => {
    if (!state.notice) return;
    setNoticeText(NOTICE_MESSAGE[state.notice.code] ?? "That didn't work.");
    const t = setTimeout(() => setNoticeText(null), 3500);
    return () => clearTimeout(t);
  }, [state.notice?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const isHost = detail?.you?.role === "host" || state.you?.role === "host";
  const role = state.you?.role ?? detail?.you?.role ?? "guest";
  const canControlScreen = role === "host" || role === "cohost";
  const muted = state.you?.muted ?? false;

  const leave = () => { sock.leave(); navigate("/rooms"); };
  const back = <Button asChild variant="outline"><Link href="/rooms">Back to Rooms</Link></Button>;

  let content: React.ReactNode;
  if (isLoading) {
    content = <div className="space-y-3"><Skeleton className="aspect-video w-full rounded-2xl" /><Skeleton className="h-40 w-full rounded-2xl" /></div>;
  } else if (error) {
    content = <Panel title="Couldn't load this room" action={<Button onClick={() => refetch()}>Try again</Button>} />;
  } else if (!detail || !room) {
    content = <Panel title="This room isn't available" body="It may have been removed, or you may not have access." action={back} />;
  } else if (room.status === "ended" || state.phase === "ended") {
    content = <Panel title="The host ended the room" body="Thanks for joining." action={back} />;
  } else if (!detail.canJoin.ok) {
    const code = detail.canJoin.code;
    content = <Panel title={code === "AGE_LIMIT" ? "This room has an age limit" : "You can't join this room"} body={DENIED_MESSAGE[code] ?? "You can't join this room."} action={back} />;
  } else if (state.phase === "denied") {
    const code = state.error ?? "NOT_FOUND";
    content = <Panel title={code === "AGE_LIMIT" ? "This room has an age limit" : code === "KICKED" ? "You were removed" : "You can't join this room"} body={DENIED_MESSAGE[code] ?? "You can't join this room."} action={back} />;
  } else if (room.status === "scheduled") {
    content = (
      <div className="space-y-4">
        <Panel title="This room hasn't started" body={room.scheduledFor ? `Planned for ${formatWhen(room.scheduledFor)}.` : "The host will start it soon."} action={isHost ? undefined : back} />
        {isHost && <HostControls room={{ ...room, host: detail.host }} onChanged={() => refetch()} />}
      </div>
    );
  } else {
    content = (
      <div className="space-y-4">
        {state.phase === "reconnecting" && (
          <div role="status" className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" data-testid="banner-reconnecting">
            <AlertTriangleIcon className="h-4 w-4 shrink-0" aria-hidden /> Reconnecting… the room will pick up where you left off.
          </div>
        )}
        {state.phase === "connecting" && <Skeleton className="h-6 w-48" />}

        <RoomScreen
          screen={state.room ? state.screen : room.screen}
          canControl={canControlScreen}
          onChange={(url) => sock.setScreen(url)}
          nowPlaying={state.nowPlaying} serverOffsetMs={state.serverOffsetMs} sendPlayback={sock.sendPlayback} leadsPlayback={role === "host"}
          strip={<div className="space-y-2"><RoomChat compact chat={state.chat} nameOf={nameOf} onSend={sock.chat} muted={muted} hidden={hidden} notice={noticeText} /><ReactionBar onReact={sock.react} /></div>}
        />

        {state.invitedYou && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/40 bg-primary/5 p-3" data-testid="invite-to-speak">
            <p className="text-sm font-medium">The host invited you to speak.</p>
            <div className="flex gap-2">
              <Button className="min-h-[44px]" onClick={() => sock.stageAction("accept")} data-testid="button-accept-mic">Accept</Button>
              <Button variant="outline" className="min-h-[44px]" onClick={() => { sock.stageAction("lower"); sock.dismissInvite(); }} data-testid="button-decline-mic">Decline</Button>
            </div>
          </div>
        )}

        <VoiceBar voice={voice} hasHand={!!me && state.hands.includes(me.id)} canAskToSpeak={role === "guest"} onRaise={() => sock.stageAction("raise")} onLower={() => sock.stageAction("lower")} />

        <RoomScene members={state.members} memberCount={state.memberCount} selfId={me?.id ?? null} reactions={state.reactions} interactions={state.interactions} hidden={hidden} stage={state.voiceEnabled ? state.stage : []} speaking={voice.activeSpeakers} onAvatarTap={pick} />

        {(role === "host" || role === "cohost") && (
          <StagePanel members={state.members} stage={state.stage} hands={state.hands} voiceEnabled={state.voiceEnabled} canSwitchVoice={role === "host"}
            onSwitch={async (on) => { if (!(await sock.setVoice(on))) setNoticeText(on ? "Voice isn't available right now." : "Couldn't switch voice off."); }}
            onStage={(action, target) => sock.stageAction(action, target)} />
        )}

        <div role="status" aria-live="polite" className="min-h-[1.25rem] text-center text-sm text-muted-foreground" data-testid="room-status-line">
          {incoming ? `${nameOf(incoming.fromId)} ${incoming.kind === "wave" ? "waved at you 👋" : `sent you ${incoming.emoji}`}` : noticeText}
        </div>

        <ReactionBar onReact={sock.react} className="justify-center" />

        <RoomChat chat={state.chat} nameOf={nameOf} onSend={sock.chat} muted={muted} hidden={hidden} />

        {isHost && room && <HostControls room={{ ...room, host: detail.host }} onChanged={() => refetch()} />}
        {isHost && <p className="text-center text-xs text-muted-foreground">If you close this page the room ends after 2 minutes.</p>}
      </div>
    );
  }

  const showHeader = !!detail && !!room;
  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Navigation />
      <main className="mx-auto max-w-2xl space-y-4 px-4 py-4">
        {showHeader && (
          <header className="flex items-start gap-3" data-testid="room-header">
            <Button asChild variant="ghost" size="icon" className="h-11 w-11 shrink-0" aria-label="Back to Rooms"><Link href="/rooms" onClick={() => sock.leave()}><ArrowLeftIcon className="h-5 w-5" /></Link></Button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate font-serif text-2xl font-bold leading-tight" data-testid="text-room-title">{room!.title}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <HostAvatar person={detail!.host ?? {}} className="h-6 w-6" mode="head" />
                <span className="truncate">{hostName(detail!.host)}</span>
                <span aria-hidden>·</span><span>{KIND_LABEL[room!.kind]}</span>
                <Badge variant="outline" data-testid="badge-room-age">{ageLimitLabel(room!.ageLimit)}</Badge>
                {room!.visibility !== "public" && <Badge variant="outline">{VISIBILITY_LABEL[room!.visibility]}</Badge>}
                {room!.status === "live" && <Badge className="bg-red-600 text-white hover:bg-red-600">Live</Badge>}
              </div>
              {room!.description && <p className="mt-1 text-sm">{room!.description}</p>}
            </div>
            {room!.status === "live" && canJoin && state.phase !== "denied" && state.phase !== "ended" && (
              <div className="flex shrink-0 flex-col gap-1">
                <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => setListOpen(true)} data-testid="button-members"><UsersIcon className="mr-1.5 h-4 w-4" />{state.memberCount || detail!.memberCount}</Button>
                <Button variant="ghost" size="sm" className="min-h-[44px]" onClick={leave} data-testid="button-leave-room">Leave</Button>
              </div>
            )}
          </header>
        )}
        {content}
      </main>
      <BottomNavigation />

      <MemberListSheet open={listOpen} onOpenChange={setListOpen} members={state.members} memberCount={state.memberCount} selfId={me?.id ?? null} hidden={hidden} onPick={(m) => { setListOpen(false); pick(m); }} />
      <AvatarActionsSheet
        open={sheetOpen} onOpenChange={setSheetOpen} roomId={id} target={picked}
        you={{ userId: me?.id ?? null, role }} myRoomId={myRoomId}
        onInteract={sock.interact} onMod={sock.mod}
        locallyMuted={!!picked && hidden.has(picked.userId)} onToggleLocalMute={toggleHidden}
        voiceOn={state.voiceEnabled} stage={state.stage} onStage={(action, target) => sock.stageAction(action, target)}
      />
    </div>
  );
}
