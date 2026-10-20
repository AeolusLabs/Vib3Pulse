// Seeded room states for the dev fixture route. Pure: no sockets, no network, no clock reads at import time.
import { initialRoomState, roomReducer, type MemberRole, type RoomMemberView, type RoomState } from "./roomReducer";
import { ticketBreakdown } from "@shared/money";

export type FixtureScene = "voice" | "live" | "immersive" | "weak" | "dropped";

const SELF = "fx-self";
const HOST = "fx-host";
const COHOST = "fx-cohost";
const STAGE_GUEST = "fx-stage";
const ANON = "fx-anon";

const PEOPLE: Array<{ id: string; role: MemberRole; name: string; username?: string }> = [
  { id: HOST, role: "host", name: "Maya Okafor", username: "maya" },
  { id: COHOST, role: "cohost", name: "Dev Patel", username: "dev" },
  { id: STAGE_GUEST, role: "guest", name: "Rosa Lindqvist", username: "rosa" },
  { id: SELF, role: "guest", name: "You", username: "you" },
  { id: "fx-g1", role: "guest", name: "Theo Baptiste", username: "theo" },
  { id: "fx-g2", role: "guest", name: "Ines Moreau", username: "ines" },
  { id: "fx-g3", role: "guest", name: "Kofi Mensah", username: "kofi" },
  { id: "fx-g4", role: "guest", name: "Lena Fischer", username: "lena" },
  { id: "fx-g5", role: "guest", name: "Sam Whitaker", username: "sam" },
  { id: "fx-g6", role: "guest", name: "Priya Nair", username: "priya" },
  { id: ANON, role: "guest", name: "Guest" },
];

export const FIXTURE_NAMES: Record<string, string> = Object.fromEntries(PEOPLE.map((p) => [p.id, p.name]));

const LINES: Array<[string, string]> = [
  [HOST, "Welcome in, everyone. Settle in, we start in a minute."],
  ["fx-g1", "Hey all, first time here"],
  [COHOST, "Glad you made it, Theo."],
  ["fx-g2", "Is the sound okay for everyone?"],
  [STAGE_GUEST, "Loud and clear on my side"],
  [SELF, "Same here, thanks"],
  ["fx-g3", "Can we get the playlist link afterwards?"],
  [HOST, "Yes, I will drop it in the chat at the end."],
  [ANON, "supercalifragilisticexpialidocious_and_a_very_long_unbroken_word_to_test_wrapping_in_the_bubble"],
];

const NOW = 1_700_000_000_000;

export function fixtureState(scene: FixtureScene): RoomState {
  const members: RoomMemberView[] = PEOPLE.map((p, i) => ({
    userId: p.id, role: p.role, muted: false, joinedAt: NOW - (PEOPLE.length - i) * 60_000,
    displayName: p.name, ...(p.username ? { username: p.username } : {}),
  }));
  const live = scene !== "voice";
  let s = initialRoomState(null);
  s = roomReducer(s, { type: "client:self", userId: SELF });
  s = roomReducer(s, {
    type: "room:state",
    room: { id: "fixture-room", liveVideo: live } as { id: string },
    members, memberCount: members.length, screen: null, you: { role: "guest", muted: false },
    voiceEnabled: true, stage: [STAGE_GUEST], hands: [],
    holder: live ? STAGE_GUEST : null, asks: [],
    away: scene === "dropped" ? NOW + 60_000 : null,
    serverNowMs: NOW,
  }, () => NOW);
  LINES.forEach(([userId, text], i) => {
    s = roomReducer(s, { type: "room:chat", userId, text, at: NOW - (LINES.length - i) * 20_000 }, () => NOW);
  });
  return s;
}

// ---------------------------------------------------------------- the real room shell in the fixture (task 1.7)

export const FIXTURE_IDS = { self: SELF, host: HOST, cohost: COHOST, stage: STAGE_GUEST, anon: ANON } as const;

/** The room record the shell needs. Plain data: the fixture never talks to the server. */
export const FIXTURE_ROOM = {
  id: "fixture-room", hostId: HOST, title: "Friday Pre-Drinks, Lagos to London", description: null, kind: "party" as const,
  visibility: "public" as const, ageLimit: "13+" as const, capacity: 50, status: "live" as const, scheduledFor: null,
  startedAt: null, endedAt: null, screen: null, eventId: null, venueId: null, noDirectInteractions: false,
};

export const FIXTURE_HOST = {
  id: HOST, username: "maya", displayName: "Maya Okafor", organizationName: null, avatarUrl: null, avatar: null, isVerified: null, isOfficial: null,
};

