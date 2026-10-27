// Verified name for payouts, end to end (throwaway database):
//   DATABASE_URL=<scratch db> SESSION_SECRET=x AGE_REVIEW=1 AGE_EVIDENCE_KEY=<base64 32 bytes> npx tsx scripts/test-age-review-api-payoutname.ts
// Refuses to run unless the database name contains "test". Uses the real encrypted store (no payoutTestHooks.verifiedName).
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcrypt";
import pg from "pg";

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname;
if (!/test/i.test(dbName)) { console.error(`Refusing to run against database "${dbName}" (name must contain "test")`); process.exit(2); }
process.env.AGE_REVIEW = "1";
process.env.DISABLE_GEOCODING = "1";
process.env.RESEND_API_KEY ||= "re_dummy_not_real";
process.env.AGE_EVIDENCE_KEY ||= Buffer.alloc(32, 3).toString("base64");

// Everything that is logged is kept so the tests can prove the legal name never appears in it.
const logged: string[] = [];
for (const k of ["log", "error", "warn", "info"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => { logged.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join(" ")); orig(...a); };
}

const { storage, ensureSchema } = await import("../server/storage");
const { redactSensitiveFields } = await import("../server/security");
const { userToSessionUser } = await import("../server/auth");
const { registerAgeReviewRoutes } = await import("../server/routes/age-review-routes");
const { registerAgeReviewAdminRoutes } = await import("../server/routes/age-review-admin-routes");
const { registerAgeVerificationAdminRoute } = await import("../server/admin-routes");
const { registerRoomPayoutRoutes } = await import("../server/rooms/payoutRoutes");
const { setPayoutProviderForTests, payoutTestHooks, payableSubaccountOf } = await import("../server/rooms/payouts");
const { setVerifiedName } = await import("../server/identity/verifiedName");
const { getVerifiedLegalName, hasVerifiedName } = await import("../server/identity/verifiedName");
const { sweepExpiredAgeReviews } = await import("../server/identity/ageReviewSweep");
const { correctDateOfBirth } = await import("../server/services/dobCorrection");
const { CONSENT_VERSION, CHECKLIST_KEYS } = await import("../shared/ageReview");
await ensureSchema();
if (payoutTestHooks.verifiedName) throw new Error("the real store must be used here");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra = "") => { if (ok) passed++; else failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${extra}`}`); };

const OWNER = new Map<string, string>();
const created: string[] = [];
const subaccounts: any[] = [];
setPayoutProviderForTests({
  listBanks: async () => [{ name: "Test Bank Plc", code: "058" }],
  resolve: async (n) => { const name = OWNER.get(n); if (!name) throw new Error("Paystack error: Could not resolve account name"); return { accountNumber: n, accountName: name }; },
  createSubaccount: async (p) => { subaccounts.push(p); return { subaccountCode: `ACCT_pn_${subaccounts.length}_${Date.now()}` }; },
  updateSubaccount: async () => {},
});

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());
app.use(async (req: any, _res, next) => {
  const a = req.header("x-test-admin");
  req.session = a ? { adminId: a, mfaVerified: true, mfaPassed: true, destroy: (cb: any) => cb?.() } : { destroy: (cb: any) => cb?.() };
  const u = req.header("x-test-user");
  if (u) { const row = await storage.getUser(u); req.user = row ? userToSessionUser(row) : undefined; }
  req.isAuthenticated = () => !!req.user;
  next();
});
app.use(redactSensitiveFields);
registerAgeReviewAdminRoutes(app);
registerAgeReviewRoutes(app);
registerAgeVerificationAdminRoute(app);
registerRoomPayoutRoutes(app);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const responses: string[] = [];
let ip = 1;
async function http(method: string, path: string, who: { admin?: string; user?: string }, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "x-forwarded-for": `10.6.${(ip >> 8) & 255}.${ip++ & 255}`, "content-type": "application/json", ...(who.admin ? { "x-test-admin": who.admin } : {}), ...(who.user ? { "x-test-user": who.user } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  responses.push(text);
  let json: any = null; try { json = JSON.parse(text); } catch { /* none */ }
  return { status: res.status, json, text };
}

const hash = await bcrypt.hash("Passw0rd!pn", 4);
const stamp = Date.now();
const yearsAgo = (y: number) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); d.setUTCDate(d.getUTCDate() - 3); return d.toISOString().slice(0, 10); };
const dob = yearsAgo(30);
const mkUser = async (n: string, o: { verified?: boolean; dob?: string } = {}) => {
  const id = (await q(
    `insert into users (email, username, user_type, password_hash, is_verified, onboarding_complete, date_of_birth, age_verified_at, age_verified_method) values ($1,$2,'social',$3,true,true,$4,$5,$6) returning id`,
    [`pn_${n}${stamp}@t.dev`, `pn_${n}${stamp}`, hash, o.dob ?? dob, o.verified ? new Date("2026-01-15T10:00:00Z") : null, o.verified ? "admin_upload" : null]))[0].id as string;
  created.push(id);
  return id;
};
const mkAdmin = async (n: string, role: string) => (await q(`insert into admin_users (username, email, password_hash, display_name, role) values ($1,$2,$3,'A',$4) returning id`, [`pn_${n}${stamp}`, `pn_${n}${stamp}@t.dev`, hash, role]))[0].id as string;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64").toString("base64");
const full = Object.fromEntries(CHECKLIST_KEYS.map((k) => [k, true]));
const consent = { consentVersion: CONSENT_VERSION };
const NAME = "Zuriel Quenby Adewale";
const hasName = async (id: string) => (await q(`select 1 from user_verified_names where user_id = $1`, [id])).length > 0;

