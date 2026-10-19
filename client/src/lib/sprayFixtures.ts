// Seeded spray states for /dev/room-fixture?spray=tray|confirm|bank|declined|limit|quiet (dev only, no network).
// Pure: the clock and the origin are passed in.
import type { SprayTier } from "@shared/money";
import { FIXTURE_IDS } from "./roomFixtures";
import { IDLE, type SprayBlock, type SprayFlow, type SprayIntent, type SprayMe, type SprayScene } from "./sprayUi";

/** A fixed lowercase UUID v4, so the fixture never needs a random source. */
export const FIXTURE_SPRAY_KEY = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

export const FIXTURE_SPRAY_BLOCK: SprayBlock = { enabled: true, roomLimitKobo: 200_000, roomSpentKobo: 0, targets: [FIXTURE_IDS.host, FIXTURE_IDS.stage] };

export const fixtureSprayMe = (): SprayMe => ({ method: { last4: "4242", brand: "visa" }, dailyLimitKobo: 2_000_000, dailySpentKobo: 0, verified: true });

const intent = (tier: SprayTier): SprayIntent => ({ tier, targetId: FIXTURE_IDS.host, key: FIXTURE_SPRAY_KEY, saveCard: false });

export function fixtureSprayStart(scene: SprayScene, now: number, origin: string): {
  flow: SprayFlow; sub: { kind: "limit"; tier: SprayTier | null } | null; tray: boolean; quiet: boolean;
} {
  switch (scene) {
    case "tray": return { flow: IDLE, sub: null, tray: true, quiet: false };
    case "confirm": return { flow: { kind: "confirming", intent: intent("bag") }, sub: null, tray: true, quiet: false };
    case "bank": return { flow: { kind: "action_required", intent: intent("bag"), sprayId: "fx-spray-bank", url: `${origin}/dev/room-fixture?spray=tray`, since: now }, sub: null, tray: true, quiet: false };
    case "declined": return { flow: { kind: "failed", intent: intent("bundle"), reason: "DECLINED", sameKey: false, sprayId: null }, sub: null, tray: true, quiet: false };
    case "limit": return { flow: IDLE, sub: { kind: "limit", tier: "bag" }, tray: true, quiet: false };
    case "quiet": return { flow: IDLE, sub: null, tray: false, quiet: true };
  }
}
