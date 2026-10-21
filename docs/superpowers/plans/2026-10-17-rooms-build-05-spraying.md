# Rooms build, phase 5: spraying (pay at the moment you throw)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. **Before executing, expand each task into step-level checkboxes with the writing-plans skill.** **GATED (see Gates).** Server and client halves are independent after task 5.1 and can be built by separate agents.

**Goal:** Let a verified adult spray the host or someone the host put on stage: choose a note, bundle, money bag or Make it Rain, pay at that moment by saved card, have the payment split at source, deliver the spray to the room within 60 seconds or reverse it, and show the effects.

**Architecture:** One payment per spray through a `SplitPaymentProvider` interface (Paystack implementation behind it, mock for tests). No wallet and no stored balance anywhere. The server is authoritative: it validates eligibility and limits, takes the payment, confirms delivery, and broadcasts a `room:spray` event. The client animates from that event, using a canvas engine ported from the prototype.

**Tech Stack:** Express, Drizzle/Postgres, Paystack REST (read current docs with WebFetch: initialize with subaccount and transaction_charge, create split, charge_authorization, refund, dispute webhooks), React, canvas 2D, WebAudio.

**Spec:** `docs/superpowers/specs/2026-10-17-rooms-redesign-and-money-design.md`. Prototype to port: `docs/design/rooms-2026-10/notes.html` (open it; the `<script>` holds the engine) and `flows.html` board 7. Legal background: `docs/legal/advisor-briefs-2026-10/*.pdf`.

## Gates

- **G1** legal opinion on the structure and tax position, **G2** ID verification provider wired, **G3** Paystack answers (split limits, settlement control, chargebacks, small repeated charges), **G4** name and artwork cleared. Until the owner clears them: flag `spray` stays OFF, mock provider only, Paystack **test** keys only, **never charge a real card**.
- Do not add a wallet, top-up, "spray pass" or any stored value, even as a convenience. If a limitation seems to need one, stop and ask the owner.

## Global Constraints

Same as earlier phases, plus:
- All amounts integers in kobo from `shared/money.ts` (`sprayBreakdown(tier, stageGuest)`). The server recomputes from the catalogue; it never accepts an amount from the client.
- Money eligibility is checked on the server for **payer, recipient and room**: payer `isIdVerifiedAdult` and not anonymous; recipient is the host or a person on stage, an ID-verified adult with a verified Paystack subaccount; room `moneyEligibleRoom` (18+ or 21+) and not ended. Teens never see money controls.
- Minimum charge: smallest tier is 5,000 V3C = 50 naira (decision D1). The 20-naira note is disabled in the tray until the owner decides.
- Every spray carries a client-generated idempotency key (UUID) stored with a unique index; a repeated key returns the first result.
- 3D Secure required at 10,000 naira and above (money bag, Make it Rain) regardless of saved card.
- Authorization codes are secrets: encrypted at rest with AES-256-GCM using `PAYMENT_TOKEN_KEY` (32 bytes base64); the process refuses to start in production without it; never logged; never returned to a client.
- Effects must never block chat: canvas is `pointer-events: none`, capped at 200 notes (120 when a live video is on screen), pauses when the tab is hidden, respects `prefers-reduced-motion` and the Quiet effects setting by replacing animation with a chat line and a short chip.
- Copy: never "cash"; say V3C and naira. No em dashes.

## Review Focus