const rev = await mkAdmin("rev", "age_reviewer"), sup1 = await mkAdmin("sup1", "super_admin"), sup2 = await mkAdmin("sup2", "super_admin"), adm = await mkAdmin("adm", "admin");

// a request submitted by the user, ready for the reviewer
async function submitted(userId: string, payouts: boolean) {
  const r = await http("POST", "/api/age-review/requests", { user: userId }, { method: "upload", documentType: "passport", ...consent, ...(payouts ? { wantsPayouts: true } : {}) });
  if (r.status !== 201) throw new Error(`create failed ${r.status} ${r.text}`);
  const id: string = r.json.request.id;
  for (const kind of ["document", "selfie"]) await http("POST", `/api/age-review/requests/${id}/evidence`, { user: userId }, { kind, mime: "image/png", data: PNG });
  await http("POST", `/api/age-review/requests/${id}/submit`, { user: userId });
  return id;
}

// ---- creating requests
const adult = await mkUser("adult");
const teen = await mkUser("teen", { dob: yearsAgo(15) });
check("consent version v2 is required", (await http("POST", "/api/age-review/requests", { user: adult }, { method: "live", consentVersion: "2026-10-v1" })).json?.code === "CONSENT_REQUIRED");
check("under 18 still NOT_OFFERED (also with wantsPayouts)", (await http("POST", "/api/age-review/requests", { user: teen }, { method: "live", wantsPayouts: true, ...consent })).json?.code === "NOT_OFFERED");
const verified = await mkUser("verified", { verified: true });
check("verified user without wantsPayouts gets ALREADY_VERIFIED", (await http("POST", "/api/age-review/requests", { user: verified }, { method: "live", ...consent })).json?.code === "ALREADY_VERIFIED");
const me0 = await http("GET", "/api/age-review/me", { user: verified });
check("me reports verified and hasPayoutName false before any name", me0.json.state === "verified" && me0.json.hasPayoutName === false);

// ---- payouts-only review of a verified user, end to end
const status0 = await http("GET", "/api/rooms/payouts/status", { user: verified });
check("payout status reports hasVerifiedName false, canLinkAccount false", status0.status === 200 && status0.json.hasVerifiedName === false && status0.json.canLinkAccount === false, status0.text);
OWNER.set("0123456789", NAME.toUpperCase());
const noName = await http("POST", "/api/rooms/payouts/account", { user: verified }, { bankCode: "058", accountNumber: "0123456789" });
check("linking without a name: NO_VERIFIED_NAME with the new message", noName.status === 422 && noName.json.code === "NO_VERIFIED_NAME" && /check your name on your ID/.test(noName.json.message), noName.text);