export interface FixtureOptions {
  scene: FixtureScene;
  theme: "dark" | "light";
  /** Who you are: a guest on the floor (default), the person live on the screen, or the host. */
  as: "guest" | "holder" | "host";
  /** Viewer data saver on. */
  sound: boolean;
  /** Room audio waits for a tap. */
  tap: boolean;
  /** The host invited you to speak (the Accept / Decline alert). */
  invite: boolean;
  /** Push this many chat lines over ten seconds (0 = none, at most 1000). */
  flood: number;
  /** Minors' room scenes: the two warnings, the adult invite sheet, an adult listening in the shell, the teen host note. */
  minors: MinorsScene | null;
}

export type MinorsScene = "refuse" | "ack" | "invites" | "listen" | "teennote";
export const MINORS_SCENES: MinorsScene[] = ["refuse", "ack", "invites", "listen", "teennote"];

const adult = (id: string, username: string, displayName: string) => ({ id, username, displayName, organizationName: null, avatarUrl: null, avatar: null, isVerified: null, isOfficial: null });

/** The invite sheet fixture: an Active and an Acknowledged row from the server, plus a Revoked row the page keeps locally. */
export const FIXTURE_INVITES = {
  active: [
    { user: adult("adult-1", "tolu", "Tolu Adeyemi"), invitedAt: "2026-10-18T09:00:00.000Z", acknowledged: false },
    { user: adult("adult-2", "sam", "Sam Rivers"), invitedAt: "2026-10-18T09:05:00.000Z", acknowledged: true },
  ],
  revoked: { user: adult("adult-3", "kemi", "Kemi Bello"), invitedAt: "2026-10-18T08:50:00.000Z", acknowledged: true },
};

const SCENES: FixtureScene[] = ["voice", "live", "immersive", "weak", "dropped"];

/** Reads the fixture's query string. Anything unknown falls back to the default, so a typo never breaks the page. */
export function parseFixtureQuery(search: string): FixtureOptions {
  const p = new URLSearchParams(search);
  const scene = p.get("scene") as FixtureScene;
  const as = p.get("as");
  const flood = Number(p.get("flood"));
  return {
    scene: SCENES.includes(scene) ? scene : "voice",
    theme: p.get("theme") === "light" ? "light" : "dark",
    as: as === "holder" || as === "host" ? as : "guest",
    sound: p.get("sound") === "1",
    tap: p.get("tap") === "1",
    invite: p.get("invite") === "1",
    minors: MINORS_SCENES.includes(p.get("minors") as MinorsScene) ? (p.get("minors") as MinorsScene) : null,
    flood: Number.isFinite(flood) && flood > 0 ? Math.min(1000, Math.floor(flood)) : 0,
  };
}

/** "live" opens compact (the picture on top, chat under it); every other live scene opens the width's default (immersive on phones). */
export function fixtureStartView(scene: FixtureScene): "compact" | undefined {
  return scene === "live" ? "compact" : undefined;
}

// ---------------------------------------------------------------- the host Controls sheet (task 3.4)

/** ?controls=host|cohost opens the Controls sheet as the host or the co-host. Separate from parseFixtureQuery so its shape stays put. */
export type ControlsScene = "host" | "cohost";
export function parseControlsFixture(search: string): ControlsScene | null {
  const c = new URLSearchParams(search).get("controls");
  return c === "host" || c === "cohost" ? c : null;
}

/** Two raised hands, one go-live ask, one guest on the mic, a co-host, and settings already set (pinned, slow mode 5 s). */
export function fixtureControlsState(as: ControlsScene): RoomState {
  let s = fixtureState("voice");
  s = roomReducer(s, { type: "client:self", userId: as === "host" ? HOST : COHOST });
  s = roomReducer(s, { type: "room:livevideo", enabled: true });
  s = roomReducer(s, { type: "room:stage", stage: [STAGE_GUEST], hands: ["fx-g1", "fx-g2"] });
  s = roomReducer(s, { type: "room:live", holder: null, asks: [STAGE_GUEST] });
  s = roomReducer(s, { type: "room:settings", pinnedMessage: "House rules: be kind, no spam.", slowModeSec: 5, locked: false });
  return { ...s, you: { role: as, muted: false }, serverOffsetMs: 0 };
}

