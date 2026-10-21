# Rooms build, phase 6: getting paid, receipts, notifications, recaps, privacy, runbook

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. **Before executing, expand each task into step-level checkboxes with the writing-plans skill.** Tasks 6.1 to 6.3 depend on phases 4 and 5; 6.4 to 6.8 can start after phase 3.

**Goal:** Give hosts and stage guests a way to connect and verify a bank account, see what they earned and what has settled; give payers receipts and limits; send the right notifications; show recaps; extend privacy settings; and leave an operations runbook so the owner can switch features on safely.

**Architecture:** Reuse the existing organizer payout accounts (`organizer_payment_accounts`, Paystack subaccounts, `server/organizer-payments-routes.ts`) instead of inventing new ones; earnings are read from the new tables, not recomputed; notifications use the existing `createNotification` and `notificationTypes`.

**Spec:** `docs/superpowers/specs/2026-10-17-rooms-redesign-and-money-design.md`. Visual reference: `docs/design/rooms-2026-10/flows.html` boards 7 to 10 (Paying for a spray, Earnings, After the room, Notifications) and screenshots `img/f-earn`, `f-hostrecap`.

## Global Constraints

Same as earlier phases. Plus: no screen or API shows another person's earnings; amounts always come from stored rows; settlement status shown to a host is "settled" only when Paystack reported it (otherwise "on its way"); bank account numbers are never returned in full (last four only).

## Review Focus

- A host with no verified payout account is told exactly what to do and cannot be sprayed or sell tickets (server enforces, not just UI).
- Account-name mismatch between BVN or NIN identity and the bank account: refused with a plain message.
- Earnings with refunds, reversals, chargebacks and clawbacks in the same week add up to the settlement amount (property test over generated histories).
- A user who changes their date of birth or loses verification keeps their earnings history but cannot receive new sprays.
- Notification storms: a host receiving 300 sprays in a minute gets one batched notification, not 300.
- Recap for a room the viewer never entered returns 404; recap never shows anonymous guests' real identities to non-privileged viewers.

---

### Task 6.1: Payout account for room hosts

**Files:** Modify `server/organizer-payments-routes.ts` (or add `server/rooms/payouts.ts` calling the same storage helpers), `shared/schema.ts` only if a column is missing, `client/src/pages/` add `RoomPayoutsPage.tsx`.
**Interfaces:** `GET /api/rooms/payouts/status` returns `{ verifiedAdult: boolean; account: { bankName: string; last4: string; nameMatches: boolean } | null; subaccountReady: boolean }`; `POST /api/rooms/payouts/account` body `{ bankCode: string; accountNumber: string }` resolves the account name with `resolvePaystackBankAccount`, compares to the verified identity name (normalized, case and spacing tolerant, order tolerant), creates the subaccount with `createPaystackSubaccount`, stores it in `organizer_payment_accounts`; requires `isIdVerifiedAdult`. Existing organizer onboarding keeps working untouched.
**Tests (mock Paystack):** unverified user 403; name mismatch 422 `NAME_MISMATCH`; success returns last four only; second call updates instead of duplicating; `canSellTickets` and `sprayEligibility` read `hasPayoutAccount` from the same helper.

### Task 6.2: Earnings API and screens

**Files:** Create `server/rooms/earnings.ts`, `client/src/pages/RoomEarningsPage.tsx`, `client/src/components/rooms/earnings/*`.
**Interfaces:** `GET /api/users/me/room-earnings?range=week|month|all` returns `{ totals: { sprayKobo: number; ticketKobo: number }, settledKobo: number, onItsWayKobo: number, heldTicketKobo: number, clawbackOpenKobo: number, byRoom: Array<{ roomId: string; title: string; sprayKobo: number; ticketKobo: number; at: string }>, nextTicketReleaseAt: string | null }`; `computeEarnings(rows)` pure so it can be property-tested. Settled status uses Paystack's settlement report for the subaccount when available (check docs); otherwise next-business-day estimate labelled "on its way".
**Tests:** pure function: refunds, reversals and clawbacks subtract correctly; a generated history property: `settled + onItsWay + held - clawbackOpen` equals the sum of host shares of delivered sprays plus paid-ticket host shares minus refunds; API: only own data; unauthenticated 401.

