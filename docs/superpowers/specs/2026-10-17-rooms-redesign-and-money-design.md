# Rooms redesign, anonymous join, paid rooms and spraying: design spec

Date: 2026-10-17. Owner: Leigh. Status: design approved in conversation, not yet built. Money features are gated on legal advice.

Source of truth for how it looks and behaves: the interactive prototypes in `docs/design/rooms-2026-10/` (open `index.html`; `rooms.html`, `notes.html`, `flows.html`, `brief.html`). Source of truth for the legal and accounting position: `docs/legal/advisor-briefs-2026-10/*.pdf` and `docs/design/rooms-2026-10/brief.html`. If a prototype and this spec disagree, this spec wins and the difference is listed in section 4.

## 1. Goal

Rebuild the room screen so chat is always visible and interactive; make live video immersive by default on phones and tablets; let people join rooms anonymously under strict age rules; give hosts a real create-room flow and controls; then add paid rooms and spraying (pay-per-spray, no balance) for verified adults in 18+ rooms, launching in Nigeria first.

Non-goals for this build: a wallet or stored balance (never), teens onboarding in Nigeria (later phase), UK/US payments (later), recording of any kind, music licensing integration, native app wrappers.

## 2. Locked product decisions

1. **Chat first.** Chat fills all height the scene does not need. No Chat/People/Controls tabs. People and host controls are sheets. Swipe a message right to reply. Pinned host message above chat. Reaction tray from a heart button. Hype bar fed by reactions.
2. **Live video.** Compact view (picture on top, speaker strip, chat below) and Immersive view (picture fills screen, floating chat, three-button rail: quality, sound only, exit; composer; tap the picture to hide chrome). **Immersive is the default on phone and tablet widths (under 1024 px); desktop uses compact with a right-hand chat rail.**
3. **Person actions.** `View profile` is the first action on every non-anonymous person.
4. **Anonymous join.** Alias `Guest XXX`. Others see alias and a plain avatar. Hosts, co-hosts and moderators see the real identity. Anonymous guests can read, chat and react only. They cannot wave, DM, take the mic or camera, pay, or be paid. Reports and bans follow the real account.
5. **Age rules.** Room limits: all, 13+, 16+, 18+, 21+, plus **Teens only (under 18)**. Adults can never be in a teens-only room. Adults cannot join anonymously in any room open to under 18s (all, 13+, 16+, teens only is teens-only anyway). Teens may join anonymously where the room allows it. Rooms a viewer cannot join are hidden from lists, not shown locked.
6. **Money is adults only, 18+/21+ rooms only.** Paid rooms and spraying require: an adult host, an 18+ or 21+ room, and ID-verified adulthood for anyone who pays or is paid. Never in rooms that allow under 18s. Never for anonymous guests.
7. **No balance.** A spray is paid at the moment it is thrown, by card (saved once, then one tap), through Paystack, split at the moment of payment between host / stage guest / platform. Vib3Cash (V3C) is only a unit shown on the price: **₦1,000 = 100,000 V3C, 1 V3C = 1 kobo**. Nothing stores V3C.
8. **Tickets** are collected into our Paystack account, held until the room has happened plus 48 hours, then paid to the host; automatic refund if the room never starts.
9. **Launch Nigeria first**, naira only (Paystack). UK/Stripe is a later phase.
10. **Name and artwork.** Do not use the word "cash" in user-facing copy (placeholder name for the unit is "V3C"; the owner may rename). No naira imagery or the ₦ sign on the notes. Notes say "NOT LEGAL TENDER".

## 3. Rules matrix (these become pure functions in `shared/`)

| Viewer age | Teens only | 13+ / 16+ (and "all") | 18+ / 21+ |
|---|---|---|---|
| Under 13 | blocked | blocked | blocked |
| 13 to 17 (16+ needs 16) | can join, anonymous allowed if host allows | can join, anonymous allowed if host allows | blocked |
| 18+ (21+ needs 21) | **blocked, code AGE_TOO_OLD** | can join, **not anonymously** | can join, anonymous allowed if host allows |

Money eligibility `moneyEligible(room, host, viewer)`: room.ageLimit in {18+, 21+} and host age >= 18 and host ID-verified adult and viewer ID-verified adult and viewer not anonymous. Recipient (host or stage guest) must be an ID-verified adult with a verified Paystack subaccount.

Host rules (existing `canHostRoom` stays): host age must meet the room's minimum; **teen hosts cannot host public rooms** (existing rule `TEEN_PUBLIC`, kept). Adults cannot host a teens-only room (new code `HOST_TOO_OLD`). Teen hosts cannot host 18+/21+ rooms (existing `HOST_BELOW_LIMIT`).

## 4. Where the prototypes differ from the code (resolve this way)

