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
