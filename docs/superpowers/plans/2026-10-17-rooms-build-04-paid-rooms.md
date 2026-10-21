# Rooms build, phase 4: paid rooms (tickets)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. **Before executing, expand each task into step-level checkboxes with the writing-plans skill.** **GATED (see Gates).** Build and test against a mock provider; do not enable in production.

**Goal:** Let an adult, ID-verified host sell tickets to an 18+ or 21+ room through Paystack: checkout, entitlement at the door, refunds (including automatic refund if the room never starts), and payment to the host 48 hours after the room ends.

**Architecture:** Reuse `server/payments/*` (checkout, verify, refund, ledger) and the Paystack webhook, adding a `roomId` metadata branch. Tickets are rows in `room_tickets`. Money is held in our Paystack account (ring-fenced record in `room_payouts`) and paid out by a settlement job using a new Paystack transfer function. All amounts come from `shared/money.ts`.

**Tech Stack:** Express, Drizzle/Postgres, Paystack REST (check current docs with WebFetch before coding transfers), React.

**Spec:** `docs/superpowers/specs/2026-10-17-rooms-redesign-and-money-design.md` (sections 3, 5, 7). Legal background: `docs/legal/advisor-briefs-2026-10/01-*.pdf`, `02-*.pdf`, `05-*.pdf`. Visual reference: `docs/design/rooms-2026-10/flows.html` board 3 (Paid rooms).

## Gates

- **G1 (legal opinion on structure and tax position)** and **G2 (ID verification provider)** must be cleared by the owner before `paidRooms` is switched on anywhere real. Until then: feature flag off, mock provider in tests, Paystack **test** keys only in any manual run. **Never charge a real card while building.**
- If the lawyer's answer changes the money flow (for example: hold ticket money in Paystack through delayed subaccount settlement instead of our account), only tasks 4.3 and 4.6 change; keep the provider behind the interfaces below.

## Global Constraints

Same as earlier phases, plus:
- Every amount is an integer in kobo. Use `ticketBreakdown(price)` from `shared/money.ts`; never recompute fees inline.
- Idempotency everywhere money moves: unique index on `room_tickets.provider_ref`; payout and refund functions safe to call twice.
- Webhooks are verified (`verifyPaystackWebhookSignature`) and never trusted for amounts: always re-verify with `verifyPaystackTransaction(reference)` and compare to the expected amount.
- Never log full card data, authorization codes or bank account numbers.
- Under-18s and unverified users cannot buy; `ticketEligible(viewer)` = `isIdVerifiedAdult(viewer)` and room `moneyEligibleRoom`. The server checks, not the client.
- Tickets are not transferable in this phase.

## Review Focus

- Double-click Pay, webhook arriving before the client verify call, client verify arriving before the webhook: exactly one ticket, one ledger row.
- Capacity race: 150 buyers for the last seat: one succeeds, the others are refunded automatically (claim the seat with an atomic UPDATE, as `claimVenueTicketSlot` does).
- Host changes the price after tickets were sold; host lowers capacity below tickets sold; host cancels a room with sold tickets.
- Ticket holder is refunded after the room started; refund requested twice; refund of a ticket whose payment was already charged back.
- A refund or cancellation after the host was paid (should not happen: payout is 48 hours after end; test the guard).
- Teen or unverified user opens a paid room link directly: 404-style refusal, no price shown.
- Naira amount tampering: client posts a different price; the server uses the stored price only.
- Paystack outage during settlement: payout stays `queued`, retried, never double-paid.

---

### Task 4.1: Schema