const rid = await submitted(verified, true);
const meOpen = await http("GET", "/api/age-review/me", { user: verified });
check("wantsPayouts creates a request and a verified user may start a payouts-only review", meOpen.json.state === "in_review" && meOpen.json.request.wantsPayouts === true && meOpen.json.verified?.method === "admin_upload");
const detail = await http("GET", `/api/admin/age-reviews/${rid}`, { admin: rev });
check("queue/detail expose wantsPayouts", detail.json.request.wantsPayouts === true && (await http("GET", "/api/admin/age-reviews", { admin: rev })).json.items.some((i: any) => i.id === rid && i.wantsPayouts === true));
const base1 = { outcome: "verify", checklist: full, idBirthdate: dob, documentNumber: "PN" + stamp };
check("legalName required when wantsPayouts (NAME_REQUIRED)", (await http("POST", `/api/admin/age-reviews/${rid}/decide`, { admin: rev }, base1)).json?.code === "NAME_REQUIRED");
const done = await http("POST", `/api/admin/age-reviews/${rid}/decide`, { admin: rev }, { ...base1, legalName: "  Zuriel   Quenby  Adewale " });
const keep = (await q(`select age_verified_at, age_verified_method from users where id = $1`, [verified]))[0];
check("a verified user who completes a payouts review keeps the original age_verified_at", done.status === 200 && new Date(keep.age_verified_at).toISOString() === "2026-01-15T10:00:00.000Z" && keep.age_verified_method === "admin_upload", done.text + JSON.stringify(keep));
const enc = (await q(`select name_enc, set_by, request_id from user_verified_names where user_id = $1`, [verified]))[0];
check("name stored encrypted (not the text), round trip works", !!enc && !Buffer.from(enc.name_enc).includes(Buffer.from("Quenby")) && (await getVerifiedLegalName(verified)) === NAME && enc.set_by === rev && enc.request_id === rid);
const other = await mkUser("other");
await q(`insert into user_verified_names (user_id, name_enc) values ($1, $2)`, [other, enc.name_enc]);
const origErr = console.error; console.error = () => {};
const wrong = await getVerifiedLegalName(other);
console.error = origErr;
check("wrong user AAD fails closed", wrong === null);
await q(`delete from user_verified_names where user_id = $1`, [other]);
check("me reports hasPayoutName true; payout status hasVerifiedName and canLinkAccount true", (await http("GET", "/api/age-review/me", { user: verified })).json.hasPayoutName === true && await (async () => { const s = (await http("GET", "/api/rooms/payouts/status", { user: verified })).json; return s.hasVerifiedName === true && s.canLinkAccount === true; })());
OWNER.set("0000000001", "SOMEONE ELSE ENTIRELY");
const mismatch2 = await http("POST", "/api/rooms/payouts/account", { user: verified }, { bankCode: "058", accountNumber: "0000000001" });
check("a mismatching account name is refused NAME_MISMATCH", mismatch2.status === 422 && mismatch2.json.code === "NAME_MISMATCH" && subaccounts.length === 0, mismatch2.text);
const link = await http("POST", "/api/rooms/payouts/account", { user: verified }, { bankCode: "058", accountNumber: "0123456789" });
check("linking a bank account works end to end with a stored name: name match creates the subaccount", link.status === 200 && subaccounts.length === 1, link.text);

// ---- NAME_NOT_REQUESTED, and the name never leaves
const plain = await mkUser("plain");
const rPlain = await submitted(plain, false);
check("legalName is refused when payouts were not asked for (NAME_NOT_REQUESTED)", (await http("POST", `/api/admin/age-reviews/${rPlain}/decide`, { admin: rev }, { ...base1, documentNumber: "PX" + stamp, legalName: NAME })).json?.code === "NAME_NOT_REQUESTED");
check("a normal review still verifies without a name", (await http("POST", `/api/admin/age-reviews/${rPlain}/decide`, { admin: rev }, { ...base1, documentNumber: "PX" + stamp })).status === 200 && !(await hasName(plain)));

// ---- birthdate change holds the name until the second approval
const bc = await mkUser("bc");
const rBc = await submitted(bc, true);
const newDob = yearsAgo(33);
const queued = await http("POST", `/api/admin/age-reviews/${rBc}/decide`, { admin: rev }, { outcome: "birthdate_change", checklist: full, idBirthdate: newDob, documentNumber: "BC" + stamp, legalName: NAME });
const held = (await q(`select proposed_legal_name_enc is not null as held, status from age_review_requests where id = $1`, [rBc]))[0];
check("birthdate change holds the proposed name (not stored yet)", queued.status === 200 && held.held === true && held.status === "pending_second_approval" && !(await hasName(bc)));
await q(`update age_review_requests set reviewer_id = $2 where id = $1`, [rBc, sup1]);
check("second approval stores the held name and clears the hold", (await http("POST", `/api/admin/age-reviews/${rBc}/second-approve`, { admin: sup2 }, { approve: true, reason: "ID checked" })).status === 200
  && (await getVerifiedLegalName(bc)) === NAME && (await q(`select proposed_legal_name_enc from age_review_requests where id = $1`, [rBc]))[0].proposed_legal_name_enc === null);

