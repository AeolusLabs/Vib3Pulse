// Rooms gaming: a game player is a spray recipient (sprayGate, start phase). Drives the room hub directly (no sockets) and
// a scratch database for the people and the room.   npm run test:rooms   (database name must contain "test"; prefix gs_)
// No charge is ever made: only sprayGate is called, never the spray endpoint or a provider.
import bcrypt from "bcrypt";
import pg from "pg";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}" (name must contain "test")`);
  process.exit(2);
}
delete process.env.ROOMS_GAMING;
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";

const rs = await import("../server/rooms/roomStorage");
const { roomHub } = await import("../server/rooms/RoomHub");
const { roomFeatures } = await import("../server/rooms/features");
const { sprayGate } = await import("../server/rooms/spray");
const { newGame, dropFromGame } = await import("../shared/gameScreen");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`);
};

const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const hash = await bcrypt.hash("Passw0rd!gs", 4);
const stamp = Date.now();
let seq = 0;
/** An ID-verified adult with a payable (name-matched) payout account. */
const mk = async (name: string) => {
  const id = (await q(
    `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, created_at, age_verified_at, age_verified_method)
     values ($1,$2,'social',$3,true,true,$4, now() - interval '60 days', now(), 'admin') returning id`,
    [`gs_${name}${stamp}@t.dev`, `gs_${name}${stamp}`, hash, yearsAgo(30)],
  ))[0].id as string;
  await q(`insert into organizer_payment_accounts (user_id, provider, paystack_subaccount_code, details_submitted, payouts_enabled, room_verified_subaccount_code, name_matched_at) values ($1,'paystack',$2,true,true,$2,now())`, [id, `ACCT_gs_${stamp}_${++seq}`]);
  return id;
};
const member = (userId: string, role: "host" | "cohost" | "guest" = "guest") =>
  ({ userId, role, muted: false, joinedAt: Date.now(), send: () => {}, info: {}, age: 30 });
/** The result without the facts object (rows from the database), for shape comparisons. */
const shape = (r: Awaited<ReturnType<typeof sprayGate>>) => (r.ok ? { ok: true } : r);

const savedSpray = roomFeatures.spray, savedGaming = roomFeatures.gaming;
try {
  roomFeatures.spray = true;
  const H = await mk("host"), P = await mk("payer"), X = await mk("player"), Y = await mk("plain");
  const room = await rs.createRoom(H, { title: "GS", kind: "party", visibility: "public", ageLimit: "18+", capacity: 20 } as any);
  await rs.setStatus(room.id, "live");
  const R = room.id as string;
  for (const [id, role] of [[H, "host"], [P, "guest"], [X, "guest"], [Y, "guest"]] as const) roomHub.join(R, member(id, role));
  roomHub.setVoiceOn(R, true);
  roomHub.setLiveVideoOn(R, true);

  // A plain guest who never plays: today's answer for someone not on the stage.
  roomFeatures.gaming = true;
  roomHub.setGameOn(R, true, { dropMs: 120_000, ageLane: null });
  const plain = shape(await sprayGate(R, P, Y, "start"));
  check("setup: a guest who is not on the stage or in the game is not sprayable", plain.ok === false, JSON.stringify(plain));

  const g = newGame(1); g.teams.A = [X]; g.featured.A = X;
  roomHub.setGame(R, g);
  const on = await sprayGate(R, P, X, "start");
  check("flag on: a player on a team is a spray recipient (eligible, kind stage)", on.ok === true && on.facts.kind === "stage" && on.facts.recipient.id === X, JSON.stringify(shape(on)));

  roomHub.setGame(R, dropFromGame(roomHub.gameOf(R), X));
  const removed = shape(await sprayGate(R, P, X, "start"));
  check("the same player after remove: the standard ineligible answer, identical to any other non-stage guest (no oracle)", JSON.stringify(removed) === JSON.stringify(plain), `${JSON.stringify(removed)} vs ${JSON.stringify(plain)}`);

  roomHub.setGame(R, g);
  roomFeatures.gaming = false;
  const off = shape(await sprayGate(R, P, X, "start"));
  check("flag off: a player in the game is answered exactly as today (not on the stage)", JSON.stringify(off) === JSON.stringify(plain), `${JSON.stringify(off)} vs ${JSON.stringify(plain)}`);

  roomFeatures.gaming = true;
  roomHub.setStage(R, { stage: [Y], hands: [], invited: [] });
  const staged = await sprayGate(R, P, Y, "start");
  check("unchanged: a stage guest is still a recipient with the flag on", staged.ok === true, JSON.stringify(shape(staged)));
  roomHub.end(R);
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  roomFeatures.spray = savedSpray; roomFeatures.gaming = savedGaming;
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
