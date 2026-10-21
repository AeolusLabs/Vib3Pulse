// "Open the teen lane / Open the 18+ lane": asks the server to open the other age group's lane of a game room.
// Only the parent's host or one of the host's mutual follows, in the lane's own age group, can; the server decides and a refusal
// is worded here (no line says anything about anyone's age). A teen lane is never public: the opener picks friends or invite only.
import { useState } from "react";
import type { RoomVisibility } from "@shared/rooms";
import { Button } from "@/components/ui/button";
import { call } from "@/components/rooms/create/createRoomApi";
import { gameRefusalText, openLaneLabel, type AgeLane } from "@/lib/gameScreen";
import "./game.css";

export interface OpenLaneProps {
  parentId: string;
  lane: AgeLane;
  /** The lane opened: the page reloads the room (the viewer may now be routed into it). */
  onOpened(): void;
  /** Say one plain line (the sheet's notice, or a status line on the page). */
  say(message: string): void;
}

const FAILED = "Couldn't open that lane. Try again.";

export default function OpenLane({ parentId, lane, onOpened, say }: OpenLaneProps) {
  const [busy, setBusy] = useState(false);
  const [vis, setVis] = useState<Extract<RoomVisibility, "friends" | "invite">>("friends");
  const open = async () => {
    if (busy) return;
    setBusy(true);
    const r = await call<unknown>("POST", `/api/rooms/${encodeURIComponent(parentId)}/lanes`, { lane, ...(lane === "teen" ? { visibility: vis } : {}) });
    setBusy(false);
    if (r.ok) { say("The lane is open."); onOpened(); return; }
    say(gameRefusalText(r) ?? (r.status === 403 ? "You can't open that lane." : FAILED));
  };
  return (
    <div className="space-y-2" data-testid="open-lane">
      {lane === "teen" && (
        <div className="gs-views" role="group" aria-label="Who can join the teen lane">
          {(["friends", "invite"] as const).map((v) => (
            <button key={v} type="button" className="gs-view" aria-pressed={vis === v} onClick={() => setVis(v)} data-testid={`open-lane-vis-${v}`}>{v === "friends" ? "Friends" : "Invite only"}</button>
          ))}
        </div>
      )}
      <Button type="button" className="min-h-[44px] rounded-full" variant="outline" disabled={busy} onClick={() => void open()} data-testid={`open-lane-${lane}`}>{busy ? "Opening…" : openLaneLabel(lane)}</Button>
    </div>
  );
}
