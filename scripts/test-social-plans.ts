// Checks the social plan rules against a real (scratch) database: pass idempotency, tier
// precedence, the atomic campaign allowance, the platform cap, purchase blocking, and the
// Stripe / Paystack webhook handlers. No network calls to Stripe, Paystack or Zernio.
//
//   node scripts/run-social-plans-test.mjs
//
// Refuses to run unless DATABASE_URL's database name contains "test".
import pg from "pg";

const dbUrl = process.env.DATABASE_URL ?? "";
if (!/test/i.test(new URL(dbUrl).pathname)) {
  console.error("Refusing to run: DATABASE_URL must point at a throwaway database whose name contains 'test'.");
  process.exit(2);
}

// Fake Zernio + Resend: no network, and we can see exactly what would have been posted.
process.env.ZERNIO_API_KEY = "zernio_test";
process.env.ZERNIO_BASE_URL = "http://zernio.test";
process.env.RESEND_API_KEY = "re_test";
const calls: Array<{ url: string; method: string; body: any }> = [];
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(typeof input === "string" ? input : input?.url ?? input);
  const method = (init.method ?? "GET").toUpperCase();
  let body: any = undefined;
  try { body = init.body ? JSON.parse(String(init.body)) : undefined; } catch { /* not JSON */ }
  calls.push({ url, method, body });
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  if (url.startsWith("http://zernio.test/v1/posts") && method === "POST") {
    return json({ post: { _id: `post_${calls.length}`, status: "publishing", platforms: body.platforms.map((p: any) => ({ platform: p.platform, status: "publishing" })) } });
  }
  return json({ success: true, id: "em_1" });
}) as typeof fetch;
const zernioPosts = () => calls.filter((c) => c.url.endsWith("/v1/posts") && c.method === "POST");
// platforms posted to since `mark` (an earlier zernioPosts().length)
const platformsSince = (mark: number) =>
  zernioPosts().slice(mark).flatMap((c) => c.body.platforms.map((p: any) => p.platform)).sort().join();

const {
  activatePass, canConnectPlatform, getActivePass, getPlanSummary, findBlockingPass,
  tryConsumeCampaign, releaseCampaign, handleStripeInvoicePaid, handleStripeSubscriptionChange,
  handleStripeOneOffIntent, handlePaystackCharge, handlePaystackSubscriptionEnded, paystackPlanName,
} = await import("../server/services/socialPlans");
const {
  createScheduledCampaign, cancelCampaign, runDueSends, failStuckSends, runImmediateCampaign,
  disconnectLapsedAccounts, sendExpiryReminders, sendLegacyConnectionNotices,
} = await import("../server/services/socialCampaigns");
const { loadTarget } = await import("../server/services/promoTargets");
const { activateTopup, applyTopupPayment, handleStripeTopupIntent } = await import("../server/services/socialPlans");
const { postToSocials } = await import("../server/services/socialPromotionService");
const { handleZernioEvent, verifyZernioSignature } = await import("../server/zernioWebhook");
const { getSocialPlanAdminStats } = await import("../server/services/socialAdminStats");
const { tierPrice, zernioMonthlyBillUsd } = await import("../shared/socialPlans");

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, extra: unknown = "") => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${JSON.stringify(extra)}`}`);
};

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;
const tag = Date.now().toString(36);
const mkUser = async (name: string) =>
  (await q(`insert into users (email, username, user_type, is_verified) values ($1,$2,'organizer',true) returning id`,
    [`${name}-${tag}@t.dev`, `${name}_${tag}`]))[0].id as string;
const connect = (userId: string, platform: string) =>
  q(`insert into connected_socials (user_id, platform, zernio_account_id) values ($1,$2,$3)`, [userId, platform, `acc-${platform}-${userId}`]);
const DAY = 86_400_000;

// ── no plan ─────────────────────────────────────────────────────────────────
const u1 = await mkUser("noplan");
check("no pass → no active pass", (await getActivePass(u1)) === undefined);
const g0 = await canConnectPlatform(u1, "instagram");
check("no plan → connect refused with 402 NO_PLAN", !g0.ok && g0.status === 402 && g0.code === "NO_PLAN", g0);
check("summary says inactive", (await getPlanSummary(u1)).active === false);

// ── one-off pass, idempotency ───────────────────────────────────────────────
const a = await activatePass({ userId: u1, tier: "starter", billing: "one_off", provider: "stripe", currency: "GBP",
  amountPaid: tierPrice("starter", "GBP", "one_off"), providerPaymentId: `pi_${tag}_1` });
const b = await activatePass({ userId: u1, tier: "starter", billing: "one_off", provider: "stripe", currency: "GBP",
  amountPaid: tierPrice("starter", "GBP", "one_off"), providerPaymentId: `pi_${tag}_1` });
check("first activation creates a pass", a.created === true);
check("replaying the same payment creates nothing", b.created === false && b.pass.id === a.pass.id);
check("only one row exists for the payment", (await q(`select count(*)::int n from social_passes where provider_payment_id=$1`, [`pi_${tag}_1`]))[0].n === 1);
check("one ledger row (not two) for the payment", (await q(`select count(*)::int n from payment_transactions where provider_payment_id=$1 and type='social_promotion'`, [`pi_${tag}_1`]))[0].n === 1);
check("one-off pass lasts 30 days, no auto-renew",
  Math.abs(a.pass.endsAt.getTime() - a.pass.startsAt.getTime() - 30 * DAY) < 1000 && a.pass.autoRenew === false);
const active1 = await getActivePass(u1);
check("pass is now active", active1?.id === a.pass.id);

// ── platform cap (Starter = 2) ──────────────────────────────────────────────
check("first platform allowed", (await canConnectPlatform(u1, "instagram")).ok === true);
await connect(u1, "instagram");
await connect(u1, "twitter");
const g3 = await canConnectPlatform(u1, "tiktok");
check("third platform on Starter blocked with PLATFORM_LIMIT", !g3.ok && g3.status === 403 && g3.code === "PLATFORM_LIMIT", g3);
check("reconnecting an already-connected platform still allowed", (await canConnectPlatform(u1, "twitter")).ok === true);

