# Avatar system, phase 1: design

Status: approved look, spec awaiting review. Reference mockup: [2026-10-12-avatar-mockup.html](2026-10-12-avatar-mockup.html) (published copy: claude.ai/artifact/EmByHZ24yq9mq2KSvkn8MM). The mockup's `av()` function is the renderer to port.

## Goal

Every user gets a customizable 2D avatar in a flat, matte, outlined style (Snapchat Comic Bitmoji direction). Phase 1 delivers the data model, one shared renderer, the editor, and the map pins. Venue/event buildings (phase 3) and party-room use (phase 4) are out of scope but the config must not block them.

## Decisions already made

- Layered SVG, stored as config JSON, never as images.
- Body types: female, male, neutral. Each type changes face shape, jaw, neck, shoulders, brows and lips, and has its own hair-style list. Outfits are shared.
- 8 complexions, 8 expressions, facial hair for male and neutral only, eyewear, headwear, gold hoops.
- The profile photo (`avatarUrl`) stays. The avatar is additive.

## Scope

In:
1. `users.avatar` JSONB column (nullable).
2. `shared/avatar.ts`: config type, option lists, defaults, `sanitizeAvatarConfig()`.
3. `client/src/components/avatar/`: `Avatar` component (modes: `full`, `bust`, `pin`), ported from the mockup and split into small files (hair, clothing, face, extras).
4. Editor: new `AvatarEditorPage` at `/avatar`, linked from the profile edit dialog and account menu. Tabs: Body, Hair, Face, Outfit, Extras. Live preview. Save via the existing profile PATCH.
5. Map: friend markers render the pin badge. Friend payload carries `avatar`.
6. First-run prompt: after login, users with no avatar see a dismissible card linking to the editor. Not a forced step.
7. Fallback chain everywhere an avatar is shown: avatar config, then photo, then initial.

Out: buildings, wardrobe store or unlocks, poses, party rooms, replacing the profile photo in feed or chat (follow-up once the pin is proven), avatar in notifications.

## Data model

```
users.avatar jsonb null
{
  v: 1,
  type: "female" | "male" | "neutral",
  skin: 0..7, hair: HairId, hairColor: 0..7,
  expression: ExprId, facial: FacialId,
  outfit: OutfitId, outfitColor: 0..7,
  eyewear: "none" | "round" | "shades",
  headwear: "none" | "cap" | "beanie" | "headphones",
  hoops: boolean
}
```

- `v` allows future shape changes without a migration.
- `sanitizeAvatarConfig(input)` is the single validator. It clamps indexes, rejects unknown ids, forces `hair` into the list for the chosen `type`, and forces `facial: "none"` for female. Used by the PATCH route (server) and by the editor (client), so both agree.
- A null `avatar` means "not created yet", not "default avatar".

## Server

- `shared/schema.ts`: add `avatar` column; add to `updateUserSchema` pick, validated through `sanitizeAvatarConfig` in the route (zod refine).
- Migration: additive nullable column, **applied to the production DB in the same task** (project rule), then verified with a select. No separate "run db:push later" step.
- `PUT /api/users/me/avatar` (as built; replaces the earlier "avatar via profile PATCH" idea): body `{ avatar: AvatarConfig | null }`. Strictly validated by `validateAvatarConfig` (400 `{message, field}` naming the first bad field; unknown keys dropped). Own limiter `avatarLimiter` (60/hour) so saves are not charged to the 5/hour profile-edit limiter. Responds inside the `req.login` callback (project rule) with `{...toPublicUser(u), ...userToSessionUser(u)}` because clients cache it as the session user. The general profile PATCH no longer accepts `avatar`.
- `sanitizeAvatarConfig` stays as the lenient repair used when rendering stored values; `validateAvatarConfig` is the strict gate for incoming bodies.
- `SessionUser` and `useAuth` `AuthUser` gain `avatar`.
- `toPublicUser` spreads the row, so `avatar` passes through. Avatar config contains no sensitive data. The global redaction middleware is unaffected.
- `server/routes/map-routes.ts`: add `avatar: users.avatar` to the friends select (and the `Going` samples). No other map behaviour changes: sharing rules, rounded positions and expiry stay as built.

## Client

- `Avatar` renders from config only; no network. Unique SVG ids per instance (counter) so many avatars on one page do not collide.
- `MapPage.tsx` `friendIcon()` builds HTML for `L.divIcon`; it will use `renderToStaticMarkup(<Avatar mode="pin" />)` so the pin shares the component. Selected state keeps the existing white ring.
- Editor state is local until Save. Switching body type resets hair, hoops and facial hair to that type's defaults (as in the mockup). Save disabled until something changed.
- Accessibility: all swatches and tiles are buttons with `aria-pressed` and labels; 44px targets; `prefers-reduced-motion` disables the idle blink and breathe.
- Light mode: the avatar art is theme-independent; surrounding UI uses existing tokens.

## Error handling

- Invalid or missing config renders the fallback chain, never throws.
- PATCH with an invalid config returns 400 with the failing field.
- Save failure keeps editor state and shows the existing toast pattern.

## Testing

- Unit: `sanitizeAvatarConfig` (bad index, unknown hair, hair not valid for type, female with facial hair, missing fields, non-object).
- Render smoke: every hair x type, every outfit x type, every expression renders without throwing and produces one root `<svg>` (loop test, cheap).
- Integration: PATCH round-trip with a valid config and with an invalid one, against a throwaway user.
- Browser (real browser, per earlier session lessons): create avatar, reload, confirm it persists; open the map as a friend and confirm the pin; switch type and confirm hair list changes. The single prod DB means test users are created and deleted by script, as in the social-events tests.

## Risks

- Prod DB is the only DB: the migration is additive and nullable, so existing queries keep working.
- Leaflet `divIcon` takes an HTML string; many pins mean many inline SVGs. Mitigation: render pin mode with a reduced layer set (no back hair detail beyond silhouette) if profiling shows cost; not built unless needed.
- Art is hand-coded SVG: new hairstyles and outfits are code changes for now. Acceptable for phase 1.

## Open items (do not block phase 1)

- Venue/event logo upload on buildings (phase 3 decision).
- Paid or unlockable items (deferred; `v` and the id-based config leave room).