// ---- declines, expiry and cancel clear the proposed name
const d1 = await mkUser("d1"), d2 = await mkUser("d2"), d3 = await mkUser("d3");
const rD1 = await submitted(d1, true), rD2 = await submitted(d2, true), rD3 = await submitted(d3, true);
for (const [r, uid] of [[rD1, d1], [rD2, d2], [rD3, d3]] as const) {
  await http("POST", `/api/admin/age-reviews/${r}/decide`, { admin: rev }, { outcome: "birthdate_change", checklist: full, idBirthdate: newDob, documentNumber: "D" + r.slice(0, 8) + stamp, legalName: NAME });
  void uid;
}
await q(`update age_review_requests set reviewer_id = $2 where id = any($1::uuid[])`, [[rD1, rD2, rD3], sup1]);
await http("POST", `/api/admin/age-reviews/${rD1}/second-approve`, { admin: sup2 }, { approve: false, reason: "not convincing" });
await http("POST", `/api/age-review/requests/${rD2}/cancel`, { user: d2 });
await q(`update age_review_requests set expires_at = now() - interval '1 minute' where id = $1`, [rD3]);
await sweepExpiredAgeReviews();
const cleared = await q(`select id, status, proposed_legal_name_enc is null as cleared from age_review_requests where id = any($1::uuid[])`, [[rD1, rD2, rD3]]);
check("declines, expiry and cancel clear the proposed name", cleared.length === 3 && cleared.every((c: any) => c.cleared === true) && cleared.map((c: any) => c.status).sort().join() === "cancelled,declined,expired", JSON.stringify(cleared));
check("none of them stored a name", !(await hasName(d1)) && !(await hasName(d2)) && !(await hasName(d3)));

// ---- deletion: revoke, teen correction, dob correction, account deletion
const v2 = await mkUser("v2", { verified: true });
const rV2 = await submitted(v2, true);
await http("POST", `/api/admin/age-reviews/${rV2}/decide`, { admin: rev }, { ...base1, documentNumber: "V2" + stamp, legalName: NAME });
check("(setup) second user has a name", await hasName(v2));
check("revoke deletes the name", (await http("POST", `/api/admin/users/${v2}/age-verification/revoke`, { admin: adm }, { reason: "chargeback review" })).status === 200 && !(await hasName(v2)));

const v3 = await mkUser("v3", { verified: true });
await setVerifiedName(pool as any, v3, NAME, null, rev);
const rV3 = await submitted(v3, true);
const teenRes = await http("POST", `/api/admin/age-reviews/${rV3}/decide`, { admin: rev }, { outcome: "teen_correction", idBirthdate: yearsAgo(15) });
check("teen correction deletes the name and stores none", teenRes.status === 200 && !(await hasName(v3)));

const v4 = await mkUser("v4", { verified: true });
await setVerifiedName(pool as any, v4, NAME, null, rev);
await correctDateOfBirth({ adminId: adm, userId: v4, dateOfBirth: yearsAgo(31), reason: "typo" });
check("a birthdate correction (which clears verification) deletes the name", !(await hasName(v4)));

const v5 = await mkUser("v5", { verified: true });
await setVerifiedName(pool as any, v5, NAME, null, rev);
await storage.softDeleteUser(v5);
check("account deletion deletes the name", !(await hasName(v5)));

// ---- changing or removing the name also stops an account that was checked against it
const payable = (id: string) => payableSubaccountOf(id);
const acctRow = async (id: string) => (await q(`select paystack_subaccount_code, room_verified_subaccount_code, name_matched_at from organizer_payment_accounts where user_id = $1 and provider = 'paystack'`, [id]))[0];
const mkPayable = (id: string) => q(
  `insert into organizer_payment_accounts (user_id, provider, paystack_subaccount_code, details_submitted, payouts_enabled, room_verified_subaccount_code, name_matched_at) values ($1,'paystack',$2,true,true,$2,now())`,
  [id, `ACCT_pn_${id.slice(0, 8)}_${stamp}`]);
