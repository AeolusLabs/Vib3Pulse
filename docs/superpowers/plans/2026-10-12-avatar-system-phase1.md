# Avatar System Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every user can create a flat, outlined 2D avatar (female, male, neutral) that shows as their pin on the map.

**Architecture:** Avatar is a versioned JSON config in a nullable `users.avatar` JSONB column. One shared module (`shared/avatar.ts`) owns option lists, defaults and the validator; one React component renders any config to SVG; the map builds Leaflet `divIcon` HTML from that component with `renderToStaticMarkup`.

**Tech Stack:** TypeScript, Drizzle + Postgres, Express, React 18, wouter, TanStack Query, Leaflet, tsx test scripts (no test framework in repo; follow `scripts/test-*.ts` with `node:assert`).

**Spec:** `docs/superpowers/specs/2026-10-12-avatar-system-phase1-design.md`. Renderer reference to port: `docs/superpowers/specs/2026-10-12-avatar-mockup.html` (functions `av()`, `pin()`, `cel()`, `mix()`, tables at top of its `<script>`).

## Global Constraints

- Config shape is exactly: `{ v: 1, type, skin 0..7, hair, hairColor 0..7, expression, facial, outfit, outfitColor 0..7, eyewear, headwear, hoops }`.
- `type` in `female | male | neutral`. Hair lists per type exactly as in the mockup `HAIRBY`; female never has facial hair.
- Expressions: smile, grin, smirk, wink, neutral, frown, scowl, surprised. Facial: none, stubble, mustache, goatee, beard, full. Outfits: hoodie, bomber, tee, tank, sweater. Eyewear: none, round, shades. Headwear: none, cap, beanie, headphones.
- Schema change must be applied to the production DB in the same task, then verified (project rule). Additive nullable column only.
- Any `req.login()` response must be sent inside its callback (the existing PATCH route already does; do not break it).
- Never return sensitive fields: route all user rows through `toPublicUser()`; `avatar` is public data.
- Map sharing rules, rounded positions and expiry are unchanged.
- Avatar must never throw on bad or missing data; fall back to photo, then initial.
- Interactive controls: `button` with `aria-pressed`, 44px targets, visible focus, `prefers-reduced-motion` disables blink and breathe.
- Do not push to GitHub, and commit only when the user asks. Stage by name if committing. Run `npm run build` before any push.

## Review Focus

- A stored `avatar` value that is garbage (string, array, unknown ids, hair invalid for type) renders the fallback and never crashes the map. Tested in Task 1 and Task 3.
- PATCH with extra or hostile keys (`__proto__`, oversized strings, arrays) stores only sanitized known keys. Task 2.
- A friend with no avatar still shows their photo or initial on the map. Task 4.
- Many avatars on one page (map with 30 pins) do not collide on SVG ids. Task 3.
- Switching body type in the editor never leaves an invalid hair or facial-hair value. Task 5.

## File Structure

- Create `shared/avatar.ts`: types, option lists, `HAIR_BY_TYPE`, `DEFAULT_BY_TYPE`, `defaultAvatar(type)`, `sanitizeAvatarConfig(input)`.
- Create `client/src/components/avatar/{palette.ts,shapes.ts,hair.tsx,face.tsx,clothing.tsx,extras.tsx,Avatar.tsx,AvatarPin.tsx}`: renderer split by responsibility.
- Create `client/src/pages/AvatarEditorPage.tsx`: editor.
- Create `client/src/components/avatar/AvatarPrompt.tsx`: dismissible first-run card.
- Modify `shared/schema.ts`, `server/auth.ts`, `server/routes/users-routes.ts`, `server/routes/map-routes.ts`, `client/src/hooks/useAuth.ts`, `client/src/pages/MapPage.tsx`, `client/src/App.tsx`, `client/src/components/EditProfileDialog.tsx`, and the feed page that hosts the prompt.
- Create `scripts/test-avatar.ts` (unit, render smoke) and `scripts/test-avatar-api.ts` (PATCH round trip).

---

### Task 1: Shared avatar module

**Files:**
- Create: `shared/avatar.ts`
- Test: `scripts/test-avatar.ts`