- Double tap, retry and webhook plus client confirm racing: exactly one charge and one delivery per idempotency key.
- Payment succeeds but the recipient left, was removed or lost stage in the meantime: reversed in full, payer told plainly.
- Payment succeeds but our server restarts before delivery: the sweep job still delivers or reverses within 60 to 90 seconds.
- A teen or unverified adult or anonymous guest calling the endpoint by hand: refused with no information about the recipient.
- A stage guest who is a teen or unverified: cannot receive; the tray omits them; the server refuses.
- Room limit and daily limit across two tabs and two devices.
- Chargeback after delivery: ledger entry, host clawback recorded, nothing deleted.
- Rain with 200 concurrent notes on a slow phone: no jank spiral (engine drops spawn rate when frames slip), memory flat after the effect ends, no leaked `requestAnimationFrame` loop after an exception (the prototype's negative time-step bug and its fix must be kept).
- Payer on a flaky network: tapping Pay while offline shows a clear failure and never leaves a "pending forever" spray.

---

### Task 5.1: Catalogue, eligibility rules and pricing display (shared, pure)

**Files:** Modify `shared/money.ts` (catalogue already from phase 0), create `shared/spray.ts`, test in `scripts/test-rooms-unit.ts`.
**Interfaces:** `SprayEligibility`: `sprayEligibility(input: { room: { ageLimit: AgeLimit; status: string }; payer: { idVerifiedAdult: boolean; anonymous: boolean; userId: string }; recipient: { userId: string; idVerifiedAdult: boolean; hasSubaccount: boolean; role: "host" | "cohost" | "guest"; onStage: boolean }; flags: { spray: boolean } }): Check<"FEATURE_OFF" | "ROOM_NOT_ELIGIBLE" | "PAYER_NOT_VERIFIED" | "PAYER_ANONYMOUS" | "SELF" | "RECIPIENT_NOT_ALLOWED" | "RECIPIENT_NOT_PAYABLE">`; `sprayLimits(config)` constants (`ROOM_LIMIT_OPTIONS_KOBO = [50000, 100000, 200000, 500000, 1000000, 10000000]`, default 200000; `DAILY_DEFAULT_KOBO = 2000000`, `DAILY_VERIFIED_MAX_KOBO = 10000000`, `ID_REQUIRED_ABOVE_KOBO = 2000000`, `THREE_DS_AT_KOBO = 1000000`, `DELIVERY_DEADLINE_MS = 60000`); `sprayPrice(tier): { kobo: number; v3c: number; label: string; display: string }` for naira ("₦10,000"); `exceedsRoomLimit(spentKobo, limitKobo, priceKobo): boolean`.
**Tests:** one assertion per code; guest on stage who is an adult with a subaccount is payable; teen recipient `RECIPIENT_NOT_ALLOWED`; self spray `SELF`; room `13+` `ROOM_NOT_ELIGIBLE`; flag off `FEATURE_OFF`; limit helper boundaries (equal to the limit is allowed, one kobo over is not).

### Task 5.2: Schema

**Files:** Create `migrations/add_spray.sql`; modify `shared/schema.ts`, `server/storage.ts` (`ensureSchema`), apply to the real DB.
**Interfaces:** `spray_payments(id uuid pk, idempotency_key text unique, room_id fk, payer_id fk, recipient_id fk, tier text, v3c bigint, amount_kobo int, vat_kobo int, fee_kobo int, reserve_kobo int, platform_kobo int, host_kobo int, guest_kobo int null, provider text, provider_ref text unique, status text check in ('created','pending','delivered','reversed','failed','disputed'), reason text null, created_at, delivered_at null, reversed_at null)`; `user_payment_methods(id uuid pk, user_id fk, provider text, auth_enc text, last4 text, brand text, bank text null, reusable boolean, signature text, created_at, deleted_at null, unique (user_id, signature))`; `room_spend(room_id, user_id, limit_kobo int, spent_kobo int, primary key (room_id, user_id))`; `users.spray_daily_limit_kobo integer null`; `host_clawbacks(id uuid pk, host_id fk, spray_id fk, amount_kobo int, status text default 'open' check in ('open','recovered','written_off'), created_at)`.
**Tests:** storage helpers: atomic `addSpend(roomId, userId, kobo, limitKobo)` returns false when it would exceed the limit and does not change `spent_kobo`; concurrent calls (Promise.all of 5) never exceed the limit.
**Acceptance:** migration applied to the real DB and verified.

### Task 5.3: Provider interface, mock, Paystack implementation

**Files:** Create `server/payments/splitProvider.ts` (interface, `getSplitProvider()`, `setSplitProviderForTests`), `server/payments/mockSplitProvider.ts`, `server/payments/paystackSplit.ts`, `server/payments/tokenCrypto.ts`.
**Interfaces:**
```ts
export interface SplitSpec { shares: { subaccountCode: string; amountKobo: number }[]; }   // recipients only; the rest stays with us
export interface ChargeResult { status: "success" | "action_required" | "failed"; reference: string; authorizationUrl?: string; failure?: "DECLINED" | "INSUFFICIENT_FUNDS" | "NOT_REUSABLE" | "NETWORK"; }
export interface SplitPaymentProvider {
  startFirstPayment(p: { reference: string; email: string; amountKobo: number; split: SplitSpec; metadata: Record<string, string>; callbackUrl: string }): Promise<{ url: string }>;
  chargeSaved(p: { reference: string; email: string; amountKobo: number; authorizationCode: string; split: SplitSpec; metadata: Record<string, string>; force3ds: boolean }): Promise<ChargeResult>;
  verify(reference: string): Promise<{ paid: boolean; amountKobo: number; metadata: Record<string, string>; authorization?: { code: string; last4: string; brand: string; bank?: string; reusable: boolean; signature: string } } | null>;
  refund(reference: string): Promise<void>;
}
export function encryptToken(plain: string): string;  export function decryptToken(enc: string): string;
```
Implementation choice (decision D6, adjust after G3): one recipient: initialize or charge with `subaccount` and `transaction_charge` = everything that stays with us (`price - hostKobo`), bearer `account`; two recipients: create a flat split via the Paystack split API then charge with `split_code`. Keep both inside `paystackSplit.ts`.
**Tests:** `encryptToken`/`decryptToken` round trip, different ciphertext each time, tamper detection fails closed; mock provider behaves per scripted outcomes (success, declined, action required, refund recorded); Paystack module has a pure `buildChargeBody(...)` function unit tested (kobo amounts, `transaction_charge` equals `price - host`, no secrets in the body log).

### Task 5.4: The spray endpoint, finalize, delivery, reversal

**Files:** Create `server/rooms/spray.ts`, `server/rooms/sprayJobs.ts`; modify `server/rooms/roomRoutes.ts` (routes), `server/payment-routes.ts` (webhook branch `meta.type === "spray"` and dispute branch), `server/rooms/roomSocket.ts` (broadcast helper).
**Interfaces:** `POST /api/rooms/:id/spray` body `{ tier: SprayTier; targetId: string /* pid or user id */; idempotencyKey: string }` returns `{ status: "delivered" | "pending" | "action_required"; sprayId: string; authorizationUrl?: string; reason?: string }`; flow: validate (5.1), resolve target through the hub, check limits (5.5), create `spray_payments` row `created`, compute `sprayBreakdown`, call `chargeSaved` (or `startFirstPayment` when no saved card, returning `action_required` with `authorizationUrl`), on success `finalizeSpray(reference)`; `finalizeSpray(reference: string): Promise<"delivered" | "reversed" | "already">` is idempotent: re-verifies with the provider, checks recipient still present, eligible and room live, atomically marks `delivered`, broadcasts `{ type: "room:spray", id, tier, v3c, fromId, toId, at }` through the identity choke point, writes the ledger (`recordTransaction` type `spray`), posts a chat receipt line; otherwise refunds and marks `reversed` with `reason`. `sweepPendingSprays(now: number)`: reverses anything `pending` or `created` older than `DELIVERY_DEADLINE_MS` after payment success was detected and delivers anything paid and still deliverable.
**Tests (mock provider):** happy path delivered once; repeat idempotency key returns the same id and charges once; declined returns `status: "failed"` shape with `reason: "DECLINED"` and no broadcast; recipient left before finalize leads to `reversed` and a refund call; sweep delivers a paid-but-undelivered spray and reverses an unpaid stale one; webhook then client confirm gives one delivery; ws: `room:spray` reaches everyone, with `fromId` being the payer's public id; ineligible payer (teen, unverified, anonymous) gets 403 with a generic message and no row is created.

### Task 5.5: Limits and payment method management

**Files:** Create `server/rooms/sprayLimits.ts`; routes in `server/rooms/roomRoutes.ts` or a new `server/rooms/sprayRoutes.ts`.
**Interfaces:** `GET /api/users/me/spray` returns `{ method: { last4: string; brand: string } | null; dailyLimitKobo: number; dailySpentKobo: number; verified: boolean }`; `PUT /api/users/me/spray/daily-limit` `{ kobo }` (cannot exceed `DAILY_DEFAULT_KOBO` unless verified, never above `DAILY_VERIFIED_MAX_KOBO`); `PUT /api/rooms/:id/spray/limit` `{ kobo }` (one of `ROOM_LIMIT_OPTIONS_KOBO`; above `ID_REQUIRED_ABOVE_KOBO` needs verified); `DELETE /api/users/me/spray/method`; velocity: at most 10 sprays per minute and 60 per hour per user (rate-limit helper pattern as in `roomLimiter`); new hosts' receive cap in their first 14 days (`NEW_HOST_RECEIVE_CAP_KOBO` config, default 5,000,000) enforced in 5.4.
**Tests:** limit boundaries; unverified user cannot raise above default; daily total across rooms; delete method then spray returns `action_required`; velocity returns 429 with `Retry-After`.

### Task 5.6: Chargebacks and clawbacks

**Files:** Modify `server/payment-routes.ts` (dispute event), create `server/rooms/clawbacks.ts`, modify `server/rooms/settlement.ts` from phase 4 to deduct open clawbacks.
**Interfaces:** on a dispute for a spray reference: mark `disputed`, write ledger `chargeback`, create `host_clawbacks` (host share) and, for stage guests, one for the guest; `applyClawbacks(hostId, availableKobo): { appliedKobo; remainingOpen }` used by settlement; admin list endpoint. Mark clawbacks `written_off` only by an admin.
**Tests:** dispute creates clawbacks equal to host and guest shares; settlement pays `max(0, amount - open clawbacks)` and marks them recovered; second dispute event for the same reference is a no-op.

### Task 5.7: Client reducer and event plumbing

**Files:** Modify `client/src/lib/roomReducer.ts` (`sprays: SprayEvent[]` ring of 20, event `room:spray`), `client/src/hooks/useRoomSocket.ts`; create `client/src/lib/sprayApi.ts` (`postSpray`, `getSprayMe`, `putRoomLimit`, `putDailyLimit`, `deleteMethod`).
**Tests:** reducer: a `room:spray` event is appended and capped; chat receipt lines come from the server as normal chat lines (no duplicate client-side line).

### Task 5.8: Effects engine port (independent of 5.2 to 5.6)

**Files:** Create `client/src/components/rooms/spray/art.ts`, `engine.ts`, `sound.ts`, `SprayLayer.tsx`, `client/src/lib/sprayTokens.ts`.
**Interfaces:** `art.ts`: `noteArt(w: number, h: number, tier: 20 | 50 | 100, o?: { back?: boolean; phase?: number; dpr?: number }): HTMLCanvasElement`, `bundleArt(w, h, dpr?)`, `bagArt(w, h, dpr?, open?: number)`, `rainArt(w, h, dpr?)` (ported from the prototype; colours from `sprayTokens.ts`, not from CSS variables, because note art is brand artwork identical in both themes). `engine.ts`: `export class SprayEngine { constructor(canvas: HTMLCanvasElement, opts?: { maxNotes?: number; videoActive?: () => boolean }); setSize(w: number, h: number, dpr: number): void; spray(kind: "n20" | "n50" | "n100" | "bundle" | "bag" | "rain", from: { x: number; y: number }, to: { x: number; y: number }, hooks?: { onLand?: () => void }): void; quiet: boolean; muted: boolean; destroy(): void }` (internally the prototype's particle types: note, spark, ring, fly, bigfly, rig; the tick loop with non-negative `dt`, try/catch per particle and guaranteed re-schedule; hit-stop `freeze`; rain layers, wind and light beams; caps from the Global Constraints). `sound.ts`: `snd.note/bundle/bag/rain()` using WebAudio, created lazily after a user gesture, honours `muted`. `SprayLayer(props: { engineRef: MutableRefObject<SprayEngine | null>; className?: string })` renders the canvas (`aria-hidden`, `pointer-events: none`, inset 0).
**Tests:** unit (no DOM): the pure helpers extracted from the engine (`windAt(t)`, `rainRate(t)`, `bezierAt(...)`, `clampDt(ts, last)`) with assertions (`clampDt` never negative, `rainRate(0) === 0`, `rainRate(1.5) === 150`, `rainRate(5) === 0`); a fixture page `/dev/spray-fixture` with buttons for each kind and a counter of live particles; manual: frames at 0.5 s, 1.0 s, 1.5 s, 2.3 s for the bag match `docs/design/rooms-2026-10/img/n8-bag.png`; Rain on a CPU throttled 4x keeps average frame time under 33 ms (use the `browse` skill, record in the QA folder).

### Task 5.9: Client tray, pay flow and limits UI

**Files:** Create `SprayTray.tsx`, `SprayConfirm.tsx` (slide to pay), `CardSheet.tsx`, `BankApproval.tsx` (opens the provider's authorization URL; returns to the room), `RoomLimitSheet.tsx`, `SpendingLimits.tsx`, `PaymentFailedSheet.tsx`, `useSpray.ts`; modify `RoomDock.tsx` (Spray button visible only when `spray` flag and eligibility from `GET /api/rooms/:id`), `AvatarActionsSheet.tsx` (Spray a person on stage).
**Interfaces:** `useSpray(roomId)` state machine: `idle`, `confirming`, `paying`, `action_required`, `delivered`, `failed(reason)`; exposes `start(tier, targetId)`; always sends an idempotency key; retries are the same key. Tray shows prices from `sprayPrice`, the room limit chip, the card ("Visa ending 4242" from `GET /api/users/me/spray`), single notes (min 50 naira), disabled states with reasons; the first spray without a card goes through `startFirstPayment` (redirect or popup) and returns with the spray finalized by the server; the slide is required for bundle, bag and rain; bag and rain always go through `action_required` (3D Secure). Effects play from the `room:spray` event (so the payer and everyone else see the same thing), not from the tap.
**Acceptance:** screenshots match `img/f-spraytray`, `f-slide`, `f-bank`, `f-decline`; teen and anonymous accounts never see Spray; Quiet effects and reduced motion replace animation with a chip and a chat line.

### Task 5.10: End-to-end proof (test mode only)

- [ ] Owner provides Paystack **test** keys and a test subaccount for a host. With the flag on locally: one named adult payer and one host; run each tier with Paystack's test cards (including a decline and a 3D Secure card); confirm ledger rows, delivered events, clawback on a simulated dispute, a reversal when the recipient leaves mid-payment.
- [ ] Fresh reviewer subagent tries to spray from a teen, unverified, anonymous and from outside the room, to spray a non-stage guest, to replay an idempotency key with a different tier, and to exceed limits in parallel. Any success is a blocker.
- [ ] `npm run test:rooms`, tsc baseline, `npm run build`; `security-review`; update the handoff table. **Flag stays OFF** until the owner says otherwise.
