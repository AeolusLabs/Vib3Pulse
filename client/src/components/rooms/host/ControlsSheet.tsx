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
import { useRoomsConfig } from "@/lib/roomsApi";
import { CONTROLS_COPY, TAB_LABEL, controlsFor, moneyPlaceholderVisible, readSettings, requestQueue, roleChange, settingsErrorMessage, type ControlsRole, type ControlsTab } from "@/lib/hostControls";
import type { useRoomSocket } from "@/hooks/useRoomSocket";
import type { RoomMemberView, RoomState } from "@/lib/roomReducer";

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
}

const nameOf = (m: RoomMemberView) => m.displayName || m.organizationName || m.username || "Guest";
const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

/**
 * The host's (and a co-host's) Controls: Requests, Stage, People, Settings. A co-host gets the actions they already have
 * and only the pinned message in Settings. Every action goes through the existing socket and REST endpoints; the server decides.
 */
export default function ControlsSheet({ open, onOpenChange, roomId, inviteToken, role, room, state, count, selfId, sock, holderAwayLeftMs, hostExtras, returnFocusTo, startTab }: ControlsSheetProps) {
  const can = controlsFor(role);
  const [tab, setTab] = useState<ControlsTab>(startTab ?? "requests");
  const { data: config } = useRoomsConfig();
  const settings = readSettings(state.room, room as unknown as Record<string, unknown>);
  const showMoney = moneyPlaceholderVisible({ role, flags: config?.features, ageLimit: room.ageLimit, minorsRoom: room.minorsRoom });
  const requests = requestQueue(state.hands, state.asks, state.liveVideo).length;

  // One plain line for anything that failed, read out politely and cleared after a few seconds.
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  const say = (message: string) => {
    setNotice(message);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  };

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

  const triggerCls = `min-h-[44px] rounded-full border px-4 text-sm font-semibold transition-none motion-safe:transition-colors data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-none data-[state=inactive]:bg-muted data-[state=inactive]:text-foreground ${FOCUS}`;

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

        <Tabs value={tab} onValueChange={(v) => setTab(v as ControlsTab)} className="mt-3">
          <TabsList className="h-auto w-full flex-wrap justify-start gap-2 bg-transparent p-0" aria-label="Controls">
            {can.tabs.map((t) => (
              <TabsTrigger key={t} value={t} className={triggerCls} data-testid={`controls-tab-${t}`}>
                {TAB_LABEL[t]}
                {t === "requests" && requests > 0 && <><span className="ml-1.5" aria-hidden>{requests}</span><span className="sr-only">, {requests} waiting</span></>}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="requests" className="mt-4">
            <RequestsPanel
              members={state.members} hands={state.hands} asks={state.asks} liveVideo={state.liveVideo}
              onAccept={(i) => (i.kind === "hand" ? sock.stageAction("accept", i.userId) : sock.liveAction("grant", i.userId))}
              onDismiss={(i) => sock.stageAction("remove", i.userId)}
              onFailed={say}
            />
          </TabsContent>

          <TabsContent value="stage" className="mt-4 space-y-3">
            <StagePanel
              inTabs
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
            />
          </TabsContent>

          <TabsContent value="settings" className="mt-4 space-y-5">
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
