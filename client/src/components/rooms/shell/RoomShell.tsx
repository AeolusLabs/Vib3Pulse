import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import RoomScreen from "@/components/rooms/RoomScreen";
import RoomScene from "@/components/rooms/RoomScene";
import { RoomChat, ReactionBar } from "@/components/rooms/RoomChat";
import AvatarActionsSheet from "@/components/rooms/AvatarActionsSheet";
import MediaIssueSheet from "@/components/rooms/MediaIssueSheet";
import { mediaIssueFromLine } from "@/lib/mediaIssues";
import VoiceBar from "@/components/rooms/VoiceBar";
import ControlsSheet from "@/components/rooms/host/ControlsSheet";
import ScreenStage from "@/components/rooms/ScreenStage";
import GameStage from "@/components/rooms/game/GameStage";
import { useGameTracks, type GameTracks } from "@/hooks/useGameTracks";
import GoLiveGameSheet from "@/components/rooms/game/GoLiveGameSheet";
import SprayTeamSheet from "@/components/rooms/game/SprayTeamSheet";
import { call } from "@/components/rooms/create/createRoomApi";
import { useGameCaps } from "@/hooks/useGameCaps";
import { pickGameProfile } from "@/lib/bandwidth";
import { sideOf, type Side } from "@shared/gameScreen";
import { GAME_MAX_NOTES, allPlayers, gameNoticeText, gameRefusalText, layoutFor as gameLayoutFor, type AgeLane, type GameLayout } from "@/lib/gameScreen";
import RoomFrame from "@/components/rooms/shell/RoomFrame";
import RoomTopBar from "@/components/rooms/shell/RoomTopBar";
import RoomDock from "@/components/rooms/shell/RoomDock";
import PeopleSheet from "@/components/rooms/shell/PeopleSheet";
import RoomMoreSheet, { RoomReportSheet, RoomSafetySheet } from "@/components/rooms/shell/RoomMoreSheet";
import ImmersiveRail from "@/components/rooms/shell/ImmersiveRail";
import { ChatLog } from "@/components/rooms/chat/ChatLog";
import { HypeBar, HypeBurst } from "@/components/rooms/chat/HypeBar";
import { ReactionTray } from "@/components/rooms/chat/ReactionTray";
import { Button } from "@/components/ui/button";
import { AlertTriangleIcon } from "@/components/ui/icons";
import { useToast } from "@/hooks/use-toast";
import { useHype } from "@/hooks/useHype";
import { useNow } from "@/hooks/useNow";
import { useDockUnlock } from "@/hooks/useDockUnlock";
import { useVideoView } from "@/hooks/useVideoView";
import type { useRoomSocket } from "@/hooks/useRoomSocket";
import type { RoomVoice } from "@/hooks/useRoomVoice";
import { REACT_GATE, reactGate, type ReactGateState } from "@/lib/hype";
import { awayRemainingMs, downSince, shouldShowHold } from "@/lib/voiceState";
import { pickStartProfile, weakLinkAdvice, type ConnInfo, type VideoProfile } from "@/lib/bandwidth";
import { layoutFor, type VideoView } from "@/lib/roomLayout";
import { TRAY_EMOJIS, camLockReason, micTapAction, shareRoomUrl } from "@/lib/roomShell";
import { qualityLabel, railAction } from "@/lib/videoViewState";
import { authorPick, replyFromItem, returnFocusTestId, shellImmersive, statusLine, stripNotice, topBarSubtitle, videoIsLive } from "@/lib/roomIntegration";
import { ADULT_LISTEN_LINE } from "@/lib/minorsRoomUi";
import { KIND_LABEL, LINK_SCREENS, NOTICE_MESSAGE, VISIBILITY_LABEL, ageLimitLabel, hostName, type RoomHostSummary, type RoomView } from "@/lib/roomsApi";
import type { ChatReply } from "@shared/rooms";
import { LIVE_HOLD_MS } from "@shared/liveScreen";
import type { ChatItem, RoomMemberView, RoomState } from "@/lib/roomReducer";
import SprayFlow, { type Sub as SpraySub } from "@/components/rooms/spray/SprayFlow";
import SprayEffects, { useSprayQuiet } from "@/components/rooms/spray/SprayEffects";
import { snd } from "@/components/rooms/spray/sound";
import { sprayTargets, type SprayBlock, type SprayFlow as SprayFlowState } from "@/lib/sprayUi";
import { moneyEligibleRoom } from "@shared/roomRules";
import type { SprayTier } from "@shared/money";

/** The socket actions the shell uses. RoomPage passes useRoomSocket(); the dev fixture passes fakes. */
export type RoomShellSocket = Pick<ReturnType<typeof useRoomSocket>,
  "chat" | "react" | "interact" | "setScreen" | "mod" | "stageAction" | "liveAction" | "sendPlayback" | "setVoice" | "setLiveVideo" | "dismissInvite" | "saveSettings" | "setRole" | "endRoom">
  & Partial<Pick<ReturnType<typeof useRoomSocket>, "gameAction">>;

