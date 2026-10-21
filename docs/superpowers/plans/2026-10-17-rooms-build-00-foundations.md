# Rooms build, phase 0: foundations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the branch, record a baseline, and land the four pure or additive pieces every later phase needs: feature flags with a config endpoint, an ID-verification seam, and the money math.

**Architecture:** Everything here is additive and behind defaults that change nothing for users. Flags live in `server/rooms/features.ts` and reach the client through `GET /api/rooms/config`. Age verification is an interface plus an admin-operated stub, so no vendor is needed yet. Money math is one pure module, `shared/money.ts`, tested against the vectors in the spec.

**Tech Stack:** TypeScript, Express, Drizzle (Postgres), tsx test scripts, React 18 with TanStack Query.

**Spec:** `docs/superpowers/specs/2026-10-17-rooms-redesign-and-money-design.md` (read sections 3, 5, 6, 7 first). Design source: `docs/design/rooms-2026-10/index.html`.

## Global Constraints

- Work on branch `feat/rooms-redesign`. Do not push, merge or open a PR without the owner's go-ahead. `docs/` stays untracked on purpose.
- Schema change = migration file in `migrations/` + mirror in `ensureSchema` in `server/storage.ts` (next to `ALTER TABLE rooms ADD COLUMN IF NOT EXISTS live_video`, around line 345) + `shared/schema.ts` + **applied to the real database in the same task** (additive and idempotent, so safe to apply without asking). Never leave "run db:push later".
- Never serialize `passwordHash`, reset or verification tokens. Use `toPublicUser`, `hostSummary`, `publicRoom`. Do not add a new response shape that skips them.
- Do not add `req.login()` or `req.session.regenerate()` calls. If one is unavoidable, send the response inside its callback.
- Server is the gate. Client mirrors the shared pure rules.
- `npx tsc --noEmit` must not exceed the baseline count recorded in Task 0.1. `npm run build` must pass before any push.
- Tests are tsx scripts: `scripts/test-rooms-unit.ts` (`test(name, fn)` with `node:assert/strict`), `scripts/test-rooms-api.ts` and `scripts/test-rooms-ws.ts` (`check(name, ok, extra)`; they refuse to run unless the DB name contains "test"). Run all with `npm run test:rooms`.
- Copy rules: no em dashes, plain words, never the word "cash" in user-facing text.

## Review Focus

- A flag env var set to garbage ("yes", " 1 ", "false") must behave as OFF unless it is exactly `"1"` or `"true"`.
- `GET /api/rooms/config` must be registered **before** `GET /api/rooms/:id`, or "config" is treated as a room id and returns 404.
- The config endpoint must work for any signed-in user, including teens, and must never include secrets or Paystack keys.
- Age verification must never be settable by the user themself; only admin roles can mark it. A user who is verified and then has their date of birth corrected by an admin must lose verification.
- Money math with odd inputs: price 0, negative or non-integer input must throw `RangeError`, not return NaN. Prices >= 1 kobo work; any minimum charge (500 naira) is enforced at the phase 5 charge boundary, not in `breakdown()`.
- Rounding must keep `platform + host (+ guest) === net` for every price from 1 to 20,000 kobo (property test).

---

### Task 0.1: Branch, baseline and handoff log

**Files:**
- Create: `docs/superpowers/plans/2026-10-17-baseline.md`

**Interfaces:**
- Produces: the recorded numbers every later task compares against (tsc error count, test pass counts, build status).