// ── purchase blocking ───────────────────────────────────────────────────────
check("a plan is already active → another purchase is blocked", !!(await findBlockingPass(u1)));

// ── atomic campaign allowance (Starter = 3) ─────────────────────────────────
const burst = await Promise.all(Array.from({ length: 10 }, () => tryConsumeCampaign(a.pass.id, 3)));
check("10 simultaneous requests take exactly 3 campaigns", burst.filter(Boolean).length === 3, burst);
check("campaigns_used is 3, never over", (await q(`select campaigns_used from social_passes where id=$1`, [a.pass.id]))[0].campaigns_used === 3);
check("a 4th campaign is refused", (await tryConsumeCampaign(a.pass.id, 3)) === false);
await releaseCampaign(a.pass.id);
check("releasing gives one back", (await tryConsumeCampaign(a.pass.id, 3)) === true);
await releaseCampaign(a.pass.id); await releaseCampaign(a.pass.id); await releaseCampaign(a.pass.id); await releaseCampaign(a.pass.id);
check("release never goes below zero", (await q(`select campaigns_used from social_passes where id=$1`, [a.pass.id]))[0].campaigns_used === 0);

// ── tier precedence + expiry ────────────────────────────────────────────────
const g = await activatePass({ userId: u1, tier: "growth", billing: "one_off", provider: "stripe", currency: "GBP",
  amountPaid: tierPrice("growth", "GBP", "one_off"), providerPaymentId: `pi_${tag}_2` });
check("higher tier takes over while lower is still running", (await getActivePass(u1))?.id === g.pass.id);
check("Growth allows a 3rd platform", (await canConnectPlatform(u1, "tiktok")).ok === true);
await q(`update social_passes set ends_at = now() - interval '1 minute' where user_id=$1`, [u1]);
check("expired passes are not active", (await getActivePass(u1)) === undefined);
check("expired plan blocks consume", (await tryConsumeCampaign(g.pass.id, 8)) === false);

// ── Stripe recurring: invoice.paid ──────────────────────────────────────────
const u2 = await mkUser("stripe-sub");
const start = Math.floor(Date.now() / 1000), end = start + 30 * 86400;
const invoice = (id: string, amount: number, extra: any = {}) => ({
  id, amount_paid: amount, currency: "gbp", customer: "cus_1",
  parent: { subscription_details: { subscription: "sub_1", metadata: { type: "social_plan", tier: "growth", userId: u2 } } },
  lines: { data: [{ period: { start, end } }] }, ...extra,
});
await handleStripeInvoicePaid(invoice(`in_${tag}_1`, tierPrice("growth", "GBP", "recurring")));
const sp = (await q(`select * from social_passes where user_id=$1`, [u2]))[0];
check("invoice.paid creates a recurring Growth pass", sp?.tier === "growth" && sp?.billing === "recurring" && sp?.auto_renew === true, sp);
check("pass runs to period end + 1 day grace", sp && Math.abs(new Date(sp.ends_at + "Z").getTime() - (end * 1000 + DAY)) < 2000, sp?.ends_at);
check("subscription + customer ids stored", sp?.provider_subscription_id === "sub_1" && sp?.provider_customer_id === "cus_1");
await handleStripeInvoicePaid(invoice(`in_${tag}_1`, tierPrice("growth", "GBP", "recurring")));
check("replayed invoice does not add a pass", (await q(`select count(*)::int n from social_passes where user_id=$1`, [u2]))[0].n === 1);
await handleStripeInvoicePaid(invoice(`in_${tag}_2`, 0));
check("zero-amount invoice is ignored", (await q(`select count(*)::int n from social_passes where user_id=$1`, [u2]))[0].n === 1);
await handleStripeInvoicePaid(invoice(`in_${tag}_3`, 999, { parent: { subscription_details: { subscription: "sub_x", metadata: { type: "something_else" } } } }));
check("someone else's subscription invoice is ignored", (await q(`select count(*)::int n from social_passes where user_id=$1`, [u2]))[0].n === 1);
await handleStripeSubscriptionChange({ id: "sub_1", status: "active", cancel_at_period_end: true, metadata: { type: "social_plan" } }, false);
check("cancel-at-period-end switches auto-renew off", (await q(`select auto_renew from social_passes where user_id=$1`, [u2]))[0].auto_renew === false);
check("pass stays usable after cancelling renewal", (await getActivePass(u2)) !== undefined);

// ── Stripe one-off webhook ──────────────────────────────────────────────────
const u3 = await mkUser("stripe-oneoff");
await handleStripeOneOffIntent({ id: `pi_${tag}_w1`, amount: 1, currency: "gbp", metadata: { type: "social_plan", billing: "one_off", tier: "pro", userId: u3 } });
check("one-off webhook with wrong amount is refused", (await getActivePass(u3)) === undefined);
await handleStripeOneOffIntent({ id: `pi_${tag}_w2`, amount: tierPrice("pro", "GBP", "one_off"), currency: "gbp", metadata: { type: "social_plan", billing: "one_off", tier: "pro", userId: u3 } });
check("one-off webhook with right amount activates Pro", (await getActivePass(u3))?.tier === "pro");