/** A dropped holder's spot is held for about 100 s from now, so the slate shows a real countdown. */
export function fixtureLiveState(scene: FixtureScene, opts: { as: FixtureOptions["as"]; now: number; invite?: boolean }): RoomState {
  let s = fixtureState(scene);
  if (opts.as === "holder") s = roomReducer(s, { type: "client:self", userId: STAGE_GUEST });
  if (opts.as === "host") s = roomReducer(s, { type: "client:self", userId: HOST });
  const role: MemberRole = opts.as === "host" ? "host" : "guest";
  return {
    ...s,
    you: { role, muted: false },
    holderAwayUntil: scene === "dropped" ? opts.now + 100_000 : s.holderAwayUntil,
    serverOffsetMs: 0,
    invitedYou: !!opts.invite,
  };
}

// ---------------------------------------------------------------- edge states (task 6.7, flows board 11)
// ?edge=micdenied|micbusy|micmissing|camdenied|cambusy|cammissing|reconnecting. The first six open the real room shell with the
// hook's inline line set, so the real sheet appears. Spray edges are ?spray=unavailable|offline; weak signal is ?scene=weak;
// full, removed, banned and ended are ?state=...

export const EDGE_SCENES = ["micdenied", "micbusy", "micmissing", "camdenied", "cambusy", "cammissing", "reconnecting"] as const;
export type EdgeScene = (typeof EDGE_SCENES)[number];
export function parseEdgeFixture(search: string): EdgeScene | null {
  const v = new URLSearchParams(search).get("edge");
  return v && (EDGE_SCENES as readonly string[]).includes(v) ? (v as EdgeScene) : null;
}

// ---------------------------------------------------------------- paid room screens (task 4.7)
// ?ticket=page|confirmed|waiting|hostsales|price|refund. Sample data only; the numbers come from ticketBreakdown like the
// server's summary does, so the host sheet reads like the real thing (38 of 100 at 5,000 naira, as in img/f-hostsales).

export type TicketScene = "page" | "checkout" | "confirmed" | "waiting" | "hostsales" | "price" | "refund";
export const TICKET_SCENES: TicketScene[] = ["page", "checkout", "confirmed", "waiting", "hostsales", "price", "refund"];
export function parseTicketFixture(search: string): TicketScene | null {
  const t = new URLSearchParams(search).get("ticket") as TicketScene | null;
  return t && TICKET_SCENES.includes(t) ? t : null;
}

export const FIXTURE_TICKET_PRICE_KOBO = 500_000;

/** A scheduled 18+ paid room. `scheduledFor` is filled in by the caller from its own clock (no clock reads here). */
export function fixtureTicketRoom(scheduledFor: string) {
  return {
    ...FIXTURE_ROOM, id: "fixture-paid-room", title: "Amapiano Sunday Session", ageLimit: "18+" as const, status: "scheduled" as const,
    scheduledFor, liveVideo: true, capacity: 100, ticketCapacity: 100, refundBeforeStart: true,
  };
}

export const FIXTURE_TICKET_BLOCK = { required: true, priceKobo: FIXTURE_TICKET_PRICE_KOBO, held: false, soldOut: false, left: 62, capacity: 100, refundBeforeStart: true };

/** A reference in the exact shape checkout makes (vib3rt_<24 hex>_<32 hex>), so the return parser accepts it. */
export const FIXTURE_TICKET_REF = `vib3rt_${"0f".repeat(12)}_${"a1".repeat(16)}`;

export const FIXTURE_TICKET = {
  id: "00000000-0000-4000-8000-00000000f1c7", roomId: "fixture-paid-room", code: "VB7K2Q", amountKobo: FIXTURE_TICKET_PRICE_KOBO,
  status: "paid" as const, createdAt: "2026-10-17T18:00:00.000Z",
};

/**
 * The summary route's body as the server sends it, `{ summary: {...} }`: `sold` paid tickets at the fixture price through
 * ticketBreakdown, `refunded` refunded ones, and a held payout when `releaseAt` is given (null: no payout row yet).
 * No capacity in it: the host's own room carries ticketCapacity (100 in the fixture room).
 */
export function fixtureTicketSummary(sold = 38, releaseAt: string | null = "2026-10-20T20:00:00.000Z", refunded = 2) {
  const b = ticketBreakdown(FIXTURE_TICKET_PRICE_KOBO);
  return {
    summary: {
      sold, refunded,
      grossKobo: b.price * sold, vatKobo: b.vat * sold, feeKobo: b.fee * sold, reserveKobo: b.reserve * sold,
      platformKobo: b.platform * sold, hostKobo: b.host * sold,
      payout: releaseAt ? { status: "held", amountKobo: b.host * sold, releaseAt, paidAt: null } : null,
    },
  };
}
