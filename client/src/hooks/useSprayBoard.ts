// Seeds the spray board for someone who joined after sprays were thrown: the top three and what they were sprayed so far.
// Live changes after that arrive as room:spray_board / room:spray_received. Quiet (initial): the tray only slides out on a live spray.
import { useEffect } from "react";
import { getSprayBoard } from "@/lib/sprayApi";
import type { RoomEvent } from "@/lib/roomReducer";

export function useSprayBoardSeed({ roomId, token, enabled, inject }: { roomId: string; token?: string; enabled: boolean; inject?: (e: RoomEvent) => void }) {
  useEffect(() => {
    if (!enabled || !inject) return;
    let dead = false;
    void getSprayBoard(roomId, token).then((r) => {
      if (dead || !r.ok || !r.body || typeof r.body !== "object") return;
      const b = r.body as { top?: unknown; mine?: { kobo?: unknown; v3c?: unknown } };
      inject({ type: "room:spray_board", top: b.top, initial: true });
      if (typeof b.mine?.kobo === "number" && typeof b.mine?.v3c === "number" && b.mine.v3c > 0) inject({ type: "room:spray_received", kobo: b.mine.kobo, v3c: b.mine.v3c });
    });
    return () => { dead = true; };
  }, [roomId, token, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
}
