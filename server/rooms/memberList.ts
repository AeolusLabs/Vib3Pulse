// Who the room:state member list carries. Pure: no hub, no sockets. Tested in scripts/test-rooms-unit-memberlist.ts.
import { ROOM_LIMITS } from "@shared/rooms";

/**
 * Members sent whole on join: a full free room (ROOM_LIMITS.capacityMax). Bigger (paid) rooms send this many plus the
 * people the client must be able to act on (see wantedMemberIds); everyone who joins later arrives by room:joined anyway.
 */
export const MEMBER_LIST_CAP: number = ROOM_LIMITS.capacityMax;

/**
 * People the client needs by id even past the cap: the stage, raised hands, live asks and the holder (the host runs them),
 * and the authors of the recent chat and the people they quoted (a tap on a name opens their actions: mute, report, ban).
 */
export function wantedMemberIds(s: {
  stage: readonly string[]; hands: readonly string[]; asks: readonly string[]; holder: string | null;
  chat: ReadonlyArray<{ userId: string; replyTo?: { userId: string } }>;
}): Set<string> {
  const ids = new Set<string>([...s.stage, ...s.hands, ...s.asks]);
  if (s.holder) ids.add(s.holder);
  for (const l of s.chat) { ids.add(l.userId); if (l.replyTo) ids.add(l.replyTo.userId); }
  return ids;
}

/** The first `cap` members in join order, then every wanted member beyond them, each once. Ids nobody holds are ignored. */
export function selectStateMembers<M extends { userId: string }>(all: readonly M[], cap: number, wanted: Iterable<string>): M[] {
  const first = all.slice(0, cap);
  const want = new Set(wanted);
  const have = new Set(first.map((m) => m.userId));
  const extra: M[] = [];
  for (const m of all.slice(cap)) if (want.has(m.userId) && !have.has(m.userId)) { extra.push(m); have.add(m.userId); }
  return [...first, ...extra];
}