- [ ] **Step 1: Cut the branch.** Run `git switch -c feat/rooms-redesign` from `main` (clean tracked tree; untracked HANDOVER files are expected). Expected: `Switched to a new branch`.
- [ ] **Step 2: Record the type-check baseline.** Run `npx tsc --noEmit 2>&1 | grep -c "error TS"`. Write the number in the baseline file as `tsc errors: N` (memory says 10; record the real value).
- [ ] **Step 3: Record the test baseline.** Run `npm run test:rooms`. Copy the three "passed, failed" summary lines into the baseline file. Expected: 0 failed in each suite. If anything fails on a clean branch, stop and tell the owner.
- [ ] **Step 4: Record the build baseline.** Run `npm run build`. Expected: exits 0. Note the main bundle size line.
- [ ] **Step 5: Smoke the dev server recipe.** Start a scratch database as in `scripts/run-rooms-tests.mjs` is not needed; instead confirm the owner's recipe works: dev server on port 5077 with `RESEND_API_KEY=re_dummy_not_real` and a scratch `DATABASE_URL` (a database whose name contains `test`). Record the exact command that worked in the baseline file.
- [ ] **Step 6: Let the runner pick up new test files** (this is what lets parallel agents add tests without editing the same file). In `scripts/run-rooms-tests.mjs`, replace the hard-coded file lists with directory scans: unit files are every `scripts/test-rooms-unit*.ts`, api and ws files are every `scripts/test-rooms-api*.ts` and `scripts/test-rooms-ws*.ts` (sorted, the original `test-rooms-api.ts` and `test-rooms-ws.ts` first). Keep the scratch-database safety checks untouched. Run `npm run test:rooms`; the output must be identical to Step 3 apart from nothing new. New api and ws test files must use their own username prefix (for example `m4_`) so they cannot collide with users the other files create. Convention for the rest of this build: **new tests go in new files named `scripts/test-rooms-unit-<topic>.ts`, `test-rooms-api-<topic>.ts`, `test-rooms-ws-<topic>.ts`**; tasks below that say "add to `scripts/test-rooms-unit.ts`" may use the topic file instead.
- [ ] **Step 7: Commit** `git add scripts/run-rooms-tests.mjs && git commit -m "test(rooms): run every test-rooms-*.ts file"`. (The baseline file is under untracked `docs/`.)

### Task 0.2: Feature flags and `GET /api/rooms/config`

**Files:**
- Modify: `server/rooms/features.ts` (flags), `server/rooms/roomRoutes.ts` (new route, placed before `app.get("/api/rooms/:id"` at about line 164), `client/src/lib/roomsApi.ts` (client fetch and hook)
- Test: `scripts/test-rooms-unit.ts` (flag parsing), `scripts/test-rooms-api.ts` (endpoint)

**Interfaces:**
- Produces (server): `roomFeatures: { linkScreens: boolean; anonymousJoin: boolean; paidRooms: boolean; spray: boolean }`, `parseFlag(v: string | undefined, fallback: boolean): boolean`, `loadRoomFeatures(env: NodeJS.ProcessEnv): typeof roomFeatures`.
- Produces (HTTP): `GET /api/rooms/config` returns `{ features: { anonymousJoin: boolean; paidRooms: boolean; spray: boolean }, limits: typeof ROOM_LIMITS, currency: "NGN", region: "NG" }`.
- Produces (client): `fetchRoomsConfig(): Promise<RoomsConfig>`, `useRoomsConfig(): UseQueryResult<RoomsConfig>` with `staleTime` 5 minutes.
- Defaults: `anonymousJoin` false until phase 2 flips it, `paidRooms` false, `spray` false. Env names: `ROOMS_ANONYMOUS_JOIN`, `ROOMS_PAID`, `ROOMS_SPRAY`.