**Files:** Create `migrations/add_room_tickets.sql`; modify `shared/schema.ts`, `server/storage.ts` (`ensureSchema`), `shared/rooms.ts` (`RoomInput` fields).
**Interfaces:** `rooms.ticket_price_kobo integer null`, `rooms.ticket_capacity integer null` (20 to 150), `rooms.refund_before_start boolean not null default true`; table `room_tickets(id uuid pk, room_id fk, user_id fk, amount_kobo int, vat_kobo int, fee_kobo int, reserve_kobo int, platform_kobo int, host_kobo int, provider text, provider_ref text unique, status text default 'paid' check in ('paid','refunded'), created_at, refunded_at null, refund_reason text null, unique (room_id, user_id) where status = 'paid')`; table `room_payouts(id uuid pk, room_id fk unique, host_id fk, amount_kobo int, status text default 'held' check in ('held','queued','paid','failed'), release_at timestamp, transfer_ref text null, attempts int default 0, last_error text null, created_at, paid_at null)`.
**Tests:** schema applied to scratch DB by the existing runner; storage helper tests: unique `(room_id, user_id)` for paid tickets, unique `provider_ref`.
**Acceptance:** migration applied to the real database and verified.

### Task 4.2: Room configuration and eligibility

**Files:** Modify `shared/roomRules.ts` (`canSellTickets(host, room)`), `server/rooms/roomRoutes.ts` (`POST` and `PATCH` accept `ticketPriceKobo`, `ticketCapacity`), `shared/rooms.ts` limits (`ticketMinKobo = 100000`, `ticketMaxKobo = 10000000`, `ticketCapacityMin = 20`, `ticketCapacityMax = 150`).
**Interfaces:** `canSellTickets(host: { age: number | null; idVerified: boolean; hasPayoutAccount: boolean }, room: { ageLimit: AgeLimit }): Check<"FEATURE_OFF" | "HOST_NOT_ADULT" | "HOST_NOT_VERIFIED" | "NO_PAYOUT_ACCOUNT" | "ROOM_NOT_ADULT">`. `hasPayoutAccount` = a verified Paystack row in `organizer_payment_accounts` for the host (reuse `server/organizer-payments-routes.ts` onboarding). Capacity for a ticketed room is `ticketCapacity` (up to 150) while free rooms stay at 50. Price and capacity cannot be changed once any ticket is sold (price) or below tickets sold (capacity).
**Tests:** table-driven for each code; creating a ticketed room with the flag off is 400 `FEATURE_OFF`; capacity above 150 rejected; price changes after a sale are 409.

### Task 4.3: Checkout, verification, webhook

**Files:** Modify `server/payments/types.ts` (`itemType` gains `"room"`), `server/payments/paystack.ts` (metadata and `roomId` pass-through), `server/payment-routes.ts` (webhook branch for `meta.roomId`), create `server/rooms/tickets.ts`, add routes in `server/rooms/roomRoutes.ts`.
**Interfaces:** `POST /api/rooms/:id/tickets/checkout` returns `{ url: string; reference: string }` (auth required; uses the stored price; refuses sold-out, ineligible, already-ticketed with 409 `ALREADY_TICKETED`); `POST /api/rooms/:id/tickets/verify` body `{ reference }` returns `{ ticket: RoomTicketView }`; `issueRoomTicket(opts: { roomId: string; userId: string; reference: string; provider: "paystack"; verifiedAmountKobo: number }): Promise<{ ticket: RoomTicket } | { refunded: true; reason: "SOLD_OUT" | "AMOUNT_MISMATCH" | "INELIGIBLE" }>` is the single code path used by webhook and verify, idempotent on `reference`; it computes `ticketBreakdown(price)`, claims a seat atomically, writes the ticket and `recordTransaction({ type: "room_ticket", ... })`.
**Tests (mock provider, `setPaymentProviderForTests`):** one reference through webhook then verify gives one ticket; amount mismatch refunds and returns `AMOUNT_MISMATCH`; sold-out refunds; under-18 buyer refunds `INELIGIBLE`; tampered client price ignored; unsigned webhook is 400.

### Task 4.4: Door check and capacity

**Files:** Modify `server/rooms/roomAccess.ts`, `server/rooms/roomSocket.ts` (`joinOnce`), `server/rooms/roomRoutes.ts` (`GET /api/rooms/:id` adds `ticket: { required: boolean; priceKobo: number; held: boolean; soldOut: boolean }`).
**Interfaces:** join refused with `TICKET_REQUIRED` unless viewer is host, co-host, or has a `paid` ticket. Hub capacity for a ticketed room is `ticketCapacity`. Anonymous join stays allowed for ticket holders in 18+ rooms (rules unchanged). Room listing shows price for viewers who can join.
**Tests:** ws: non-holder refused `TICKET_REQUIRED`; holder admitted; host admitted; refunded ticket refused; REST `ticket` block correct for each.