### Task 6.3: Payer receipts and history

**Files:** Create `server/rooms/receipts.ts`, `client/src/pages/RoomPaymentsPage.tsx`.
**Interfaces:** `GET /api/users/me/room-payments?cursor=` returns `{ items: Array<{ id: string; kind: "spray" | "ticket" | "refund"; title: string; amountKobo: number; vatKobo: number; at: string; status: string }>, next: string | null }`; `GET /api/users/me/room-payments/:id/receipt` returns a printable HTML receipt page (VAT shown; business details placeholders read from config until the company details are provided).
**Tests:** only own rows; pagination stable; refund rows appear as negative entries.

### Task 6.4: Notifications

**Files:** Modify `shared/schema.ts` `notificationTypes` (add `"room_ticket"`, `"room_refund"`, `"spray_received"`, `"payout_paid"`; `"room_starting"` added in phase 3), `server/rooms/notify.ts`, client `NotificationBell` mapping (copy and link per type).
**Interfaces:** `notifySprayReceived(hostId, roomId, kobo)` batches per recipient and room into one notification updated at most once a minute ("You received ₦X in Friday Pre-Drinks"); ticket confirmation, refund issued, payout paid, room live (existing). Links go to `/rooms/:id`, `/rooms/earnings`.
**Tests:** batching unit test with an injected clock; each type has a link and copy; no notification contains an anonymous guest's identity.

### Task 6.5: Recaps

**Files:** Create `server/rooms/recap.ts`, route `GET /api/rooms/:id/recap`, client `RoomRecapPage.tsx` shown after a room ends.
**Interfaces:** guest recap `{ minutesIn: number; messages: number; next: { roomId: string; scheduledFor: string } | null; follow: boolean }`; host recap adds `{ minutes: number; peak: number; ticketsSold: number; followersGained: number; earnedKobo: number }` (peak and followers tracked during the room, see below). Track peak in `RoomHub` and persist `rooms.peak_members int` on end (additive column, applied).
**Tests:** viewer who never joined 404; guest never sees host-only fields; anonymous guests appear only as "Guest" with no identity to others.

### Task 6.6: Privacy settings

**Files:** Modify `shared/rooms.ts` (`RoomPrivacy` gains `notifyFriendsLive: boolean`, default true; tolerant reader keeps old rows valid), `client/src/components/RoomPrivacyCard.tsx`, notifications job that sends `room_live` (respect the setting).
**Tests:** `resolveRoomPrivacy({})` has `notifyFriendsLive === true`; strict validator rejects non-boolean; an old stored value without the field resolves with the default; existing cross-age DM tests unchanged.

### Task 6.7: Error and edge states

**Files:** client only: reconnecting banner (exists), mic and camera permission sheets, weak signal (exists), spray not available sheet, payment failed (phase 5). Map every state in `flows.html` board 11.
**Acceptance:** each state reachable in the fixture route and covered by a screenshot.

### Task 6.8: Runbook and launch checklist

**Files:** Create `docs/ops/rooms-money-runbook.md` (untracked docs), update `HANDOVER_ROOMS_BUILD_2026-10-17.md`.
**Contents:** every environment variable (`ROOM_ANON_SECRET`, `PAYMENT_TOKEN_KEY`, `ROOMS_ANONYMOUS_JOIN`, `ROOMS_PAID`, `ROOMS_SPRAY`, Paystack keys, webhook URL and events to subscribe: `charge.success`, `charge.dispute.create`, `refund.processed`, transfer events); the order to turn things on (anonymous join, then paid rooms for a small allow-list of hosts, then spray); the first-hour monitoring checklist (failed charges rate, reversals, webhook errors, payout failures); rollback (flip flags off; revert merge commit); the owner's go-live checklist from `docs/legal/advisor-briefs-2026-10/` (legal opinions in hand, ID verification live, naming cleared, terms published).
**Acceptance:** a person who has not seen the project can follow it to enable features on staging and to disable them in an emergency.

### Task 6.9: Final gate

`npm run test:rooms` (all suites), `npx tsc --noEmit` baseline, `npm run build`, `code-review` and `security-review`, one full manual pass across both accounts (adult, teen) covering every board in `flows.html`, owner sign-off before any push or flag change.