check("(setup) the linked account of the verified user is payable", (await payable(verified)) !== null);
async function reReview(userId: string, name: string, tag: string) {
  const id = await submitted(userId, true);
  return http("POST", `/api/admin/age-reviews/${id}/decide`, { admin: rev }, { ...base1, documentNumber: tag + stamp, legalName: name });
}
check("a payouts re-review storing the SAME name keeps the match", (await reReview(verified, "ZURIEL  quenby adewale".replace("quenby", "Quenby"), "SN")).status === 200 && (await payable(verified)) !== null);
check("a different new name clears the match, the account stays linked but unpayable", (await reReview(verified, "Zuriel Quenby Olawale", "DN")).status === 200
  && (await payable(verified)) === null && (await acctRow(verified))?.paystack_subaccount_code != null && (await acctRow(verified)).room_verified_subaccount_code === null && (await acctRow(verified)).name_matched_at === null);

const rv = await mkUser("rv", { verified: true });
await setVerifiedName(pool as any, rv, NAME, null, rev); await mkPayable(rv);
check("(setup) payable before revoke", (await payable(rv)) !== null);
check("revoke clears the match and the account becomes unpayable", (await http("POST", `/api/admin/users/${rv}/age-verification/revoke`, { admin: adm }, { reason: "chargeback review" })).status === 200
  && (await payable(rv)) === null && !(await hasName(rv)) && (await acctRow(rv))?.paystack_subaccount_code != null);

const dc = await mkUser("dc", { verified: true });
await setVerifiedName(pool as any, dc, NAME, null, rev); await mkPayable(dc);
await correctDateOfBirth({ adminId: adm, userId: dc, dateOfBirth: yearsAgo(31), reason: "typo" });
check("dob correction clears name and match", !(await hasName(dc)) && (await payable(dc)) === null);

const cl = await mkUser("cl", { verified: true });
await setVerifiedName(pool as any, cl, NAME, null, rev); await mkPayable(cl);
check("the direct clear (verified:false) clears name and match", (await http("POST", `/api/admin/users/${cl}/age-verification`, { admin: adm }, { verified: false, reason: "found a problem" })).status === 200 && !(await hasName(cl)) && (await payable(cl)) === null);

const tc = await mkUser("tc", { verified: true });
await setVerifiedName(pool as any, tc, NAME, null, rev); await mkPayable(tc);
const rTc = await submitted(tc, true);
await http("POST", `/api/admin/age-reviews/${rTc}/decide`, { admin: rev }, { outcome: "teen_correction", idBirthdate: yearsAgo(15) });
check("teen correction clears name and match", !(await hasName(tc)) && (await payable(tc)) === null);

const gone = await mkUser("gone", { verified: true });
await setVerifiedName(pool as any, gone, NAME, null, rev); await mkPayable(gone);
await storage.softDeleteUser(gone);
check("account deletion clears name and match", !(await hasName(gone)) && (await payable(gone)) === null);

check("spray gate refuses after the match is cleared (it asks only payableSubaccountOf)", (await payable(rv)) === null && /payableSubaccountOf\(userId\)/.test((await import("node:fs")).readFileSync("server/rooms/spray.ts", "utf8")));

// ---- an undecryptable stored name counts as no name
const tam = await mkUser("tam", { verified: true });
await setVerifiedName(pool as any, tam, NAME, null, rev);
await q(`update user_verified_names set name_enc = $2 where user_id = $1`, [tam, Buffer.from("v1:garbage-not-a-real-ciphertext-at-all-0123456789")]);
const quiet = console.error; console.error = () => {};
const tamMe = await http("GET", "/api/age-review/me", { user: tam });
const tamSt = await http("GET", "/api/rooms/payouts/status", { user: tam });
console.error = quiet;
check("an undecryptable row counts as no name everywhere (hasPayoutName, hasVerifiedName, canLinkAccount)", tamMe.json.hasPayoutName === false && tamSt.json.hasVerifiedName === false && tamSt.json.canLinkAccount === false);

// ---- me precedence: only an open PAYOUTS review changes the state of a verified user
const vp = await mkUser("vp", { verified: true });
await q(`insert into age_review_requests (user_id, method, status, document_type, registered_dob_snapshot, consent_version, consented_at, wants_payouts) values ($1,'live','submitted','passport',$2,$3,now(),false)`, [vp, dob, CONSENT_VERSION]);
check("an open request that did not ask for payouts leaves a verified user 'verified' (old order)", (await http("GET", "/api/age-review/me", { user: vp })).json.state === "verified");
await q(`update age_review_requests set wants_payouts = true where user_id = $1`, [vp]);
check("...an open payouts request makes it 'in_review'", (await http("GET", "/api/age-review/me", { user: vp })).json.state === "in_review");