// ── Paystack ────────────────────────────────────────────────────────────────
const u4 = await mkUser("paystack");
const email = `paystack-${tag}@t.dev`;
const firstCharge = { reference: `ps_${tag}_1`, customer: { email, customer_code: "CUS_abc" } };
const ngnRecurring = tierPrice("starter", "NGN", "recurring");
const handled = await handlePaystackCharge(firstCharge, { amountSmallestUnit: ngnRecurring, currency: "NGN", metadata: { type: "social_plan", billing: "recurring", tier: "starter", userId: u4 } });
check("first Paystack charge is recognised as a social plan", handled === true);
check("first Paystack charge creates a recurring Starter pass", (await getActivePass(u4))?.billing === "recurring");
const renewal = { reference: `ps_${tag}_2`, customer: { email, customer_code: "CUS_abc" }, plan: { name: paystackPlanName("starter", ngnRecurring) } };
check("renewal charge (no metadata) is recognised", (await handlePaystackCharge(renewal, { amountSmallestUnit: ngnRecurring, currency: "NGN", metadata: {} })) === true);
check("renewal added a second period for the right user", (await q(`select count(*)::int n from social_passes where user_id=$1`, [u4]))[0].n === 2);
check("a ticket payment is not mistaken for a plan", (await handlePaystackCharge({ reference: `ps_${tag}_t` }, { amountSmallestUnit: 100, currency: "NGN", metadata: { eventId: "e1" } })) === false);
await handlePaystackCharge({ reference: `ps_${tag}_3`, customer: { email, customer_code: "CUS_abc" } }, { amountSmallestUnit: 5, currency: "NGN", metadata: { type: "social_plan", billing: "one_off", tier: "pro", userId: u4 } });
check("Paystack one-off with wrong amount is refused", (await getActivePass(u4))?.tier === "starter");
await handlePaystackSubscriptionEnded({ plan: { name: paystackPlanName("starter", ngnRecurring) }, customer: { customer_code: "CUS_abc" } });
check("subscription.disable switches auto-renew off", (await q(`select bool_or(auto_renew) a from social_passes where user_id=$1`, [u4]))[0].a === false);


// ═══ Scheduling ═════════════════════════════════════════════════════════════
const MIN = 60_000;
const inMin = (m: number) => new Date(Date.now() + m * MIN);
const owner = await mkUser("sched-owner");
const stranger = await mkUser("sched-stranger");
const mkEvent = async (organizerId: string, daysAhead = 10) =>
  (await q(`insert into events (organizer_id,title,description,event_date,location,category,tickets_available,moderation_status)
            values ($1,'Sched Night','d', now() + ($2 || ' days')::interval,'London','Music',100,'approved') returning id`,
    [organizerId, String(daysAhead)]))[0].id as string;
const ev = await mkEvent(owner);
const pg1 = await activatePass({ userId: owner, tier: "growth", billing: "one_off", provider: "stripe", currency: "GBP",
  amountPaid: tierPrice("growth", "GBP", "one_off"), providerPaymentId: `pi_${tag}_s1` });
for (const p of ["instagram", "twitter", "facebook"]) await connect(owner, p);
const used = async () => (await q(`select campaigns_used from social_passes where id=$1`, [pg1.pass.id]))[0].campaigns_used as number;
const ALL = ["instagram", "twitter", "facebook"];
const base = { userId: owner, eventId: ev, platforms: ALL, timezone: "Europe/London" };

// refusals leave the allowance untouched
const refuse = async (name: string, over: Record<string, unknown>, code: string) => {
  const before = await used();
  const r: any = await createScheduledCampaign({ ...base, times: [inMin(60)], ...over } as any);
  check(name, r.ok === false && r.code === code && (await used()) === before, { r, used: await used(), before });
};
await refuse("a time less than 5 minutes away is refused", { times: [inMin(2)] }, "TOO_SOON");
await refuse("a time after the event starts is refused", { times: [new Date(Date.now() + 11 * DAY)] }, "AFTER_EVENT");
await refuse("a time after the plan ends is refused", { times: [new Date(Date.now() + 31 * DAY)], eventId: await mkEvent(owner, 60) }, "AFTER_PLAN");
await refuse("two times closer than 30 minutes are refused", { times: [inMin(60), inMin(75)] }, "TOO_CLOSE");
await refuse("4 times on Growth (limit 3) are refused", { times: [inMin(60), inMin(120), inMin(180), inMin(240)] }, "TIMES_LIMIT");
await refuse("an unconnected platform is refused", { platforms: ["instagram", "tiktok"] }, "NOT_CONNECTED");
const rNoPlan: any = await createScheduledCampaign({ ...base, userId: stranger, times: [inMin(60)] });
check("a user with no plan is refused", rNoPlan.ok === false && rNoPlan.code === "NOT_OWNER" || rNoPlan.code === "NO_PLAN", rNoPlan);
await activatePass({ userId: stranger, tier: "pro", billing: "one_off", provider: "stripe", currency: "GBP",
  amountPaid: 1, providerPaymentId: `pi_${tag}_s2` });
const rNot: any = await createScheduledCampaign({ ...base, userId: stranger, times: [inMin(60)] });
check("scheduling for an event you do not own is refused", rNot.ok === false && rNot.code === "NOT_OWNER", rNot);
await q(`update events set is_cancelled=true where id=$1`, [ev]);
await refuse("a cancelled event is refused", { times: [inMin(60)] }, "EVENT_CANCELLED");
await q(`update events set is_cancelled=false where id=$1`, [ev]);

// happy path: 3 times
const c1: any = await createScheduledCampaign({ ...base, times: [inMin(180), inMin(60), inMin(120)] });
check("3-time campaign is created", c1.ok === true, c1);
check("it takes exactly one campaign from the plan", (await used()) === 1);
const sends1 = await q(`select id, send_index, status from social_campaign_sends where campaign_id=$1 order by send_index`, [c1.campaignId]);
check("sends are stored in time order, all scheduled", sends1.length === 3 && sends1.every((s: any) => s.status === "scheduled"));
check("nothing posts before it is due", (await runDueSends()) === 0 && zernioPosts().length === 0);

// first send becomes due → posts to everything
await q(`update social_campaign_sends set run_at = now() - interval '1 minute' where id=$1`, [sends1[0].id]);
const mark1 = zernioPosts().length;
check("the due send runs", (await runDueSends()) === 1);
check("first send posts to all 3 platforms including X", platformsSince(mark1) === "facebook,instagram,twitter", platformsSince(mark1));
check("first send is marked sent", (await q(`select status from social_campaign_sends where id=$1`, [sends1[0].id]))[0].status === "sent");
check("running again does not repeat the send", (await runDueSends()) === 0 && zernioPosts().length === mark1 + 3);

