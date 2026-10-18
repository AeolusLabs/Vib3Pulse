// Profile reads and the block check (throwaway database):   npm run test:rooms
//   DATABASE_URL=<scratch db> SESSION_SECRET=x npx tsx scripts/test-rooms-api-profilesafety.ts
// Refuses to run unless the database name contains "test", because it creates users.
//
// The rule under test: if either side has blocked the other, every profile read by a SIGNED-IN viewer, by id or username,
// answers exactly as for a user who does not exist (404 {"message":"User not found"}). Not covered by the rule: signed-out
// visitors can still read public profiles, and the follow route answers a blocked pair with 403 instead of 404.
// Unblocking goes by id through /api/blocks, never through the profile.
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcrypt";
import pg from "pg";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}" (name must contain "test")`);
  process.exit(2);
}
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";

const { storage } = await import("../server/storage");
const { redactSensitiveFields } = await import("../server/security");
const { registerUsersRoutes } = await import("../server/routes/users-routes");
const { registerBlockRoutes } = await import("../server/routes/block-routes");
const { userToSessionUser } = await import("../server/auth");
const { registerRoomRoutes } = await import("../server/rooms/roomRoutes");
const rs = await import("../server/rooms/roomStorage");
const { roomHub } = await import("../server/rooms/RoomHub");