- [ ] **Step 1: Write failing unit tests** in `scripts/test-rooms-unit.ts`: `parseFlag("1", false) === true`, `parseFlag("true", false) === true`, `parseFlag("yes", false) === false`, `parseFlag(" 1 ", false) === false`, `parseFlag(undefined, true) === true`, `parseFlag("", true) === true` (empty falls back).
- [ ] **Step 2: Run** `npx tsx scripts/test-rooms-unit.ts`. Expected: FAIL (`parseFlag` not exported).
- [ ] **Step 3: Implement** `parseFlag` and `loadRoomFeatures` in `server/rooms/features.ts`; keep `DEFAULT_ROOM_FEATURES` and the mutable `roomFeatures` object; initialise `roomFeatures` from `loadRoomFeatures(process.env)`.
- [ ] **Step 4: Write a failing API test** in `scripts/test-rooms-api.ts`: signed-in user GET `/api/rooms/config` returns 200, `features.paidRooms === false`, `features.spray === false`, `limits.capacityMax === 50`, `currency === "NGN"`; unauthenticated returns 401; response JSON contains no key matching `/secret|key|token/i`.
- [ ] **Step 5: Implement the route** in `roomRoutes.ts` with `requireAuth`, registered before the `/:id` route. Return only the fields above.
- [ ] **Step 6: Add the client fetch and hook** in `roomsApi.ts` (use the existing `apiRequest` or fetch pattern in that file).
- [ ] **Step 7: Run** `npm run test:rooms`. Expected: all pass, including the new checks.
- [ ] **Step 8: Commit.** `git add server/rooms/features.ts server/rooms/roomRoutes.ts client/src/lib/roomsApi.ts scripts/test-rooms-unit.ts scripts/test-rooms-api.ts && git commit -m "feat(rooms): feature flags and /api/rooms/config"`

### Task 0.3: ID-verification seam

**Files:**
- Create: `migrations/add_age_verification.sql`, `shared/ageVerification.ts`, `server/identity/ageVerification.ts`
- Modify: `shared/schema.ts` (two columns on `users`), `server/storage.ts` (`ensureSchema` mirror plus `setAgeVerification`), `server/admin-routes.ts` (admin route, next to `PUT /api/admin/users/:id/date-of-birth` at about line 617), `server/routes/users-routes.ts` (read route) or `server/rooms/roomRoutes.ts` next to the room-privacy routes
- Test: `scripts/test-rooms-unit.ts`, `scripts/test-rooms-api.ts`

**Interfaces:**
- Produces (shared): `type AgeVerificationMethod = "admin" | "provider"`, `interface AgeVerification { verified: boolean; band: "adult" | "teen" | null; at: string | null; method: AgeVerificationMethod | null }`, `isIdVerifiedAdult(u: { ageVerifiedAt: Date | null; dateOfBirth: string | null }, now?: Date): boolean` (true only when `ageVerifiedAt` is set and `ageFromDob(dateOfBirth) >= 18`).
- Produces (server): `interface AgeVerifier { status(userId: string): Promise<AgeVerification>; start(userId: string): Promise<{ url?: string; message: string }> }`, `export const ageVerifier: AgeVerifier` (stub reads the DB columns; `start` returns `{ message: "ID verification is not available yet" }`), `setAgeVerifierForTests(v: AgeVerifier | null)`.
- Produces (HTTP): `GET /api/users/me/age-verification` returns `AgeVerification`. `POST /api/admin/users/:id/age-verification` body `{ verified: boolean }` (roles `super_admin`, `admin`, `user_support`) sets or clears the columns with method `"admin"` and writes an admin audit log entry like the date-of-birth route does.
- Columns: `users.age_verified_at timestamp null`, `users.age_verified_method text null`.
- Behavior: the existing admin date-of-birth correction route clears `age_verified_at` and `age_verified_method`.

