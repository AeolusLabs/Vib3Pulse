// The one answer to "is spraying on in this room right now". Everything that shows or gates spraying reads it.
import type { Room } from "@shared/schema";
import { roomFeatures } from "./features";
import { getControl, isHostFrozen } from "./roomControls";

export type SprayOffReason = "FEATURE_OFF" | "PAUSED" | "HOST_OFF" | "ADMIN_BLOCKED" | "HOST_FROZEN";
export type SprayEffective = { on: boolean; reason: null | SprayOffReason };

/** First failing reason wins, in this order. Phase "deliver" of an already charged spray never asks (see sprayGate). */
export async function sprayEffectiveFor(room: Pick<Room, "hostId" | "sprayEnabled" | "sprayAdminBlocked">): Promise<SprayEffective> {
  const off = (reason: SprayOffReason): SprayEffective => ({ on: false, reason });
  if (roomFeatures.spray !== true) return off("FEATURE_OFF");
  if (await getControl("sprays_paused")) return off("PAUSED");
  if (room.sprayEnabled !== true) return off("HOST_OFF");
  if (room.sprayAdminBlocked === true) return off("ADMIN_BLOCKED");
  if (await isHostFrozen(room.hostId)) return off("HOST_FROZEN");
  return { on: true, reason: null };
}
