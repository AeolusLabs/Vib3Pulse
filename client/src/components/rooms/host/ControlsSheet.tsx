import { useEffect, useRef, useState, type ReactNode } from "react";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import RoomSheetContent from "@/components/rooms/shell/RoomSheetContent";
import StagePanel from "@/components/rooms/StagePanel";
import HostAvatar from "@/components/rooms/HostAvatar";
import RequestsPanel from "@/components/rooms/host/RequestsPanel";
import PeoplePanel from "@/components/rooms/host/PeoplePanel";
import SettingsPanel from "@/components/rooms/host/SettingsPanel";
import EndRoomDialog from "@/components/rooms/host/EndRoomDialog";
import { NOTICE_MESSAGE, useRoomsConfig } from "@/lib/roomsApi";
import { CONTROLS_COPY, TAB_LABEL, controlsFor, moneyPlaceholderVisible, readSettings, requestQueue, roleChange, settingsErrorMessage, type ControlsRole, type ControlsTab } from "@/lib/hostControls";
import type { useRoomSocket } from "@/hooks/useRoomSocket";
import type { RoomMemberView, RoomState } from "@/lib/roomReducer";
import GameConsole, { type GameConsoleProps } from "@/components/rooms/game/GameConsole";
import { gameNoticeText } from "@/lib/gameScreen";

/** The socket and REST actions the sheet uses. RoomPage passes useRoomSocket(); the dev fixture passes fakes. */
export type ControlsSocket = Pick<ReturnType<typeof useRoomSocket>,
  "mod" | "stageAction" | "liveAction" | "setVoice" | "setLiveVideo" | "saveSettings" | "setRole" | "endRoom">;

export interface ControlsSheetProps {
  open: boolean;
  onOpenChange(o: boolean): void;
  roomId: string;
  inviteToken?: string;
  role: ControlsRole;
  /** The room details (age limit, minors' room, and the settings until the socket's room record carries them). */
  room: { ageLimit: string; minorsRoom?: boolean };
  state: RoomState;
  /** Everyone in the room, the host included. */
  count: number;
  selfId: string | null;
  sock: ControlsSocket;
  holderAwayLeftMs: number | null;
  /** Host only: the existing host block (invite link, Invite an adult in a minors' room, waves switch), shown under Settings. */
  hostExtras?: ReactNode;
  /** Where focus goes when the sheet closes (the button that opened it). */
  returnFocusTo?: () => HTMLElement | null;
  /** Dev fixture only: open on this tab. */
  startTab?: ControlsTab;
  /** Gamers live: present only for a game room with the flag on. Adds a Game tab; without it the sheet is exactly as before. */
  gameConsole?: Omit<GameConsoleProps, "say" | "game"> & { game: NonNullable<RoomState["game"]> };
}

const nameOf = (m: RoomMemberView) => m.displayName || m.organizationName || m.username || "Guest";
const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

/**
 * The host's (and a co-host's) Controls: Requests, Stage, People, Settings. A co-host gets the actions they already have
 * and only the pinned message in Settings. Every action goes through the existing socket and REST endpoints; the server decides.
 */
