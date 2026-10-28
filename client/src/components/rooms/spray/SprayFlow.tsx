// The whole spray flow in ONE bottom sheet whose content follows the state: tray, add a card, confirm (slide to pay), bank
// approval, failed, room limit, spending limits. One sheet, so moving between steps never fights over focus, Escape or the
// scrim. The room renders this only when the server sent a spray block (ID-verified adult, live 18+ room).
import type { Side } from "@shared/gameScreen";
import { SIDE_NAME } from "@/lib/gameScreen";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import RoomSheetContent from "@/components/rooms/shell/RoomSheetContent";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import type { SprayTier } from "@shared/money";
import type { SprayEvent } from "@/lib/roomReducer";
import { deleteMethod, getSprayMe } from "@/lib/sprayApi";
import { SPRAY_COPY, defaultTarget, holdsSprayBlock, inFlight, parseSprayMe, tileAction, type SprayBlock, type SprayFlow as Flow, type SprayMe } from "@/lib/sprayUi";
import { snd } from "./sound";
import { useSpray } from "./useSpray";
import SprayTray from "./SprayTray";
import CardSheet from "./CardSheet";
import SprayConfirm from "./SprayConfirm";
import BankApproval from "./BankApproval";
import PaymentFailedSheet from "./PaymentFailedSheet";
import SpendingLimits from "./SpendingLimits";

export const SPRAY_ME_KEY = ["/api/users/me/spray"] as const;

