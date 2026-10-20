// Seeded spray states for /dev/room-fixture?spray=tray|confirm|bank|declined|limit|quiet (dev only, no network).
// Pure: the clock and the origin are passed in. Imported only by the DEV-only fixture page (and the unit test), so none of
// this reaches the production bundle.
import type { SprayTier } from "@shared/money";
import { FIXTURE_IDS } from "./roomFixtures";
import { IDLE, type SprayBlock, type SprayFlow, type SprayIntent, type SprayMe } from "./sprayUi";

/** Dev fixture scenes for /dev/room-fixture?spray=... */
export const SPRAY_SCENES = ["tray", "confirm", "bank", "declined", "limit", "quiet"] as const;
export type SprayScene = (typeof SPRAY_SCENES)[number];
export function parseSprayFixture(search: string): SprayScene | null {
  const v = new URLSearchParams(search).get("spray");
  return v && (SPRAY_SCENES as readonly string[]).includes(v) ? (v as SprayScene) : null;
}

/** A fixed lowercase UUID v4, so the fixture never needs a random source. */
export const FIXTURE_SPRAY_KEY = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

export const FIXTURE_SPRAY_BLOCK: SprayBlock = { enabled: true, roomLimitKobo: 200_000, roomSpentKobo: 0, targets: [FIXTURE_IDS.host, FIXTURE_IDS.stage] };

export const fixtureSprayMe = (): SprayMe => ({ method: { last4: "4242", brand: "visa" }, dailyLimitKobo: 2_000_000, dailySpentKobo: 0, verified: true });

const intent = (tier: SprayTier): SprayIntent => ({ tier, targetId: FIXTURE_IDS.host, key: FIXTURE_SPRAY_KEY, saveCard: false });

/** The chat line the server sends with a delivered spray (server/rooms/spray.ts announceDelivery), word for word. */
export function fixtureSprayChatText(tier: SprayTier, recipientName: string): string {
  if (tier === "rain") return `made it rain on ${recipientName}`;
  const label = tier === "note" ? "note" : tier === "bundle" ? "bundle" : "money bag";
  return `sprayed ${recipientName} a ${label}`;
}

export function fixtureSprayStart(scene: SprayScene, now: number, origin: string): {
  flow: SprayFlow; sub: { kind: "limit"; tier: SprayTier | null } | null; tray: boolean; quiet: boolean;
} {
  switch (scene) {
    case "tray": return { flow: IDLE, sub: null, tray: true, quiet: false };
    case "confirm": return { flow: { kind: "confirming", intent: intent("bag") }, sub: null, tray: true, quiet: false };
    case "bank": {
      // A same-origin stand-in for the bank page: allowed by safeAuthorizationUrl in dev builds only.
      const url = `${origin}/dev/room-fixture?spray=tray`;
      return { flow: { kind: "action_required", intent: { ...intent("bag"), bankUrl: url }, sprayId: "fx-spray-bank", url, since: now }, sub: null, tray: true, quiet: false };
    }
    case "declined": return { flow: { kind: "failed", intent: intent("bundle"), reason: "DECLINED", sameKey: false, sprayId: null }, sub: null, tray: true, quiet: false };
    case "limit": return { flow: IDLE, sub: { kind: "limit", tier: "bag" }, tray: true, quiet: false };
    case "quiet": return { flow: IDLE, sub: null, tray: false, quiet: true };
  }
}