### Task 4.5: Refunds, cancellation, automatic refund

**Files:** Create `server/rooms/refunds.ts`; add routes `POST /api/rooms/:id/tickets/refund` (self), `POST /api/rooms/:id/cancel` (host); job `startRoomRefundJob()` in the server start-up next to the other jobs.
**Interfaces:** `refundTicket(ticketId: string, reason: "buyer" | "host_cancelled" | "never_started" | "oversold"): Promise<"refunded" | "already" | "not_allowed">` uses `refundPayment(providerRef, "paystack")`, marks `refunded`, writes a ledger row of type `room_ticket_refund`, notifies the buyer (notification type to add: `room_refund`). Buyer refunds allowed only before `scheduledFor - 60 minutes` and when `refund_before_start` is true. Job: every 5 minutes, a scheduled room with tickets whose `scheduledFor + 60 minutes` passed without starting is cancelled and all paid tickets refunded.
**Tests:** buyer refund before and after the window; second refund call returns `already`; host cancel refunds all; job refunds a never-started room exactly once even if run twice; payout row is removed or zeroed on cancel.

### Task 4.6: Settlement to the host

**Files:** Create `server/rooms/settlement.ts`; add to `server/payments/paystack.ts`: `createPaystackTransferRecipient`, `createPaystackTransfer`; job `startSettlementJob()`.
**Interfaces:** when a ticketed room ends, `scheduleRoomPayout(roomId)` creates or updates `room_payouts` with `release_at = endedAt + 48h` and `amount_kobo = sum(host_kobo of paid tickets)`. Job every 5 minutes: for `held` rows past `release_at` mark `queued` then pay via Paystack transfer with a deterministic reference (`room-payout-<roomId>`); success marks `paid`; failure records `last_error`, increments `attempts`, leaves `queued` for retry, and after 5 attempts marks `failed` and raises an admin-visible alert. Recipient bank details come from the host's verified payout account; never from the request.
**Tests (mock transfer):** payout appears only after 48 hours (inject clock); double run pays once (same reference); refund after end but before release reduces the payout; transfer failure retries then fails after 5 attempts; amount equals sum of `host_kobo`.

### Task 4.5b: Admin visibility

**Files:** `server/admin-routes.ts` finance area: read-only list of `room_payouts` and `room_tickets` totals; reuse admin roles.
**Tests:** api: only finance roles can read.

### Task 4.7: Client

**Files:** Create `client/src/components/rooms/tickets/TicketPage.tsx`, `Checkout.tsx`, `TicketConfirmed.tsx`, `WaitingRoom.tsx`, `HostSales.tsx`, `RefundButton.tsx`; modify `RoomPage.tsx` branches (`TICKET_REQUIRED` shows the ticket page), wizard price step (`StepPrice.tsx`) using `ticketBreakdown` for the live earnings estimate, `roomsApi.ts` types.
**Interfaces:** ticket page shows cover, age tag, price with "includes VAT", tickets left, refund promise, button "Get ticket · ₦5,000"; checkout redirects to Paystack (reuse the existing event checkout pattern in the client) and returns to `/rooms/:id?ref=...` which calls verify; confirmation shows the ticket (a short code, no QR in this phase); waiting room countdown until the host goes live; host sales sheet shows sold, gross, platform share, you earn, release date, all from `ticketBreakdown` sums returned by a host-only endpoint `GET /api/rooms/:id/tickets/summary`.
**Acceptance:** screenshots match `img/f-price`, `f-ticket`, `f-checkout`, `f-ticketok`, `f-hostsales`; under-18 never sees a price; flows work end to end against Paystack **test** mode by the owner (instructions in handoff).

### Task 4.8: Gate

`npm run test:rooms` green (new ticket suites included), tsc baseline, build; `security-review` and `code-review`; an independent reviewer subagent tries to double-spend and oversell using only the plan's Review Focus; update handoff table. Flag stays OFF.