function useOnline() {
  const [on, setOn] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  useEffect(() => {
    const up = () => setOn(true), down = () => setOn(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  return on;
}

export type Sub = { kind: "limits" } | { kind: "card-replace" };

export interface SprayFlowProps {
  roomId: string;
  token?: string;
  block: SprayBlock;
  /** People who can be sprayed now (sprayTargets), the host first. */
  targets: string[];
  hostId: string;
  nameOf(userId: string): string;
  sprays: readonly SprayEvent[];
  trayOpen: boolean;
  onTrayOpenChange(open: boolean): void;
  /** Opened from a person's sheet: spray them. */
  presetTarget: string | null;
  /** Money moved or a limit changed: refetch the room (limit and spent). */
  onSettled(): void;
  quiet: boolean;
  onQuiet(on: boolean): void;
  returnFocusTo?: () => HTMLElement | null;
  /**
   * Money is in motion, or there is an outcome the payer has not read: the room must keep this flow mounted (it holds
   * the last good spray block) even if a reload comes back without one.
   */
  onHoldChange?(hold: boolean): void;
  /** The game stage's team sheet picked a tier for a team: start a team intent (one charge split between the team). */
  teamRequest?: { side: Side; tier: SprayTier; anchorId: string; seq: number } | null;
  /** Dev fixture only. */
  initial?: { flow: Flow; sub: Sub | null };
}

export default function SprayFlow({ roomId, token, block, targets, hostId, nameOf, sprays, trayOpen, onTrayOpenChange, presetTarget, onSettled, quiet, onQuiet, returnFocusTo, onHoldChange, teamRequest, initial }: SprayFlowProps) {
  const { toast } = useToast();
  const online = useOnline();
  const settled = () => { onSettled(); void queryClient.invalidateQueries({ queryKey: SPRAY_ME_KEY }); };
  const flow = useSpray(roomId, { token, sprays, onSettled: settled, initial: initial?.flow });
  const s = flow.state;
  const [sub, setSub] = useState<Sub | null>(initial?.sub ?? null);
  const [hidden, setHidden] = useState(false);
  const [cardOkFor, setCardOkFor] = useState<string | null>(null);
  const [cardBusy, setCardBusy] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);
  const skipCard = useRef(false);
  const autoPay = useRef(false);


  const [targetId, setTargetId] = useState<string | null>(() => presetTarget ?? defaultTarget(targets, hostId));
  useEffect(() => { if (presetTarget) setTargetId(presetTarget); }, [presetTarget]);
  useEffect(() => { if (!targetId || !targets.includes(targetId)) setTargetId(defaultTarget(targets, hostId)); }, [targets.join("|"), hostId]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = trayOpen || s.kind !== "idle" || sub !== null;
  const meQ = useQuery<SprayMe>({
    queryKey: SPRAY_ME_KEY,
    queryFn: async () => {
      const r = await getSprayMe();
      const me = r.ok ? parseSprayMe(r.body) : null;
      if (!me) throw new Error("Couldn't load your card");
      return me;
    },
    enabled: active,
    staleTime: 0,
    retry: 1,
  });
  const me = meQ.data ?? null;

  // A new step (the bank, an outcome): show the sheet again if it was hidden while waiting. Opening Spray again shows it too.
  useEffect(() => { setHidden(false); }, [s.kind]);
  useEffect(() => { if (trayOpen) setHidden(false); }, [trayOpen]);
  // Tell the room to keep this flow (and its block) while money is in motion or an outcome is unread.
  const hold = holdsSprayBlock(s);
  const holdRef = useRef(onHoldChange);
  holdRef.current = onHoldChange;
  useEffect(() => { holdRef.current?.(hold); }, [hold]);
  useEffect(() => () => { holdRef.current?.(false); }, []);
  // "Use another card": the save choice is made on that sheet and carried to the new intent.
  const [replaceSave, setReplaceSave] = useState(false);
  // After "Use another card" the card was chosen in that sheet: skip the add-a-card step once for the new intent.
  const intentKey = s.kind === "idle" ? null : s.intent.key;
  useEffect(() => {
    if (skipCard.current && intentKey && s.kind === "confirming") { skipCard.current = false; setCardOkFor(intentKey); }
  }, [intentKey, s.kind]);
  // "Try again" after an unknown outcome resends the same request (same key) straight away.
  useEffect(() => {
    if (s.kind === "confirming" && autoPay.current) { autoPay.current = false; void flow.pay(); }
  }, [s]); // eslint-disable-line react-hooks/exhaustive-deps
  // Landed: say so, and get the sheet out of the way so the effect is seen.
  const deliveredId = s.kind === "delivered" ? s.sprayId : null;
  useEffect(() => {
    if (!deliveredId || s.kind !== "delivered") return;
    toast({ title: `${SPRAY_COPY.sent} ${s.intent.side ? SIDE_NAME[s.intent.side] : nameOf(s.intent.targetId)}` });
    flow.close();
    onTrayOpenChange(false);
  }, [deliveredId]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (tier: SprayTier) => {
    snd.unlock(); // the tap is the gesture the browser needs before any sound
    if (!targetId) return;
    const a = tileAction(tier, block, me, online);
    if (a.kind !== "pay") return;
    if (!flow.start(tier, targetId)) toast({ title: "A spray is still on its way. Wait for it to land." });
  };

  // The team sheet's pick: the same checks as a single spray (the card and the connection), then a team intent with its own key.
  const lastTeamSeq = useRef(0);
  useEffect(() => {
    if (!teamRequest || teamRequest.seq === lastTeamSeq.current) return;
    lastTeamSeq.current = teamRequest.seq;
    snd.unlock();
    const a = tileAction(teamRequest.tier, block, me, online);
    if (a.kind !== "pay") return;
    if (!flow.start(teamRequest.tier, teamRequest.anchorId, teamRequest.side)) toast({ title: "A spray is still on its way. Wait for it to land." });
  }, [teamRequest?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  const retry = () => {
    if (s.kind === "failed" && s.sameKey) autoPay.current = true;
    flow.retry();
  };

  const replaceCard = async () => {
    if (cardBusy || s.kind !== "failed") return;
    setCardBusy(true);
    setCardError(null);
    const save = replaceSave;
    const r = await deleteMethod();
    setCardBusy(false);
    if (!r.ok) { setCardError(r.status === 0 ? "You're offline. Try again when you're back online." : "Couldn't forget the card. Try again."); return; }
    queryClient.setQueryData<SprayMe | undefined>(SPRAY_ME_KEY, (m) => (m ? { ...m, method: null } : m));
    void queryClient.invalidateQueries({ queryKey: SPRAY_ME_KEY });
    setSub(null);
    skipCard.current = true;
    // A decline is definitive: a new intent, a new key. The two events are applied in order, so the choice made on the
    // "Use another card" sheet lands on the new intent (review M5).
    flow.retry();
    flow.setSaveCard(save);
  };

  // ---------------------------------------------------------------- which step shows
  // Only once we know there is no saved card (while the settings load, no card step flashes; the server decides anyway).
  const needsCard = s.kind === "confirming" && !!me && !me.method && cardOkFor !== s.intent.key;
  type View = "tray" | "card" | "confirm" | "bank" | "failed" | "limits" | "card-replace" | null;
  const view: View = sub ? sub.kind
    : s.kind === "confirming" ? (needsCard ? "card" : "confirm")
    : s.kind === "paying" ? (hidden ? null : "confirm")
    : s.kind === "action_required" ? (hidden ? null : "bank")
    : s.kind === "failed" ? "failed"
    : s.kind === "delivered" ? null
    : trayOpen ? "tray" : null;

  /** Hide while money is in motion (the hook keeps watching and the outcome brings the sheet back); otherwise close. */
  const hide = () => { setHidden(true); onTrayOpenChange(false); };
  const dismiss = () => {
    if (sub) { setSub(null); setCardError(null); return; }
    if (inFlight(s)) { hide(); return; }
    if (s.kind !== "idle") { flow.close(); return; }
    onTrayOpenChange(false);
  };

  const name = (id: string) => nameOf(id);
  let body: React.ReactNode = null;
  if (view === "tray") {
    body = targets.length === 0 || !targetId ? (
      <div className="grid gap-3" data-testid="spray-no-targets">
        <SheetHeader className="text-left"><SheetTitle>Spray</SheetTitle><SheetDescription>Nobody here can be sprayed right now. You can spray the host and people on stage.</SheetDescription></SheetHeader>
        <Button className="min-h-[44px] rounded-full" onClick={() => onTrayOpenChange(false)}>{SPRAY_COPY.done}</Button>
      </div>
    ) : (
      <SprayTray block={block} me={me} meError={meQ.isError && !me} onRetryMe={() => void meQ.refetch()}
        targets={targets.map((id) => ({ id, name: name(id) }))} targetId={targetId} onTarget={setTargetId}
        online={online} onPick={pick} onLimits={() => setSub({ kind: "limits" })}
        quiet={quiet} onQuiet={onQuiet} onDone={() => onTrayOpenChange(false)} />
    );
  } else if (view === "card" && s.kind === "confirming") {
    body = <CardSheet mode="add" method={null} saveCard={s.intent.saveCard} onSaveCard={flow.setSaveCard} onContinue={() => setCardOkFor(s.intent.key)}
      onPayOther={() => { flow.setPayOther(true); setCardOkFor(s.intent.key); }} onCancel={flow.close} />;
  } else if (view === "card-replace" && s.kind === "failed") {
    body = <CardSheet mode="replace" method={me?.method ?? null} saveCard={replaceSave} onSaveCard={setReplaceSave}
      onContinue={() => void replaceCard()} onCancel={() => setSub(null)} busy={cardBusy} error={cardError} />;
  } else if (view === "confirm" && (s.kind === "confirming" || s.kind === "paying")) {
    body = <SprayConfirm tier={s.intent.tier} name={s.intent.side ? SIDE_NAME[s.intent.side] : name(s.intent.targetId)} method={me?.method ?? null}
      paying={s.kind === "paying"} sending={s.kind === "paying" && !!s.sprayId} unknown={s.kind === "paying" && s.unknown === true}
      bankUrl={s.kind === "paying" ? s.intent.bankUrl ?? null : null}
      payOther={s.intent.payOther === true} onPayOther={s.kind === "confirming" ? flow.setPayOther : undefined}
      anonymous={s.intent.anonymous === true} onAnonymous={s.kind === "confirming" ? flow.setAnonymous : undefined}
      onPay={() => { snd.unlock(); flow.pay(); }} onCancel={flow.close} onHide={hide} />;
  } else if (view === "bank" && s.kind === "action_required") {
    body = <BankApproval tier={s.intent.tier} url={s.url} onClose={hide} />;
  } else if (view === "failed" && s.kind === "failed") {
    const tier = s.intent.tier;
    body = <PaymentFailedSheet key={`${s.intent.key}:${s.reason}`} reason={s.reason} retryAfterSec={s.retryAfterSec} onRetry={retry}
      onAnotherCard={() => { setCardError(null); setReplaceSave(false); setSub({ kind: "card-replace" }); }}
      onClose={flow.close} />;
  } else if (view === "limits") {
    body = <SpendingLimits me={me} onChanged={() => void queryClient.invalidateQueries({ queryKey: SPRAY_ME_KEY })} onClose={() => setSub(null)} />;
  }

  return (
    <Sheet open={view !== null && body !== null} onOpenChange={(o) => { if (!o) dismiss(); }}>
      <RoomSheetContent side="bottom" className="max-h-[90vh] overflow-y-auto rounded-t-2xl" returnFocusTo={returnFocusTo} data-testid="spray-sheet" data-view={view ?? "closed"}>
        {body}
      </RoomSheetContent>
    </Sheet>
  );
}