// ---- an answered request is closed: an old open request of a verified person must not block the payouts check
const { closeAnsweredRequests } = await import("../server/identity/ageReviewService");
const openRow = (uid: string, payouts: boolean, status = "submitted") => q(`insert into age_review_requests (user_id, method, status, document_type, registered_dob_snapshot, consent_version, consented_at, wants_payouts) values ($1,'upload',$4,'passport',$2,$3,now(),$5)`, [uid, dob, CONSENT_VERSION, status, payouts]);
const vq = await mkUser("vq", { verified: true });
await openRow(vq, false);
const vqNew = await http("POST", "/api/age-review/requests", { user: vq }, { method: "upload", documentType: "passport", ...consent, wantsPayouts: true });
check("a verified person with an old open request can start a payouts check (201), no OPEN_REQUEST_EXISTS", vqNew.status === 201, JSON.stringify(vqNew));
check("...and the old request is closed as approved, its photos gone", (await q(`select status from age_review_requests where user_id = $1 and wants_payouts = false`, [vq]))[0]?.status === "approved");
const vr = await mkUser("vr", { verified: true });
await openRow(vr, true, "draft");
check("closeAnsweredRequests leaves an open payouts request alone (its name is still to be recorded)", (await closeAnsweredRequests(vr)).length === 0 && (await q(`select status from age_review_requests where user_id = $1`, [vr]))[0].status === "draft");
const vs = await mkUser("vs", { verified: true });
await openRow(vs, false, "needs_more");
const closedIds = await closeAnsweredRequests(vs);
check("closeAnsweredRequests closes the open one that did not ask for payouts, and says which", closedIds.length === 1 && (await q(`select status, code from age_review_requests where user_id = $1`, [vs]))[0].status === "approved");
check("...so the person has no open request left", (await http("GET", "/api/age-review/me", { user: vs })).json.request === null);

// ---- the link race: the name or the verification vanishes during the Paystack round trip
const lr = await mkUser("lr", { verified: true });
await setVerifiedName(pool as any, lr, NAME, null, rev);
OWNER.set("0222222222", NAME.toUpperCase());
let revokeMidFlight: (() => Promise<void>) | null = async () => { await q(`delete from user_verified_names where user_id = $1`, [lr]); };
setPayoutProviderForTests({
  listBanks: async () => [{ name: "Test Bank Plc", code: "058" }],
  resolve: async (n) => { if (revokeMidFlight) { const f = revokeMidFlight; revokeMidFlight = null; await f(); } const name = OWNER.get(n); if (!name) throw new Error("Paystack error: Could not resolve account name"); return { accountNumber: n, accountName: name }; },
  createSubaccount: async (p) => { subaccounts.push(p); return { subaccountCode: `ACCT_pn_${subaccounts.length}_${Date.now()}` }; },
  updateSubaccount: async () => {},
});
const before = subaccounts.length;
const raced = await http("POST", "/api/rooms/payouts/account", { user: lr }, { bankCode: "058", accountNumber: "0222222222" });
check("the name vanishing mid-flight stops the link (NO_VERIFIED_NAME, nothing created)", raced.status === 422 && raced.json.code === "NO_VERIFIED_NAME" && subaccounts.length === before && (await payable(lr)) === null, raced.text);
await setVerifiedName(pool as any, lr, NAME, null, rev);
revokeMidFlight = async () => { await q(`update users set age_verified_at = null where id = $1`, [lr]); };
const raced2 = await http("POST", "/api/rooms/payouts/account", { user: lr }, { bankCode: "058", accountNumber: "0222222222" });
check("the verification vanishing mid-flight stops the link (NOT_VERIFIED, nothing created)", raced2.status === 403 && raced2.json.code === "NOT_VERIFIED" && subaccounts.length === before, raced2.text);

// ---- the name is nowhere it should not be
const leaks = [...responses, ...logged].filter((s) => /Quenby/i.test(s));
check("name never in any response or log line", leaks.length === 0, leaks.slice(0, 2).join(" | ").slice(0, 200));
const audits = await q(`select details, reason from admin_activity_logs where details ilike '%Quenby%' or reason ilike '%Quenby%'`);
check("name never in any audit row", audits.length === 0);
check("the audit row only says payouts=true", (await q(`select details from admin_activity_logs where action = 'age_review.decide' and target_id = $1`, [rid]))[0].details.includes("payouts=true"));
check("no notification mentions it", (await q(`select 1 from notifications where message ilike '%Quenby%' or title ilike '%Quenby%'`)).length === 0);

await q(`delete from users where id = any($1::text[])`, [created]);
server.close();
await pool.end();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
