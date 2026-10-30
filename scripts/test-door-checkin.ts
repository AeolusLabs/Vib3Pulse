// Integration test for the door check-in work: staff PIN sign-in (+ lockout), 8-char short codes,
// structured validate results, the check-in log, stats, undo, and the wallet data additions.
//
//   DATABASE_URL=<throwaway db> BASE_URL=http://localhost:5058 npx tsx scripts/test-door-checkin.ts
//
// Start the server against the same throwaway database first. Refuses to run unless the database
// name contains "test", because it creates users, events and tickets.
import bcrypt from "bcrypt";
import crypto from "crypto";
import pg from "pg";

const dbUrl = process.env.DATABASE_URL ?? "";
const base = process.env.BASE_URL ?? "http://localhost:5058";
if (!/test/i.test(new URL(dbUrl).pathname)) {
  console.error("Refusing to run: DATABASE_URL must point at a throwaway database whose name contains 'test'.");
  process.exit(2);
}

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`);
};

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;
const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];

// ── HTTP clients: each has its own cookie jar + CSRF token (organiser, holder, anonymous staff) ──
let ipCounter = 0;
const freshIp = () => `10.20.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
class Client {
  jar = new Map<string, string>();
  csrf = "";
  token: string | undefined;
  private absorb(res: Response) {
    for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(";"); const i = kv.indexOf("="); this.jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  }
  private cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  async init() {
    const r = await fetch(base + "/api/csrf-token", { headers: { cookie: this.cookie() } });
    this.absorb(r); this.csrf = (await r.json()).csrfToken;
    return this;
  }
  async call(method: string, path: string, body?: unknown, ip = freshIp()) {
    const headers: Record<string, string> = { "content-type": "application/json", "x-csrf-token": this.csrf, cookie: this.cookie(), "x-forwarded-for": ip };
    if (this.token) headers["x-scanner-token"] = this.token;
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    this.absorb(res);
    let json: any = null; try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  }
  async login(username: string, password: string) {
    await this.init();
    const r = await this.call("POST", "/api/auth/login", { username, password });
    await this.init(); // login rotates the CSRF token
    return r;
  }
}

// ── fixtures ────────────────────────────────────────────────────────────────
const password = `Tp1!${globalThis.crypto.randomUUID().slice(0, 12)}`; // random per run
const hash = await bcrypt.hash(password, 10);
const tag = Date.now().toString(36);
const mkUser = async (username: string, displayName: string | null, type = "organizer") =>
  (await one(
    `insert into users (email, username, display_name, user_type, password_hash, is_verified, onboarding_complete, can_manage_venues)
     values ($1,$2,$3,$4,$5,true,true,true) returning id`,
    [`${username}@t.dev`, username, displayName, type, hash],
  )).id as string;
const orgName = `door_org_${tag}`, otherName = `door_other_${tag}`, holderName = `door_holder_${tag}`;
const orgId = await mkUser(orgName, "Olivia Organiser");
const otherOrgId = await mkUser(otherName, null);
const holderId = await mkUser(holderName, "Hannah Holder", "user");
const holder2Id = await mkUser(`door_h2_${tag}`, null, "user"); // no display name: falls back to username
const holder2Username = (await one(`select username from users where id=$1`, [holder2Id])).username as string;

const future = (days: number) => new Date(Date.now() + days * 864e5).toISOString();
const mkEvent = async (title: string, ownerId = orgId, capacity = 100) =>
  (await one(
    `insert into events (organizer_id,title,description,event_date,location,category,tickets_available)
     values ($1,$2,'d',$3,'Somewhere','Music',$4) returning id`, [ownerId, title, future(2), capacity])).id as string;
const E1 = await mkEvent(`Door Night ${tag}`);
const E2 = await mkEvent(`Other Night ${tag}`);
const E3 = await mkEvent(`Lockout Night ${tag}`);
const vipTier = (await one(
  `insert into ticket_tiers (event_id,name,price_smallest_unit,quantity) values ($1,'VIP',1000,50) returning id`, [E1])).id as string;