// second send → X is skipped (already posted once for this campaign)
await q(`update social_posts set posted_at = now() - interval '1 hour' where event_id=$1`, [ev]); // clear the 2-minute duplicate guard
await q(`update social_campaign_sends set run_at = now() - interval '1 minute' where id=$1`, [sends1[1].id]);
const mark2 = zernioPosts().length;
await runDueSends();
check("second send skips X, posts to the others", platformsSince(mark2) === "facebook,instagram", platformsSince(mark2));

// cancel after one send went out
const cx: any = await cancelCampaign(owner, c1.campaignId);
check("cancelling after a send went out does not return the campaign", cx.ok && cx.allowanceReturned === false && (await used()) === 1, cx);
check("the unsent third send is cancelled", (await q(`select status from social_campaign_sends where id=$1`, [sends1[2].id]))[0].status === "cancelled");
check("posted sends keep their status", (await q(`select status from social_campaign_sends where id=$1`, [sends1[0].id]))[0].status === "sent");
check("another user cannot cancel it", ((await cancelCampaign(stranger, c1.campaignId)) as any).code === "NOT_FOUND");

// cancel early → returned, only once
const c2: any = await createScheduledCampaign({ ...base, times: [inMin(120)] });
check("second campaign takes another campaign", c2.ok && (await used()) === 2);
const cx2: any = await cancelCampaign(owner, c2.campaignId);
check("cancelling well before the first send returns the campaign", cx2.allowanceReturned === true && (await used()) === 1, cx2);
await cancelCampaign(owner, c2.campaignId);
check("cancelling twice does not return it twice", (await used()) === 1);

// cancel too late → spent
const c3: any = await createScheduledCampaign({ ...base, times: [inMin(10)] });
const cx3: any = await cancelCampaign(owner, c3.campaignId);
check("cancelling inside the 15-minute cutoff keeps the campaign spent", cx3.ok && cx3.allowanceReturned === false && (await used()) === 2, cx3);

// event unapproved by send time → skipped and the campaign comes back
const c4: any = await createScheduledCampaign({ ...base, times: [inMin(60)] });
const usedBefore = await used();
await q(`update events set moderation_status='pending' where id=$1`, [ev]);
await q(`update social_campaign_sends set run_at = now() - interval '1 minute' where campaign_id=$1`, [c4.campaignId]);
const postsBefore = zernioPosts().length;
await runDueSends();
await q(`update events set moderation_status='approved' where id=$1`, [ev]);
check("an event pulled from moderation is not posted", zernioPosts().length === postsBefore);
check("that send is skipped", (await q(`select status from social_campaign_sends where campaign_id=$1`, [c4.campaignId]))[0].status === "skipped");
check("the unused campaign goes back to the plan", (await used()) === usedBefore - 1, { used: await used(), usedBefore });

// interrupted send → failed, not retried, campaign returned
const c5: any = await createScheduledCampaign({ ...base, times: [inMin(60)] });
const usedBefore5 = await used();
await q(`update social_campaign_sends set status='sending', claimed_at = now() - interval '20 minutes' where campaign_id=$1`, [c5.campaignId]);
check("a send stuck in 'sending' is failed, not retried", (await failStuckSends()) === 1 && (await q(`select status from social_campaign_sends where campaign_id=$1`, [c5.campaignId]))[0].status === "failed");
check("and the campaign returns because nothing was posted", (await used()) === usedBefore5 - 1);

// ═══ Plan lifecycle ═════════════════════════════════════════════════════════
const zDeletes = () => calls.filter((c) => c.method === "DELETE").length;
const mkConn = async (userId: string, platform: string) => {
  await q(`insert into connected_socials (user_id, platform, zernio_account_id) values ($1,$2,$3)`, [userId, platform, `acc-${platform}-${userId}`]);
};
const isConnected = async (userId: string, platform: string) =>
  (await q(`select disconnected_at from connected_socials where user_id=$1 and platform=$2`, [userId, platform]))[0].disconnected_at === null;

const lapsed = await mkUser("lapsed");           // plan ended 10 days ago
const inGrace = await mkUser("ingrace");          // plan ended 3 days ago
const live = await mkUser("live");                // plan active
for (const [u, endDays] of [[lapsed, -10], [inGrace, -3], [live, 20]] as const) {
  await mkConn(u, "instagram");
  const r = await activatePass({ userId: u, tier: "starter", billing: "one_off", provider: "stripe", currency: "GBP", amountPaid: 1299, providerPaymentId: `pi_${tag}_${u}` });
  await q(`update social_passes set starts_at = now() - interval '40 days', ends_at = now() + ($2 || ' days')::interval where id=$1`, [r.pass.id, String(endDays)]);
}
const deletesBefore = zDeletes();
await disconnectLapsedAccounts();
check("account of a plan that ended 10 days ago is disconnected", !(await isConnected(lapsed, "instagram")));
check("account within the 7-day grace period stays", await isConnected(inGrace, "instagram"));
check("account with an active plan stays", await isConnected(live, "instagram"));
check("the lapsed account was also revoked on Zernio", zDeletes() === deletesBefore + 1, { deletes: zDeletes() - deletesBefore });

// expiry reminders
const soon = await mkUser("soon");
const soonPass = await activatePass({ userId: soon, tier: "growth", billing: "one_off", provider: "stripe", currency: "GBP", amountPaid: 3299, providerPaymentId: `pi_${tag}_soon` });
await q(`update social_passes set ends_at = now() + interval '2 days' where id=$1`, [soonPass.pass.id]);
const renewed = await mkUser("renewed");
const rp1 = await activatePass({ userId: renewed, tier: "starter", billing: "one_off", provider: "stripe", currency: "GBP", amountPaid: 1299, providerPaymentId: `pi_${tag}_r1` });
await q(`update social_passes set ends_at = now() + interval '2 days' where id=$1`, [rp1.pass.id]);
await activatePass({ userId: renewed, tier: "starter", billing: "one_off", provider: "stripe", currency: "GBP", amountPaid: 1299, providerPaymentId: `pi_${tag}_r2` });
await q(`update social_passes set starts_at = now() + interval '2 days', ends_at = now() + interval '32 days' where provider_payment_id=$1`, [`pi_${tag}_r2`]);
const subbed = await mkUser("subbed");
const sbp = await activatePass({ userId: subbed, tier: "starter", billing: "recurring", provider: "stripe", currency: "GBP", amountPaid: 999, providerPaymentId: `in_${tag}_sub` });
await q(`update social_passes set ends_at = now() + interval '2 days' where id=$1`, [sbp.pass.id]);