export interface RoomShellProps {
  id: string;
  /** Invite token from the URL (private rooms); report and share pass it through. */
  token?: string;
  room: Omit<RoomView, "host" | "memberCount">;
  host: RoomHostSummary | null;
  /** Member count from the room details, used until the socket reports its own. */
  fallbackCount: number;
  isHost: boolean;
  role: "host" | "cohost" | "guest";
  meId: string | null;
  state: RoomState;
  sock: RoomShellSocket;
  voice: RoomVoice;
  /** A room the viewer hosts that could take an invite (null when there isn't one). */
  myRoomId: string | null;
  /** The app's top navigation, shown in the desktop layout only. */
  nav?: ReactNode;
  /** Host only: the existing host block (invite link, Invite an adult, waves switch), shown under the Controls sheet's Settings tab. */
  hostControls?: ReactNode;
  /** Dev fixture only: open the Controls sheet on load (on its Requests tab). */
  startControlsOpen?: boolean;
  onLeave(): void;
  /** The last refetch of the room details failed. The room carries on with the details it has; a small line says so. */
  detailsError?: boolean;
  /** An adult in a room for under 18s: they listen and chat. No mic, hand, or camera offers, and a short line says why. */
  listenOnly?: boolean;
  /** Show the line that says why. Only for a viewer known to be an adult, so a teen never sees it while their age loads. */
  listenLine?: boolean;
  /** Dev fixture only: open in this video view instead of the width's default. */
  startView?: VideoView;
  /**
   * Phase 5: the room's spray block, already parsed with parseSprayBlock (null for everyone the server did not send it to:
   * teens, unverified adults, minors' rooms, listen-only viewers). Without it there is no Spray button or row anywhere.
   */
  spray?: SprayBlock | null;
  /** Refetch the room details (spray limit, spent, targets). */
  onSprayChanged?: () => void;
  /** Dev fixture only: start the spray flow in this state. */
  sprayFixture?: { flow: SprayFlowState; sub: SpraySub | null; tray: boolean; quiet: boolean };
  /** Dev fixture only: stand-in game tracks (moving canvases) instead of LiveKit's. */
  gameTracksFixture?: GameTracks;
  /** Dev fixture only: open a game sheet on load. */
  gameSheetFixture?: "play" | "teamspray";
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

const byTestId = (id: string | null) => (id ? document.querySelector<HTMLElement>(`[data-testid="${id}"]`) : null);

/**
 * The room itself once the socket is live: one stable element tree for every layout (stack, rail) and view (compact,
 * immersive). Crossing 1024 px or switching views only changes classes, so the picture, the camera choice, the composer
 * draft and the chat scroll survive. People are always addressed by RoomMemberView.userId, never by username.
 */
export default function RoomShell({ id, token, room, host, fallbackCount, isHost, role, meId, state, sock, voice, myRoomId, nav, hostControls, onLeave, startView, startControlsOpen = false, detailsError = false, listenOnly = false, listenLine = false, spray = null, onSprayChanged, sprayFixture, gameTracksFixture, gameSheetFixture }: RoomShellProps) {
  const { toast } = useToast();

  const [hidden, setHidden] = useState<Set<string>>(new Set()); // people the viewer muted for themselves
  const toggleHidden = (uid: string) => setHidden((s) => { const n = new Set(s); if (n.has(uid)) n.delete(uid); else n.add(uid); return n; });
  const [picked, setPicked] = useState<RoomMemberView | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  // Which sheet a chained sheet came from, so closing it puts focus back on the top bar button that started the chain.
  const [actionsFrom, setActionsFrom] = useState<"people" | null>(null);
  const [controlsFrom, setControlsFrom] = useState<"more" | null>(null);
  const pick = (m: RoomMemberView, from: "people" | null = null) => { setPicked(m); setActionsFrom(from); setActionsOpen(true); };

  // The shell's sheets. Only one is open at a time; Radix gives each Escape, a scrim, a focus trap and focus return.
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(startControlsOpen);
  const [liveControlsOpen, setLiveControlsOpen] = useState(false);
  // Opening a sheet from another sheet: wait for the first one's close animation so focus return doesn't fight the new trap.
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);
  const after = (fn: () => void) => { const t = setTimeout(() => { timers.current.delete(t); fn(); }, 220); timers.current.add(t); };

  const [reply, setReply] = useState<ChatReply | null>(null);
  const [trayOpen, setTrayOpen] = useState(false);