| Prototype | Existing code | Decision |
|---|---|---|
| Wizard kinds Talk / Music / Live video / Q and A | `ROOM_KINDS = party, listening, talk, event`; live video is a flag | Keep the four kinds, relabel in the wizard (Party, Listening, Talk, Event). Live video stays a toggle. No new kind. |
| Teen host can host a 13+ room | `canHostRoom` forbids teen hosts on public rooms | Keep the rule. A teen host's wizard offers Friends or Invite visibility only. The prototype screen `Who can join (teen host)` should show that. |
| Teens only room | No such `AgeLimit` | Add `teen` to `AgeLimit` (min 13, max 17). New code `AGE_TOO_OLD`. |
| Join screen preview controls | n/a | Prototype-only. Real screen shows the viewer's own state. |
| Pinned message, slow mode, lock room | not in schema | Additive columns on `rooms` (phase 3). |
| Anonymous alias | none | `room_members.anonymous`, `room_members.alias`, `rooms.anonymous_allowed` (phase 2). |
| Money, V3C, tickets, sprays | `payment_transactions` ledger and Paystack/Stripe exist for event tickets | Reuse `server/payments/*`, extend with split payments and saved-card charges (phases 4 and 5). |
| Price `₦1,000` pack, wallet screens | none | No wallet. Wallet screens in the pack are replaced by the "Paying for a spray" board. |
| Sound, haptics, effects | none | Port the engine from `notes.html` into `client/src/components/rooms/spray/` (phase 5). |

## 5. Money model (exact, in kobo; this is the test vector set)

Fee model for a payment of `price` kobo:

- `vat = round(price * 75 / 1075)`  (7.5% included in the price)
- `fee = min(200000, round(price * 0.015) + (price >= 250000 ? 10000 : 0))`  (Paystack local card: 1.5% plus 100 naira, 100 naira waived below 2,500 naira, capped at 2,000 naira)
- `reserve = round(price * reservePct)`  (`reservePct` = 0.025 for sprays, 0.01 for tickets)
- `net = price - vat - fee - reserve`
- `platform = round(net * platformPct / 100)`; `host = net - platform` (remainder, so the shares always sum to `net`)
- Stage-guest spray: `hostCut = round(net * 15 / 100)`; `guest = net - platform - hostCut`

Platform percentage by spray: notes 30, bundle 25, money bag 20, Make it Rain 15, ticket 15.

| Case | price (kobo) | vat | fee | reserve | net | platform | host | guest |
|---|---|---|---|---|---|---|---|---|
| Note 100 naira | 10,000 | 698 | 150 | 250 | 8,902 | 2,671 | 6,231 | n/a |
| Bundle 1,000 naira | 100,000 | 6,977 | 1,500 | 2,500 | 89,023 | 22,256 | 66,767 | n/a |
| Money bag 10,000 naira | 1,000,000 | 69,767 | 25,000 | 25,000 | 880,233 | 176,047 | 704,186 | n/a |
| Make it Rain 100,000 naira | 10,000,000 | 697,674 | 160,000 | 250,000 | 8,892,326 | 1,333,849 | 7,558,477 | n/a |
| Ticket 5,000 naira (reserve 1%) | 500,000 | 34,884 | 17,500 | 5,000 | 442,616 | 66,392 | 376,224 | n/a |
| Money bag to a stage guest | 1,000,000 | 69,767 | 25,000 | 25,000 | 880,233 | 176,047 | 132,035 | 572,151 |

Catalogue: note small 2,000 / medium 5,000 / large 10,000 V3C (naira 20 / 50 / 100); bundle 100,000 V3C (1,000 naira, 100 notes); money bag 1,000,000 V3C (10,000 naira); Make it Rain 10,000,000 V3C (100,000 naira). Outside Nigeria later: price = naira price converted at a configured rate, single notes hidden.

Safety numbers: room limit chosen by the buyer (500 / 1,000 / 2,000 / 5,000 / 10,000 / 100,000 naira, default 2,000); daily limit default 20,000 naira, verified adults up to 100,000; limits above 20,000 need ID verification; 3D Secure required at 10,000 naira and above; sprays not confirmed delivered within 60 seconds are reversed in full; new hosts have a receive cap in their first 14 days (value set in config).

## 6. Decisions still open (defaults to build with; owner may change)

| # | Question | Default |
|---|---|---|
| D1 | Smallest single charge: 50 naira, or batch 20-naira notes | Smallest note is 50 naira (Paystack recommends 50 as minimum). Batching is NOT built. The 20-naira note stays in artwork and is disabled in the tray until the owner decides. |
| D2 | Rename "Vib3Cash" | Use constant `UNIT_LABEL = "V3C"` in one file so a rename is one edit. |
| D3 | Money only in 18+/21+ rooms | Yes (as section 2). |
| D4 | Anonymous teens on the mic in teens-only rooms | No, anonymous guests never get the mic. |
| D5 | ID verification provider | Not chosen. Build the interface and a manual/admin stub (phase 0). Real provider is a decision before phase 5. |
| D6 | Paystack split mechanics for multi-party sprays (flat split per transaction vs subaccount charge) | Build behind an interface `SplitPaymentProvider`; real implementation confirmed with Paystack answers (brief 05). |
| D7 | Ticket money custody (ours vs delayed subaccount settlement) | Ours, ring-fenced record, until Paystack confirms delayed settlement. |

## 7. Gates

- **G0** none: phases 0, 1, 2, 3 can start now.
- **G1** written legal opinions (brief 01 questions A1 to A4) and the tax position (brief 02 A1, B1, B2): required before phase 4 ships. Build can start against a mock provider; do not enable in production.
- **G2** ID verification provider chosen and wired: required before phases 4 and 5 are switched on.
- **G3** Paystack answers (brief 05): split limits, settlement control, chargebacks, small repeated charges: required before the spray payment code is finalized.
- **G4** name and artwork cleared (legal brief 01 C1): required before spraying is switched on.

Money features ship behind feature flags that default OFF (`paidRooms`, `spray`). Turning them on in production is the owner's decision, not the builder's.