const emailCalls = () => calls.filter((c) => c.url.includes("resend")).length;
const emailsBefore = emailCalls();
const n1 = await sendExpiryReminders();
check("exactly one reminder goes out (one-off, ending soon, not renewed)", n1 === 1 && emailCalls() - emailsBefore === 1, { n1, emails: emailCalls() - emailsBefore });
check("the reminder is marked sent", (await q(`select expiry_reminder_sent_at from social_passes where id=$1`, [soonPass.pass.id]))[0].expiry_reminder_sent_at !== null);
check("a user who already bought the next period is not reminded", (await q(`select expiry_reminder_sent_at from social_passes where id=$1`, [rp1.pass.id]))[0].expiry_reminder_sent_at === null);
check("an auto-renewing subscriber is not reminded", (await q(`select expiry_reminder_sent_at from social_passes where id=$1`, [sbp.pass.id]))[0].expiry_reminder_sent_at === null);
check("running again sends no second reminder", (await sendExpiryReminders()) === 0);



// ═══ Venue promotion ════════════════════════════════════════════════════════
const mkVenue = async (ownerId: string) =>
  (await q(`insert into venues (owner_id, name, category, location, address, description)
            values ($1,'Club Zephyr','Nightclub','12 Dock Rd, London','12 Dock Rd, London','Rooftop bar & club') returning id`, [ownerId]))[0].id as string;
const mkNight = async (venueId: string, hours = 72, approved = true) =>
  (await q(`insert into venue_entry_nights (venue_id, name, date, cover_price_cents, moderation_status)
            values ($1,'Afro Fridays', now() + ($2 || ' hours')::interval, 1000, $3) returning id`, [venueId, String(hours), approved ? "approved" : "pending"]))[0].id as string;
const venueId = await mkVenue(owner);
const nightId = await mkNight(venueId);
const strangersVenue = await mkVenue(stranger);

const tv: any = await loadTarget(owner, { venueId });
check("owner can promote their venue", tv.ok && tv.target.kind === "venue" && tv.target.startsAt === null, tv);
check("venue post text has the venue name and link", tv.ok && tv.target.content.includes("Club Zephyr") && tv.target.content.includes(`/venues/${venueId}`), tv.target?.content);
const tn: any = await loadTarget(owner, { venueNightId: nightId });
check("owner can promote a venue night", tn.ok && tn.target.kind === "venue_night" && tn.target.cols.venueId === venueId, tn);
check("night post text has night, venue and date", tn.ok && tn.target.content.includes("Afro Fridays") && tn.target.content.includes("Club Zephyr"), tn.target?.content);
check("someone else's venue is refused", (await loadTarget(owner, { venueId: strangersVenue }) as any).code === "NOT_OWNER");
check("a night of someone else's venue is refused", (await loadTarget(owner, { venueNightId: await mkNight(strangersVenue) }) as any).code === "NOT_OWNER");
check("an unapproved night is refused", (await loadTarget(owner, { venueNightId: await mkNight(venueId, 72, false) }) as any).code === "NOT_APPROVED");
check("a target must be an event OR a venue, not both or neither",
  (await loadTarget(owner, { eventId: ev, venueId }) as any).code === "BAD_TARGET" && (await loadTarget(owner, {}) as any).code === "BAD_TARGET");

// schedule a night: sends must be before the night starts
const usedV0 = await used();
const vBad: any = await createScheduledCampaign({ userId: owner, venueNightId: nightId, platforms: ["instagram"], times: [inMin(80 * 60)], timezone: "Europe/London" });
check("a time after the night starts is refused", vBad.ok === false && vBad.code === "AFTER_EVENT", vBad);
const vc: any = await createScheduledCampaign({ userId: owner, venueNightId: nightId, platforms: ["instagram", "twitter"], times: [inMin(60)], timezone: "Europe/London" });
check("a venue night campaign is created", vc.ok === true && (await used()) === usedV0 + 1, vc);
const vSend = (await q(`select id from social_campaign_sends where campaign_id=$1`, [vc.campaignId]))[0].id;
await q(`update social_campaign_sends set run_at = now() - interval '1 minute' where id=$1`, [vSend]);
const markV = zernioPosts().length;
await runDueSends();
check("the venue night send posts to both platforms", platformsSince(markV) === "instagram,twitter", platformsSince(markV));
const vPost = (await q(`select venue_id, venue_night_id, event_id, content from social_posts where venue_night_id=$1 limit 1`, [nightId]))[0];
check("the post is recorded against the venue night, not an event", vPost && vPost.venue_id === venueId && vPost.event_id === null && vPost.content.includes("Afro Fridays"), vPost);
const vList = await (await import("../server/services/socialCampaigns")).listCampaigns(owner, { venueNightId: nightId });
check("campaigns can be listed by venue night, with a readable title", vList.length === 1 && vList[0].eventTitle === "Afro Fridays at Club Zephyr", vList[0]?.eventTitle);

// whole-venue campaign: no end date, bounded only by the plan
const usedV1 = await used();
const vv: any = await createScheduledCampaign({ userId: owner, venueId, platforms: ["facebook"], times: [new Date(Date.now() + 20 * DAY)], timezone: "Europe/London" });
check("a whole-venue campaign can be scheduled weeks ahead", vv.ok === true && (await used()) === usedV1 + 1, vv);
await cancelCampaign(owner, vv.campaignId);

