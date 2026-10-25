// The host's Money section in Controls: the same Paid room and Spray states as the create wizard, for a scheduled or live room.
// Spray changes go through PATCH /api/rooms/:id; the server decides (canEnableSpray) and its refusal is shown here.
import { useEffect, useState } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import StepSpray from "@/components/rooms/create/StepSpray";
import { call } from "@/components/rooms/create/createRoomApi";
import { useRoomsConfig } from "@/lib/roomsApi";
import { MONEY_COPY, moneyRefusal, moneyView } from "@/lib/moneySection";
import { SPRAY_LIVE_COPY, hostSprayLine, sprayToggleRefusal } from "@/lib/sprayLive";

export interface ControlsMoneyProps {
  roomId: string;
  /** Called after a saved change so the room details upstream are refetched and every reader sees the saved value. */
  onChanged?: () => void;
  room: { ageLimit: string; minorsRoom?: boolean; status?: string; sprayEnabled?: boolean; ticketPriceKobo?: number | null;
    /** What the room says right now (room:settings): spray effectively on, and whether an admin blocked it. Absent with the flag off. */
    sprayOn?: boolean; sprayBlockedByAdmin?: boolean };
}

export default function ControlsMoney({ roomId, room, onChanged }: ControlsMoneyProps) {
  const { data: config } = useRoomsConfig(true);
  const view = moneyView({ flags: config?.features, readiness: config?.hostMoneyReadiness, ageLimit: room.ageLimit, minorsRoom: room.minorsRoom });
  const [on, setOn] = useState(room.sprayEnabled === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  // A refused switch (403) is learned from the answer before the socket says so; the room flag takes over once it arrives.
  const [blockSeen, setBlockSeen] = useState(false);
  const blocked = room.sprayBlockedByAdmin === true || blockSeen;
  useEffect(() => { if (room.sprayBlockedByAdmin === false) setBlockSeen(false); }, [room.sprayBlockedByAdmin]);
  useEffect(() => { setOn(room.sprayEnabled === true); }, [room.sprayEnabled]);
  // The server's effective state wins over the saved choice (an admin block or a pause turns it off under the host).
  // A saved change shows as saved until the next settings event, so a success never looks like a failure.
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => { setOverride(null); }, [room.sprayOn]);
  const platformLine = blocked ? null : hostSprayLine({ sprayOn: room.sprayOn, sprayEnabled: on });
  const shownOn = !blocked && (platformLine ? true : override ?? (typeof room.sprayOn === "boolean" ? room.sprayOn : on));
  if (!view.visible) return null;

  const save = async (next: boolean) => {
    setBusy(true); setError(null);
    const res = await call<unknown>("PATCH", `/api/rooms/${encodeURIComponent(roomId)}`, { sprayEnabled: next });
    setBusy(false);
    if (res.ok) { setOn(next); setOverride(next); onChanged?.(); }
    else {
      const live = sprayToggleRefusal(res);
      if (live?.adminBlocked) { setBlockSeen(true); onChanged?.(); }
      setError(live ? live.text : moneyRefusal(res.code) ?? MONEY_COPY.saveFailed);
    }
  };
  const change = (next: boolean) => {
    if (shownOn && !next && room.status === "live") setConfirmOff(true);
    else void save(next);
  };

  return (
    <>
      <StepSpray
        view={view} testPrefix="controls-money" error={blocked ? null : error ?? platformLine}
        paid={{ on: typeof room.ticketPriceKobo === "number" }}
        spray={{ on: shownOn, set: change, busy, blocked: blocked ? SPRAY_LIVE_COPY.adminBlocked : undefined }}
      />
      <AlertDialog open={confirmOff} onOpenChange={setConfirmOff}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{MONEY_COPY.confirmOffTitle}</AlertDialogTitle>
            <AlertDialogDescription>{MONEY_COPY.confirmOffBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-[44px]" data-testid="button-spray-keep">{MONEY_COPY.confirmOffStay}</AlertDialogCancel>
            <AlertDialogAction className="min-h-[44px]" onClick={() => void save(false)} data-testid="button-spray-off">{MONEY_COPY.confirmOffGo}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
