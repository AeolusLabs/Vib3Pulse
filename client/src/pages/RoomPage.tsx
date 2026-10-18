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
import RoomLobby from "@/components/rooms/RoomLobby";
import HostAvatar from "@/components/rooms/HostAvatar";
import RoomFrame from "@/components/rooms/shell/RoomFrame";
import RoomTopBar from "@/components/rooms/shell/RoomTopBar";
import RoomDock from "@/components/rooms/shell/RoomDock";
import PeopleSheet from "@/components/rooms/shell/PeopleSheet";
import RoomMoreSheet, { RoomReportSheet, RoomSafetySheet } from "@/components/rooms/shell/RoomMoreSheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useRoomSocket } from "@/hooks/useRoomSocket";
import { useRoomVoice } from "@/hooks/useRoomVoice";
import { HypeBar, HypeBurst } from "@/components/rooms/chat/HypeBar";
import { ReactionTray } from "@/components/rooms/chat/ReactionTray";
import { useHype } from "@/hooks/useHype";
import { REACT_GATE, reactGate, type ReactGateState } from "@/lib/hype";
import VoiceBar from "@/components/rooms/VoiceBar";
import StagePanel from "@/components/rooms/StagePanel";
import ScreenStage from "@/components/rooms/ScreenStage";
import { useNow } from "@/hooks/useNow";
import { awayRemainingMs, downSince, shouldShowHold } from "@/lib/voiceState";
import { pickStartProfile, weakLinkAdvice, type VideoProfile } from "@/lib/bandwidth";
import { layoutFor } from "@/lib/roomLayout";
import { TRAY_EMOJIS, camLockReason, micTapAction, shareRoomUrl } from "@/lib/roomShell";
import { useDockUnlock } from "@/hooks/useDockUnlock";
import { LIVE_HOLD_MS } from "@shared/liveScreen";
import { DENIED_MESSAGE, KIND_LABEL, LINK_SCREENS, type PeekMember, NOTICE_MESSAGE, VISIBILITY_LABEL, ageLimitLabel, fetchRooms, formatWhen, hostName, type RoomHostSummary, type RoomView } from "@/lib/roomsApi";
import type { ChatItem, RoomMemberView } from "@/lib/roomReducer";
import { AlertTriangleIcon, ArrowLeftIcon } from "@/components/ui/icons";

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

