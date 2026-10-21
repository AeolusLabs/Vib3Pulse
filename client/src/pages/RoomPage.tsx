import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import Navigation from "@/components/Navigation";
import BottomNavigation from "@/components/BottomNavigation";
import HostControls from "@/components/rooms/HostControls";
import RoomLobby from "@/components/rooms/RoomLobby";
import { NotStartedPanel, RoomCodePanel } from "@/components/rooms/RoomStatePanels";
import HostAvatar from "@/components/rooms/HostAvatar";
import MinorsRoomWarning from "@/components/rooms/MinorsRoomWarning";
import TicketPage from "@/components/rooms/tickets/TicketPage";
import Checkout from "@/components/rooms/tickets/Checkout";
import TicketConfirmed from "@/components/rooms/tickets/TicketConfirmed";
import WaitingRoom from "@/components/rooms/tickets/WaitingRoom";
import HostSales from "@/components/rooms/tickets/HostSales";
import RoomShell from "@/components/rooms/shell/RoomShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useRoomSocket } from "@/hooks/useRoomSocket";
import { useRoomVoice } from "@/hooks/useRoomVoice";
import { showsShell } from "@/lib/roomIntegration";
import { AGE_LIMIT_EVICTED_COPY, DENIED_MESSAGE, HOST_REVIEW_COPY, KIND_LABEL, type PeekMember, VISIBILITY_LABEL, ageLimitLabel, fetchRooms, hostName, type RoomHostSummary, type RoomTicketView, type RoomView } from "@/lib/roomsApi";
import { inviteTokenFor, parseTicketBlock, returnRef, searchWithoutRef, showsPrice, ticketGate } from "@/lib/roomTickets";
import { kickRemainingAfter, recapProbeDelayMs, stateForCode } from "@/lib/roomStates";
import { ArrowLeftIcon } from "@/components/ui/icons";
import { isAgeUnknownDenied, isLaneDenied, isMinorsDenied, isRoomDenial, listenOnlyHere, minorsCodeFor, parseRoomDenial, showListenLine, type RoomDenial } from "@/lib/minorsRoomUi";
import type { AdultInvite } from "@/lib/minorsRoomApi";
import OpenLane from "@/components/rooms/game/OpenLane";
import { laneForAge } from "@/lib/gameScreen";
import { SprayReturn } from "@/components/rooms/spray/BankApproval";
import { parseSprayBlock, searchWithoutSpray, sprayReturnId } from "@/lib/sprayUi";
import { moneyEligibleRoom } from "@shared/roomRules";

interface RoomDetail {
  room: Omit<RoomView, "host" | "memberCount">;
  host: RoomHostSummary | null;
  canJoin: { ok: true } | { ok: false; code: string };
  memberCount: number;
  peek?: PeekMember[];
  /** Top-level sibling of `room` (not a field of it): whether the viewer has a reminder on this scheduled room. */
  reminderSet?: boolean;
  you: { role: "host" | "cohost" | "guest" } | null;
  /**
   * Paid rooms (lane S1): sent ONLY to viewers who can view the room and are ticket-eligible adults. Read through
   * parseTicketBlock / ticketGate; when it is absent there is no price and no ticket UI, whatever else the room says.
   */
  ticket?: unknown;
  /**
   * Spraying (phase 5): sent ONLY to a viewer who passes payer eligibility in a live, money-eligible room. Read through
   * parseSprayBlock; absent means no Spray button or row anywhere.
   */
  spray?: unknown;
  /**
   * Age lanes: when the id in the URL is a lane PARENT, the server answers with the viewer's own lane. `room` is that lane;
   * everything the page does to the room (join, voice, report, spray) uses `lane.roomId`.
   */
  lane?: { parentRoomId: string; roomId: string; ageLane: "teen" | "adult" };
}