  const width = useViewportWidth();
  const { layout } = layoutFor(width, state.liveVideo ? "live" : "voice");
  const live = videoIsLive({ liveVideo: state.liveVideo, holder: state.holder, linkScreens: LINK_SCREENS });
  const video = useVideoView(live);
  useEffect(() => { if (startView) video.setView(startView); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const immersive = shellImmersive({ layout, live, view: video.view });
  useEffect(() => { if (!immersive) setTrayOpen(false); }, [immersive]);

  // Chat lines outlive the people who wrote them, so remember every name seen while they were in the room.
  const names = useRef(new Map<string, string>());
  state.members.forEach((m) => names.current.set(m.userId, m.displayName || m.organizationName || m.username || "Guest"));
  const nameOf = useCallback((uid: string) => names.current.get(uid) ?? (uid === host?.id ? hostName(host) : "Someone"), [host, state.members]); // eslint-disable-line react-hooks/exhaustive-deps

  // A short spoken/visible line for the most recent private thing aimed at me, and for the last rejected action.
  const incoming = state.interactions.filter((i) => i.targetId === meId && !hidden.has(i.fromId)).slice(-1)[0];
  const [noticeText, setNoticeText] = useState<string | null>(null);
  useEffect(() => {
    if (!state.notice) return;
    setNoticeText((state.game ? gameNoticeText(state.notice.code) : null) ?? NOTICE_MESSAGE[state.notice.code] ?? "That didn't work.");
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

  // ---------------------------------------------------------------- spraying (phase 5)
  const [storedQuiet, setQuiet] = useSprayQuiet();
  const quiet = storedQuiet || sprayFixture?.quiet === true;
  const [sprayOpen, setSprayOpen] = useState(sprayFixture?.tray ?? false);
  const [sprayPreset, setSprayPreset] = useState<string | null>(null);
  const sprayBlock = listenOnly ? null : spray;
  // The flow keeps the last good block while money is in motion or an outcome is unread (review I7, ruling 2): a reload
  // that comes back without a block (the payer's socket was reconnecting, the room emptied) must never unmount it.
  // New sprays still need a live block: targets come from `sprayBlock` only, so a held block offers nobody to spray.
  const [sprayHold, setSprayHold] = useState(false);
  const lastSprayBlock = useRef<SprayBlock | null>(null);
  if (sprayBlock) lastSprayBlock.current = sprayBlock;
  const flowBlock = sprayBlock ?? (sprayHold ? lastSprayBlock.current : null);
  const cohostIds = state.members.filter((m) => m.role === "cohost").map((m) => m.userId);
  const gamePlayers = state.game ? allPlayers(state.game) : [];
  const sprayStage = [...state.stage, ...cohostIds, ...gamePlayers];
  const sprayTo = sprayTargets(sprayBlock ?? null, { hostId: room.hostId, stage: sprayStage, memberIds: state.members.map((m) => m.userId), selfId: meId });
  // Who can be sprayed changed (stage, co-hosts, the host coming or going, the room filling): ask the server again for the
  // block and its targets (it decides who is payable). Not only when a block exists: a block that was absent because the
  // viewer was alone or nobody was on stage must appear once someone is (review C1, M18). Only where spraying could exist.
  const sprayPossible = !listenOnly && room.status === "live" && moneyEligibleRoom(room);
  const hostHere = state.members.some((m) => m.userId === room.hostId);
  const stageKey = sprayPossible ? `${state.stage.join("|")}#${cohostIds.join("|")}#${gamePlayers.join("|")}#${hostHere ? 1 : 0}#${(state.memberCount || fallbackCount) > 1 ? 1 : 0}` : "";
  const firstStage = useRef(true);
  useEffect(() => {
    if (firstStage.current) { firstStage.current = false; return; }
    if (!stageKey || !onSprayChanged) return;
    const t = setTimeout(onSprayChanged, 600);
    return () => clearTimeout(t);
  }, [stageKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Focus goes back to whatever opened Spray (the dock button, or the person's avatar), if it is still on screen (M16).
  const sprayOpener = useRef<HTMLElement | null>(null);
  const visibleEl = (el: HTMLElement | null) => (el && el.isConnected && el.getClientRects().length > 0 ? el : null);
  const sprayReturnFocus = () => visibleEl(sprayOpener.current) ?? visibleEl(byTestId("dock-spray"));
  const liveVideoRef = useRef(state.liveVideo);
  liveVideoRef.current = state.liveVideo;
  const videoActive = useCallback(() => liveVideoRef.current, []);

  const canControlScreen = role === "host" || role === "cohost";
  const muted = state.you?.muted ?? false;

  // The dock mic unlocks room audio with the tap itself (a user gesture), then follows the voice status to the real outcome.
  const unlockFromDock = useDockUnlock(voice, { isGuest: role === "guest", hands: state.hands, meId: meId ?? undefined, onRaise: () => sock.stageAction("raise"), toast });

  // While the holder's own connection is down, count down (about) how long their spot is held; viewers get the server's deadline.
  // LiveKit's signal blips also flip `voice.reconnecting` for well under a second: the countdown only shows for a real drop, and it
  // counts from when the drop began, so it neither flashes nor restarts.
  const iAmHolder = !!meId && state.holder === meId;
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

  // Stable chat callbacks: ChatLog memoises its rows, so new functions on every render would repaint every line on every message.
  const chatActions = useRef({ reply: (_: ChatItem) => {}, heart: (_: ChatItem) => {}, wave: (_: string) => {}, author: (_: string) => {} });
  chatActions.current = {
    reply: (item) => { const r = replyFromItem(item); if (r) setReply(r); },
    heart: () => sendReaction("❤️"),
    wave: (uid) => { sock.interact(uid, "wave"); },
    author: (uid) => {
      const r = authorPick(state.members, (id) => names.current.has(id), uid);
      if (r.kind === "open") pick(r.member);
      else toast({ title: r.kind === "left" ? `${nameOf(uid)} has left the room.` : "Couldn't open that person." });
    },
  };
  const onReply = useCallback((item: ChatItem) => chatActions.current.reply(item), []);
  const onHeart = useCallback((item: ChatItem) => chatActions.current.heart(item), []);
  const onWave = useCallback((uid: string) => chatActions.current.wave(uid), []);
  const onPickAuthor = useCallback((uid: string) => chatActions.current.author(uid), []);

  const isCoHostOrHost = role === "host" || role === "cohost";
  const onStageNow = role !== "guest" || (!!meId && state.stage.includes(meId));
  const isHolder = iAmHolder;
  const canAskLive = !listenOnly && state.liveVideo && onStageNow && !isHolder && state.phase === "live";
  const asked = !!meId && state.asks.includes(meId);
  const askLabel = isCoHostOrHost ? "Go live" : "Ask to go live";
  const ageLabel = ageLimitLabel(room.ageLimit);
  const count = state.memberCount || fallbackCount;
  const holderName = state.holder ? nameOf(state.holder) : null;
  // The last devices the person chose, so the blocked-camera sheet's Try again starts with the same ones.
  const lastGoLive = useRef<{ cameraId?: string; micId?: string; musicMode?: boolean }>({});
  const goLive = (d: { cameraId?: string; micId?: string; musicMode?: boolean }) => { lastGoLive.current = d; return voice.startCamera({ ...d, profile: quality === "auto" ? pickStartProfile((navigator as unknown as { connection?: ConnInfo }).connection) : quality }); };
  const stopLive = () => { void voice.stopCamera(); sock.liveAction("stop"); };
  const askLive = () => (isCoHostOrHost && meId ? sock.liveAction("grant", meId) : sock.liveAction("ask"));
  const withdrawLive = () => sock.liveAction("withdraw");

  // ---------------------------------------------------------------- gamers live (flag on AND this room carries a game)
  const game = state.game;
  const gameCaps = useGameCaps(!!game);
  const gameOn = gameCaps.on && !!game;
  const [gameViewPref, setGameViewPref] = useState<GameLayout | null>(null);
  const gameLayout: GameLayout = game ? gameLayoutFor(game, gameViewPref) : "team";
  const realGameTracks = useGameTracks(gameOn ? voice.room : null, gameOn ? game : null, {
    audioOnly: voice.audioOnly, layout: gameLayout, selfId: meId,
    // The browser's own "Stop sharing" bar: give the slot back so the room doesn't keep a dead feed.
    onShareEnded: () => { if (meId) sock.gameAction?.("remove", { targetId: meId }); },
  });
  const gameTracks = gameTracksFixture ?? realGameTracks;
  const iAmMod = role === "host" || role === "cohost";
  const myGameSide = game && meId ? sideOf(game, meId) : null;
  const myAskSide = game && meId ? game.asks.find((a) => a.userId === meId)?.side ?? null : null;
  const [playOpen, setPlayOpen] = useState(gameSheetFixture === "play");
  const [teamSprayOpen, setTeamSprayOpen] = useState(gameSheetFixture === "teamspray");
  const [teamSpraySide, setTeamSpraySide] = useState<Side>("A");
  // The team sheet's pick, handed to the spray flow (which owns the key, the pay step and the bank page).
  const [teamRequest, setTeamRequest] = useState<{ side: Side; tier: SprayTier; anchorId: string; seq: number } | null>(null);
  const teamSeq = useRef(0);
  const onPlay = () => { if (!myGameSide && myAskSide) sock.gameAction?.("withdraw"); else setPlayOpen(true); };
  // A host or co-host is put straight in (the server lets them accept themselves); everyone else asks and waits for an accept.
  const joinGame = (side: Side) => { if (!meId) return; if (iAmMod) sock.gameAction?.("accept", { targetId: meId, side }); else sock.gameAction?.("ask", { side }); };
  const stopPlaying = () => { gameTracks.stopShare(); if (meId) sock.gameAction?.("remove", { targetId: meId }); setPlayOpen(false); };
  // Age lanes: the room's own lane (the server sends it only to that lane's own viewers) and the parent it belongs to.
  const laneInfo = (state.room ?? room) as { ageLane?: string | null; parentRoomId?: string | null };
  const roomLane: AgeLane | null = laneInfo.ageLane === "teen" || laneInfo.ageLane === "adult" ? laneInfo.ageLane : null;
  const sprayTeamOk = gameCaps.teamSpray && !!sprayBlock && sprayTo.length > 0;
  const sprayPlayer = (playerId: string) => {
    snd.unlock();
    sprayOpener.current = byTestId(`tile-spray-${playerId}`);
    setSprayPreset(playerId);
    setSprayOpen(true);
  };

  // Chat + reactions over a fullscreen screen (only rendered while it is fullscreen; the dock is not on screen then).
  const strip = (
    <div className="space-y-2">
      <RoomChat compact chat={state.chat} nameOf={nameOf} onSend={(t) => sock.chat(t)} muted={muted} hidden={hidden} notice={stripNotice(noticeText, gateNotice)} />
      <ReactionBar onReact={sendReaction} />
    </div>
  );
  // A blocked, busy or missing mic or camera: the sheet says what to do next (board 11). Closing it keeps the inline line.
  const mediaIssue = mediaIssueFromLine(voice.micError, voice.cameraError);
  const mediaKey = mediaIssue ? `${mediaIssue.device}:${mediaIssue.reason}` : null;
  const [mediaDismissed, setMediaDismissed] = useState<string | null>(null);
  useEffect(() => { if (!mediaKey) setMediaDismissed(null); }, [mediaKey]);
  const voiceNeedsAttention = voice.status === "needs-tap" || voice.status === "connecting" || voice.status === "error" || !!voice.micError;

  const zone = (
    // Same children in every view; in immersive the banners float above the chat, clear of the rail (right-16, like the chat)
    // and never under the top bar (capped height, scrolls on a short landscape phone); the picture fills the frame.
    <div className={immersive ? "absolute inset-0" : "space-y-3 pb-2"} data-testid="room-zone-inner">
      <div className={immersive ? "absolute left-2 right-16 bottom-[calc(30%+84px+env(safe-area-inset-bottom,0px))] z-[7] max-h-[calc(70%-148px-env(safe-area-inset-bottom,0px))] space-y-2 overflow-y-auto overscroll-contain empty:hidden" : "space-y-3 empty:hidden"} data-testid="room-banners">
        {/* First: the one that needs an answer stays in view when the box has to scroll (short landscape phones). */}
        {state.invitedYou && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/40 bg-card p-3 text-foreground" data-testid="invite-to-speak">
            <p className="text-sm font-medium">The host invited you to speak.</p>
            <div className="flex gap-2">
              <Button className="min-h-[44px] rounded-full" onClick={() => sock.stageAction("accept")} data-testid="button-accept-mic">Accept</Button>
              <Button variant="outline" className="min-h-[44px] rounded-full" onClick={() => { sock.stageAction("lower"); sock.dismissInvite(); }} data-testid="button-decline-mic">Decline</Button>
            </div>
          </div>
        )}
        {listenOnly && listenLine && (
          <p role="status" className="rounded-xl border bg-muted px-3 py-2 text-sm text-muted-foreground" data-testid="banner-listen-only">{ADULT_LISTEN_LINE}</p>
        )}
        {state.phase === "reconnecting" && (
          <div role="status" className="flex items-center gap-2 rounded-xl border bg-muted px-3 py-2 text-sm text-foreground" data-testid="banner-reconnecting">
            <AlertTriangleIcon className="h-4 w-4 shrink-0" aria-hidden /> Reconnecting… the room will pick up where you left off.
          </div>
        )}
        {detailsError && (
          <p role="status" className="rounded-xl border bg-muted px-3 py-2 text-sm text-muted-foreground" data-testid="banner-details-error">Couldn't refresh the room details. You're still in the room.</p>
        )}
        {/* The dock owns the mic otherwise; this only shows while audio needs a tap, is connecting, failed, or the mic errored. */}
        {voiceNeedsAttention && <VoiceBar voice={voice} hasHand={!!meId && state.hands.includes(meId)} canAskToSpeak={role === "guest" && !listenOnly} onRaise={() => sock.stageAction("raise")} onLower={() => sock.stageAction("lower")} />}
      </div>
      {LINK_SCREENS && (
        <RoomScreen
          screen={state.room ? state.screen : room.screen}
          canControl={canControlScreen}
          onChange={(url) => sock.setScreen(url)}
          nowPlaying={state.nowPlaying} serverOffsetMs={state.serverOffsetMs} sendPlayback={sock.sendPlayback} leadsPlayback={role === "host"}
          strip={strip}
        />
      )}
      {gameOn && game && (
        <GameStage
          game={game} tracks={gameTracks} me={meId} layout={gameLayout} onLayout={setGameViewPref} nameOf={nameOf}
          serverOffsetMs={state.serverOffsetMs} audioOnly={voice.audioOnly}
          sprayable={sprayTo} onSpray={sprayPlayer}
          onSprayTeam={sprayTeamOk ? (side) => { setTeamSpraySide(side); setTeamSprayOpen(true); } : undefined}
          onPlay={sock.gameAction ? onPlay : undefined}
          ageLane={gameCaps.lanes ? roomLane : null}
        />
      )}
      {state.liveVideo && !LINK_SCREENS && !(gameOn && game) && (
        <ScreenStage
          layout={immersive ? "immersive" : "compact"}
          track={isHolder ? voice.localVideo : voice.video}
          holderName={holderName}
          isHolder={isHolder}
          cameraOn={voice.cameraOn} cameraError={voice.cameraError}
          onGoLive={goLive}
          onStop={stopLive}
          canAsk={canAskLive} askLabel={askLabel} asked={asked}
          onAsk={askLive}
          onWithdraw={withdrawLive}
          needsTap={voice.status === "needs-tap"} onTap={() => void voice.unlock()}
          holderAway={state.holderAwayUntil !== null} holderLeftMs={holderLeftMs} holderAwayLeftMs={holderAwayLeftMs}
          quality={quality} onQuality={setQuality}
          videoPaused={voice.videoPaused} onPauseVideo={() => void voice.pauseVideo()} onResumeVideo={() => void voice.resumeVideo()}
          audioOnly={voice.audioOnly} onAudioOnly={voice.setAudioOnly} weakLink={weakLink}
          comingBack={voice.comingBack} strip={strip}
          onPictureTap={video.toggleChrome}
          onExpand={live && video.canImmerse ? () => video.setView("immersive") : undefined}
          watching={live ? count : undefined}
          controlsOpen={liveControlsOpen} onControlsOpenChange={setLiveControlsOpen}
        />
      )}
      {/* Voice room: the scene. Live video: one strip of speakers under the picture (hidden in immersive, where the picture is the room). */}
      <div className={immersive ? "hidden" : undefined}>
        <RoomScene variant={state.liveVideo ? "strip" : "scene"} members={state.members} memberCount={state.memberCount} selfId={meId} reactions={state.reactions} interactions={state.interactions} hidden={hidden} stage={state.voiceEnabled ? state.stage : []} speaking={voice.activeSpeakers} onAvatarTap={(m) => pick(m)} />
      </div>
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
      onSend={(text) => { sock.chat(text, reply ?? undefined); setReply(null); }}
      onReact={sendReaction}
      trayOpen={trayOpen}
      onToggleTray={() => setTrayOpen((o) => !o)}
      voice={{
        hasHand: !!meId && state.hands.includes(meId),
        canAsk: !listenOnly && state.voiceEnabled && role === "guest" && !voice.canPublish,
        onRaise: () => sock.stageAction("raise"),
        onLower: () => sock.stageAction("lower"),
        // A mic tap while audio waits for a tap (or failed) unlocks it; while connecting it only explains.
        needsUnlock: micAction === "unlock",
        onUnlock: unlockFromDock,
        muteLocked: !listenOnly && micAction === "wait" ? "Audio is still connecting." : undefined,
        mic: !listenOnly && voiceUp && voice.canPublish ? { on: voice.micOn, onToggle: () => void voice.toggleMic() } : undefined,
      }}
      cam={{
        visible: state.liveVideo && !listenOnly && !gameOn,
        pressed: (isHolder && voice.cameraOn) || asked,
        lockedReason: camLockReason({ liveVideo: state.liveVideo, phaseLive: state.phase === "live", onStage: onStageNow, isHolder, cameraOn: voice.cameraOn }),
        label: isHolder ? "Stop live video" : asked ? "Withdraw your request to go live" : isCoHostOrHost ? "Go live on camera" : "Ask to go live",
        onClick: () => { if (isHolder) stopLive(); else if (asked) withdrawLive(); else askLive(); },
      }}
      immersive={immersive}
      hype={<HypeBar store={hype.store} />}
      tray={<ReactionTray emojis={TRAY_EMOJIS} open={trayOpen} onClose={() => setTrayOpen(false)} onPick={sendReaction} />}
      spray={sprayBlock && sprayTo.length > 0 ? { onOpen: () => {
        snd.unlock();
        sprayOpener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : byTestId("dock-spray");
        setSprayPreset(null);
        setSprayOpen(true);
      } } : undefined}
    />
  );

  const rail = railAction({ isHolder, cameraOn: voice.cameraOn, videoPaused: voice.videoPaused, canAsk: canAskLive, asked, askLabel });
  const line = statusLine(incomingShown, noticeText, gateNotice);
  const floating = (
    <>
      <SprayEffects sprays={state.sprays} nameOf={nameOf} quiet={quiet} serverOffsetMs={state.serverOffsetMs} videoActive={videoActive}
        selfId={meId} onThank={!muted && !listenOnly ? (text) => { sock.chat(text); } : undefined} maxNotes={gameOn ? GAME_MAX_NOTES : undefined} />
      <HypeBurst burst={hype.burst} layout={layout} />
      <div role="status" aria-live="polite" className={`pointer-events-none absolute top-[calc(68px+env(safe-area-inset-top,0px))] z-[13] w-max -translate-x-1/2 ${layout === "rail" ? "left-[calc((100%-360px)/2)] max-w-[calc((100%-360px)*0.9)]" : "left-1/2 max-w-[90%]"}`} data-testid="room-status-line">
        {line && <p className="rounded-full bg-foreground px-4 py-2 text-center text-sm font-medium text-background shadow-lg">{line}</p>}
      </div>
      {immersive && (
        <ImmersiveRail
          qualityLabel={qualityLabel(quality, voice.audioOnly)}
          soundOnly={voice.audioOnly}
          onQuality={() => setLiveControlsOpen(true)}
          onSoundOnly={() => voice.setAudioOnly(!voice.audioOnly)}
          onExit={() => video.setView("compact")}
          hidden={video.chromeHidden}
          onReveal={video.showChrome}
          isHolder={isHolder}
          action={rail}
          onAction={rail?.kind === "stop" ? stopLive : rail?.kind === "ask" ? askLive : withdrawLive}
        />
      )}
    </>
  );

  const top = (
    <RoomTopBar
      title={room.title}
      ageLabel={ageLabel}
      hostName={hostName(host)}
      isLive={room.status === "live"}
      subtitle={topBarSubtitle({ immersive, holderName, count, away: state.holderAwayUntil !== null || holderLeftMs !== null, self: isHolder })}
      count={count}
      immersive={immersive}
      onBack={onLeave}
      onPeople={() => setPeopleOpen(true)}
      onMore={() => setMoreOpen(true)}
      onControls={isCoHostOrHost ? () => { setControlsFrom(null); setControlsOpen(true); } : undefined}
    />
  );

  return (
    // Navigation stays mounted and is only hidden in the stack layout, so the tree is the same on both sides of 1024 px.
    <div className="flex h-[100dvh] flex-col bg-background">
      <div className={layout === "rail" ? "contents" : "hidden"}>{nav}</div>
      <div className={`mx-auto min-h-0 w-full flex-1 ${layout === "rail" ? "max-w-[1440px]" : ""}`}>
        <RoomFrame
          layout={layout}
          immersive={immersive}
          chromeHidden={video.chromeHidden}
          onReveal={video.showChrome}
          live={state.liveVideo}
          top={top}
          zone={zone}
          chat={<ChatLog chat={state.chat} nameOf={nameOf} selfId={meId} hidden={hidden} immersive={immersive} onReply={onReply} onHeart={onHeart} onWave={onWave} onPickAuthor={onPickAuthor} />}
          dock={dock}
          floating={floating}
        />
      </div>

      <PeopleSheet
        open={peopleOpen} onOpenChange={setPeopleOpen}
        members={state.members} memberCount={count} selfId={meId} hidden={hidden}
        stage={state.voiceEnabled ? state.stage : []}
        onPick={(m) => { setPeopleOpen(false); after(() => pick(m, "people")); }}
      />
      <RoomMoreSheet
        open={moreOpen} onOpenChange={setMoreOpen}
        roomId={id} isHost={isHost} canShare={!!shareRoomUrl("", room)}
        subtitle={`${ageLabel} room · ${KIND_LABEL[room.kind]}${room.visibility !== "public" ? ` · ${VISIBILITY_LABEL[room.visibility]}` : ""}`}
        onShare={() => void share()}
        onSafety={() => after(() => setSafetyOpen(true))}
        onReport={() => after(() => setReportOpen(true))}
        onLeave={onLeave}
        onControls={isCoHostOrHost ? () => { setControlsFrom("more"); after(() => setControlsOpen(true)); } : undefined}
      />
      <MediaIssueSheet
        issue={mediaKey && mediaKey !== mediaDismissed ? mediaIssue : null}
        returnFocusTo={() => byTestId(mediaIssue?.device === "camera" ? "dock-cam" : "dock-mic")}
        onClose={() => setMediaDismissed(mediaKey)}
        onTryAgain={() => { setMediaDismissed(mediaKey); if (mediaIssue?.device === "camera") void goLive(lastGoLive.current); else void voice.toggleMic(); }}
      />
      <RoomSafetySheet open={safetyOpen} onOpenChange={setSafetyOpen} ageLimit={room.ageLimit} ageLabel={ageLabel} returnFocusTo={() => byTestId("room-more")} />
      <RoomReportSheet open={reportOpen} onOpenChange={setReportOpen} roomId={id} inviteToken={token} returnFocusTo={() => byTestId("room-more")} />
      {isCoHostOrHost && (
        <ControlsSheet
          open={controlsOpen} onOpenChange={setControlsOpen}
          roomId={id} inviteToken={token} role={role === "host" ? "host" : "cohost"}
          room={room} state={state} count={count} selfId={meId} sock={sock}
          holderAwayLeftMs={holderAwayLeftMs}
          hostExtras={isHost ? hostControls : undefined}
          gameConsole={gameOn && game && sock.gameAction ? {
            game, nameOf, onAction: (a, extra) => sock.gameAction?.(a, extra) ?? false,
            // A refusal comes back in words (TEAM_FULL, GAME_IN_PROGRESS ...), not as the server's raw text.
            onSaveRoom: async (patch) => { const r = await call<unknown>("PATCH", `/api/rooms/${encodeURIComponent(id)}`, patch); return r.ok ? null : gameRefusalText(r) ?? "Couldn't save that. Try again."; },
            lanes: gameCaps.lanes && roomLane && laneInfo.parentRoomId ? { ageLane: roomLane, parentId: laneInfo.parentRoomId, onOpened: () => onSprayChanged?.() } : undefined,
            dropTimeoutMs: Number((state.room as { gameDropTimeoutMs?: number } | null)?.gameDropTimeoutMs ?? 120_000),
            layout: gameLayout, onLayout: setGameViewPref, serverOffsetMs: state.serverOffsetMs, canSaveRoom: role === "host",
          } : undefined}
          returnFocusTo={() => byTestId(returnFocusTestId(controlsFrom))}
        />
      )}

      <AvatarActionsSheet
        open={actionsOpen} onOpenChange={setActionsOpen} roomId={id} target={picked}
        you={{ userId: meId, role }} myRoomId={myRoomId}
        onInteract={sock.interact} onMod={sock.mod}
        locallyMuted={!!picked && hidden.has(picked.userId)} onToggleLocalMute={toggleHidden}
        voiceOn={state.voiceEnabled} stage={state.stage} onStage={(action, target) => sock.stageAction(action, target)}
        returnFocusTo={() => byTestId(returnFocusTestId(actionsFrom))}
        onSpray={picked && sprayBlock && sprayTo.includes(picked.userId) ? () => {
          snd.unlock();
          sprayOpener.current = byTestId(`avatar-${picked.userId}`) ?? byTestId(`strip-${picked.userId}`);
          setSprayPreset(picked.userId);
          after(() => setSprayOpen(true));
        } : undefined}
      />
      {gameOn && game && (
        <GoLiveGameSheet
          open={playOpen} onOpenChange={setPlayOpen} game={game} mySide={myGameSide} askedSide={myAskSide} isMod={iAmMod}
          ingest={gameCaps.ingest}
          onGetIngress={async () => { const r = await call<{ url: string; streamKey: string }>("POST", `/api/rooms/${encodeURIComponent(id)}/game/ingress`); return r.ok && r.body?.url && r.body?.streamKey ? { url: r.body.url, streamKey: r.body.streamKey } : null; }}
          canCapture={typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function"}
          sharing={gameTracks.sharing} shareError={gameTracks.shareError}
          initialProfile={pickGameProfile((navigator as unknown as { connection?: ConnInfo }).connection)}
          nameOf={nameOf} onJoin={joinGame} onWithdraw={() => sock.gameAction?.("withdraw")}
          onShare={(p) => gameTracks.startShare(p)} onStop={stopPlaying}
          returnFocusTo={() => byTestId("game-play")}
        />
      )}
      {gameOn && game && sprayTeamOk && (
        <SprayTeamSheet
          open={teamSprayOpen} onOpenChange={setTeamSprayOpen} game={game} side={teamSpraySide} onSide={setTeamSpraySide}
          follow={gameTracks.following} nameOf={nameOf}
          onThrow={(side, tier) => {
            const anchorId = game.featured[side] ?? game.teams[side][0];
            if (!anchorId) return;
            setTeamSprayOpen(false);
            after(() => setTeamRequest({ side, tier, anchorId, seq: ++teamSeq.current }));
          }}
          onPlayer={(pid) => { setTeamSprayOpen(false); after(() => sprayPlayer(pid)); }}
          returnFocusTo={() => byTestId(`lane-spray-${teamSpraySide}`)}
        />
      )}
      {flowBlock && (
        <SprayFlow
          roomId={id} token={token} block={flowBlock} targets={sprayTo} hostId={room.hostId} nameOf={nameOf} sprays={state.sprays}
          trayOpen={sprayOpen} onTrayOpenChange={setSprayOpen} presetTarget={sprayPreset}
          onSettled={() => onSprayChanged?.()} quiet={quiet} onQuiet={setQuiet}
          returnFocusTo={sprayReturnFocus} onHoldChange={setSprayHold} teamRequest={teamRequest}
          initial={sprayFixture ? { flow: sprayFixture.flow, sub: sprayFixture.sub } : undefined}
        />
      )}
    </div>
  );
}
