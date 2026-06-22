# Zernio Social Integration — Manual Testing Checklist

Work through these sections top-to-bottom. Each section has a **Setup** note and numbered test cases. Mark each ✅ pass / ❌ fail / ⏭️ skip (no Zernio creds yet).

---

## Prerequisites

| Item | How to verify |
|------|--------------|
| `ZERNIO_API_KEY` set in env | `echo $ZERNIO_API_KEY` — must start with `zernio_live_` |
| `ZERNIO_BASE_URL` set | e.g. `https://api.zernio.com` — no trailing slash |
| DB migration ran | `psql $DATABASE_URL -c "\d connected_socials"` — table must exist |
| Server starts clean | `npm run dev` — no import errors in console |

---

## 1 — Database Schema

**Setup:** Connect to the Postgres DB directly.

- [ ] `connected_socials` table exists with columns: `id`, `user_id`, `platform`, `zernio_account_id`, `handle`, `connected_at`, `disconnected_at`, `oauth_state`, `oauth_state_expires_at`
- [ ] `social_posts` table exists with columns: `id`, `event_id`, `user_id`, `platform`, `zernio_post_id`, `content`, `status`, `error_message`, `posted_at`, `cost_usd`
- [ ] `users.zernio_profile_id` column exists (`VARCHAR(255) UNIQUE`)
- [ ] `UNIQUE(user_id, platform)` constraint exists on `connected_socials`
- [ ] `idx_connected_socials_user` index exists
- [ ] `idx_social_posts_event_platform` index exists
- [ ] `idx_social_posts_posted_at` index exists

**Verify with:**
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name IN ('connected_socials','social_posts')
ORDER BY table_name, ordinal_position;
```

---

## 2 — Zernio HTTP Client

**Setup:** Set a bad API key (`ZERNIO_API_KEY=bad`) to test error handling, then restore the real one.

- [ ] With missing `ZERNIO_API_KEY`: `createOrganizerProfile` throws `ZernioError` with status 500 and message containing "ZERNIO_API_KEY"
- [ ] With missing `ZERNIO_BASE_URL`: same shape of error
- [ ] With valid key: `createOrganizerProfile` returns a non-empty string profile ID
- [ ] Network timeout / Zernio 5xx: route returns HTTP 503 (not 500) — check via `ZERNIO_BASE_URL=http://localhost:1` (nothing listening)
- [ ] Zernio 4xx (e.g. 404 profile not found): route forwards the status, not 500
- [ ] **No API key in logs**: search server output for the literal `ZERNIO_API_KEY` value — must not appear

---

## 3 — OAuth Connect Flow

**Setup:** Log in as an organizer account. Open DevTools → Network.

### 3a — Happy path

- [ ] Visit `/organizer/social` — page loads, "No accounts connected" state shown
- [ ] Click "Connect" for any platform — popup opens (not a new tab)
- [ ] Popup redirects to `https://api.zernio.com/...` (Zernio OAuth page)
- [ ] After authorising on Zernio: popup sends `postMessage({ success: true })` and closes
- [ ] Parent page receives message and calls `refetchSocials()` — connected account appears without a page reload
- [ ] Toast "Account connected" appears

### 3b — OAuth CSRF protection

- [ ] Manually open `/api/auth/social/callback?state=WRONGVALUE` in a new tab (while logged in) — should return HTML that closes the popup, **not** save any account
- [ ] Check server logs: `oauth_state_mismatch` security event logged
- [ ] Open callback with no `state` param — same result, `oauth_state_missing` logged
- [ ] Open callback after the 10-minute TTL (`oauth_state_expires_at` has passed) — should fail gracefully with "OAuth session expired" message

### 3c — Non-organizer blocked

- [ ] Log in as a regular user (not organizer)
- [ ] `GET /api/auth/social/connect?platform=instagram` → HTTP 403 `"Only organizers can connect social accounts"`

### 3d — Invalid platform

- [ ] `GET /api/auth/social/connect?platform=myspace` → HTTP 400

---

## 4 — Connected Socials List

**Setup:** Organizer with at least one connected account.

