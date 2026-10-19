import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import HostControls from "@/components/rooms/HostControls";
import RoomLobby from "@/components/rooms/RoomLobby";
import HostAvatar from "@/components/rooms/HostAvatar";
import MinorsRoomWarning from "@/components/rooms/MinorsRoomWarning";
import RoomShell from "@/components/rooms/shell/RoomShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useRoomSocket } from "@/hooks/useRoomSocket";
import { useRoomVoice } from "@/hooks/useRoomVoice";
import { showsShell } from "@/lib/roomIntegration";
import { AGE_LIMIT_EVICTED_COPY, DENIED_MESSAGE, HOST_REVIEW_COPY, KIND_LABEL, type PeekMember, VISIBILITY_LABEL, ageLimitLabel, fetchRooms, formatWhen, hostName, type RoomHostSummary, type RoomView } from "@/lib/roomsApi";
import { ArrowLeftIcon } from "@/components/ui/icons";
import { isAgeUnknownDenied, isMinorsDenied, isRoomDenial, listenOnlyHere, minorsCodeFor, parseRoomDenial, showListenLine, type RoomDenial } from "@/lib/minorsRoomUi";
import type { AdultInvite } from "@/lib/minorsRoomApi";

interface RoomDetail {
  room: Omit<RoomView, "host" | "memberCount">;
  host: RoomHostSummary | null;
  canJoin: { ok: true } | { ok: false; code: string };
  memberCount: number;
  peek?: PeekMember[];
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

  const { data: raw, isLoading, error, refetch } = useQuery<RoomDetail | RoomDenial | null>({
    queryKey: ["room", id, token ?? ""],
    queryFn: async () => {
      const r = await fetch(`/api/rooms/${id}${token ? `?token=${encodeURIComponent(token)}` : ""}`, { credentials: "include" });
      if (r.status === 404) return null;
      // A minors' room refusal keeps only its code: the text and anything else in the body is dropped, so nothing about the room is cached.
      if (r.status === 403) { const denied = parseRoomDenial(r.status, await r.json().catch(() => null)); if (denied) return denied; }
      if (!r.ok) throw new Error("Couldn't load the room");
      return r.json();
    },
    staleTime: 0,
    refetchInterval: (q) => { const d = q.state.data; return d && !isRoomDenial(d) && d.room.status === "scheduled" ? 15_000 : false; }, // a waiting guest sees it go live
    gcTime: 0, // a refusal or a room is not kept around once the page closes
  });

  const sock = useRoomSocket(id, { inviteToken: token });
  const { state } = sock;
  const detail = isRoomDenial(raw) ? null : raw;
  const ageUnknownDenied = isAgeUnknownDenied(raw);
  // Invites taken back this session. Lives here, not in the Controls sheet, so the "Revoked" rows survive the sheet closing.
  const [revokedInvites, setRevokedInvites] = useState<Map<string, AdultInvite>>(new Map());
  const minorsCode = minorsCodeFor(isMinorsDenied(raw) ? raw : null, state); // one screen, whether the refusal came over HTTP or the socket
  // "reconnecting" counts as live: a blip in the app connection must not hang up the media (that ended the stream by our own hand).
  const voice = useRoomVoice(id, { enabled: state.voiceEnabled && (state.phase === "live" || state.phase === "reconnecting"), inviteToken: token, onCameraLost: () => sock.liveAction("stop") });
  const room = detail?.room;
  const live = room?.status === "live";
  const canJoin = detail?.canJoin.ok === true;

