// Seeded room states for the dev fixture route. Pure: no sockets, no network, no clock reads at import time.
import { initialRoomState, roomReducer, type MemberRole, type RoomMemberView, type RoomState } from "./roomReducer";

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