- [ ] `GET /api/organizer/connected-socials` returns array of `{ platform, handle, connectedAt }`
- [ ] `disconnected_at IS NOT NULL` accounts are **not** returned (soft-deleted ones hidden)
- [ ] Unauthenticated request → HTTP 401
- [ ] Regular user (non-organizer) → HTTP 403

---

## 5 — Disconnect Social Account

**Setup:** Organizer with `instagram` connected.

- [ ] `POST /api/organizer/disconnect-social { platform: "instagram" }` → HTTP 200 `{ success: true }`
- [ ] Re-fetch `/api/organizer/connected-socials` — `instagram` no longer appears
- [ ] DB: `disconnected_at` is set on the row (soft delete, row still exists)
- [ ] Zernio revoke called (check Zernio dashboard or mock the call)
- [ ] **Zernio revoke fails**: server still returns 200, `disconnected_at` is still set locally, error is captured in Sentry (check Sentry or look for `[Social] Zernio disconnect failed` log)
- [ ] Trying to disconnect a platform that is not connected → HTTP 404
- [ ] Another organizer cannot disconnect a different organizer's account (test by sending the request with the wrong session)
- [ ] Reconnecting the same platform after disconnect: `POST /api/auth/social/connect` for `instagram` again — `ON CONFLICT … DO UPDATE` should clear `disconnected_at` and restore the account

---

## 6 — Event Promotion (POST /api/events/:id/promote)

**Setup:** Organizer with `instagram` and `twitter` connected; one **approved** event and one **draft** event.

### 6a — Happy path

- [ ] `POST /api/events/:id/promote { platforms: ["instagram","twitter"] }` → HTTP 200
- [ ] Response: `{ postsCreated: 2, totalCostUsd: <number>, platforms: [{platform, success:true}, ...] }`
- [ ] Two rows inserted in `social_posts` with `status="posted"`
- [ ] `zernio_post_id` and `cost_usd` populated on successful rows

### 6b — Partial failure

- [ ] Connect `instagram` but not `twitter`. Post to both → response has `postsCreated: 1`, `failed: ["twitter"]`
- [ ] `social_posts` row for `twitter` has `status="failed"`, `error_message="twitter not connected"`
- [ ] Response HTTP status is still **200** (partial is not an error)

### 6c — Ownership check

- [ ] Another organizer tries to promote event they don't own → HTTP 403 `"You do not own this event"`

### 6d — Moderation check

- [ ] Promote a **draft** or **pending** event → HTTP 403 `"Event must be approved before it can be promoted"`

### 6e — Idempotency guard

- [ ] POST promote for `instagram` (success). Within 2 minutes, POST again for `instagram` → result shows `success: false, error: "Already posted recently"` for that platform
- [ ] After 2+ minutes: same request succeeds again

### 6f — Rate limit

- [ ] Send 21 promote requests within 1 hour (use a loop or repeated curl) — the 21st returns HTTP 429 with `"Too many promote requests"`
- [ ] Rate limit is keyed to **user ID** not IP — two organizers on the same IP each get their own 20/h quota

### 6g — Content sanitization

- [ ] Create an event with title `<script>alert(1)</script>`, promote it
- [ ] Check `social_posts.content` — HTML tags stripped, plain text only
- [ ] Category with spaces/symbols (`Hip Hop & RnB!`) → hashtag becomes `#HipHopRnB` (alphanumeric only)

### 6h — Validation

- [ ] `{ platforms: [] }` → HTTP 400 `"Select at least one platform"`
- [ ] `{ platforms: ["myspace"] }` → HTTP 400
- [ ] Missing body → HTTP 400
- [ ] Event ID does not exist → HTTP 404
- [ ] Unauthenticated → HTTP 401

---

## 7 — Admin Social Routes

**Setup:** Log in as admin (`super_admin` or `finance_manager`).

### 7a — GET /api/admin/social/dashboard

- [ ] Returns `{ stats, daily_posts, by_platform }`
- [ ] `stats.total_posts` matches `SELECT COUNT(*) FROM social_posts WHERE posted_at >= now() - interval '30 days'`
- [ ] `stats.total_cost_usd` matches `SELECT SUM(cost_usd) …`
- [ ] `stats.posts_failed` matches `SELECT COUNT(*) … WHERE status='failed'`
- [ ] Non-admin request → HTTP 401/403