/** sessionStorage, or null where the browser refuses it (private modes): the invite token then lives only in the URL. */
const sessionStore = () => { try { return window.sessionStorage; } catch { return null; } };

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
  const { toast } = useToast();
  // The URL's ?token= first; on the way back from Paystack (no token in the return URL) the one TicketPage kept for this room.
  const token = useMemo(() => inviteTokenFor(window.location.search, sessionStore(), id), [id]);

  const { data: raw, isLoading, error, refetch } = useQuery<RoomDetail | RoomDenial | null>({
    queryKey: ["room", id, token ?? ""],
    queryFn: async () => {
      const r = await fetch(`/api/rooms/${id}${token ? `?token=${encodeURIComponent(token)}` : ""}`, { credentials: "include" });
      // A refusal keeps only its code and the server's warning sentence: nothing else in the body is kept, so nothing about the room is cached.
      // A lane parent with no lane for this viewer answers 404 NO_LANE, which gets its own screen; any other 404 is "not available".
      if (r.status === 404) { const denied = parseRoomDenial(r.status, await r.json().catch(() => null)); return denied; }
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
  const voice = useRoomVoice(detail?.lane?.roomId ?? id, { enabled: state.voiceEnabled && (state.phase === "live" || state.phase === "reconnecting"), inviteToken: token, onCameraLost: () => sock.liveAction("stop"), game: !!state.game });
  const room = detail?.room;
  // The room that is actually joined: the viewer's lane when the URL is a lane parent, else the URL's own id.
  const roomId = detail?.lane?.roomId ?? id;
  const live = room?.status === "live";
  const canJoin = detail?.canJoin.ok === true;

  // The host (and anyone already a member, e.g. after a reload) goes straight in; everyone else sees the lobby and taps Join.
  const [joinTapped, setJoinTapped] = useState(false);
  const goesStraightIn = !!detail && (detail.room.hostId === me?.id || !!detail.you);
  // The way back from the bank (/rooms/:id?spray=<sprayId>), usually in the tab the approval opened. That tab only reports
  // how the payer's own spray went; it never joins the room (the payer's room tab is still in it).
  const [sprayBack, setSprayBack] = useState(() => sprayReturnId(window.location.search));
  const clearSprayBack = () => {
    try { window.history.replaceState(window.history.state, "", `${window.location.pathname}${searchWithoutSpray(window.location.search)}${window.location.hash}`); } catch { /* harmless */ }
    setSprayBack(null);
  };
  useEffect(() => {
    if (!sprayBack && live && canJoin && state.phase === "idle" && (goesStraightIn || joinTapped)) sock.join();
  }, [sprayBack, live, canJoin, state.phase, goesStraightIn, joinTapped]); // eslint-disable-line react-hooks/exhaustive-deps
  // Tapping Join was the gesture that lets the browser play sound: start room audio as soon as the room has voice, no second tap.
  useEffect(() => {
    if (joinTapped && state.phase === "live" && state.voiceEnabled && voice.status === "needs-tap") void voice.unlock();
  }, [joinTapped, state.phase, state.voiceEnabled, voice.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Adults only listen and chat in a minors' room. The age is the viewer's own, read from their own settings; the server enforces it regardless.
  const minorsRoom = detail?.room.minorsRoom === true || state.room?.minorsRoom === true;
  const { data: myAge } = useQuery<{ age: number | null }>({ queryKey: ["/api/users/me/room-privacy"], enabled: !!me && (minorsRoom || isLaneDenied(raw)) });
  const listenOnly = listenOnlyHere({ minorsRoom, age: myAge?.age });
  const listenLine = showListenLine({ minorsRoom, age: myAge?.age });

  const role = state.you?.role ?? detail?.you?.role ?? "guest";
  const isHost = detail?.you?.role === "host" || state.you?.role === "host";
  // "See your recap" only for people who were in the room. The recap route is the one that knows (it answers 404 to
  // everyone else), so ask it once the room has ended; the recap page reuses this cache entry.
  // A room that ends while everyone is watching would send every client at once: each waits a random 0 to 5 s first.
  const roomEnded = room?.status === "ended" || state.phase === "ended";
  const signedIn = !!me;
  const [recapAskReady, setRecapAskReady] = useState(false);
  useEffect(() => {
    if (!roomEnded || !signedIn || recapAskReady) return;
    const t = setTimeout(() => setRecapAskReady(true), recapProbeDelayMs(state.phase === "ended", Math.random()));
    return () => clearTimeout(t);
  }, [roomEnded, signedIn, recapAskReady]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: recapProbe } = useQuery<unknown>({
    queryKey: [`/api/rooms/${encodeURIComponent(id)}/recap`], enabled: signedIn && roomEnded && recapAskReady, retry: false, staleTime: 0,
  });

  // ---------------------------------------------------------------- paid rooms (task 4.7)
  // The way back from Paystack carries the payment reference; it is verified once, then dropped from the address.
  const [payRef, setPayRef] = useState(() => returnRef(window.location.search));
  const [confirmed, setConfirmed] = useState<{ ticket: RoomTicketView; duplicateRefunded: boolean } | null>(null);
  const clearPayRef = () => {
    try { window.history.replaceState(window.history.state, "", `${window.location.pathname}${searchWithoutRef(window.location.search)}${window.location.hash}`); } catch { /* the reference stays; verify is idempotent */ }
    setPayRef(null);
  };
  const ticketBlock = parseTicketBlock(detail?.ticket);
  const viewerRole = isHost || (!!me && detail?.room.hostId === me.id) ? "host" : state.you?.role ?? detail?.you?.role ?? null;
  const gate = ticketGate(detail?.ticket, viewerRole);
  const ticketed = (isHost || (!!me && detail?.room.hostId === me.id)) && (!!ticketBlock?.required || (detail?.room.ticketCapacity ?? 0) > 0);
  // A holder who waited for the start goes straight in when the room goes live (they already chose to come).
  const waited = useRef(false);
  if (gate === "held" && room?.status === "scheduled") waited.current = true;
  useEffect(() => {
    if (waited.current && live && gate === "held" && !joinTapped) setJoinTapped(true);
  }, [live, gate]); // eslint-disable-line react-hooks/exhaustive-deps
  // The socket said TICKET_REQUIRED (a refunded ticket, or the page was stale): reload the room so the right screen shows.
  const ticketRefused = state.phase === "denied" && state.error === "TICKET_REQUIRED";
  useEffect(() => { if (ticketRefused) void refetch(); }, [ticketRefused]); // eslint-disable-line react-hooks/exhaustive-deps
  const onRefunded = (message: string) => { toast({ title: message }); void refetch(); };

  const { data: myLive } = useQuery<RoomView[]>({ queryKey: ["/api/rooms", "live"], queryFn: () => fetchRooms("live"), staleTime: 15_000, enabled: !!me });
  const myRoomId = myLive?.find((r) => r.hostId === me?.id && r.id !== id && r.visibility !== "invite")?.id ?? null;

  // The screen was taken back (host stopped it, an adult arrived, voice went off): switch the camera off here too.
  useEffect(() => {
    if ((voice.onAir || voice.cameraOn || voice.videoPaused) && state.phase === "live" && state.holder !== me?.id) void voice.stopCamera(); // not while reconnecting: the room state is only paused, not changed
  }, [voice.onAir, voice.cameraOn, voice.videoPaused, state.phase, state.holder, me?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The server says nothing about how long a removal lasts, so the clock starts when the removal reaches us here.
  const kickedAt = useRef<number | null>(null);
  if (state.phase === "denied" && state.error === "KICKED") { if (kickedAt.current === null) kickedAt.current = Date.now(); } else kickedAt.current = null;

  const leave = () => { sock.leave(); navigate("/rooms"); };
  const back = <Button asChild variant="outline"><Link href="/rooms">Back to Rooms</Link></Button>;

  // ---------------------------------------------------------------- the room itself (chat-first shell)
  // A failed refetch keeps the last details (react-query keeps data on error), so the live room stays; it says so in a line.
  const inRoom = showsShell({ isLoading, hasDetail: !!detail && !!room, roomStatus: room?.status ?? "", canJoin: detail?.canJoin.ok === true, phase: state.phase });

  const sprayBlock = parseSprayBlock(detail?.spray, room, { listenOnly });
  // The spray block is only sent to a viewer the server already has in the room's hub, and the first GET always runs
  // before the socket joins. So ask again each time the socket becomes live: after the join, and after every reconnect
  // (review C1). Only where spraying could exist at all, so other rooms make no extra request.
  const sprayRoom = !!room && room.status === "live" && moneyEligibleRoom(room) && !listenOnly;
  useEffect(() => {
    if (state.phase === "live" && sprayRoom) void refetch();
  }, [state.phase, sprayRoom]); // eslint-disable-line react-hooks/exhaustive-deps

  if (inRoom && detail && room && !sprayBack) {
    return (
      <RoomShell
        id={roomId}
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
        hostControls={<>
          <HostControls room={{ ...room, host: detail.host }} onChanged={() => refetch()} isHost={isHost} revokedInvites={revokedInvites} onRevokedInvitesChange={setRevokedInvites} endElsewhere ticketed={ticketed} />
          {ticketed && <HostSales room={room} capacity={room.ticketCapacity ?? ticketBlock?.capacity ?? null} token={token} onChanged={() => { void refetch(); }} />}
        </>}
        onLeave={leave}
        detailsError={!!error}
        listenOnly={listenOnly}
        listenLine={listenLine}
        spray={sprayBlock}
        onSprayChanged={() => { void refetch(); }}
      />
    );
  }

  // ---------------------------------------------------------------- everything before and after the room
  let content: React.ReactNode;
  let bare = false; // the ticket screens carry the title themselves: only a back button above them
  if (sprayBack) {
    bare = true;
    content = <SprayReturn roomId={id} sprayId={sprayBack} token={token} onBack={() => { clearSprayBack(); void refetch(); }} />;
  } else if (confirmed) {
    // First: the return from Paystack verified a paid ticket. The room may still be loading (or unavailable); the
    // confirmation then shows the ticket without the room's details.
    bare = true;
    content = <TicketConfirmed ticket={confirmed.ticket} duplicateRefunded={confirmed.duplicateRefunded} room={room ?? null} hostName={detail ? hostName(detail.host) : null} onContinue={() => { setConfirmed(null); void refetch(); }} />;
  } else if (payRef) {
    // Before the room loads, any refusal and the not-available panel: verify is bound to this buyer by the reference and
    // shows nothing about the room, so a charge always gets its answer.
    bare = true;
    content = <Checkout roomId={id} reference={payRef} onVerified={(t, dup) => { clearPayRef(); setConfirmed({ ticket: t, duplicateRefunded: dup }); void refetch(); }} onBack={() => { clearPayRef(); void refetch(); }} />;
  } else if (isLoading) {
    content = <div className="space-y-3"><Skeleton className="aspect-video w-full rounded-2xl" /><Skeleton className="h-40 w-full rounded-2xl" /></div>;
  } else if (minorsCode) {
    // The warning screen alone: no title, no host. Acknowledging records it, clears any socket refusal, reloads the room and joins.
    content = <MinorsRoomWarning code={minorsCode} roomId={id} text={isMinorsDenied(raw) ? raw.warning : state.errorWarning ?? undefined} onAcknowledged={async () => {
      if (state.phase === "denied") sock.leave();
      setJoinTapped(true);
      const r = await refetch();
      return !r.isError && !isRoomDenial(r.data); // still refused or failed: the screen says so
    }} />;
  } else if (isLaneDenied(raw)) {
    // A lane parent with nothing for this viewer: the server's own sentence, and (when they know their age group) a way to open it.
    const lane = laneForAge(myAge?.age);
    content = <Panel title="You can't join this room" body={raw.warning ?? DENIED_MESSAGE[raw.laneDenied === "NO_LANE" ? "NOT_FOUND" : "AGE_LIMIT"] ?? "You can't join this room."}
      action={<div className="space-y-3">{lane && raw.laneDenied === "NO_LANE" && <OpenLane parentId={id} lane={lane} onOpened={() => { void refetch(); }} say={(m) => toast({ title: m })} />}{back}</div>} />;
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
      : <RoomCodePanel code="ROOM_ENDED" room={room} recapHref={recapProbe ? `/rooms/${encodeURIComponent(id)}/recap` : undefined} onRetry={() => { void refetch(); }} />;
  } else if (ticketBlock && showsPrice(gate)) {
    bare = true;
    // Only from the server's ticket block (an eligible adult who can view the room). Never inferred from anything else.
    content = <TicketPage room={room} host={detail.host} ticket={ticketBlock} token={token} onRefetch={() => { void refetch(); }} />;
  } else if (!detail.canJoin.ok && !(detail.canJoin.code === "ROOM_NOT_LIVE" && room.status === "scheduled")) {
    const code = detail.canJoin.code;
    content = stateForCode(code)
      ? <RoomCodePanel code={code} room={room} onRetry={() => { void refetch(); }} />
      : <Panel title={code === "AGE_LIMIT" ? "This room has an age limit" : "You can't join this room"} body={DENIED_MESSAGE[code] ?? "You can't join this room."} action={back} />;
  } else if (state.phase === "denied" && stateForCode(state.error)) {
    content = <RoomCodePanel code={state.error!} kickRemainingMs={state.error === "KICKED" ? kickRemainingAfter(kickedAt.current, Date.now()) : null} room={room} onRetry={() => { sock.leave(); void refetch(); }} />;
  } else if (state.phase === "denied") {
    const code = state.error ?? "NOT_FOUND";
    content = <Panel title={code === "AGE_LIMIT" ? "This room has an age limit" : "You can't join this room"} body={code === "AGE_LIMIT" && state.room ? AGE_LIMIT_EVICTED_COPY : state.errorWarning ?? DENIED_MESSAGE[code] ?? "You can't join this room."} action={back} />;
  } else if (room.status === "scheduled" && gate === "held" && ticketBlock) {
    bare = true;
    // The refund promise comes from the ticket block (a guest's room object does not carry refundBeforeStart).
    content = <WaitingRoom room={{ ...room, id, refundBeforeStart: ticketBlock.refundBeforeStart ?? room.refundBeforeStart }} hostName={hostName(detail.host)} token={token} priceKobo={ticketBlock.priceKobo} onRecheck={() => { void refetch(); }} onRefunded={onRefunded} />;
  } else if (room.status === "scheduled") {
    content = (
      <div className="space-y-4">
        <NotStartedPanel room={room} reminderSet={detail.reminderSet === true} hostName={hostName(detail.host)} canRemind={!isHost} />
        {isHost && <HostControls room={{ ...room, host: detail.host }} onChanged={() => refetch()} isHost={isHost} revokedInvites={revokedInvites} onRevokedInvitesChange={setRevokedInvites} ticketed={ticketed} />}
        {ticketed && <HostSales room={room} capacity={room.ticketCapacity ?? ticketBlock?.capacity ?? null} token={token} onChanged={() => { void refetch(); }} />}
      </div>
    );
  } else {
    // idle or connecting: the lobby (the room shell takes over once the socket is live).
    content = (
      <RoomLobby room={room} host={detail.host} peek={detail.peek ?? []} memberCount={detail.memberCount} joining={joinTapped || goesStraightIn} invitedLanding={!goesStraightIn} onJoin={() => setJoinTapped(true)} />
    );
  }

  const showHeader = !!detail && !!room && !minorsCode && !bare; // never the title or host above a minors' room warning
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
                {room!.status === "live" && !roomEnded && <Badge className="bg-red-600 text-white hover:bg-red-600">Live</Badge>}
              </div>
              {room!.description && <p className="mt-1 text-sm">{room!.description}</p>}
            </div>
          </header>
        )}
        {bare && (
          <Button asChild variant="ghost" size="icon" className="h-11 w-11" aria-label="Back to Rooms"><Link href="/rooms" onClick={() => sock.leave()}><ArrowLeftIcon className="h-5 w-5" /></Link></Button>
        )}
        {content}
      </main>
      <BottomNavigation />
    </div>
  );
}