- [ ] **Step 1: Failing unit tests** for `isIdVerifiedAdult`: verified + 30 years old true; verified + 17 false; not verified + 30 false; verified but null DOB false.
- [ ] **Step 2: Run, see FAIL.**
- [ ] **Step 3: Write `migrations/add_age_verification.sql`** (BEGIN; two `ADD COLUMN IF NOT EXISTS`; COMMIT), add the same two statements to `ensureSchema`, and add the two columns to the `users` table in `shared/schema.ts`.
- [ ] **Step 4: Apply the migration to the real database now** with the same method used for `add_rooms_live_video.sql` (a small `pg` script run with `node --env-file=.env`; copy the pattern of `scripts/run-social-events-migration.mjs`). Verify with `SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name LIKE 'age_verified%'`. Expected: two rows. Note in the baseline file that it was applied.
- [ ] **Step 5: Implement** `shared/ageVerification.ts`, `server/identity/ageVerification.ts`, the storage helper and the two routes. Make sure the read route returns only the `AgeVerification` shape (never the DOB).
- [ ] **Step 6: API tests:** a normal user cannot POST the admin route (403); an admin can set it, then `GET /api/users/me/age-verification` as that user returns `verified: true, band: "adult"`; after the admin changes the user's DOB the flag is cleared.
- [ ] **Step 7: Run** `npm run test:rooms`. Expected: pass.
- [ ] **Step 8: Commit** `feat(identity): age verification columns, stub verifier and admin route`.

### Task 0.4: Money math, pure

**Files:**
- Create: `shared/money.ts`
- Test: `scripts/test-rooms-unit.ts`

**Interfaces:**
- Produces: `export type SprayTier = "n20" | "n50" | "n100" | "bundle" | "bag" | "rain"`, `export const SPRAY_CATALOGUE: Record<SprayTier, { v3c: number; kobo: number; platformPct: number; label: string }>` (values from the spec section 5), `export const TICKET_PLATFORM_PCT = 15`, `export interface Breakdown { price: number; vat: number; fee: number; reserve: number; net: number; platform: number; host: number; guest: number | null }`, `export function breakdown(opts: { price: number; platformPct: number; reservePct: number; stageGuest?: boolean }): Breakdown`, `export function sprayBreakdown(tier: SprayTier, stageGuest?: boolean): Breakdown`, `export function ticketBreakdown(priceKobo: number): Breakdown`, `export const UNIT_LABEL = "V3C"`, `export function formatV3c(n: number): string`.
- Behavior: all amounts integers in kobo; throws `RangeError` for non-integer, negative or zero `price`; rounding exactly as spec section 5.

- [ ] **Step 1: Write the failing tests** in `scripts/test-rooms-unit.ts` using the six vectors from spec section 5, asserting every field with `assert.deepEqual`. Example for the money bag: `sprayBreakdown("bag")` deep-equals `{ price: 1000000, vat: 69767, fee: 25000, reserve: 25000, net: 880233, platform: 176047, host: 704186, guest: null }`; `sprayBreakdown("bag", true)` has `host: 132035, guest: 572151`.
- [ ] **Step 2: Add the property test:** for every `price` from 1 to 20000, `breakdown({price, platformPct: 20, reservePct: 0.025})` satisfies `platform + host === net` and `vat + fee + reserve + net === price`; with `stageGuest: true`, `platform + host + guest === net`. Add `RangeError` tests for `0`, `-5`, `10.5`, `NaN`.
- [ ] **Step 3: Run, see FAIL.**
- [ ] **Step 4: Implement** `shared/money.ts` per the formulas in the spec (single function `breakdown`; `sprayBreakdown` and `ticketBreakdown` are thin wrappers using the catalogue and `reservePct` 0.025 and 0.01).
- [ ] **Step 5: Run** `npx tsx scripts/test-rooms-unit.ts`. Expected: all new tests PASS.
- [ ] **Step 6: Commit** `feat(money): pure spray and ticket breakdown with test vectors`.

### Task 0.5: Phase 0 gate

- [ ] **Step 1:** `npm run test:rooms` all green; `npx tsc --noEmit | grep -c "error TS"` is not above baseline; `npm run build` exits 0.
- [ ] **Step 2:** Run the `code-review` skill (or dispatch a reviewer subagent) on the branch diff. Fix findings.
- [ ] **Step 3:** Update the handoff file's progress table (`HANDOVER_ROOMS_BUILD_2026-10-17.md`): mark phase 0 done, list commit hashes.
