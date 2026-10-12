# Social promotion (Zernio) — testing

Social promotion is sold as **monthly plans** (Starter / Growth / Pro), monthly (auto-renewing) or a one-off 30-day pass. A plan gives a number of connected platforms and campaigns; a campaign posts an event, a venue, or a venue night to the organizer's connected accounts, now or at scheduled times. Source of truth for tiers, limits and prices: `shared/socialPlans.ts`.

## 1. Automated checks (no live accounts needed)

```
node --env-file=.env scripts/run-social-plans-test.mjs
```

Creates a scratch database, builds the schema, runs `scripts/test-social-plans.ts` with Zernio and Resend faked, and drops the database. It never touches `DATABASE_URL`'s own database. Currently ~150 checks covering:

- passes: activation, replayed payments, tier precedence, expiry, purchase blocking, the platform cap, the campaign allowance under simultaneous requests
- Stripe `invoice.paid` / subscription changes / one-off intents, Paystack first charge, renewal, subscription end
- scheduling rules, send job, X-once-per-campaign, cancel/allowance return, interrupted sends, event pulled before send
- venue and venue-night promotion
- plan lifecycle: lapsed-account disconnect, expiry reminder, launch notice
- top-ups: extra campaigns / platforms, caps, replays, wrong amounts, webhooks
- late Zernio failures: a post rejected after Zernio accepted it flips the send and gives the campaign back (once)
- Zernio webhook signature + events, admin stats, Zernio bill maths

## 2. Setup for live testing

| Item | Notes |
|------|-------|
| `ZERNIO_API_KEY`, `ZERNIO_BASE_URL` | key starts `zernio_live_`; base URL has no trailing slash |
| `ZERNIO_WEBHOOK_SECRET` | any long random string; must equal the secret registered with Zernio |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | use **test** keys; webhook must deliver `invoice.paid`, `customer.subscription.updated`, `customer.subscription.deleted`, `payment_intent.succeeded` |
| `PAYSTACK_SECRET_KEY` | use a **test** key; webhook must deliver `charge.success`, `subscription.create`, `subscription.disable`, `subscription.not_renew` |
| `APP_URL` | public URL; used in post text, checkout return URLs, emails |
| `RESEND_API_KEY`, `FROM_EMAIL` | expiry reminders and the launch notice |

Register the Zernio webhook once per environment:

```
APP_URL=https://<your app> ZERNIO_WEBHOOK_SECRET=<secret> node --env-file=.env scripts/register-zernio-webhook.mjs
```

Then send a test delivery from Zernio (`POST /v1/webhooks/test`) and confirm the server answers 200 (a wrong secret answers 400, a missing `ZERNIO_WEBHOOK_SECRET` answers 503).

## 3. Manual checks that need live providers

Mark each ✅ / ❌ / ⏭️. These are the paths the automated suite fakes, so they are the highest risk.

### 3a. Buying a plan
- [ ] `/organizer/social` with no plan shows the plan picker; GBP and NGN prices match `shared/socialPlans.ts`
- [ ] **One-off, GBP (Stripe test card):** pay → plan shows active for 30 days, Starter meters 0 / 3 campaigns
- [ ] **One-off, NGN (Paystack test card):** same
- [ ] Buying any plan while one is active → refused with the end date and a pointer to top-ups (there is no mid-period upgrade)
- [ ] **Monthly, GBP:** redirected to Stripe Checkout → returns to `/organizer/social?social_plan=success` → "Activating your plan…" then active (webhook `invoice.paid`)
- [ ] **Monthly, NGN:** redirected to Paystack → returns → active. In Paystack, the plan named `vib3-social-<tier>-<kobo>` exists
- [ ] Renewal: trigger the next invoice/charge (Stripe test clock / Paystack) → a second pass row appears, campaigns reset to 0
- [ ] **Cancel renewal** (both providers) → provider shows the subscription cancelling/disabled; plan stays active to the end of the period
- [ ] Failed renewal payment → no new pass; the old one runs out