// venue posts and event posts don't block each other's duplicate guard
const markDup = zernioPosts().length;
await q(`update social_posts set posted_at = now() - interval '1 hour' where venue_night_id=$1`, [nightId]);
const vc2: any = await createScheduledCampaign({ userId: owner, venueId, platforms: ["facebook"], times: [inMin(60)], timezone: "UTC" });
await q(`update social_campaign_sends set run_at = now() - interval '1 minute' where campaign_id=$1`, [vc2.campaignId]);
await runDueSends();
check("a venue post is not blocked by a recent post for one of its nights", platformsSince(markDup) === "facebook", platformsSince(markDup));

// ═══ Zernio webhook ═════════════════════════════════════════════════════════
const crypto = await import("node:crypto");
const body = Buffer.from(JSON.stringify({ event: "post.published" }));
const goodSig = crypto.createHmac("sha256", "whsec").update(body).digest("hex");
check("a correct signature verifies", verifyZernioSignature(body, goodSig, "whsec"));
check("a sha256= prefixed signature verifies", verifyZernioSignature(body, `sha256=${goodSig}`, "whsec"));
check("a wrong signature is rejected", !verifyZernioSignature(body, goodSig.replace(/.$/, "0"), "whsec") || goodSig.endsWith("0"));
check("a signature made with another secret is rejected", !verifyZernioSignature(body, goodSig, "other"));
check("a missing or short signature is rejected", !verifyZernioSignature(body, undefined, "whsec") && !verifyZernioSignature(body, "abc", "whsec"));
check("a changed body is rejected", !verifyZernioSignature(Buffer.from("{}"), goodSig, "whsec"));

const wUser = await mkUser("webhook");
const wEv = await mkEvent(wUser);
const mkPost = async (zid: string, status = "posted") =>
  (await q(`insert into social_posts (event_id, user_id, platform, zernio_post_id, content, status) values ($1,$2,'instagram',$3,'x',$4) returning id`, [wEv, wUser, zid, status]))[0].id as string;
const p1 = await mkPost(`zp_${tag}_1`);
await handleZernioEvent({ event: "post.published", post: { id: `zp_${tag}_1`, platforms: [{ platform: "instagram", publishedUrl: "https://instagram.com/p/abc" }] } });
const r1 = (await q(`select status, confirmed_at, platform_post_url from social_posts where id=$1`, [p1]))[0];
check("post.published confirms the post and stores its link", r1.confirmed_at !== null && r1.platform_post_url === "https://instagram.com/p/abc" && r1.status === "posted", r1);
await handleZernioEvent({ event: "post.published", post: { id: `zp_${tag}_1`, platforms: [{ publishedUrl: "https://elsewhere" }] } });
check("a repeated delivery changes nothing", (await q(`select platform_post_url from social_posts where id=$1`, [p1]))[0].platform_post_url === "https://instagram.com/p/abc");
const p2 = await mkPost(`zp_${tag}_2`);
await handleZernioEvent({ event: "post.failed", post: { id: `zp_${tag}_2`, platforms: [{ error: { message: "Token expired" } }] } });
const r2 = (await q(`select status, error_message from social_posts where id=$1`, [p2]))[0];
check("post.failed marks the post failed with the reason", r2.status === "failed" && r2.error_message === "Token expired", r2);
await handleZernioEvent({ event: "post.published", post: { id: "zp_does_not_exist" } });
check("an event for an unknown post is ignored", true);

await mkConn(wUser, "instagram");
await handleZernioEvent({ event: "account.disconnected", disconnectionType: "intentional", account: { id: `acc-instagram-${wUser}` } });
check("an intentional disconnect (our own) is ignored", (await q(`select needs_reconnect from connected_socials where user_id=$1`, [wUser]))[0].needs_reconnect === false);
await handleZernioEvent({ event: "account.disconnected", disconnectionType: "unintentional", account: { id: `acc-instagram-${wUser}` } });
check("an unintentional disconnect flags the account for reconnect", (await q(`select needs_reconnect from connected_socials where user_id=$1`, [wUser]))[0].needs_reconnect === true);
await q(`update social_posts set posted_at = now() - interval '1 hour' where event_id=$1`, [wEv]); // clear the duplicate guard so the reconnect check is what decides
const pr = await postToSocials({ cols: { eventId: wEv, venueId: null, venueNightId: null }, content: "hello" }, wUser, ["instagram"] as any);
check("posting to a flagged account is refused without calling Zernio", pr.postsCreated === 0 && /reconnect/i.test(pr.platforms[0].error ?? ""), pr);
await q(`insert into connected_socials (user_id, platform, zernio_account_id) values ($1,'facebook','acc-fb-w') on conflict do nothing`, [wUser]);
await handleZernioEvent({ event: "account.connected", account: { id: "acc-fb-w" } });
check("account.connected is ignored", (await q(`select needs_reconnect from connected_socials where platform='facebook' and user_id=$1`, [wUser]))[0].needs_reconnect === false);

// ═══ Launch notice, admin stats, Zernio bill ════════════════════════════════
const legacy = await mkUser("legacy");
await mkConn(legacy, "instagram");
const emailsBeforeNotice = emailCalls();
const noticed = await sendLegacyConnectionNotices();
check("a user with accounts and no plan gets exactly one notice", noticed >= 1 && (await q(`select plan_notice_sent_at from connected_socials where user_id=$1`, [legacy]))[0].plan_notice_sent_at !== null && emailCalls() > emailsBeforeNotice);
check("the notice is not sent twice", (await sendLegacyConnectionNotices()) === 0);
check("a user with a plan gets no notice", (await q(`select plan_notice_sent_at from connected_socials where user_id=$1`, [owner])).every((r: any) => r.plan_notice_sent_at === null));

check("Zernio bill: 2 accounts are free", zernioMonthlyBillUsd(2) === 0);
check("Zernio bill: 12 accounts = 8x$6 + 2x$3", zernioMonthlyBillUsd(12) === 54, zernioMonthlyBillUsd(12));
check("Zernio bill: 41 accounts = 8x$6 + 31x$3", zernioMonthlyBillUsd(41) === 141, zernioMonthlyBillUsd(41));
check("Zernio bill: 105 accounts includes the $1 tier", zernioMonthlyBillUsd(105) === 48 + 270 + 5, zernioMonthlyBillUsd(105));