function useViewportWidth() {
  const [w, setW] = useState(() => (typeof window === "undefined" ? 390 : window.innerWidth));
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

/**
 * Stand-in chat log for the shell's chat slot until task 1.3's ChatLog lands (1.7 swaps it in and deletes RoomChat).
 * Text only, never HTML. Sticks to the bottom only while the reader is within 48 px of it.
 */
function InterimChatLog({ chat, nameOf, selfId, hidden }: { chat: ChatItem[]; nameOf: (uid: string) => string; selfId: string | null; hidden: Set<string> }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lines = chat.filter((c) => !hidden.has(c.userId)).slice(-200);
  const last = lines[lines.length - 1]?.id;
  useEffect(() => { const el = ref.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [last]);
  return (
    <div
      ref={ref}
      role="log"
      aria-live="polite"
      aria-label="Room chat"
      tabIndex={0}
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}
      className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-3 pb-2 pt-1 [mask-image:linear-gradient(180deg,transparent_0,#000_20px)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      data-testid="chat-log"
    >
      {lines.length === 0 && <p className="mt-auto px-2 py-1.5 text-sm text-muted-foreground">Say hi.</p>}
      {lines.map((c, i) => (
        <p key={c.id} className={`${i === 0 ? "mt-auto " : ""}rounded-xl px-2 py-1 text-[15px] leading-snug [overflow-wrap:anywhere]`}>
          <span className={`mr-1.5 text-[13px] font-semibold ${c.userId === selfId ? "text-primary" : ""}`}>{c.userId === selfId ? "You" : nameOf(c.userId)}</span>
          <span>{c.text}</span>
        </p>
      ))}
    </div>
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

  const [hidden, setHidden] = useState<Set<string>>(new Set()); // people the viewer muted for themselves
  const toggleHidden = (uid: string) => setHidden((s) => { const n = new Set(s); n.has(uid) ? n.delete(uid) : n.add(uid); return n; });
  const [picked, setPicked] = useState<RoomMemberView | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const pick = (m: RoomMemberView) => { setPicked(m); setSheetOpen(true); };

  // The shell's sheets. Only one is open at a time; Radix gives each Escape, a scrim, a focus trap and focus return.
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  // Opening a sheet from another sheet: wait for the first one's close animation so focus return doesn't fight the new trap.
  const after = (fn: () => void) => setTimeout(fn, 220);

  // Reply target for the composer. Task 1.3's ChatLog sets it (onReply); task 1.3 also sends it with the message.
  const [reply, setReply] = useState<{ userId: string; text: string } | null>(null);
  // Immersive reaction tray, and the hype bar fed by every reaction the room delivers (including your own).
  const [trayOpen, setTrayOpen] = useState(false);

  const width = useViewportWidth();

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
  const hype = useHype(state.reactions);
  // Taps are metered a little under the server's reaction bucket so RATE_LIMITED should not fire; a blocked tap shows the usual calm line.
  const reactGateState = useRef<ReactGateState>({ tokens: REACT_GATE.burst, at: Date.now() });
  // Its own line and timer, so it and the server-notice effect above never clear each other.
  const [gateNotice, setGateNotice] = useState<string | null>(null);
  const gateTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(gateTimer.current), []);
  const sendReaction = (emoji: string) => {
    const g = reactGate(reactGateState.current, Date.now());
    reactGateState.current = g.state;
    if (g.ok) sock.react(emoji);
    else {
      setGateNotice(NOTICE_MESSAGE.RATE_LIMITED);
      clearTimeout(gateTimer.current);
      gateTimer.current = setTimeout(() => setGateNotice(null), 2500);
    }
  };
  // The wave / private reaction line fades after a few seconds instead of sitting over the room.
  const [incomingShown, setIncomingShown] = useState<string | null>(null);
  useEffect(() => {
    if (!incoming) return;
    setIncomingShown(`${nameOf(incoming.fromId)} ${incoming.kind === "wave" ? "waved at you 👋" : `sent you ${incoming.emoji}`}`);
    const t = setTimeout(() => setIncomingShown(null), 4000);
    return () => clearTimeout(t);
  }, [incoming]); // eslint-disable-line react-hooks/exhaustive-deps

  const isHost = detail?.you?.role === "host" || state.you?.role === "host";
  const role = state.you?.role ?? detail?.you?.role ?? "guest";
  const canControlScreen = role === "host" || role === "cohost";
  const muted = state.you?.muted ?? false;

  // The dock mic unlocks room audio with the tap itself (a user gesture). voice.unlock() resolves even when connecting failed,
  // so follow the voice status to the real outcome: only then say "Room audio on" and raise a guest's hand, or say it failed.
  const unlockFromDock = useDockUnlock(voice, { isGuest: role === "guest", hands: state.hands, meId: me?.id, onRaise: () => sock.stageAction("raise"), toast });

  // The screen was taken back (host stopped it, an adult arrived, voice went off): switch the camera off here too.
  useEffect(() => {
    if ((voice.onAir || voice.cameraOn || voice.videoPaused) && state.phase === "live" && state.holder !== me?.id) void voice.stopCamera(); // not while reconnecting: the room state is only paused, not changed
  }, [voice.onAir, voice.cameraOn, voice.videoPaused, state.phase, state.holder, me?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // While the holder's own connection is down, count down (about) how long their spot is held; viewers get the server's deadline.
  // LiveKit's signal blips also flip `voice.reconnecting` for well under a second: the countdown only shows for a real drop, and it
  // counts from when the drop began, so it neither flashes nor restarts.
  const iAmHolder = !!me && state.holder === me.id;
  const offline = iAmHolder && (state.phase === "reconnecting" || voice.reconnecting);
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  useEffect(() => { setOfflineSince((s) => downSince(s, offline, Date.now())); }, [offline]);
  const [mediaDownSince, setMediaDownSince] = useState<number | null>(null);
  useEffect(() => { setMediaDownSince((s) => downSince(s, voice.reconnecting, Date.now())); }, [voice.reconnecting]);
  const tick = useNow(offline || state.holderAwayUntil !== null);
  const showHold = shouldShowHold({ isHolder: iAmHolder, socketReconnecting: state.phase === "reconnecting", mediaDownSince, now: tick });
  const holderLeftMs = !showHold || offlineSince === null ? null : Math.max(0, LIVE_HOLD_MS - (tick - offlineSince));
  const holderAwayLeftMs = awayRemainingMs(state.holderAwayUntil, state.serverOffsetMs, tick);

  const [quality, setQuality] = useState<VideoProfile | "auto">("auto");
  const linkTick = useNow(voice.linkPoorSince !== null);
  const weakLink = weakLinkAdvice(voice.linkQuality, voice.linkPoorSince === null ? 0 : linkTick - voice.linkPoorSince) === "suggest-audio-only";

  const leave = () => { sock.leave(); navigate("/rooms"); };
  const back = <Button asChild variant="outline"><Link href="/rooms">Back to Rooms</Link></Button>;

  const share = async () => {
    const url = room ? shareRoomUrl(window.location.origin, room) : null;
    if (!url) return;
    try {
      if (navigator.share && window.matchMedia("(pointer: coarse)").matches) await navigator.share({ title: room!.title, url });
      else { await navigator.clipboard.writeText(url); toast({ title: "Link copied" }); }
    } catch (e: any) {
      if (e?.name !== "AbortError") toast({ title: "Copy the link from your browser bar" });
    }
  };

  // ---------------------------------------------------------------- the room itself (chat-first shell)
  const inRoom = !isLoading && !error && !!detail && !!room && room.status !== "ended" && state.phase !== "ended" && detail.canJoin.ok
    && state.phase !== "denied" && room.status !== "scheduled" && (state.phase === "live" || state.phase === "reconnecting");

  if (inRoom && detail && room) {
    const isCoHostOrHost = role === "host" || role === "cohost";
    const onStageNow = role !== "guest" || (!!me && state.stage.includes(me.id));
    const isHolder = iAmHolder;
    const canAskLive = state.liveVideo && onStageNow && !isHolder && state.phase === "live";
    const asked = !!me && state.asks.includes(me.id);
    const { layout } = layoutFor(width, state.liveVideo ? "live" : "voice");
    // Task 1.5 / 1.7: replace with `useVideoView(state.liveVideo)` (`view === "immersive"`, default from layoutFor().immersiveDefault).
    // Off until ScreenStage learns its immersive layout, so today's picture keeps its controls on screen.
    const immersive = false;
    const ageLabel = ageLimitLabel(room.ageLimit);
    const count = state.memberCount || detail.memberCount;
    const goLive = (d: { cameraId?: string; micId?: string; musicMode?: boolean }) => voice.startCamera({ ...d, profile: quality === "auto" ? pickStartProfile((navigator as unknown as { connection?: import("@/lib/bandwidth").ConnInfo }).connection) : quality });
    const stopLive = () => { void voice.stopCamera(); sock.liveAction("stop"); };
    const askLive = () => (isCoHostOrHost && me ? sock.liveAction("grant", me.id) : sock.liveAction("ask"));

    // Chat + reactions over a fullscreen screen (only rendered while it is fullscreen).
    const strip = <div className="space-y-2"><RoomChat compact chat={state.chat} nameOf={nameOf} onSend={sock.chat} muted={muted} hidden={hidden} notice={noticeText} /><ReactionBar onReact={sendReaction} /></div>;
    const voiceNeedsAttention = voice.status === "needs-tap" || voice.status === "connecting" || voice.status === "error" || !!voice.micError;

    const zone = (
      <div className="space-y-3 pb-2">
        {state.phase === "reconnecting" && (
          <div role="status" className="flex items-center gap-2 rounded-xl border bg-muted px-3 py-2 text-sm" data-testid="banner-reconnecting">
            <AlertTriangleIcon className="h-4 w-4 shrink-0" aria-hidden /> Reconnecting… the room will pick up where you left off.
          </div>
        )}
        {/* First in the zone so it is on screen without scrolling. The dock owns the mic otherwise; this only shows while audio
            needs a tap, is connecting, failed, or the mic errored (the dock mic also unlocks audio on tap). */}
        {voiceNeedsAttention && <VoiceBar voice={voice} hasHand={!!me && state.hands.includes(me.id)} canAskToSpeak={role === "guest"} onRaise={() => sock.stageAction("raise")} onLower={() => sock.stageAction("lower")} />}
        {LINK_SCREENS && (
          <RoomScreen
            screen={state.room ? state.screen : room.screen}
            canControl={canControlScreen}
            onChange={(url) => sock.setScreen(url)}
            nowPlaying={state.nowPlaying} serverOffsetMs={state.serverOffsetMs} sendPlayback={sock.sendPlayback} leadsPlayback={role === "host"}
            strip={strip}
          />
        )}
        {state.invitedYou && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/40 bg-primary/5 p-3" data-testid="invite-to-speak">
            <p className="text-sm font-medium">The host invited you to speak.</p>
            <div className="flex gap-2">
              <Button className="min-h-[44px] rounded-full" onClick={() => sock.stageAction("accept")} data-testid="button-accept-mic">Accept</Button>
              <Button variant="outline" className="min-h-[44px] rounded-full" onClick={() => { sock.stageAction("lower"); sock.dismissInvite(); }} data-testid="button-decline-mic">Decline</Button>
            </div>
          </div>
        )}
        {state.liveVideo && !LINK_SCREENS && (
          <ScreenStage
            track={isHolder ? voice.localVideo : voice.video}
            holderName={state.holder ? nameOf(state.holder) : null}
            isHolder={isHolder}
            cameraOn={voice.cameraOn} cameraError={voice.cameraError}
            onGoLive={goLive}
            onStop={stopLive}
            canAsk={canAskLive} askLabel={isCoHostOrHost ? "Go live" : "Ask to go live"} asked={asked}
            onAsk={askLive}
            onWithdraw={() => sock.liveAction("withdraw")}
            needsTap={voice.status === "needs-tap"} onTap={() => void voice.unlock()}
            holderAway={state.holderAwayUntil !== null} holderLeftMs={holderLeftMs}
            quality={quality} onQuality={setQuality}
            videoPaused={voice.videoPaused} onPauseVideo={() => void voice.pauseVideo()} onResumeVideo={() => void voice.resumeVideo()}
            audioOnly={voice.audioOnly} onAudioOnly={voice.setAudioOnly} weakLink={weakLink}
            comingBack={voice.comingBack} strip={strip}
          />
        )}
        {/* Task 1.5 swaps this for SpeakerStrip while live video is on. */}
        <RoomScene members={state.members} memberCount={state.memberCount} selfId={me?.id ?? null} reactions={state.reactions} interactions={state.interactions} hidden={hidden} stage={state.voiceEnabled ? state.stage : []} speaking={voice.activeSpeakers} onAvatarTap={pick} />
      </div>
    );

    const voiceUp = voice.status === "listening" || voice.status === "speaking";
    const micAction = state.voiceEnabled ? micTapAction({ status: voice.status, canPublish: voice.canPublish, canAsk: role === "guest" }) : null;
    const dock = (
      <RoomDock
        muted={muted}
        reply={reply}
        replyName={reply ? nameOf(reply.userId) : undefined}
        onCancelReply={() => setReply(null)}
        // Task 1.3: `sock.chat(text, reply ?? undefined)`.
        onSend={(text) => { sock.chat(text); setReply(null); }}
        onReact={sendReaction}
        trayOpen={trayOpen}
        onToggleTray={() => setTrayOpen((o) => !o)}
        voice={{
          hasHand: !!me && state.hands.includes(me.id),
          canAsk: state.voiceEnabled && role === "guest" && !voice.canPublish,
          onRaise: () => sock.stageAction("raise"),
          onLower: () => sock.stageAction("lower"),
          // A mic tap while audio waits for a tap (or failed) unlocks it; while connecting it only explains.
          needsUnlock: micAction === "unlock",
          onUnlock: unlockFromDock,
          muteLocked: micAction === "wait" ? "Audio is still connecting." : undefined,
          mic: voiceUp && voice.canPublish ? { on: voice.micOn, onToggle: () => void voice.toggleMic() } : undefined,
        }}
        cam={{
          visible: state.liveVideo,
          pressed: (isHolder && voice.cameraOn) || asked,
          lockedReason: camLockReason({ liveVideo: state.liveVideo, phaseLive: state.phase === "live", onStage: onStageNow, isHolder, cameraOn: voice.cameraOn }),
          label: isHolder ? "Stop live video" : asked ? "Withdraw your request to go live" : isCoHostOrHost ? "Go live on camera" : "Ask to go live",
          onClick: () => { if (isHolder) stopLive(); else if (asked) sock.liveAction("withdraw"); else askLive(); },
        }}
        immersive={immersive}
        hype={<HypeBar store={hype.store} />}
        tray={<ReactionTray emojis={TRAY_EMOJIS} open={trayOpen} onClose={() => setTrayOpen(false)} onPick={sendReaction} />}
      />
    );

    const statusLine = incomingShown ?? noticeText ?? gateNotice;
    const floating = (
      <>
      <HypeBurst burst={hype.burst} layout={layout} />
      <div role="status" aria-live="polite" className={`pointer-events-none absolute top-[68px] z-[13] w-max -translate-x-1/2 ${layout === "rail" ? "left-[calc((100%-360px)/2)] max-w-[calc((100%-360px)*0.9)]" : "left-1/2 max-w-[90%]"}`} data-testid="room-status-line">
        {statusLine && <p className="rounded-full bg-foreground px-4 py-2 text-center text-sm font-medium text-background shadow-lg">{statusLine}</p>}
      </div>
      </>
    );

    const top = (
      <RoomTopBar
        title={room.title}
        ageLabel={ageLabel}
        hostName={hostName(detail.host)}
        isLive={room.status === "live"}
        count={count}
        immersive={immersive}
        onBack={leave}
        onPeople={() => setPeopleOpen(true)}
        onMore={() => setMoreOpen(true)}
        onControls={isCoHostOrHost ? () => setControlsOpen(true) : undefined}
      />
    );

    return (
      // One stable tree for both layouts: crossing 1024 px (a tablet rotating) only changes classes, so the picture, the
      // composer draft and the chat scroll survive. Navigation stays mounted and is only hidden in the stack layout.
      <div className="flex h-[100dvh] flex-col bg-background">
        <div className={layout === "rail" ? "contents" : "hidden"}><Navigation /></div>
        <div className={`mx-auto min-h-0 w-full flex-1 ${layout === "rail" ? "max-w-[1440px]" : ""}`}>
          <RoomFrame
            layout={layout}
            immersive={immersive}
            top={top}
            zone={zone}
            chat={<InterimChatLog chat={state.chat} nameOf={nameOf} selfId={me?.id ?? null} hidden={hidden} />}
            dock={dock}
            floating={floating}
          />
        </div>

        <PeopleSheet
          open={peopleOpen} onOpenChange={setPeopleOpen}
          members={state.members} memberCount={count} selfId={me?.id ?? null} hidden={hidden}
          stage={state.voiceEnabled ? state.stage : []}
          onPick={(m) => { setPeopleOpen(false); after(() => pick(m)); }}
        />
        <RoomMoreSheet
          open={moreOpen} onOpenChange={setMoreOpen}
          roomId={id} isHost={isHost} canShare={!!shareRoomUrl("", room)}
          subtitle={`${ageLabel} room · ${KIND_LABEL[room.kind]}${room.visibility !== "public" ? ` · ${VISIBILITY_LABEL[room.visibility]}` : ""}`}
          onShare={() => void share()}
          onSafety={() => after(() => setSafetyOpen(true))}
          onReport={() => after(() => setReportOpen(true))}
          onLeave={leave}
          onControls={isCoHostOrHost ? () => after(() => setControlsOpen(true)) : undefined}
        />
        <RoomSafetySheet open={safetyOpen} onOpenChange={setSafetyOpen} ageLimit={room.ageLimit} ageLabel={ageLabel} />
        <RoomReportSheet open={reportOpen} onOpenChange={setReportOpen} roomId={id} inviteToken={token} />
        {isCoHostOrHost && (
          <Sheet open={controlsOpen} onOpenChange={setControlsOpen}>
            <SheetContent side="bottom" className="max-h-[88dvh] overflow-y-auto rounded-t-3xl pb-[calc(20px+env(safe-area-inset-bottom,0px))] sm:mx-auto sm:max-w-lg" data-testid="room-controls-sheet">
              <SheetHeader className="text-left">
                <SheetTitle className="font-sans text-lg font-semibold">Controls</SheetTitle>
                <SheetDescription>{isHost ? "Run the room. If you close this page the room ends shortly after." : "Help the host run the mic and the screen."}</SheetDescription>
              </SheetHeader>
              <div className="mt-3 space-y-4">
                <StagePanel members={state.members} stage={state.stage} hands={state.hands} voiceEnabled={state.voiceEnabled} canSwitchVoice={role === "host"}
                  onSwitch={async (on) => { if (!(await sock.setVoice(on))) setNoticeText(on ? "Voice isn't available right now." : "Couldn't switch voice off."); }}
                  onStage={(action, target) => sock.stageAction(action, target)}
                  liveVideo={state.liveVideo} holder={state.holder} liveAsks={state.asks} canSwitchLive={role === "host"}
                  onSwitchLive={async (on) => { if (!(await sock.setLiveVideo(on))) setNoticeText(on ? "Live video isn't available for this room." : "Couldn't switch live video off."); }}
                  onLive={(action, target) => sock.liveAction(action, target)} holderAwayLeftMs={holderAwayLeftMs} />
                {isHost && <HostControls room={{ ...room, host: detail.host }} onChanged={() => refetch()} />}
              </div>
            </SheetContent>
          </Sheet>
        )}

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

  // ---------------------------------------------------------------- everything before and after the room
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
    // idle or connecting: the lobby (the room shell takes over once the socket is live).
    content = (
      <RoomLobby room={room} host={detail.host} peek={detail.peek ?? []} memberCount={detail.memberCount} joining={joinTapped || goesStraightIn} onJoin={() => setJoinTapped(true)} />
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