**Interfaces:**
- Produces:
  - `type AvatarType = "female" | "male" | "neutral"`; `type AvatarConfig` (shape in Global Constraints).
  - `const HAIR_BY_TYPE: Record<AvatarType, readonly string[]>`; `const EXPRESSIONS`, `FACIAL`, `OUTFITS`, `EYEWEAR`, `HEADWEAR` as readonly string arrays.
  - `defaultAvatar(type: AvatarType = "female"): AvatarConfig`
  - `sanitizeAvatarConfig(input: unknown): AvatarConfig | null` returns `null` for non-objects, otherwise a fully valid config (clamps indexes to 0..7, unknown ids replaced by that field's default, hair forced into `HAIR_BY_TYPE[type]` else the type default, facial forced to `"none"` for female, unknown keys dropped, `v` forced to 1).

- [ ] **Step 1: Write failing tests** in `scripts/test-avatar.ts` using `node:assert/strict`:
  - `sanitizeAvatarConfig("x")`, `(null)`, `([])` return `null`.
  - `{type:"female", facial:"beard"}` yields `facial === "none"`.
  - `{type:"male", hair:"long"}` yields `hair === "fade"` (male default); `{type:"female", hair:"long"}` keeps `"long"`.
  - `{skin: 99, hairColor: -3}` yields `skin === 7`, `hairColor === 0`.
  - Input `{type:"male", __proto__:{x:1}, extra:"y"}` result has no `extra` key and `Object.keys` equals the 11 config keys.
  - Idempotent: `sanitize(sanitize(x))` deep-equals `sanitize(x)` for a fuzz list of 50 random objects.
- [ ] **Step 2: Run** `npx tsx scripts/test-avatar.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `shared/avatar.ts` with the signatures above. Option lists copied from the mockup tables; defaults per type: female `{hair:"long",hoops:true}`, male `{hair:"fade"}`, neutral `{hair:"crop"}`, common `skin:3, hairColor:0, expression:"smile", facial:"none", outfit:"hoodie", outfitColor:0, eyewear:"none", headwear:"none"`.
- [ ] **Step 4: Run** the script. Expected: all asserts pass, prints `avatar unit: ok`.

---

### Task 2: Column, migration, PATCH route, session user

**Files:**
- Modify: `shared/schema.ts` (users table near `avatarUrl`; `updateUserSchema` pick), `server/auth.ts` (`SessionUser`, `userToSessionUser`), `server/routes/users-routes.ts:615-660`, `client/src/hooks/useAuth.ts` (`AuthUser`)
- Test: `scripts/test-avatar-api.ts`

**Interfaces:**
- Consumes: `sanitizeAvatarConfig` from Task 1.
- Produces: `users.avatar` (`jsonb("avatar").$type<AvatarConfig | null>()`); `SessionUser.avatar?: AvatarConfig | null`; `AuthUser.avatar` same; `PATCH /api/users/:userId` accepts `avatar` (object or `null` to clear) and stores the sanitized value; a non-object, non-null value returns 400 `{message:"Invalid avatar"}`.

- [ ] **Step 1: Write failing integration test** `scripts/test-avatar-api.ts` modelled on `scripts/test-venue-write-allowlist.ts` (read it for the throwaway-user and session helpers). Cases: (a) valid avatar PATCH returns 200 and `GET /api/auth/session` shows it; (b) hostile body `{avatar:{type:"male",__proto__:{x:1},evil:"<script>"}}` stores only the 11 known keys; (c) `{avatar:"nope"}` returns 400; (d) `{avatar:null}` clears it; (e) after PATCH the session cookie still works on the next request (no logout). Test user deleted in a `finally`.
- [ ] **Step 2: Run** `npx tsx --env-file=.env scripts/test-avatar-api.ts` against a local server. Expected: FAIL.
- [ ] **Step 3: Add the column** in `shared/schema.ts`, add `avatar: true` to the `updateUserSchema` pick with a zod override that accepts `unknown` object or null; sanitize in the route (`updates.avatar = updates.avatar === null ? null : sanitizeAvatarConfig(updates.avatar) ?? 400`). Add to `SessionUser`, `userToSessionUser`, `AuthUser`.
- [ ] **Step 4: Apply the migration to the production DB now.** Use the repo's existing migration-script pattern (`scripts/run-social-events-migration.mjs`): create `scripts/run-avatar-migration.mjs` running `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar jsonb;`, then run it with `node --env-file=.env`. Verify with `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='users' AND column_name='avatar'`. Expected: one row, `jsonb`.
- [ ] **Step 5: Run** the integration test. Expected: all cases pass; `npm run check` reports no new type errors.

---

### Task 3: Avatar renderer component

**Files:**
- Create: `client/src/components/avatar/{palette.ts,shapes.ts,hair.tsx,face.tsx,clothing.tsx,extras.tsx,Avatar.tsx,AvatarPin.tsx}`
- Test: extend `scripts/test-avatar.ts` (render smoke, uses `react-dom/server`)

**Interfaces:**
- Consumes: `AvatarConfig`, option lists, `sanitizeAvatarConfig` (Task 1).
- Produces:
  - `palette.ts`: `SKINS`, `HAIR_COLORS`, `OUTFIT_COLORS` (hex arrays from mockup), `mix(a: string, b: string, t: number): string`.
  - `shapes.ts`: `cel(...)` helper returning a React fragment (outline, shade, offset light tone, clipped extras) and a `useUid()`-style id generator that is unique per `Avatar` instance (use `React.useId`, sanitized for SVG ids).
  - `Avatar({config, mode?: "full" | "bust" | "face", className?}): JSX.Element` where `mode` selects the viewBox (`full` `10 4 180 276`, `bust` `20 96 160 190`, `face` `50 36 100 108`) and the component sanitizes its own input, rendering `defaultAvatar()` never; for `null`/invalid config it returns `null` so callers use their fallback.
  - `AvatarPin({config, size?: number}): JSX.Element`: round badge with white outline, bust crop clipped to a circle, as mockup `pin()`.

- [ ] **Step 1: Write failing smoke tests** appended to `scripts/test-avatar.ts`: for every type, hair in `HAIR_BY_TYPE[type]`, outfit, expression and facial (male/neutral), `renderToStaticMarkup(<Avatar .../>)` starts with `<svg`, contains exactly one root `<svg`, and has no `NaN` or `undefined` in the markup. `renderToStaticMarkup(<Avatar config={"junk" as any}/>)` returns `""`. Render 30 `AvatarPin`s in one fragment and assert every `id="..."` value is unique.
- [ ] **Step 2: Run** `npx tsx scripts/test-avatar.ts`. Expected: FAIL.
- [ ] **Step 3: Port the mockup renderer** into the files above, one responsibility per file: hair (all 21 styles, back/locks/front layers, cap-hides-front rule), face (eyes with clip per eye, brows, 8 mouths, nose, blush, ears, neck, facial hair), clothing (torso, five outfits with the corrected necklines), extras (eyewear, headwear, hoops). Behaviour and coordinates come from the mockup; React attributes use camelCase (`strokeWidth`, `fillOpacity`, `clipPath`). Idle `blink` and `breathe` classes get CSS in `client/src/index.css` guarded by `prefers-reduced-motion: no-preference`.
- [ ] **Step 4: Run** the script. Expected: `avatar render: ok` with the counts of combinations rendered.
- [ ] **Step 5: Visual check:** temporary route-free page is not needed; render the full matrix to an HTML file via `scripts/` one-off using `renderToStaticMarkup`, open headless Chrome screenshot, and compare to the mockup contact sheets by eye for the same ids. Delete the one-off file afterwards.

---

### Task 4: Map pins and friends payload

**Files:**
- Modify: `server/routes/map-routes.ts` (friends select near line 145; `Going` samples near lines 185-194), `client/src/pages/MapPage.tsx` (`MapFriend`, `Going` interfaces lines 14-15; `friendIcon()` line 50)
- Test: extend `scripts/test-avatar-api.ts`

**Interfaces:**
- Consumes: `AvatarPin` (Task 3), `users.avatar` (Task 2).
- Produces: friends and `friendsGoing.sample` items include `avatar: AvatarConfig | null`; `friendIcon(f, selected)` renders `renderToStaticMarkup(<AvatarPin config={f.avatar} />)` inside the existing 40px wrapper when `f.avatar` sanitizes to a config, else the existing photo or initial markup.

- [ ] **Step 1: Write failing API test:** two throwaway users who are mutual friends, B sharing location with A (reuse the setup from the existing map tests in `scripts/` if present, else the Map sharing endpoints in `map-routes.ts`); B has an avatar; `GET` the nearby endpoint as A and assert B's entry has `avatar.type` equal to what B saved, and a friend with no avatar has `avatar === null`. Also assert the response contains none of `passwordHash`, `email`.
- [ ] **Step 2: Run** and confirm FAIL.
- [ ] **Step 3: Add `avatar: users.avatar`** to the two selects and the `Going` mapping; update the TS interfaces; in `friendIcon` branch on a sanitized avatar. Keep `selected` white ring behaviour.
- [ ] **Step 4: Run** the test; expected PASS.
- [ ] **Step 5: Browser check** (real browser, per earlier lessons): run the dev server, log in as two users, confirm the avatar pin appears, the photo user still shows their photo, an avatar-less user shows the initial, and tapping a pin still opens the existing detail sheet.

---

### Task 5: Editor page

**Files:**
- Create: `client/src/pages/AvatarEditorPage.tsx`
- Modify: `client/src/App.tsx` (add `/avatar` route inside `AuthenticatedLayout`, same pattern as `/map`), `client/src/components/EditProfileDialog.tsx` (add a "Edit avatar" link to `/avatar`)

**Interfaces:**
- Consumes: `Avatar`, option lists, `defaultAvatar`, `sanitizeAvatarConfig`, `useAuth`, `apiRequest` (`client/src/lib/queryClient.ts`).
- Produces: route `/avatar`. State is local until Save; Save calls `apiRequest("PATCH", "/api/users/me", { avatar })` then `queryClient.invalidateQueries` for `["/api/auth/session"]` and the profile keys used by `EditProfileDialog`. Changing body type sets `config = sanitize({...config, type, ...DEFAULT_BY_TYPE[type] hair/hoops/facial})`.

- [ ] **Step 1: Write the failing test** as a pure-function test in `scripts/test-avatar.ts`: export `switchType(config, type): AvatarConfig` from `AvatarEditorPage` helpers (place in `shared/avatar.ts` as `switchAvatarType`) and assert: male to female with `facial:"beard"` returns `facial:"none"` and a female hair; female `long` to male returns `fade`; skin and colours are preserved.
- [ ] **Step 2: Run**; expected FAIL.
- [ ] **Step 3: Implement `switchAvatarType(config: AvatarConfig, type: AvatarType): AvatarConfig`** in `shared/avatar.ts` and build the page: stage preview (`Avatar mode="full"`), tabs Body, Hair, Face, Outfit, Extras, thumbnail tiles rendered with `Avatar mode="face"` or `"bust"`, swatches, Save and Reset buttons, Save disabled when unchanged, existing toast on success and on failure (keep local state on failure). Facial-hair section for female shows the note "Available on Male and Neutral avatars." Use existing design tokens and components (`button.tsx`, `card.tsx`); no new colours.
- [ ] **Step 4: Run** unit script; expected PASS. Then `npm run check` clean.
- [ ] **Step 5: Browser check:** open `/avatar`, switch Female to Male (hair list changes, defaults apply), pick beard and grin, Save, reload, confirm it persisted; switch to Female and confirm the facial-hair note; confirm keyboard tab order and visible focus.

---

### Task 6: First-run prompt, fallbacks, ship check

**Files:**
- Create: `client/src/components/avatar/AvatarPrompt.tsx`
- Modify: the authenticated home page that hosts the card (`client/src/pages/FeedPage.tsx`)

**Interfaces:**
- Consumes: `useAuth` (`user.avatar`), route `/avatar`.
- Produces: `AvatarPrompt()` renders nothing when `user.avatar` is set or the user dismissed it (`localStorage` key `vp.avatarPrompt.dismissed`, wrapped in try/catch); otherwise a card with a short line, a link button to `/avatar`, and a dismiss button.

- [ ] **Step 1: Implement** the component and mount it at the top of the feed.
- [ ] **Step 2: Browser check:** new user sees the card; after saving an avatar it disappears; dismiss persists after reload; with storage blocked the card still renders and dismisses for the session.
- [ ] **Step 3: Full verification:** `npx tsx scripts/test-avatar.ts`, `npx tsx --env-file=.env scripts/test-avatar-api.ts`, `npm run check`, `npm run build`. Expected: all pass with no new errors.
- [ ] **Step 4: Update memory:** add a project memory file for the avatar system (what shipped, where the renderer lives, mockup path, phase 3 and 4 still open) and a pointer line in `MEMORY.md`.
- [ ] **Step 5: Report** to the user what was verified in a real browser and what was not (headwear combos, light mode if untested). Do not push.