### 3a-2. Top-ups
- [ ] Use up all campaigns → the promote dialog offers +2 / +5 campaigns, charged in the currency the plan was bought in
- [ ] Pay (Stripe test card, then Paystack test card) → meter grows by the pack size immediately; one `social_topups` row and one ledger row
- [ ] At the platform cap → "+1 connected platform" is offered; after paying, the extra platform connects; a 3rd platform top-up is refused (max 2)
- [ ] Close the browser right after paying → the webhook still applies the top-up (no double apply when you come back)
- [ ] Top-up bought, then the plan period ends → extras are gone with it (they do not carry over)
- [ ] Top-up payment that can't be applied (plan ended between paying and applying) → refunded automatically; check `payment_issues` if the refund call fails

### 3b. Connecting accounts
- [ ] No plan → connect is refused ("Choose a social plan…")
- [ ] Connect up to the cap (Starter 2); a third is refused in the dialog, and by the server if you hit `/api/auth/social/connect` directly
- [ ] Connect two platforms at the same time in two popups → no more than the cap end up connected; extras are revoked on Zernio
- [ ] **OAuth `redirect_url`:** the `state` query parameter survives Zernio's redirect (see the caveat in `server/zernio.ts` `generateOAuthUrl`). If connect always fails with "Security check failed", this is why
- [ ] Disconnect removes it on Zernio and locally

### 3c. Posting
- [ ] Post now to Instagram + X → both appear on the real accounts with the right text and link
- [ ] Post a **venue** and a **venue night** → text is the venue/night text, link goes to `/venues/<id>`
- [ ] Posting the same thing twice within 2 minutes → "Already posted recently"
- [ ] A 4th send to one platform inside 24 h → "Daily limit reached"
- [ ] After a post is published, `social_posts.confirmed_at` and `platform_post_url` fill in (webhook `post.published`)
- [ ] Break a token (revoke the app in the platform's settings) → `account.disconnected` marks the account "Needs reconnect"; posting to it is refused; Reconnect clears it
- [ ] A post the platform rejects → `post.failed` flips the row to `failed` with the reason, the send shows Failed/Partly posted, and **if every post of the campaign failed the campaign comes back to the meter** (one that still has a published post stays spent)

### 3d. Scheduling
- [ ] Schedule 2–3 times (Growth) → "Already scheduled" lists them; each posts at its time (check within ~1 minute)
- [ ] **X posts only once** across the campaign's sends; the other platforms post every time
- [ ] A time that is <5 min away, <30 min after another, after the event/night starts, or after the plan ends → refused with a clear message
- [ ] Cancel ≥15 min before the first post → campaign returns to the meter; cancel closer (or after a send) → it stays used
- [ ] Unapprove the event before its send time → the send is **skipped** (reason shown) and the campaign returns
- [ ] Restart the server mid-send (or kill it) → send shows "Failed · Interrupted while posting" after ~10 min, is not re-posted
- [ ] Timezone: pick 18:00 in your local time; it posts at 18:00 local

### 3e. Plan end and lifecycle
- [ ] One-off pass: reminder email arrives ~3 days before the end (set `ends_at` to now()+2 days in a test DB to trigger it; the job runs hourly at :17)
- [ ] 7 days after the plan ends, connected accounts are disconnected on Zernio and in the app
- [ ] **Launch notice:** an organizer with accounts connected before plans existed gets one email; accounts are disconnected after `SOCIAL_PLANS_LAUNCHED_AT` + 7 days (19 Oct 2026) if they pick no plan

### 3f. Admin (`/admin/social`, finance_manager or super_admin)
- [ ] Plan revenue, estimated costs and margin appear and match `payment_transactions` (type `social_promotion`) for the last 30 days
- [ ] Health checks read 0 where they should (over-cap users, stuck sends, unconfirmed posts)
- [ ] Other admin roles do not see the plan section (the API answers 403)

## 4. Security regression
- [ ] Zernio API key and webhook secret never appear in server logs
- [ ] `/api/webhooks/zernio` with a bad or missing signature → 400; duplicate delivery (same `X-Zernio-Event-Id`) → 200 `duplicate`, no second change
- [ ] Plan/campaign routes reject non-organizers (403) and unauthenticated users (401)
- [ ] Another organizer cannot cancel your campaign (404) or promote your event/venue (403)
- [ ] A payment intent made for one tier cannot activate another (amount and tier are checked against the catalog)