await storage.ensureLoginAttemptsTable();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`);
};

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());
app.use(async (req: any, _res, next) => {
  const id = req.header("x-test-user");
  if (id) {
    const u = await storage.getUser(id);
    req.user = u ? userToSessionUser(u) : undefined;
  }
  req.isAuthenticated = () => !!req.user;
  next();
});
app.use(redactSensitiveFields);
registerUsersRoutes(app);
registerBlockRoutes(app);
registerRoomRoutes(app);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;

let ipSeq = 1;
async function http(method: string, path: string, as: string | null, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, ...(as ? { "x-test-user": as } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

const hash = await bcrypt.hash("Passw0rd!rooms", 4);
const stamp = Date.now();
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); return d.toISOString().slice(0, 10); };
const mk = async (name: string) => {
  const row = (await q(
    `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, phone_number)
     values ($1,$2,'social',$3,true,true,$4,'07000000001') returning id, username`, [`pf_${name}${stamp}@t.dev`, `pf_${name}${stamp}`, hash, yearsAgo(30)]))[0];
  return { id: row.id as string, username: row.username as string };
};
const block = (blocker: string, blocked: string) => q(`insert into user_blocks (blocker_id, blocked_id) values ($1,$2) on conflict do nothing`, [blocker, blocked]);
const unblockRows = (blocker: string, blocked: string) => q(`delete from user_blocks where blocker_id=$1 and blocked_id=$2`, [blocker, blocked]);

// The routes a profile page or the room peek reads, for one target (by id or username).
const READS = ["", "/profile", "/follow-stats", "/posts", "/liked-posts", "/reposted-posts"] as const;
const read = (ident: string, suffix: string, as: string | null) => http("GET", `/api/users/${encodeURIComponent(ident)}${suffix}`, as);

try {
  const A = await mk("a"), B = await mk("b"), C = await mk("c");
  const GHOST_ID = "00000000-0000-4000-8000-000000000000";
  const ghostName = `pf_ghost${stamp}`;

  // ---- baseline: unblocked pair reads normally
  for (const sfx of READS) {
    const byId = await read(A.id, sfx, B.id);
    const byName = await read(A.username, sfx, B.id);
    check(`unblocked: B reads A${sfx || " (peek)"} by id and username -> 200`, byId.status === 200 && byName.status === 200, `${byId.status}/${byName.status}`);
  }
  check("unblocked: signed-out viewer reads A -> 200 (profiles stay public)", (await read(A.username, "", null)).status === 200);

  // ---- the "does not exist" answer, per route, to compare against
  const missing: Record<string, { status: number; body: string }> = {};
  for (const sfx of READS) {
    const byId = await read(GHOST_ID, sfx, B.id);
    const byName = await read(ghostName, sfx, B.id);
    missing[sfx] = { status: byId.status, body: JSON.stringify(byId.json) };
    check(`missing user${sfx || " (peek)"}: 404 "User not found" by id and username`,
      byId.status === 404 && byName.status === 404 && byId.json?.message === "User not found" && JSON.stringify(byId.json) === JSON.stringify(byName.json), JSON.stringify([byId, byName]));
  }

  // ---- A blocks B: B reading A gets exactly the missing-user answer
  await block(A.id, B.id);
  for (const sfx of READS) {
    const byId = await read(A.id, sfx, B.id);
    const byName = await read(A.username, sfx, B.id);
    check(`A blocked B: B reads A${sfx || " (peek)"} by id and username is identical to a missing user`,
      byId.status === missing[sfx].status && JSON.stringify(byId.json) === missing[sfx].body && byName.status === missing[sfx].status && JSON.stringify(byName.json) === missing[sfx].body,
      JSON.stringify([byId, byName, missing[sfx]]));
  }

  // ---- A blocks B: A reading B (the blocker) gets the same answer; unblock does not need the profile
  for (const sfx of READS) {
    const byId = await read(B.id, sfx, A.id);
    const byName = await read(B.username, sfx, A.id);
    check(`A blocked B: A reads B${sfx || " (peek)"} by id and username -> same 404 as a missing user`,
      byId.status === 404 && byName.status === 404 && JSON.stringify(byId.json) === missing[sfx].body && JSON.stringify(byName.json) === missing[sfx].body, JSON.stringify([byId, byName]));
  }
  const list = await http("GET", "/api/blocks", A.id);
  check("A can still list who they blocked (Account settings), with B's id", list.status === 200 && list.json?.blocked?.some((u: any) => u.id === B.id), JSON.stringify(list));
  const un = await http("DELETE", `/api/blocks/${B.id}`, A.id);
  check("A can unblock B by id while B's profile is hidden from A", un.status === 200 && un.json?.blocked === false, JSON.stringify(un));
  check("after unblocking, both directions read normally again", (await read(B.username, "", A.id)).status === 200 && (await read(A.username, "", B.id)).status === 200);

  // ---- the block API itself still works through the app route and then hides both ways
  const put = await http("PUT", `/api/blocks/${A.id}`, B.id);
  check("B blocks A through PUT /api/blocks/:id -> 200", put.status === 200 && put.json?.blocked === true, JSON.stringify(put));
  check("B blocked A: A reading B -> 404 (blocker is hidden from the blocked person)", (await read(B.username, "", A.id)).status === 404);
  check("B blocked A: B reading A -> 404 as well (blocked person's profile hidden from the blocker)", (await read(A.username, "", B.id)).status === 404);
  await http("DELETE", `/api/blocks/${A.id}`, B.id);

  // ---- third parties, self and signed-out are not affected by someone else's block
  await block(A.id, B.id);
  check("third party C reads A and B normally", (await read(A.username, "", C.id)).status === 200 && (await read(B.username, "", C.id)).status === 200);
  check("A reads their own profile normally", (await read(A.username, "", A.id)).status === 200);
  check("signed-out viewer is not affected by a block", (await read(A.username, "", null)).status === 200);
  await unblockRows(A.id, B.id);

  // ---- deleted users behave as before: a block row changes nothing about how a deleted account reads, and nothing 500s
  const D = await mk("d");
  await storage.softDeleteUser(D.id);
  const dOpen = await read(D.id, "", B.id);
  await block(B.id, D.id);
  const dBlocked = await read(D.id, "", B.id);
  check("deleted user: reads without a 500, blocked or not", dOpen.status < 500 && dBlocked.status < 500, JSON.stringify([dOpen.status, dBlocked.status]));
  check("deleted user: a blocked read is 404 like a missing user, never a 200 that ignores the block", dBlocked.status === 404 && JSON.stringify(dBlocked.json) === missing[""].body, JSON.stringify([dOpen.status, dBlocked.status, dBlocked.json]));

  // ---- the peek never receives birthdate, email or phone
  const peek = await read(A.id, "", B.id);
  const flat = JSON.stringify(peek.json);
  check("peek: no dateOfBirth, email, phone or password material",
    peek.status === 200 && !("dateOfBirth" in peek.json) && !("email" in peek.json) && !("phoneNumber" in peek.json) && !/passwordHash|resetToken|verificationToken|07000000001/.test(flat), flat.slice(0, 300));
  const full = await read(A.id, "/profile", B.id);
  check("profile page data: no dateOfBirth, email or phone either", full.status === 200 && !JSON.stringify(full.json).includes("dateOfBirth") && !("email" in (full.json?.user ?? {})) && !JSON.stringify(full.json).includes("07000000001"), JSON.stringify(full.json).slice(0, 300));

  // ---- room "View profile" flag: the server says false when either side has blocked the other
  const room = await rs.createRoom(A.id, { title: "pf room", kind: "party", visibility: "public", ageLimit: "all" } as any);
  await rs.setStatus(room.id, "live");
  for (const u of [A, B, C]) roomHub.join(room.id, { userId: u.id, role: u.id === A.id ? "host" : "guest", muted: false, joinedAt: Date.now(), send: () => {} });
  const act = (viewer: string, target: string) => http("GET", `/api/rooms/${room.id}/members/${target}/actions`, viewer);
  check("actions: unblocked pair gets profile:true", (await act(B.id, A.id)).json?.actions?.profile === true);
  check("actions: yourself gets profile:true", (await act(B.id, B.id)).json?.actions?.profile === true);
  // Oracle check: people who are NOT in the room (blocked with B or not) look exactly like a missing user.
  const E = await mk("e");
  const probeBlocked = await act(B.id, D.id), probeMissing = await act(B.id, GHOST_ID), probeFree = await act(B.id, E.id);
  await block(B.id, E.id);
  const probeBlocked2 = await act(B.id, E.id);
  check("actions: blocked pair outside the room == missing user (same body)", JSON.stringify(probeBlocked.json) === JSON.stringify(probeMissing.json) && JSON.stringify(probeBlocked2.json) === JSON.stringify(probeMissing.json) && JSON.stringify(probeFree.json) === JSON.stringify(probeMissing.json), JSON.stringify([probeBlocked.json, probeBlocked2.json, probeMissing.json, probeFree.json]));
  await unblockRows(B.id, E.id);
  // A hosts the room, so B and C are guests. C blocks B (a guest-to-guest block; the room itself stays visible to both).
  await block(C.id, B.id);
  const blockedView = await act(B.id, C.id);
  const blockerView = await act(C.id, B.id);
  check("actions: target blocked the viewer -> profile:false", blockedView.status === 200 && blockedView.json?.actions?.profile === false, JSON.stringify(blockedView));
  check("actions: viewer blocked the target -> profile:false", blockerView.status === 200 && blockerView.json?.actions?.profile === false, JSON.stringify(blockerView));
  check("actions: a blocked pair also gets no interact, dm or invite", ["interact", "dm", "invite"].every((k) => blockedView.json?.actions?.[k] === false && blockerView.json?.actions?.[k] === false), JSON.stringify([blockedView.json, blockerView.json]));
  check("actions: the host A is unaffected by that block (profile:true for B and C)", (await act(A.id, B.id)).json?.actions?.profile === true && (await act(A.id, C.id)).json?.actions?.profile === true);
  check("actions: only booleans", Object.values(blockedView.json?.actions ?? {}).every((v) => typeof v === "boolean"));
  await unblockRows(C.id, B.id);
  // When the host blocked the viewer, the whole room is already hidden from them (existing rule): the actions call is a 404.
  await block(A.id, B.id);
  check("actions: host blocked the viewer -> the room itself is 404 for them (existing rule, no profile hint)", (await act(B.id, A.id)).status === 404);
  await unblockRows(A.id, B.id);
} catch (e: any) {
  failed++; console.log(`FAIL uncaught: ${e.stack || e}`);
} finally {
  server.close();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