export default function ControlsSheet({ open, onOpenChange, roomId, inviteToken, role, room, state, count, selfId, sock, holderAwayLeftMs, hostExtras, returnFocusTo, startTab, gameConsole }: ControlsSheetProps) {
  const can = controlsFor(role);
  const [tab, setTab] = useState<ControlsTab | "game">(startTab ?? "requests");
  const { data: config } = useRoomsConfig();
  const settings = readSettings(state.room, room as unknown as Record<string, unknown>);
  const showMoney = moneyPlaceholderVisible({ role, flags: config?.features, ageLimit: room.ageLimit, minorsRoom: room.minorsRoom });
  // Requests already tapped are hidden here and in the badge alike, until the server's next list or a refusal (a notice) brings them back.
  const [acted, setActed] = useState<Set<string>>(new Set());
  const noticeN = state.notice?.n ?? 0;
  const listKey = `${state.hands.join(",")}|${state.asks.join(",")}|${state.liveVideo}|${noticeN}`;
  useEffect(() => { setActed(new Set()); }, [listKey]);
  const requests = requestQueue(state.hands, state.asks, state.liveVideo, acted).length;

  // One plain line for anything that failed, read out politely and cleared after a few seconds.
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  const say = (message: string) => {
    setNotice(message);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  };

  // A refusal from the room (stage full, not allowed, slow down ...) is said out loud while the sheet is open. Older ones are not replayed on opening.
  const seenNotice = useRef(noticeN);
  useEffect(() => {
    if (!open || noticeN === seenNotice.current) { seenNotice.current = noticeN; return; }
    seenNotice.current = noticeN;
    say((state.game ? gameNoticeText(state.notice?.code ?? "") : null) ?? NOTICE_MESSAGE[state.notice?.code ?? ""] ?? CONTROLS_COPY.sendFailed);
  }, [open, noticeN]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeRole = async (m: RoomMemberView, to: "cohost" | "guest") => {
    const err = await sock.setRole(m.userId, to);
    if (err !== null) say(settingsErrorMessage(err, "Couldn't change their role. Try again."));
  };
  const roleButton = (m: RoomMemberView) => {
    const change = roleChange(role, m, selfId);
    if (!change) return null;
    const to = change === "make-cohost" ? "cohost" : "guest";
    return (
      <Button size="sm" variant="ghost" className={`min-h-[44px] ${FOCUS}`} onClick={() => void changeRole(m, to)} data-testid={`button-role-${to}-${m.userId}`}>
        {change === "make-cohost" ? CONTROLS_COPY.makeCohost : CONTROLS_COPY.removeCohost}
      </Button>
    );
  };
  const cohosts = state.members.filter((m) => m.role === "cohost");

  const triggerCls = `min-h-[44px] rounded-full border px-4 text-sm font-semibold transition-none motion-safe:transition-colors data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-none data-[state=inactive]:bg-muted data-[state=inactive]:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0 ${FOCUS}`; // the tab primitive draws a ring; the outline is the one focus mark

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <RoomSheetContent side="bottom" returnFocusTo={returnFocusTo} className="max-h-[88dvh] overflow-y-auto rounded-t-3xl pb-[calc(20px+env(safe-area-inset-bottom,0px))] sm:mx-auto sm:max-w-lg" data-testid="room-controls-sheet">
        <SheetHeader className="pr-10 text-left">
          <SheetTitle className="font-sans text-lg font-semibold">{CONTROLS_COPY.title}</SheetTitle>
          <SheetDescription>{role === "host" ? CONTROLS_COPY.hostSub : CONTROLS_COPY.cohostSub}</SheetDescription>
        </SheetHeader>

        <div role="status" aria-live="polite" data-testid="controls-notice">
          {notice && <p className="mt-3 rounded-xl border bg-muted px-3 py-2 text-sm font-medium text-foreground">{notice}</p>}
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as ControlsTab | "game")} className="mt-3">
          <TabsList className="h-auto w-full flex-wrap justify-start gap-2 bg-transparent p-0" aria-label="Controls">
            {can.tabs.map((t) => (
              <TabsTrigger key={t} value={t} className={triggerCls} data-testid={`controls-tab-${t}`}>
                {TAB_LABEL[t]}
                {t === "requests" && requests > 0 && <><span className="ml-1.5" aria-hidden>{requests}</span><span className="sr-only">, {requests} waiting</span></>}
              </TabsTrigger>
            ))}
            {gameConsole && <TabsTrigger value="game" className={triggerCls} data-testid="controls-tab-game">Game</TabsTrigger>}
          </TabsList>

          <TabsContent value="requests" className="mt-4">
            <RequestsPanel
              members={state.members} hands={state.hands} asks={state.asks} liveVideo={state.liveVideo}
              acted={acted} onActed={(key) => setActed((s) => new Set(s).add(key))}
              onAccept={(i) => (i.kind === "hand" ? sock.stageAction("accept", i.userId) : sock.liveAction("grant", i.userId))}
              onDismiss={(i) => sock.stageAction("remove", i.userId)}
              onFailed={say}
            />
          </TabsContent>

          <TabsContent value="stage" className="mt-4 space-y-3">
            <StagePanel
              inTabs hostInTabs={role === "host"}
              members={state.members} stage={state.stage} hands={state.hands} voiceEnabled={state.voiceEnabled}
              canSwitchVoice={false} onSwitch={() => {}}
              onStage={(action, target) => { if (!sock.stageAction(action, target)) say(CONTROLS_COPY.sendFailed); }}
              liveVideo={state.liveVideo} holder={state.holder} liveAsks={state.asks} canSwitchLive={false} onSwitchLive={() => {}}
              onLive={(action, target) => { if (!sock.liveAction(action, target)) say(CONTROLS_COPY.sendFailed); }}
              holderAwayLeftMs={holderAwayLeftMs}
              speakerExtra={can.makeCohost ? roleButton : undefined}
            />
            <section aria-label="Co-hosts" className="space-y-2 rounded-2xl border p-3" data-testid="cohost-list">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Co-hosts ({cohosts.length})</h3>
              {cohosts.length === 0 ? <p className="py-1 text-sm text-muted-foreground">{can.makeCohost ? "None yet. Make someone on the mic a co-host." : "None yet."}</p> : (
                <ul className="space-y-1">
                  {cohosts.map((m) => (
                    <li key={m.userId} className="flex items-center gap-2" data-testid={`cohost-${m.userId}`}>
                      <HostAvatar person={m} className="h-8 w-8" /><span className="min-w-0 flex-1 truncate text-sm">{m.userId === selfId ? "You" : nameOf(m)}</span>
                      {can.makeCohost && roleButton(m)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </TabsContent>

          <TabsContent value="people" className="mt-4">
            <PeoplePanel
              roomId={roomId} inviteToken={inviteToken} role={role} selfId={selfId}
              members={state.members} memberCount={count} stage={state.voiceEnabled ? state.stage : []}
              onMod={(action, target) => sock.mod(action, target)}
              onNotice={say}
              roleExtra={can.makeCohost ? roleButton : undefined}
            />
          </TabsContent>

          {gameConsole && (
            <TabsContent value="game" className="mt-4">
              <GameConsole {...gameConsole} say={say} />
            </TabsContent>
          )}

          {/* Settings stays mounted (hidden) so an unsaved pinned message survives a tab switch. */}
          <TabsContent value="settings" forceMount className="mt-4 space-y-5 data-[state=inactive]:hidden">
            <SettingsPanel
              role={role} settings={settings}
              onSave={(patch) => sock.saveSettings(patch)}
              voiceEnabled={state.voiceEnabled} liveVideo={state.liveVideo}
              onSwitchVoice={(on) => sock.setVoice(on)} onSwitchLive={(on) => sock.setLiveVideo(on)}
              showMoney={showMoney}
              hostExtras={hostExtras}
              onMessage={say}
            />
            {can.endRoom && (
              <div className="border-t pt-4">
                <EndRoomDialog count={count} onEnd={() => sock.endRoom()} />
              </div>
            )}
          </TabsContent>
        </Tabs>
      </RoomSheetContent>
    </Sheet>
  );
}