const stats = await getSocialPlanAdminStats();
check("admin stats count active plans by tier", stats.activePlans.total >= 1 && typeof stats.activePlans.byTier.growth.one_off === "number", stats.activePlans);
check("admin stats include plan revenue from the ledger", stats.revenue30d.byCurrency.GBP > 0 && stats.revenue30d.gbp > 0, stats.revenue30d);
check("admin stats estimate costs and a margin", stats.costs30d.totalGbp > 0 && stats.marginGbp !== undefined, stats.costs30d);
check("admin stats list the health checks", ["overCapUsers", "needsReconnect", "expiring7d", "scheduled24h", "failedSends7d", "stuckSending", "unconfirmedPosts"].every((k) => typeof (stats.health as any)[k] === "number"), stats.health);
check("a flagged account shows up under needs-reconnect", stats.health.needsReconnect >= 1, stats.health);



// ═══ Top-ups ════════════════════════════════════════════════════════════════
const tu = await mkUser("topup");
const tuPass = await activatePass({ userId: tu, tier: "starter", billing: "one_off", provider: "stripe", currency: "GBP",
  amountPaid: tierPrice("starter", "GBP", "one_off"), providerPaymentId: `pi_${tag}_tu0` });
const tuUsed = async () => (await q(`select campaigns_used, extra_campaigns, extra_platforms from social_passes where id=$1`, [tuPass.pass.id]))[0];
check("a second plan is refused while one is running, whatever the tier", !!(await findBlockingPass(tu)));

for (let i = 0; i < 3; i++) await tryConsumeCampaign(tuPass.pass.id, 3);
check("Starter is out of campaigns after 3", (await tryConsumeCampaign(tuPass.pass.id, 3)) === false);
const t1 = await activateTopup({ userId: tu, pack: "campaigns_2", provider: "stripe", currency: "GBP", amountPaid: 799, providerPaymentId: `pi_${tag}_tu1` });
check("a +2 campaigns top-up is applied", t1.ok && t1.created && (await tuUsed()).extra_campaigns === 2, t1);
check("it adds two more campaigns, and no more", (await tryConsumeCampaign(tuPass.pass.id, 3)) && (await tryConsumeCampaign(tuPass.pass.id, 3)) && !(await tryConsumeCampaign(tuPass.pass.id, 3)));
const sum = await getPlanSummary(tu);
check("the plan summary reports the bigger limit", sum.campaignsLimit === 5 && sum.campaignsLeft === 0 && sum.extraCampaigns === 2, sum);
const t1b = await activateTopup({ userId: tu, pack: "campaigns_2", provider: "stripe", currency: "GBP", amountPaid: 799, providerPaymentId: `pi_${tag}_tu1` });
check("the same payment replayed adds nothing", t1b.ok && !t1b.created && (await tuUsed()).extra_campaigns === 2);
check("one ledger row per top-up payment", (await q(`select count(*)::int n from payment_transactions where provider_payment_id=$1`, [`pi_${tag}_tu1`]))[0].n === 1);

await connect(tu, "instagram"); await connect(tu, "twitter");
const g3t: any = await canConnectPlatform(tu, "tiktok");
check("a 3rd platform is blocked on Starter", !g3t.ok && g3t.code === "PLATFORM_LIMIT");
check("the block message points at top-ups, not upgrades", /top-up/i.test(g3t.message) && !/upgrade/i.test(g3t.message), g3t.message);
await activateTopup({ userId: tu, pack: "platform_1", provider: "stripe", currency: "GBP", amountPaid: 699, providerPaymentId: `pi_${tag}_tu2` });
check("a platform top-up lets a 3rd platform connect", (await canConnectPlatform(tu, "tiktok")).ok === true && (await getPlanSummary(tu)).maxPlatforms === 3);
await activateTopup({ userId: tu, pack: "platform_1", provider: "stripe", currency: "GBP", amountPaid: 699, providerPaymentId: `pi_${tag}_tu3` });
check("a second platform top-up works (max 2 extra)", (await tuUsed()).extra_platforms === 2);
const t4 = await activateTopup({ userId: tu, pack: "platform_1", provider: "stripe", currency: "GBP", amountPaid: 699, providerPaymentId: `pi_${tag}_tu4` });
check("a third platform top-up is refused", !t4.ok && t4.reason === "platform_cap" && (await tuUsed()).extra_platforms === 2, t4);
check("the summary says no more platform top-ups", (await getPlanSummary(tu)).canAddPlatformTopup === false);

const noPlanUser = await mkUser("topup-noplan");
const tNo = await activateTopup({ userId: noPlanUser, pack: "campaigns_2", provider: "stripe", currency: "GBP", amountPaid: 799, providerPaymentId: `pi_${tag}_tu5` });
check("a top-up with no active plan is not applied", !tNo.ok && tNo.reason === "no_plan", tNo);

const bad1 = await applyTopupPayment({ userId: tu, pack: "campaigns_2", provider: "stripe", currency: "GBP", amountPaid: 1, providerPaymentId: `pi_${tag}_tu6` });
check("a top-up payment with the wrong amount is rejected", !bad1.ok && bad1.reason === "invalid" && (await tuUsed()).extra_campaigns === 2, bad1);
const bad2 = await applyTopupPayment({ userId: tu, pack: "free_stuff", provider: "stripe", currency: "GBP", amountPaid: 799, providerPaymentId: `pi_${tag}_tu7` });
check("an unknown top-up pack is rejected", !bad2.ok && bad2.reason === "invalid");

