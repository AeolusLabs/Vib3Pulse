// End-to-end check of social events (Phase 2: private events, creation + RSVP).
// Mounts the REAL routes, REAL storage and the REAL global redaction middleware on a
// throwaway express app; only authentication is faked (x-test-user header).
//
//   DATABASE_URL=<scratch db> npx tsx scripts/test-social-events-phase2.ts
//
// Refuses to run unless the database name contains "test" - never point it at prod.
import express from "express";
import crypto from "crypto";
import pg from "pg";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run against database "${dbName}" (name must contain "test")`);
  process.exit(1);
}

const { storage } = await import("../server/storage");
const { redactSensitiveFields } = await import("../server/security");
const { registerSocialEventGate, registerSocialEventRoutes } = await import("../server/routes/social-events-routes");
const { registerEventsRoutes } = await import("../server/routes/events-routes");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;

// ---- fixtures -------------------------------------------------------------
const tag = crypto.randomBytes(3).toString("hex");
async function mkUser(name: string, verified: boolean) {
  const [u] = await q(
    `insert into users (email, username, user_type, is_verified, display_name) values ($1,$2,'social',$3,$4) returning id`,
    [`${name}-${tag}@test.local`, `${name}_${tag}`, verified, name],
  );
  return u.id as string;
}
const host = await mkUser("host", true);
const unverified = await mkUser("unverified", false);
const otherHost = await mkUser("otherhost", true);
const member = await mkUser("member", true);

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  const id = req.header("x-test-user");
  req.user = id ? { id, username: id, email: "", userType: "social" } : undefined;
  req.isAuthenticated = () => !!id;
  next();
});
app.use("/api", redactSensitiveFields);
// A deliberately careless endpoint: returns the raw events row. The global redaction
// middleware is the safety net under test.
app.get("/api/__raw/:id", async (req, res) => res.json(await storage.getEvent(req.params.id)));
registerSocialEventGate(app);
registerEventsRoutes(app);
registerSocialEventRoutes(app);

const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;

async function call(method: string, path: string, opts: { user?: string; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.user) headers["x-test-user"] = opts.user;
  if (opts.token) headers["x-rsvp-token"] = opts.token;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { passes++; console.log(`  ok   ${label}`); }
  else { failures++; console.log(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ""); }
}

const ADDRESS = "12 Secret Street, Hidden Town";
const future = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
const body = (over: Record<string, unknown> = {}) => ({
  title: "Ada's 30th", description: "Come celebrate", socialType: "birthday", visibility: "private",
  eventDate: future(10), location: "Shoreditch, London", exactAddress: ADDRESS, capacity: 20, maxPlusOnes: 2,
  dressCode: "Smart casual", schedule: [{ name: "Doors", time: "7pm" }, { name: "Cake", time: "9pm" }], ...over,
});
const tokenOf = (inviteUrl: string) => inviteUrl.split("/i/")[1];

try {
  console.log("\ncreation + access control");
  check("unauthenticated create -> 401", (await call("POST", "/api/social-events", { body: body() })).status === 401);
  const unv = await call("POST", "/api/social-events", { user: unverified, body: body() });
  check("unverified email -> 403 EMAIL_NOT_VERIFIED", unv.status === 403 && unv.json?.code === "EMAIL_NOT_VERIFIED", unv.json);
  const pub = await call("POST", "/api/social-events", { user: host, body: body({ visibility: "public" }) });
  check("public create without a verified phone -> 403 PHONE_NOT_VERIFIED (full public rules: phase 3 suite)", pub.status === 403 && pub.json?.code === "PHONE_NOT_VERIFIED", pub.json);
  check("past date -> 400", (await call("POST", "/api/social-events", { user: host, body: body({ eventDate: future(-1) }) })).status === 400);
  check("missing address -> 400", (await call("POST", "/api/social-events", { user: host, body: body({ exactAddress: "" }) })).status === 400);
  check("javascript: image url -> 400", (await call("POST", "/api/social-events", { user: host, body: body({ imageUrl: "javascript:alert(1)" }) })).status === 400);

  const created = await call("POST", "/api/social-events", { user: host, body: body({ title: "Ada <script>x</script>30th", socialType: "wedding" }) });
  check("verified host creates private wedding -> 201", created.status === 201, created.json);
  const ev = created.json;
  check("host view has address + inviteUrl", ev?.address === ADDRESS && typeof ev?.inviteUrl === "string", ev);
  check("title sanitised", !/script/i.test(ev?.title ?? ""), ev?.title);
  const [row] = await q(`select kind, visibility, moderation_status, ticket_price, tickets_available, social_type from events where id=$1`, [ev.id]);
  check("row: kind=social visibility=private approved price=0", row.kind === "social" && row.visibility === "private" && row.moderation_status === "approved" && row.ticket_price === 0, row);
  const token = tokenOf(ev.inviteUrl);

  console.log("\nprivate events never leak into discovery / generic routes");
  check("getEvents excludes it", !(await storage.getEvents()).some((e) => e.id === ev.id));
  check("getEventsByCategory('social') excludes it", !(await storage.getEventsByCategory("social")).some((e) => e.id === ev.id));
  check("searchEvents excludes it", !(await storage.searchEvents("Ada")).some((e) => e.id === ev.id));
  check("getPromotedEvents excludes it", !(await storage.getPromotedEvents()).some((e) => e.id === ev.id));
  check("getEventsByOrganizer (profile/analytics) excludes it", !(await storage.getEventsByOrganizer(host)).some((e) => e.id === ev.id));
  check("getUserEvents excludes it", !(await storage.getUserEvents(host)).some((e) => e.id === ev.id));
  for (const [label, m, p, u] of [
    ["GET /api/events/:id (anon)", "GET", `/api/events/${ev.id}`, undefined],
    ["GET /api/events/:id (host)", "GET", `/api/events/${ev.id}`, host],
    ["GET attendees", "GET", `/api/events/${ev.id}/attendees`, undefined],
    ["GET quote", "GET", `/api/events/${ev.id}/quote`, undefined],
    ["PUT generic update (host)", "PUT", `/api/events/${ev.id}`, host],
    ["POST ticket-tiers (host)", "POST", `/api/events/${ev.id}/ticket-tiers`, host],
  ] as const) {
    check(`${label} -> 404`, (await call(m, p, { user: u, body: m === "GET" ? undefined : {} })).status === 404);
  }
  const rs = await call("POST", "/api/rsvps", { user: member, body: { eventId: ev.id } });
  check("generic /api/rsvps refuses social event -> 400", rs.status === 400, rs.json);

  const raw = await call("GET", `/api/__raw/${ev.id}`);
  check("careless raw endpoint: exactAddress/inviteToken stripped by global redaction", raw.status === 200 && !raw.text.includes(ADDRESS) && !raw.text.includes(token) && !/exactAddress|inviteToken/.test(raw.text), raw.text.slice(0, 200));

  console.log("\ninvite page (no account)");
  check("bad token -> 404", (await call("GET", "/api/invite/not-a-real-token-123")).status === 404);
  const inv = await call("GET", `/api/invite/${token}`);
  check("invite loads", inv.status === 200 && inv.json?.title && inv.json?.area === "Shoreditch, London", inv.json);
  check("invite never contains the exact address", !inv.text.includes(ADDRESS));
  check("invite has dress code + schedule (wedding modules)", inv.json?.dressCode === "Smart casual" && inv.json?.schedule?.length === 2);
  check("invite is no-store + noindex", /no-store/.test(inv.headers.get("cache-control") ?? "") && /noindex/.test(inv.headers.get("x-robots-tag") ?? ""));

  console.log("\nRSVP as a guest without an account");
  check("RSVP before answering -> responded:false", (await call("GET", `/api/invite/${token}/rsvp`)).json?.responded === false);
  check("plus-ones above the cap -> 400", (await call("PUT", `/api/invite/${token}/rsvp`, { body: { name: "Bola", attending: true, plusOneCount: 3 } })).status === 400);
  check("empty name -> 400", (await call("PUT", `/api/invite/${token}/rsvp`, { body: { name: " ", attending: true, plusOneCount: 0 } })).status === 400);
  const yes = await call("PUT", `/api/invite/${token}/rsvp`, { body: { name: "Bola", attending: true, plusOneCount: 1 } });
  check("guest says yes (+1) -> 200 with manageToken and address", yes.status === 200 && yes.json?.attending === true && !!yes.json?.manageToken && yes.json?.address === ADDRESS, yes.json);
  const manage = yes.json?.manageToken as string;
  const [t] = await q(`select user_id, guest_token_hash, guest_name, plus_one_count, status, payment_provider, amount_paid, address_approved_at from tickets where event_id=$1`, [ev.id]);
  check("stored as a price-0 free ticket, userId NULL", t.user_id === null && t.payment_provider === "free" && t.amount_paid === 0 && t.status === "confirmed" && t.plus_one_count === 1, t);
  check("only the token HASH is stored", t.guest_token_hash === crypto.createHash("sha256").update(manage).digest("hex") && t.guest_token_hash !== manage);
  check("capacity counts heads (guest + plus-one = 2)", (await q(`select tickets_sold from events where id=$1`, [ev.id]))[0].tickets_sold === 2);
  const mine = await call("GET", `/api/invite/${token}/rsvp`, { token: manage });
  check("guest reads own RSVP with token (address shown)", mine.json?.responded === true && mine.json?.address === ADDRESS && mine.json?.name === "Bola", mine.json);
  check("wrong token -> responded:false, no address", (await call("GET", `/api/invite/${token}/rsvp`, { token: "nope" })).json?.responded === false);
  const sameAgain = await call("PUT", `/api/invite/${token}/rsvp`, { token: manage, body: { name: "Bola A.", attending: true, plusOneCount: 2 } });
  check("edit RSVP (plus-ones 1->2): no new token, still one ticket", sameAgain.status === 200 && !sameAgain.json?.manageToken && (await q(`select count(*)::int n from tickets where event_id=$1`, [ev.id]))[0].n === 1, sameAgain.json);
  check("headcount now 3", (await q(`select tickets_sold from events where id=$1`, [ev.id]))[0].tickets_sold === 3);
  const no = await call("PUT", `/api/invite/${token}/rsvp`, { token: manage, body: { name: "Bola A.", attending: false, plusOneCount: 0 } });
  check("changing to 'no' releases the seats and withdraws the address", no.json?.attending === false && no.json?.address === null && (await q(`select tickets_sold from events where id=$1`, [ev.id]))[0].tickets_sold === 0, no.json);
  await call("PUT", `/api/invite/${token}/rsvp`, { token: manage, body: { name: "Bola A.", attending: true, plusOneCount: 0 } });

  console.log("\nRSVP as a logged-in account");
  const acct = await call("PUT", `/api/invite/${token}/rsvp`, { user: member, body: { name: "Member M", attending: true, plusOneCount: 1 } });
  check("account RSVP -> 200, no manageToken", acct.status === 200 && !acct.json?.manageToken, acct.json);
  const [mt] = await q(`select user_id, guest_token_hash from tickets where event_id=$1 and user_id=$2`, [ev.id, member]);
  check("ticket is tied to the account", !!mt && mt.guest_token_hash === null);
  check("wallet lists it", (await storage.getUserTickets(member)).some((x) => x.eventId === ev.id));
  await call("PUT", `/api/invite/${token}/rsvp`, { user: member, body: { name: "Member M", attending: false, plusOneCount: 0 } });
  check("declined RSVP hidden from wallet", !(await storage.getUserTickets(member)).some((x) => x.eventId === ev.id));

  console.log("\nhost: notifications, guest list, audit, ownership");
  check("host was notified of RSVPs", (await q(`select count(*)::int n from notifications where user_id=$1 and type='event_rsvp'`, [host]))[0].n >= 3);
  check("other user cannot read guest list -> 404", (await call("GET", `/api/social-events/${ev.id}/guests`, { user: otherHost })).status === 404);
  check("anonymous guest list -> 401", (await call("GET", `/api/social-events/${ev.id}/guests`)).status === 401);
  const before = (await q(`select count(*)::int n from guest_data_audit where event_id=$1`, [ev.id]))[0].n;
  const gl = await call("GET", `/api/social-events/${ev.id}/guests`, { user: host });
  check("host guest list: names + counts only", gl.status === 200 && gl.json.guests.some((g: any) => g.name === "Bola A." && g.plusOneCount === 0) && gl.json.guests.every((g: any) => Object.keys(g).sort().join() === "addressApproved,attending,hasAccount,id,name,plusOneCount,removed,respondedAt"), gl.json);
  const after = await q(`select actor_type, actor_user_id, data_accessed from guest_data_audit where event_id=$1`, [ev.id]);
  check("guest-list read wrote a guest_data_audit row", after.length === before + 1 && after[after.length - 1].actor_type === "host" && after[after.length - 1].actor_user_id === host, after);
  check("other host cannot cancel / patch / rotate", (await Promise.all([
    call("POST", `/api/social-events/${ev.id}/cancel`, { user: otherHost }),
    call("PATCH", `/api/social-events/${ev.id}`, { user: otherHost, body: { title: "hijack" } }),
    call("POST", `/api/social-events/${ev.id}/rotate-invite`, { user: otherHost }),
  ])).every((r) => r.status === 404));
  check("no CSV/export route exists", (await call("GET", `/api/social-events/${ev.id}/guests.csv`, { user: host })).status === 404 && (await call("GET", `/api/social-events/${ev.id}/guests/export`, { user: host })).status === 404);

  console.log("\nhost: edit + rotate invite");
  await call("PUT", `/api/invite/${token}/rsvp`, { body: { name: "Chi", attending: true, plusOneCount: 1 } }); // 1 (Bola) + 2 (Chi) = 3 heads confirmed
  check("capacity below confirmed heads (2 < 3) -> 400", (await call("PATCH", `/api/social-events/${ev.id}`, { user: host, body: { capacity: 2 } })).status === 400);
  check("capacity equal to confirmed heads (3) is allowed", (await call("PATCH", `/api/social-events/${ev.id}`, { user: host, body: { capacity: 3 } })).status === 200);
  const patched = await call("PATCH", `/api/social-events/${ev.id}`, { user: host, body: { dressCode: "Black tie", capacity: 30 } });
  check("PATCH updates fields", patched.status === 200 && patched.json?.dressCode === "Black tie" && patched.json?.capacity === 30, patched.json);
  const rot = await call("POST", `/api/social-events/${ev.id}/rotate-invite`, { user: host });
  const token2 = tokenOf(rot.json.inviteUrl);
  check("rotated: old link dead, new link works, RSVPs kept", token2 !== token && (await call("GET", `/api/invite/${token}`)).status === 404 && (await call("GET", `/api/invite/${token2}`)).status === 200 && (await call("GET", `/api/social-events/${ev.id}/guests`, { user: host })).json.guests.length === 3);

  console.log("\ncapacity + concurrency");
  const small = (await call("POST", "/api/social-events", { user: host, body: body({ capacity: 3, maxPlusOnes: 2 }) })).json;
  const st = tokenOf(small.inviteUrl);
  check("guest A takes all 3 seats (self + 2)", (await call("PUT", `/api/invite/${st}/rsvp`, { body: { name: "A", attending: true, plusOneCount: 2 } })).status === 200);
  const full = await call("PUT", `/api/invite/${st}/rsvp`, { body: { name: "B", attending: true, plusOneCount: 0 } });
  check("guest B 'yes' -> 409 FULL", full.status === 409 && full.json?.code === "FULL", full.json);
  check("guest B can still decline", (await call("PUT", `/api/invite/${st}/rsvp`, { body: { name: "B", attending: false, plusOneCount: 0 } })).status === 200);
  check("invite page reports full", (await call("GET", `/api/invite/${st}`)).json?.full === true);

  const race = (await call("POST", "/api/social-events", { user: host, body: body({ capacity: 5, maxPlusOnes: 0 }) })).json;
  const rt = tokenOf(race.inviteUrl);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => call("PUT", `/api/invite/${rt}/rsvp`, { body: { name: `G${i}`, attending: true, plusOneCount: 0 } })));
  const ok = results.filter((r) => r.status === 200).length;
  const fullN = results.filter((r) => r.status === 409).length;
  const [rr] = await q(`select tickets_sold, (select count(*)::int from tickets where event_id=$1 and status='confirmed') confirmed from events where id=$1`, [race.id]);
  check(`12 simultaneous RSVPs, capacity 5: exactly 5 accepted, 7 full (got ${ok}/${fullN})`, ok === 5 && fullN === 7 && rr.tickets_sold === 5 && rr.confirmed === 5, rr);

  console.log("\ncancel");
  const cancelled = await call("POST", `/api/social-events/${ev.id}/cancel`, { user: host });
  check("host cancels", cancelled.json?.isCancelled === true);
  const afterCancel = await call("GET", `/api/invite/${token2}`);
  check("invite shows cancelled", afterCancel.json?.cancelled === true);
  check("RSVP to cancelled event -> 400 CANCELLED", (await call("PUT", `/api/invite/${token2}/rsvp`, { body: { name: "Late", attending: true, plusOneCount: 0 } })).json?.code === "CANCELLED");
  check("cancelled event withholds address from existing guests", (await call("GET", `/api/invite/${token2}/rsvp`, { token: manage })).json?.address === null);

  console.log("\ncommercial events untouched");
  const comm = await storage.getEvents();
  check("getEvents still works on commercial events (no regression)", Array.isArray(comm));
  const cEvent = await storage.createEvent({ organizerId: host, title: "Club night", description: "x", eventDate: new Date(Date.now() + 86400000), location: "Soho", category: "music", ticketsAvailable: 10, moderationStatus: "approved" });
  check("commercial event defaults to kind=commercial, visibility=public and is discoverable", cEvent.kind === "commercial" && cEvent.visibility === "public" && (await storage.getEvents()).some((e) => e.id === cEvent.id));
  check("GET /api/events/:id still works for commercial (gate passes through)", (await call("GET", `/api/events/${cEvent.id}`)).status === 200);
} catch (e) {
  failures++;
  console.error("\nUNEXPECTED ERROR", e);
} finally {
  server.close();
  await pool.end();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