const T = {
  vip:      "a3f912bc-1111-4111-8111-111111111111",
  guest:    "b4c8d1e2-2222-4222-8222-222222222222",
  refunded: "c5d9e2f3-3333-4333-8333-333333333333",
  ambA:     "deadbeef-0000-4000-8000-000000000001",
  ambB:     "deadbeef-0000-4000-8000-000000000002",
  other:    "e6f0a3b4-4444-4444-8444-444444444444", // belongs to E2
  plain:    "f7a1b4c5-5555-4555-8555-555555555555",
};
const mkTicket = async (code: string, eventId: string, opts: { user?: string | null; tier?: string | null; status?: string; guestName?: string } = {}) =>
  (await one(
    `insert into tickets (user_id,event_id,ticket_tier_id,status,validation_code,guest_name,guest_token_hash)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [opts.user ?? null, eventId, opts.tier ?? null, opts.status ?? "confirmed", code, opts.guestName ?? null,
     opts.user ? null : crypto.randomUUID()])).id as string;
const tid = {
  vip: await mkTicket(T.vip, E1, { user: holderId, tier: vipTier }),
  guest: await mkTicket(T.guest, E1, { guestName: "Guest Gary" }),
  refunded: await mkTicket(T.refunded, E1, { user: holder2Id, status: "refunded" }),
  ambA: await mkTicket(T.ambA, E1, { user: holder2Id }),
  ambB: await mkTicket(T.ambB, E1, { user: holder2Id }),
  other: await mkTicket(T.other, E2, { user: holder2Id }),
  plain: await mkTicket(T.plain, E1, { user: holder2Id }),
};

// Venue night fixtures
const venueId = (await one(`insert into venues (owner_id,name,category,location) values ($1,'Door Venue','Club','Elsewhere') returning id`, [orgId])).id as string;
const mkNight = async (name: string, cap: number | null) =>
  (await one(`insert into venue_entry_nights (venue_id,name,date,cover_price_cents,capacity) values ($1,$2,$3,500,$4) returning id`, [venueId, name, future(2), cap])).id as string;
const N1 = await mkNight(`Friday ${tag}`, 80);
const N2 = await mkNight(`Saturday ${tag}`, null);
const V = {
  main:     "11aa22bb-1111-4111-8111-111111111111",
  other:    "22bb33cc-2222-4222-8222-222222222222", // belongs to N2
  refunded: "33cc44dd-3333-4333-8333-333333333333",
  ambA:     "99aabbcc-0000-4000-8000-000000000001",
  ambB:     "99aabbcc-0000-4000-8000-000000000002",
};
const mkVT = async (code: string, night: string, status = "confirmed") =>
  (await one(`insert into venue_tickets (user_id,venue_entry_night_id,status,validation_code) values ($1,$2,$3,$4) returning id`, [holderId, night, status, code])).id as string;
const vtid = {
  main: await mkVT(V.main, N1), other: await mkVT(V.other, N2), refunded: await mkVT(V.refunded, N1, "refunded"),
  ambA: await mkVT(V.ambA, N1), ambB: await mkVT(V.ambB, N1),
};

// ── sessions ────────────────────────────────────────────────────────────────
const org = new Client(); const other = new Client(); const holder = new Client(); const anon = await new Client().init();
check("login organiser", (await org.login(orgName, password)).status === 200);
check("login other organiser", (await other.login(otherName, password)).status === 200);
check("login ticket holder", (await holder.login(holderName, password)).status === 200);

// ═════════════════════════════ 1. Staff codes + PIN sign-in (events) ═════════════════════════════
const mkCode = async (c: Client, evId: string) => (await c.call("POST", `/api/events/${evId}/staff-codes`, {})).json;
const c1 = await mkCode(org, E1);
check("create staff code returns a 6-digit pin", /^\d{6}$/.test(c1?.pin ?? ""), JSON.stringify(c1));
check("create staff code still returns the 64-char code", /^[0-9a-f]{64}$/.test(c1?.code ?? ""));
const listed = await org.call("GET", `/api/events/${E1}/staff-codes`);
check("organiser list includes pin and code", listed.status === 200 && listed.json.some((r: any) => r.id === c1.id && r.pin === c1.pin && r.code === c1.code));
check("non-owner cannot list staff codes", (await other.call("GET", `/api/events/${E1}/staff-codes`)).status === 403);
check("anonymous cannot list staff codes", (await anon.call("GET", `/api/events/${E1}/staff-codes`)).status === 401);
check("non-owner cannot create staff codes", (await other.call("POST", `/api/events/${E1}/staff-codes`, {})).status === 403);

const knownPins = new Set((await q(`select pin from event_staff_access_codes where pin is not null`)).map((r: any) => r.pin));
let wrongPin = "000000"; while (knownPins.has(wrongPin)) wrongPin = String(Math.floor(Math.random() * 1e6)).padStart(6, "0");

const wrong = await anon.call("POST", `/api/events/${E1}/staff-access/validate`, { pin: wrongPin, staffName: "Sam" });
check("wrong PIN: 404 reason invalid + friendly message", wrong.status === 404 && wrong.json.reason === "invalid" && /PIN/.test(wrong.json.message), JSON.stringify(wrong));
check("wrong PIN reports attemptsLeft", typeof wrong.json.attemptsLeft === "number");

const login1 = await anon.call("POST", `/api/events/${E1}/staff-access/validate`, { pin: c1.pin, staffName: "Door Dave" });
check("PIN sign-in succeeds", login1.status === 200 && /^[0-9a-f]{64}$/.test(login1.json.scannerToken ?? ""), JSON.stringify(login1));
check("PIN sign-in returns event + staff name", login1.json.eventId === E1 && login1.json.staffName === "Door Dave" && login1.json.eventTitle.startsWith("Door Night"));
const redeemBody = JSON.stringify(login1.json);
check("redeem response does not leak pin or long code", !redeemBody.includes(c1.pin) && !redeemBody.includes(c1.code));
const S1 = new Client(); await S1.init(); S1.token = login1.json.scannerToken;
const verify = await S1.call("GET", "/api/scanner/verify");
check("scanner token from PIN sign-in verifies", verify.status === 200 && verify.json.valid === true && verify.json.type === "event");
check("verify response does not leak pin or code", !JSON.stringify(verify.json).includes(c1.pin) && !JSON.stringify(verify.json).includes(c1.code));

const again = await anon.call("POST", `/api/events/${E1}/staff-access/validate`, { pin: c1.pin, staffName: "Someone Else" });
check("reusing a signed-in PIN: 409 reason in_use", again.status === 409 && again.json.reason === "in_use" && /another device/.test(again.json.message), JSON.stringify(again));
const againCode = await anon.call("POST", `/api/events/${E1}/staff-access/validate`, { code: c1.code, staffName: "Someone Else" });
check("reusing a signed-in long code: 409 reason in_use", againCode.status === 409 && againCode.json.reason === "in_use");

const cRev = await mkCode(org, E1);
await org.call("DELETE", `/api/events/${E1}/staff-codes/${cRev.id}`);
const rev = await anon.call("POST", `/api/events/${E1}/staff-access/validate`, { pin: cRev.pin, staffName: "Sam" });
check("revoked PIN: 403 reason revoked", rev.status === 403 && rev.json.reason === "revoked" && /revoked/.test(rev.json.message), JSON.stringify(rev));

const cExp = await mkCode(org, E1);
await q(`update event_staff_access_codes set expires_at = now() - interval '1 minute' where id=$1`, [cExp.id]);
const exp = await anon.call("POST", `/api/events/${E1}/staff-access/validate`, { pin: cExp.pin, staffName: "Sam" });
check("expired PIN: 410 reason expired", exp.status === 410 && exp.json.reason === "expired" && /expired/.test(exp.json.message), JSON.stringify(exp));

const cLong = await mkCode(org, E1);
const viaLong = await anon.call("POST", `/api/events/${E1}/staff-access/validate`, { code: cLong.code, staffName: "Long Lena" });
check("64-char code sign-in still works on the event route", viaLong.status === 200 && viaLong.json.staffName === "Long Lena", JSON.stringify(viaLong));
const cAuth = await mkCode(org, E1);
const viaAuth = await anon.call("POST", "/api/scanner/auth", { code: cAuth.code, staffName: "Auth Amy" });
check("/api/scanner/auth still works with the 64-char code", viaAuth.status === 200 && viaAuth.json.eventId === E1, JSON.stringify(viaAuth));
const authPin = await anon.call("POST", "/api/scanner/auth", { pin: cAuth.pin, staffName: "Auth Amy" });
check("/api/scanner/auth rejects a PIN (long code only)", authPin.status === 400);
const authBad = await anon.call("POST", "/api/scanner/auth", { code: "f".repeat(64), staffName: "Auth Amy" });
check("/api/scanner/auth unknown code: 404 reason invalid", authBad.status === 404 && authBad.json.reason === "invalid");

const cCross = await mkCode(org, E1);
const crossPin = await anon.call("POST", `/api/events/${E2}/staff-access/validate`, { pin: cCross.pin, staffName: "Sam" });
check("event-scoped PIN cannot be used on another event", crossPin.status === 404 && crossPin.json.reason === "invalid", JSON.stringify(crossPin));
const crossCode = await anon.call("POST", `/api/events/${E2}/staff-access/validate`, { code: cCross.code, staffName: "Sam" });
check("event-scoped long code cannot be used on another event", crossCode.status === 404 && crossCode.json.reason === "invalid");
check("cross-event attempts did not consume the code", (await one(`select status from event_staff_access_codes where id=$1`, [cCross.id])).status === "pending");

check("both code and pin: 400", (await anon.call("POST", `/api/events/${E1}/staff-access/validate`, { code: cCross.code, pin: cCross.pin, staffName: "Sam" })).status === 400);
check("neither code nor pin: 400", (await anon.call("POST", `/api/events/${E1}/staff-access/validate`, { staffName: "Sam" })).status === 400);
check("5-digit PIN: 400", (await anon.call("POST", `/api/events/${E1}/staff-access/validate`, { pin: "12345", staffName: "Sam" })).status === 400);
check("unknown event: 404", (await anon.call("POST", `/api/events/nope-${tag}/staff-access/validate`, { pin: "123456", staffName: "Sam" })).status === 404);

const pinsOnEvent = await q(`select pin from event_staff_access_codes where event_id=$1`, [E1]);
check("PINs are unique per event", new Set(pinsOnEvent.map((r: any) => r.pin)).size === pinsOnEvent.length);
let dupBlocked = false;
try { await q(`insert into event_staff_access_codes (event_id,organizer_id,code,expires_at,pin) values ($1,$2,$3,now()+interval '1 day',$4)`, [E1, orgId, "z".repeat(64), c1.pin]); }
catch (e: any) { dupBlocked = e.code === "23505"; }
check("unique index rejects a duplicate (event, pin)", dupBlocked);

// Lockout: 10 wrong PINs (each from a different IP) lock PIN sign-in for the event across all IPs.
const cLock = await mkCode(org, E3);
const lockPins = new Set((await q(`select pin from event_staff_access_codes where event_id=$1`, [E3])).map((r: any) => r.pin));
let lastAttempt: any = null;
for (let i = 0; i < 10; i++) {
  let p = String(Math.floor(Math.random() * 1e6)).padStart(6, "0"); while (lockPins.has(p)) p = String((Number(p) + 1) % 1e6).padStart(6, "0");
  lastAttempt = await anon.call("POST", `/api/events/${E3}/staff-access/validate`, { pin: p, staffName: "Sam" });
}
check("10th wrong PIN still answers invalid with attemptsLeft 0", lastAttempt.status === 404 && lastAttempt.json.attemptsLeft === 0, JSON.stringify(lastAttempt));
const locked = await anon.call("POST", `/api/events/${E3}/staff-access/validate`, { pin: cLock.pin, staffName: "Sam" });
check("after 10 wrong PINs even the CORRECT PIN is refused: 429 reason locked", locked.status === 429 && locked.json.reason === "locked" && locked.json.retryAfterSeconds > 0, JSON.stringify(locked));
const lockedWrong = await anon.call("POST", `/api/events/${E3}/staff-access/validate`, { pin: "111111", staffName: "Sam" });
check("locked: a different IP is locked too", lockedWrong.status === 429 && lockedWrong.json.reason === "locked");
const lockOk = await anon.call("POST", `/api/events/${E3}/staff-access/validate`, { code: cLock.code, staffName: "Link Larry" });
check("locked: the long-code link still signs in", lockOk.status === 200, JSON.stringify(lockOk));
const otherEventFree = await anon.call("POST", `/api/events/${E1}/staff-access/validate`, { pin: wrongPin, staffName: "Sam" });
check("lockout is per event: another event still answers normally", otherEventFree.status === 404 && otherEventFree.json.reason === "invalid");

// ═════════════════════════════ 2. Validate: short codes + structured results (events) ═════════════════════════════
const validate = (c: Client, body: object) => c.call("POST", "/api/tickets/validate", { eventId: E1, ...body });
const sc = await validate(S1, { shortCode: "a3f9-12BC" });
check("short code (mixed case, dash) admits: 200 valid", sc.status === 200 && sc.json.valid === true && sc.json.alreadyCheckedIn === false, JSON.stringify(sc));
check("valid: ticketInfo has holder, tier, checkedInAt, staff name",
  sc.json.ticketInfo?.id === tid.vip && sc.json.ticketInfo.holderName === "Hannah Holder" && sc.json.ticketInfo.tierName === "VIP" &&
  !!sc.json.ticketInfo.checkedInAt && sc.json.ticketInfo.checkedInByName === "Door Dave", JSON.stringify(sc.json.ticketInfo));
check("valid: legacy fields kept (message, ticket.user)", sc.json.message === "Ticket validated successfully" && sc.json.ticket?.user?.username === holderName);
const scBody = JSON.stringify(sc.json);
check("valid: no credential or guest-token fields in the body", !/passwordHash|password_hash|guestTokenHash|resetToken/i.test(scBody));
const dup = await validate(S1, { validationCode: T.vip });
check("second scan by full code: 200 reason already_used", dup.status === 200 && dup.json.valid === false && dup.json.alreadyCheckedIn === true && dup.json.reason === "already_used", JSON.stringify(dup));
check("already_used: ticketInfo names who checked in and when", dup.json.ticketInfo?.checkedInByName === "Door Dave" && !!dup.json.ticketInfo?.checkedInAt && dup.json.checkedInAt);
const dupShort = await validate(S1, { shortCode: "A3F912BC" });
check("second scan by short code: already_used", dupShort.json.reason === "already_used");

const spaced = await validate(S1, { shortCode: "b4c8 d1e2" });
check("short code with a space resolves (guest ticket, holderName = guestName)", spaced.json.valid === true && spaced.json.ticketInfo.holderName === "Guest Gary" && spaced.json.ticketInfo.tierName === null, JSON.stringify(spaced.json));
check("incomplete short code: 400", (await validate(S1, { shortCode: "a3f9" })).status === 400);
check("neither code nor shortCode: 400", (await validate(S1, {})).status === 400);
check("both codes: 400", (await validate(S1, { shortCode: "a3f912bc", validationCode: T.vip })).status === 400);
const amb = await validate(S1, { shortCode: "DEAD-BEEF" });
check("ambiguous prefix: 409 reason ambiguous (valid false)", amb.status === 409 && amb.json.reason === "ambiguous" && amb.json.valid === false && /full code/.test(amb.json.message), JSON.stringify(amb));
check("ambiguous: neither ticket was admitted", (await q(`select id from tickets where id in ($1,$2) and checked_in_at is not null`, [tid.ambA, tid.ambB])).length === 0);
const amb2 = await validate(S1, { validationCode: T.ambA });
check("ambiguous tickets still admit by full code", amb2.json.valid === true);

const nf = await validate(S1, { validationCode: crypto.randomUUID() });
check("unknown full code: 200 reason not_found", nf.status === 200 && nf.json.valid === false && nf.json.reason === "not_found", JSON.stringify(nf));
const nfShort = await validate(S1, { shortCode: "01234567" });
check("unknown short code: 200 reason not_found", nfShort.status === 200 && nfShort.json.reason === "not_found");
const wrongEv = await validate(S1, { validationCode: T.other });
check("ticket for another event: 200 reason wrong_event with label + date",
  wrongEv.status === 200 && wrongEv.json.valid === false && wrongEv.json.reason === "wrong_event" &&
  wrongEv.json.ticketLabel.startsWith("Other Night") && !!wrongEv.json.ticketDate, JSON.stringify(wrongEv));
check("wrong_event did not admit", (await one(`select checked_in_at from tickets where id=$1`, [tid.other])).checked_in_at === null);
const wrongEvShort = await validate(S1, { shortCode: "e6f0a3b4" });
check("short code of another event's ticket is not_found (lookup is scoped)", wrongEvShort.json.reason === "not_found");
const ref = await validate(S1, { validationCode: T.refunded });
check("refunded ticket: 200 reason not_confirmed", ref.status === 200 && ref.json.valid === false && ref.json.reason === "not_confirmed" && /refunded/.test(ref.json.message), JSON.stringify(ref));

check("anonymous validate: 401", (await validate(anon, { validationCode: T.plain })).status === 401);
const otherScan = await validate(other, { validationCode: T.plain });
check("non-owner organiser validate: 403", otherScan.status === 403);
const wrongTokenScope = await S1.call("POST", "/api/tickets/validate", { eventId: E2, validationCode: T.other });
check("staff token for E1 cannot scan E2: 403", wrongTokenScope.status === 403);
check("bad scanner token: 401", (await (async () => { const b = new Client(); await b.init(); b.token = "x".repeat(64); return validate(b, { validationCode: T.plain }); })()).status === 401);

const orgScan = await validate(org, { shortCode: T.plain.slice(0, 8) });
check("organiser session admits by short code; checkedInByName = organiser display name",
  orgScan.json.valid === true && orgScan.json.ticketInfo.checkedInByName === "Olivia Organiser", JSON.stringify(orgScan.json.ticketInfo));
const orgDup = await validate(org, { validationCode: T.plain });
check("organiser already_used shows their own name", orgDup.json.reason === "already_used" && orgDup.json.ticketInfo.checkedInByName === "Olivia Organiser");
check("no-display-name holder falls back to username", orgScan.json.ticketInfo.holderName === holder2Username);

// ═════════════════════════════ 3. Stats + log (events) ═════════════════════════════
const dbCounts = await one(`select count(*) filter (where checked_in_at is not null)::int as admitted, count(*)::int as total from tickets where event_id=$1 and status='confirmed'`, [E1]);
const stats = await S1.call("GET", "/api/scanner/stats");
const s1Row = await one(`select scan_count from event_staff_access_codes where id=$1`, [c1.id]);
check("stats: type, admitted, total, capacity, mine",
  stats.status === 200 && stats.json.type === "event" && stats.json.admitted === dbCounts.admitted && stats.json.total === dbCounts.total &&
  stats.json.capacity === 100 && stats.json.mine === s1Row.scan_count, JSON.stringify({ stats, dbCounts, s1Row }));
check("stats: total counts confirmed tickets only (refunded excluded)", stats.json.total === 5, `total=${stats.json.total}`);
check("stats: staff mine counts only this code's admits (vip, guest, ambA = 3)", stats.json.mine === 3, `mine=${stats.json.mine}`);
check("stats: no token -> 401", (await anon.call("GET", "/api/scanner/stats")).status === 401);
const logResp = await S1.call("GET", "/api/scanner/log");
check("scanner log: 200 array newest-first", logResp.status === 200 && Array.isArray(logResp.json) &&
  logResp.json.every((r: any, i: number, a: any[]) => i === 0 || new Date(a[i - 1].createdAt) >= new Date(r.createdAt)));
check("scanner log: newest entry is the organiser's admit of the plain ticket",
  logResp.json[0]?.ticketId === tid.plain && logResp.json[0].action === "admit" && logResp.json[0].actorName === "Olivia Organiser" && logResp.json[0].holderName === holder2Username);
const vipRow = logResp.json.find((r: any) => r.ticketId === tid.vip);
check("scanner log: vip row has holder, tier, staff name", vipRow?.holderName === "Hannah Holder" && vipRow.tierName === "VIP" && vipRow.actorName === "Door Dave" && !!vipRow.id && !!vipRow.createdAt);
check("scanner log: 4 admits so far (vip, guest, ambA, plain), nothing for refused scans", logResp.json.length === 4, `len=${logResp.json.length}`);
check("scanner log: limit honoured", (await S1.call("GET", "/api/scanner/log?limit=2")).json.length === 2);
check("scanner log: limit 0 and 101 rejected", (await S1.call("GET", "/api/scanner/log?limit=0")).status === 400 && (await S1.call("GET", "/api/scanner/log?limit=101")).status === 400);
check("scanner log: no token -> 401", (await anon.call("GET", "/api/scanner/log")).status === 401);
const logBody = JSON.stringify(logResp.json);
check("scanner log does not expose pins or codes", !logBody.includes(c1.pin) && !logBody.includes(c1.code) && !/staffCodeId/.test(logBody));
const orgLog = await org.call("GET", `/api/events/${E1}/check-in-log`);
check("organiser log: same entries as the scanner log", orgLog.status === 200 && JSON.stringify(orgLog.json) === JSON.stringify(logResp.json));
check("organiser log: non-owner 403, anonymous 401", (await other.call("GET", `/api/events/${E1}/check-in-log`)).status === 403 && (await anon.call("GET", `/api/events/${E1}/check-in-log`)).status === 401);
const staffLogOther = new Client(); await staffLogOther.init(); staffLogOther.token = viaLong.json.scannerToken;
check("a second staff device sees the same log", JSON.stringify((await staffLogOther.call("GET", "/api/scanner/log")).json) === JSON.stringify(logResp.json));

// ═════════════════════════════ 4. Undo (events) ═════════════════════════════
const undoPath = "/api/tickets/undo-check-in";
const uOrg = await org.call("POST", undoPath, { ticketId: tid.plain, eventId: E1 });
check("organiser undo: success", uOrg.status === 200 && uOrg.json.success === true, JSON.stringify(uOrg));
const plainRow = await one(`select checked_in_at, checked_in_by from tickets where id=$1`, [tid.plain]);
check("undo clears checked_in_at and checked_in_by", plainRow.checked_in_at === null && plainRow.checked_in_by === null);
const undoLog = (await org.call("GET", `/api/events/${E1}/check-in-log`)).json;
check("undo wrote a log row, newest first", undoLog[0].action === "undo" && undoLog[0].ticketId === tid.plain && undoLog[0].actorName === "Olivia Organiser");
const uAgain = await org.call("POST", undoPath, { ticketId: tid.plain, eventId: E1 });
check("undo of a not-checked-in ticket: 409 reason not_checked_in", uAgain.status === 409 && uAgain.json.reason === "not_checked_in");
check("undo by non-owner organiser: 403", (await other.call("POST", undoPath, { ticketId: tid.vip, eventId: E1 })).status === 403);
check("undo anonymous: 401", (await anon.call("POST", undoPath, { ticketId: tid.vip, eventId: E1 })).status === 401);
check("undo with bad body: 400", (await org.call("POST", undoPath, { eventId: E1 })).status === 400);
check("undo of a ticket from another event: 404", (await org.call("POST", undoPath, { ticketId: tid.other, eventId: E1 })).status === 404);
check("staff token cannot undo for another event: 403", (await S1.call("POST", undoPath, { ticketId: tid.other, eventId: E2 })).status === 403);

const before = (await one(`select scan_count from event_staff_access_codes where id=$1`, [c1.id])).scan_count;
const uStaff = await S1.call("POST", undoPath, { ticketId: tid.vip, eventId: E1 });
check("staff undo within the window: success", uStaff.status === 200 && uStaff.json.success === true, JSON.stringify(uStaff));
const after = (await one(`select scan_count from event_staff_access_codes where id=$1`, [c1.id])).scan_count;
check("staff undo gives the scan back to the admitting staff code", after === before - 1, `${before} -> ${after}`);
check("staff undo logged as staff with their name", (await S1.call("GET", "/api/scanner/log?limit=1")).json[0].actorName === "Door Dave");
check("stats reflect the undo", (await S1.call("GET", "/api/scanner/stats")).json.admitted === dbCounts.admitted - 2);
const readmit = await validate(S1, { validationCode: T.vip });
check("an undone ticket can be admitted again", readmit.json.valid === true);
await q(`update tickets set checked_in_at = now() - interval '11 minutes' where id=$1`, [tid.vip]);
const uLate = await S1.call("POST", undoPath, { ticketId: tid.vip, eventId: E1 });
check("staff undo after 10 minutes: 403 reason window_expired", uLate.status === 403 && uLate.json.reason === "window_expired", JSON.stringify(uLate));
check("late staff undo left the ticket checked in", (await one(`select checked_in_at from tickets where id=$1`, [tid.vip])).checked_in_at !== null);
await q(`update event_staff_access_codes set scan_count = 0 where id=$1`, [c1.id]);
const uOrgLate = await org.call("POST", undoPath, { ticketId: tid.vip, eventId: E1 });
check("organiser can undo an old check-in", uOrgLate.status === 200);
check("scan count never drops below 0", (await one(`select scan_count from event_staff_access_codes where id=$1`, [c1.id])).scan_count === 0);

// ═════════════════════════════ 5. Wallet data ═════════════════════════════
const wallet = await holder.call("GET", "/api/tickets");
const wVip = wallet.json?.find?.((t: any) => t.id === tid.vip);
check("GET /api/tickets: tier {id,name} on a tiered ticket", wallet.status === 200 && wVip?.tier?.id === vipTier && wVip.tier.name === "VIP", JSON.stringify(wVip?.tier));
check("GET /api/tickets: still carries event and validationCode", !!wVip?.event?.title && wVip.validationCode === T.vip);
const holder2 = new Client(); await holder2.login(holder2Username, password);
const wPlain = (await holder2.call("GET", "/api/tickets")).json.find((t: any) => t.id === tid.plain);
check("GET /api/tickets: tier is null for a tierless ticket", wPlain && wPlain.tier === null);

// ═════════════════════════════ 6. Venue-night equivalents ═════════════════════════════
const vc = (await org.call("POST", `/api/venue-events/${N1}/staff-codes`, {})).json;
check("venue: staff code has pin + code, shown to the owner list",
  /^\d{6}$/.test(vc?.pin ?? "") && /^[0-9a-f]{64}$/.test(vc?.code ?? "") &&
  (await org.call("GET", `/api/venue-events/${N1}/staff-codes`)).json.some((r: any) => r.pin === vc.pin));
check("venue: non-owner cannot list codes", (await other.call("GET", `/api/venue-events/${N1}/staff-codes`)).status === 403);
const vWrong = await anon.call("POST", `/api/venue-events/${N1}/staff-access/validate`, { pin: wrongPin, staffName: "Sam" });
check("venue: wrong PIN 404 reason invalid", vWrong.status === 404 && vWrong.json.reason === "invalid");
const vCross = await anon.call("POST", `/api/venue-events/${N2}/staff-access/validate`, { pin: vc.pin, staffName: "Sam" });
check("venue: PIN scoped to its night", vCross.status === 404 && vCross.json.reason === "invalid");
const vLogin = await anon.call("POST", `/api/venue-events/${N1}/staff-access/validate`, { pin: vc.pin, staffName: "Venue Vic" });
check("venue: PIN sign-in succeeds", vLogin.status === 200 && vLogin.json.eventId === N1 && vLogin.json.staffName === "Venue Vic", JSON.stringify(vLogin));
check("venue: reuse -> 409 in_use", (await anon.call("POST", `/api/venue-events/${N1}/staff-access/validate`, { pin: vc.pin, staffName: "x" })).json.reason === "in_use");
const vRev = (await org.call("POST", `/api/venue-events/${N1}/staff-codes`, {})).json;
await org.call("DELETE", `/api/venue-events/${N1}/staff-codes/${vRev.id}`);
check("venue: revoked -> 403 revoked", (await anon.call("POST", `/api/venue-events/${N1}/staff-access/validate`, { pin: vRev.pin, staffName: "x" })).json.reason === "revoked");
const vExp = (await org.call("POST", `/api/venue-events/${N1}/staff-codes`, {})).json;
await q(`update venue_staff_access_codes set expires_at = now() - interval '1 minute' where id=$1`, [vExp.id]);
check("venue: expired -> 410 expired", (await anon.call("POST", `/api/venue-events/${N1}/staff-access/validate`, { pin: vExp.pin, staffName: "x" })).json.reason === "expired");
const vLong = (await org.call("POST", `/api/venue-events/${N1}/staff-codes`, {})).json;
check("venue: 64-char code still signs in", (await anon.call("POST", `/api/venue-events/${N1}/staff-access/validate`, { code: vLong.code, staffName: "Long Lou" })).status === 200);
// venue lockout
const vLockCode = (await org.call("POST", `/api/venue-events/${N2}/staff-codes`, {})).json;
let vLast: any;
for (let i = 0; i < 10; i++) {
  const p = String(900000 + i) === vLockCode.pin ? "800000" : String(900000 + i);
  vLast = await anon.call("POST", `/api/venue-events/${N2}/staff-access/validate`, { pin: p, staffName: "x" });
}
const vLocked = await anon.call("POST", `/api/venue-events/${N2}/staff-access/validate`, { pin: vLockCode.pin, staffName: "x" });
check("venue: lockout after 10 wrong PINs", vLocked.status === 429 && vLocked.json.reason === "locked", JSON.stringify({ vLast: vLast.status, vLocked }));

const VS = new Client(); await VS.init(); VS.token = vLogin.json.scannerToken;
const vValidate = (c: Client, body: object) => c.call("POST", "/api/venue-tickets/validate", { eventId: N1, ...body });
const vAdmit = await vValidate(VS, { shortCode: "11AA-22BB" });
check("venue: short code admits with ticketInfo (tierName null, staff name)",
  vAdmit.status === 200 && vAdmit.json.valid === true && vAdmit.json.ticketInfo.holderName === "Hannah Holder" &&
  vAdmit.json.ticketInfo.tierName === null && vAdmit.json.ticketInfo.checkedInByName === "Venue Vic", JSON.stringify(vAdmit.json));
check("venue: no credential fields in validate body", !/passwordHash|password_hash|resetToken/i.test(JSON.stringify(vAdmit.json)));
check("venue: ticket flips to checked_in", (await one(`select status from venue_tickets where id=$1`, [vtid.main])).status === "checked_in");
const vDup = await vValidate(VS, { validationCode: V.main });
check("venue: already_used with ticketInfo", vDup.status === 200 && vDup.json.reason === "already_used" && vDup.json.ticketInfo.checkedInByName === "Venue Vic");
const vAmb = await vValidate(VS, { shortCode: "99aabbcc" });
check("venue: ambiguous -> 409", vAmb.status === 409 && vAmb.json.reason === "ambiguous");
const vWrongNight = await vValidate(VS, { validationCode: V.other });
check("venue: other night's ticket -> wrong_event with label + date",
  vWrongNight.status === 200 && vWrongNight.json.reason === "wrong_event" && vWrongNight.json.ticketLabel.startsWith("Saturday") && !!vWrongNight.json.ticketDate);
check("venue: unknown -> not_found", (await vValidate(VS, { validationCode: crypto.randomUUID() })).json.reason === "not_found");
check("venue: refunded -> not_confirmed", (await vValidate(VS, { validationCode: V.refunded })).json.reason === "not_confirmed");
check("venue: staff token for N1 cannot scan N2: 403", (await VS.call("POST", "/api/venue-tickets/validate", { eventId: N2, validationCode: V.other })).status === 403);
check("venue: anonymous -> 401, non-owner -> 403", (await vValidate(anon, { validationCode: V.main })).status === 401 && (await vValidate(other, { validationCode: V.main })).status === 403);
const vOrgScan = await vValidate(org, { validationCode: V.ambA });
check("venue: organiser admit, checkedInByName = display name", vOrgScan.json.valid === true && vOrgScan.json.ticketInfo.checkedInByName === "Olivia Organiser");

const vStats = await VS.call("GET", "/api/scanner/stats");
check("venue stats: type venue-event, admitted 2, total 3 (refunded excluded), capacity 80, mine 1",
  vStats.status === 200 && vStats.json.type === "venue-event" && vStats.json.admitted === 2 && vStats.json.total === 3 &&
  vStats.json.capacity === 80 && vStats.json.mine === 1, JSON.stringify(vStats));
const vLog = await VS.call("GET", "/api/scanner/log");
check("venue log: newest first, 2 admits", vLog.json.length === 2 && vLog.json[0].ticketId === vtid.ambA && vLog.json[1].actorName === "Venue Vic");
check("venue organiser log matches; non-owner 403",
  JSON.stringify((await org.call("GET", `/api/venue-events/${N1}/check-in-log`)).json) === JSON.stringify(vLog.json) &&
  (await other.call("GET", `/api/venue-events/${N1}/check-in-log`)).status === 403);

const vUndoPath = "/api/venue-tickets/undo-check-in";
const vUndo = await VS.call("POST", vUndoPath, { ticketId: vtid.main, eventId: N1 });
check("venue: staff undo within window", vUndo.status === 200 && vUndo.json.success === true);
const vRow = await one(`select status, checked_in_at from venue_tickets where id=$1`, [vtid.main]);
check("venue: undo restores status confirmed and clears check-in", vRow.status === "confirmed" && vRow.checked_in_at === null);
check("venue: undo returned the staff scan", (await VS.call("GET", "/api/scanner/stats")).json.mine === 0);
check("venue: undo again -> 409 not_checked_in", (await VS.call("POST", vUndoPath, { ticketId: vtid.main, eventId: N1 })).json.reason === "not_checked_in");
await q(`update venue_tickets set checked_in_at = now() - interval '11 minutes' where id=$1`, [vtid.ambA]);
check("venue: staff undo after 10 minutes refused", (await VS.call("POST", vUndoPath, { ticketId: vtid.ambA, eventId: N1 })).json.reason === "window_expired");
check("venue: organiser undo of an old check-in works", (await org.call("POST", vUndoPath, { ticketId: vtid.ambA, eventId: N1 })).status === 200);
check("venue: undo for a ticket of another night -> 404", (await org.call("POST", vUndoPath, { ticketId: vtid.other, eventId: N1 })).status === 404);

const vWallet = await holder.call("GET", "/api/my-venue-tickets");
const vw = vWallet.json?.find?.((t: any) => t.id === vtid.main);
check("GET /api/my-venue-tickets: validationCode, status, checkedInAt, entryNight, venue present",
  vWallet.status === 200 && vw?.validationCode === V.main && vw.status === "confirmed" && "checkedInAt" in vw && vw.entryNight?.id === N1 && vw.venue?.id === venueId);

await db.end();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