const tu2 = await mkUser("topup2");
const tu2Pass = await activatePass({ userId: tu2, tier: "starter", billing: "one_off", provider: "stripe", currency: "GBP", amountPaid: 1299, providerPaymentId: `pi_${tag}_tw0` });
await handleStripeTopupIntent({ id: `pi_${tag}_tw1`, amount: 1799, currency: "gbp", metadata: { type: "social_topup", pack: "campaigns_5", userId: tu2 } });
check("the Stripe webhook applies a top-up", (await q(`select extra_campaigns from social_passes where id=$1`, [tu2Pass.pass.id]))[0].extra_campaigns === 5);
await handlePaystackCharge({ reference: `ps_${tag}_tw2` }, { amountSmallestUnit: 1_480_000, currency: "NGN", metadata: { type: "social_topup", pack: "campaigns_2", userId: tu2 } });
check("the Paystack webhook applies a top-up", (await q(`select extra_campaigns from social_passes where id=$1`, [tu2Pass.pass.id]))[0].extra_campaigns === 7);
check("a Paystack top-up is not mistaken for a ticket payment", (await handlePaystackCharge({ reference: `ps_${tag}_tw3` }, { amountSmallestUnit: 1_480_000, currency: "NGN", metadata: { type: "social_topup", pack: "campaigns_2", userId: tu2 } })) === true);

// ═══ Late Zernio failures give the campaign back ════════════════════════════
const lf = await mkUser("latefail");
const lfPass = await activatePass({ userId: lf, tier: "growth", billing: "one_off", provider: "stripe", currency: "GBP", amountPaid: 3299, providerPaymentId: `pi_${tag}_lf0` });
await connect(lf, "instagram"); await connect(lf, "facebook");
const lfUsed = async () => (await q(`select campaigns_used from social_passes where id=$1`, [lfPass.pass.id]))[0].campaigns_used as number;
const lfUse = async (ev: string) => {
  const t: any = await loadTarget(lf, { eventId: ev });
  const ok = await tryConsumeCampaign(lfPass.pass.id, 8);
  return runImmediateCampaign({ userId: lf, target: t.target, platforms: ["instagram", "facebook"], passId: lfPass.pass.id }).then((o) => ({ o, ok }));
};
const postIds = async (campaignId: string) =>
  (await q(`select zernio_post_id, platform from social_posts where campaign_id=$1 order by platform`, [campaignId])) as Array<{ zernio_post_id: string; platform: string }>;
const sendOf = async (campaignId: string) => (await q(`select status from social_campaign_sends where campaign_id=$1`, [campaignId]))[0].status as string;
const releasedOf = async (campaignId: string) => (await q(`select allowance_released from social_campaigns where id=$1`, [campaignId]))[0].allowance_released as boolean;

// scenario A: both accepted, then the platforms reject them one by one
const evA = await mkEvent(lf);
const { o: oA } = await lfUse(evA);
check("post now runs as a campaign and posts to both platforms", oA.status === "sent" && oA.result?.postsCreated === 2, oA);
check("it used one campaign", (await lfUsed()) === 1);
const pA = await postIds(oA.campaignId);
check("each post remembers its campaign and send", pA.length === 2 && (await q(`select count(*)::int n from social_posts where campaign_id=$1 and send_id is not null`, [oA.campaignId]))[0].n === 2);
await handleZernioEvent({ event: "post.failed", post: { id: pA[0].zernio_post_id, platforms: [{ error: "rejected" }] } });
check("one post failing later makes the send partial", (await sendOf(oA.campaignId)) === "partial", await sendOf(oA.campaignId));
check("and the campaign stays used while one post stands", (await lfUsed()) === 1 && (await releasedOf(oA.campaignId)) === false);
await handleZernioEvent({ event: "post.failed", post: { id: pA[1].zernio_post_id, platforms: [{ error: "rejected" }] } });
check("the second failing makes the send failed", (await sendOf(oA.campaignId)) === "failed", await sendOf(oA.campaignId));
check("now the campaign goes back to the plan", (await lfUsed()) === 0 && (await releasedOf(oA.campaignId)) === true);
await handleZernioEvent({ event: "post.failed", post: { id: pA[1].zernio_post_id, platforms: [{ error: "rejected" }] } });
check("a repeated failure notice does not return it twice", (await lfUsed()) === 0);

// scenario B: a confirmed post keeps the campaign spent even if another fails
const evB = await mkEvent(lf);
const { o: oB } = await lfUse(evB);
const pB = await postIds(oB.campaignId);
await handleZernioEvent({ event: "post.published", post: { id: pB[0].zernio_post_id, platforms: [{ publishedUrl: "https://x" }] } });
await handleZernioEvent({ event: "post.failed", post: { id: pB[1].zernio_post_id, platforms: [{ error: "rejected" }] } });
check("one published and one failed keeps the campaign spent", (await lfUsed()) === 1 && (await sendOf(oB.campaignId)) === "partial");

// scenario C: scheduled campaigns get the same treatment
const evC = await mkEvent(lf);
const cC: any = await createScheduledCampaign({ userId: lf, eventId: evC, platforms: ["instagram"], times: [inMin(60)], timezone: "UTC" });
await q(`update social_campaign_sends set run_at = now() - interval '1 minute' where campaign_id=$1`, [cC.campaignId]);
await runDueSends();
check("a scheduled send posted", (await sendOf(cC.campaignId)) === "sent");
const usedBeforeC = await lfUsed();
const pC = await postIds(cC.campaignId);
await handleZernioEvent({ event: "post.failed", post: { id: pC[0].zernio_post_id, platforms: [{ error: "rejected" }] } });
check("its late failure returns the campaign", (await lfUsed()) === usedBeforeC - 1 && (await sendOf(cC.campaignId)) === "failed");

// scenario D: nothing to post at all (event pulled) returns it straight away and says why
const evD = await mkEvent(lf);
const tD: any = await loadTarget(lf, { eventId: evD });
await tryConsumeCampaign(lfPass.pass.id, 8);
const usedBeforeD = await lfUsed();
await q(`update events set moderation_status='pending' where id=$1`, [evD]);
const oD = await runImmediateCampaign({ userId: lf, target: tD.target, platforms: ["instagram"], passId: lfPass.pass.id });
check("post now for an event pulled from moderation posts nothing and says why", oD.status === "skipped" && oD.result === null && !!oD.note, oD);
check("and the campaign goes straight back", (await lfUsed()) === usedBeforeD - 1);


console.log(`\n${passed} passed, ${failed} failed`);
await db.end();
process.exit(failed === 0 ? 0 : 1);