  // The host (and anyone already a member, e.g. after a reload) goes straight in; everyone else sees the lobby and taps Join.
  const [joinTapped, setJoinTapped] = useState(false);
  const goesStraightIn = !!detail && (detail.room.hostId === me?.id || !!detail.you);
  useEffect(() => {
    if (live && canJoin && state.phase === "idle" && (goesStraightIn || joinTapped)) sock.join();
  }, [live, canJoin, state.phase, goesStraightIn, joinTapped]); // eslint-disable-line react-hooks/exhaustive-deps
  // Tapping Join was the gesture that lets the browser play sound: start room audio as soon as the room has voice, no second tap.
  useEffect(() => {
    if (joinTapped && state.phase === "live" && state.voiceEnabled && voice.status === "needs-tap") void voice.unlock();
  }, [joinTapped, state.phase, state.voiceEnabled, voice.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Adults only listen and chat in a minors' room. The age is the viewer's own, read from their own settings; the server enforces it regardless.
  const minorsRoom = detail?.room.minorsRoom === true || state.room?.minorsRoom === true;
  const { data: myAge } = useQuery<{ age: number | null }>({ queryKey: ["/api/users/me/room-privacy"], enabled: !!me && minorsRoom });
  const listenOnly = listenOnlyHere({ minorsRoom, age: myAge?.age });
  const listenLine = showListenLine({ minorsRoom, age: myAge?.age });

  const role = state.you?.role ?? detail?.you?.role ?? "guest";
  const isHost = detail?.you?.role === "host" || state.you?.role === "host";

  const { data: myLive } = useQuery<RoomView[]>({ queryKey: ["/api/rooms", "live"], queryFn: () => fetchRooms("live"), staleTime: 15_000, enabled: !!me });
  const myRoomId = myLive?.find((r) => r.hostId === me?.id && r.id !== id && r.visibility !== "invite")?.id ?? null;

  // The screen was taken back (host stopped it, an adult arrived, voice went off): switch the camera off here too.
  useEffect(() => {
    if ((voice.onAir || voice.cameraOn || voice.videoPaused) && state.phase === "live" && state.holder !== me?.id) void voice.stopCamera(); // not while reconnecting: the room state is only paused, not changed
  }, [voice.onAir, voice.cameraOn, voice.videoPaused, state.phase, state.holder, me?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const leave = () => { sock.leave(); navigate("/rooms"); };
  const back = <Button asChild variant="outline"><Link href="/rooms">Back to Rooms</Link></Button>;

  // ---------------------------------------------------------------- the room itself (chat-first shell)
  // A failed refetch keeps the last details (react-query keeps data on error), so the live room stays; it says so in a line.
  const inRoom = showsShell({ isLoading, hasDetail: !!detail && !!room, roomStatus: room?.status ?? "", canJoin: detail?.canJoin.ok === true, phase: state.phase });

  if (inRoom && detail && room) {
    return (
      <RoomShell
        id={id}
        token={token}
        room={room}
        host={detail.host}
        fallbackCount={detail.memberCount}
        isHost={isHost}
        role={role}
        meId={me?.id ?? null}
        state={state}
        sock={sock}
        voice={voice}
        myRoomId={myRoomId}
        nav={<Navigation />}
        hostControls={<HostControls room={{ ...room, host: detail.host }} onChanged={() => refetch()} isHost={isHost} revokedInvites={revokedInvites} onRevokedInvitesChange={setRevokedInvites} endElsewhere />}
        onLeave={leave}
        detailsError={!!error}
        listenOnly={listenOnly}
        listenLine={listenLine}
      />
    );
  }

  // ---------------------------------------------------------------- everything before and after the room
  let content: React.ReactNode;
  if (isLoading) {
    content = <div className="space-y-3"><Skeleton className="aspect-video w-full rounded-2xl" /><Skeleton className="h-40 w-full rounded-2xl" /></div>;
  } else if (minorsCode) {
    // The warning screen alone: no title, no host. Acknowledging records it, clears any socket refusal, reloads the room and joins.
    content = <MinorsRoomWarning code={minorsCode} roomId={id} onAcknowledged={async () => {
      if (state.phase === "denied") sock.leave();
      setJoinTapped(true);
      const r = await refetch();
      return !r.isError && !isRoomDenial(r.data); // still refused or failed: the screen says so
    }} />;
  } else if (ageUnknownDenied) {
    // No date of birth on file: the plain message only. No warning (they may be a teen) and no room details.
    content = <Panel title="You can't join this room" body={DENIED_MESSAGE.AGE_UNKNOWN} action={back} />;
  } else if (error) {
    content = <Panel title="Couldn't load this room" action={<Button onClick={() => refetch()}>Try again</Button>} />;
  } else if (!detail || !room) {
    content = <Panel title="This room isn't available" body="It may have been removed, or you may not have access." action={back} />;
  } else if (room.status === "ended" || state.phase === "ended") {
    content = state.notice?.code === "HOST_REVIEW"
      ? <Panel title="This room has closed" body={HOST_REVIEW_COPY} action={back} />
      : <Panel title="The host ended the room" body="Thanks for joining." action={back} />;
  } else if (!detail.canJoin.ok) {
    const code = detail.canJoin.code;
    content = <Panel title={code === "AGE_LIMIT" ? "This room has an age limit" : "You can't join this room"} body={DENIED_MESSAGE[code] ?? "You can't join this room."} action={back} />;
  } else if (state.phase === "denied") {
    const code = state.error ?? "NOT_FOUND";
    content = <Panel title={code === "AGE_LIMIT" ? "This room has an age limit" : code === "KICKED" ? "You were removed" : "You can't join this room"} body={code === "AGE_LIMIT" && state.room ? AGE_LIMIT_EVICTED_COPY : DENIED_MESSAGE[code] ?? "You can't join this room."} action={back} />;
  } else if (room.status === "scheduled") {
    content = (
      <div className="space-y-4">
        <Panel title="This room hasn't started" body={room.scheduledFor ? `Planned for ${formatWhen(room.scheduledFor)}.` : "The host will start it soon."} action={isHost ? undefined : back} />
        {isHost && <HostControls room={{ ...room, host: detail.host }} onChanged={() => refetch()} isHost={isHost} revokedInvites={revokedInvites} onRevokedInvitesChange={setRevokedInvites} />}
      </div>
    );
  } else {
    // idle or connecting: the lobby (the room shell takes over once the socket is live).
    content = (
      <RoomLobby room={room} host={detail.host} peek={detail.peek ?? []} memberCount={detail.memberCount} joining={joinTapped || goesStraightIn} onJoin={() => setJoinTapped(true)} />
    );
  }

  const showHeader = !!detail && !!room && !minorsCode; // never the title or host above a minors' room warning
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
                <HostAvatar person={detail!.host ?? {}} className="h-6 w-6 rounded-full" />
                <span className="truncate">{hostName(detail!.host)}</span>
                <span aria-hidden>·</span><span>{KIND_LABEL[room!.kind]}</span>
                <Badge variant="outline" data-testid="badge-room-age">{ageLimitLabel(room!.ageLimit)}</Badge>
                {room!.visibility !== "public" && <Badge variant="outline">{VISIBILITY_LABEL[room!.visibility]}</Badge>}
                {room!.status === "live" && <Badge className="bg-red-600 text-white hover:bg-red-600">Live</Badge>}
              </div>
              {room!.description && <p className="mt-1 text-sm">{room!.description}</p>}
            </div>
          </header>
        )}
        {content}
      </main>
      <BottomNavigation />
    </div>
  );
}
