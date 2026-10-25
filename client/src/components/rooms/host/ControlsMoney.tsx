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

export interface ControlsMoneyProps {
  roomId: string;
  /** Called after a saved change so the room details upstream are refetched and every reader sees the saved value. */
  onChanged?: () => void;
  room: { ageLimit: string; minorsRoom?: boolean; status?: string; sprayEnabled?: boolean; ticketPriceKobo?: number | null };
}

export default function ControlsMoney({ roomId, room, onChanged }: ControlsMoneyProps) {
  const { data: config } = useRoomsConfig(true);
  const view = moneyView({ flags: config?.features, readiness: config?.hostMoneyReadiness, ageLimit: room.ageLimit, minorsRoom: room.minorsRoom });
  const [on, setOn] = useState(room.sprayEnabled === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  useEffect(() => { setOn(room.sprayEnabled === true); }, [room.sprayEnabled]);
  if (!view.visible) return null;

  const save = async (next: boolean) => {
    setBusy(true); setError(null);
    const res = await call<unknown>("PATCH", `/api/rooms/${encodeURIComponent(roomId)}`, { sprayEnabled: next });
    setBusy(false);
    if (res.ok) { setOn(next); onChanged?.(); }
    else setError(moneyRefusal(res.code) ?? MONEY_COPY.saveFailed);
  };
  const change = (next: boolean) => {
    if (on && !next && room.status === "live") setConfirmOff(true);
    else void save(next);
  };

  return (
    <>
      <StepSpray
        view={view} testPrefix="controls-money" error={error}
        paid={{ on: typeof room.ticketPriceKobo === "number" }}
        spray={{ on, set: change, busy }}
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