### 7b — GET /api/admin/social/organizers

- [ ] Returns array; each item has `user_id`, `org_name`, `connected_accounts`, `posts_this_month`, `cost_this_month`
- [ ] No `email` field in any response item
- [ ] `?limit=5&offset=0` returns at most 5 rows
- [ ] `limit` capped at 200 (send `?limit=9999` — response has ≤200 rows)

### 7c — GET /api/admin/social/costs

- [ ] Returns `{ this_month_actual, monthly_projection, by_platform, daily, trend_direction }`
- [ ] `monthly_projection` is a plausible number (not NaN, not 0 when there are posts)
- [ ] `trend_direction` is one of `"up"`, `"down"`, `"stable"`
- [ ] `by_platform` is an object keyed by platform name with string cost values

### 7d — GET /api/admin/social/platforms

- [ ] Returns array of `{ platform, posts_this_month, cost_this_month }`
- [ ] Only platforms that have actual posts appear
- [ ] Content moderator role → HTTP 403 (route is restricted to super_admin, finance_manager, analytics_viewer)

---

## 8 — Frontend: SocialPromotionPage (/organizer/social)

**Setup:** Log in as an organizer in the browser.

- [ ] Page loads at `/organizer/social` without crashing
- [ ] Loading skeletons shown while data fetches
- [ ] "No accounts connected" empty state shown when none connected
- [ ] Connected accounts grid renders (avatar initial, handle, disconnect button)
- [ ] "Connect a new account" buttons render only for unconnected platforms
- [ ] Once all platforms connected, "All platforms connected" message shown
- [ ] Clicking a connect button opens a popup (not a redirect)
- [ ] After popup closes with success: toast appears + accounts list refreshes
- [ ] Disconnect button removes account from grid; selected platform checkbox removed from promote form
- [ ] Event selector shows only approved events (draft events excluded)
- [ ] Platform checkboxes only appear for **connected** platforms
- [ ] "Select all" / "Deselect all" toggle works
- [ ] Promote button disabled when no event selected
- [ ] Promote button disabled when no platforms selected
- [ ] Promote button shows spinner and "Posting to N platforms…" during mutation
- [ ] Results card appears after promote: green checkmark for success, red X for failure
- [ ] Non-organizer user sees "Organizer access only" gate (not a crash)
- [ ] Page is mobile-responsive (test at 375 px width)

---

## 9 — Frontend: AdminSocialDashboard (/admin/social)

**Setup:** Log in as admin.

- [ ] Page accessible from admin sidebar "Social Media" nav item
- [ ] Nav item visible to `super_admin`, `finance_manager`, `analytics_viewer` — hidden for `content_moderator`, `user_support`, `event_reviewer`
- [ ] 4 stat cards render with correct values (cross-check against DB)
- [ ] Loading skeleton shown while queries are in-flight
- [ ] Cost projection card shows month-to-date + projected total + trend badge
- [ ] Trend badge shows correct colour (red=up, green=down, grey=stable)
- [ ] Platform breakdown table sorts by post count descending
- [ ] "No data yet" empty state shown when tables are empty
- [ ] Organizer activity table renders `org_name` (not email)
- [ ] Page does not crash when all counts are zero

---

## 10 — Security Regression

- [ ] CSRF: social routes require the CSRF cookie+header token (same as all `/api/*` routes) — remove `X-CSRF-Token` header → HTTP 403
- [ ] SQL injection: send `platform = "'; DROP TABLE connected_socials; --"` in disconnect body → HTTP 400 (Zod rejects before DB)
- [ ] XSS in `org_name`: insert organizer with `org_name = '<img src=x onerror=alert(1)>'` → check admin dashboard renders it as escaped text (React default)
- [ ] Zernio API key not leaked: check full server log output for the literal value of `ZERNIO_API_KEY` — must not appear anywhere
- [ ] Admin routes require `req.session.adminId` — calling `/api/admin/social/dashboard` with a regular user session (not admin) returns HTTP 401

---

## Done

Once all sections pass, the Zernio social integration is production-ready. Items marked ⏭️ (no live creds) should be retested once a real Zernio sandbox account is available.
