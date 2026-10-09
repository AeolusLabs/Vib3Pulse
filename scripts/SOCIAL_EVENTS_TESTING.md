# Testing social events

One command runs everything:

```
npm run test:social
```

It takes about 10-15 minutes (the database is remote) and prints `ALL GREEN` or lists what failed.

Run part of it:

```
npm run test:social -- --only=4,6     # suites 2, 3, 4, 5, 6
npm run test:social -- --keep         # don't drop the scratch databases afterwards
```

## Is it safe to run?

Yes. It never runs a test or migration against your real database. For each group of suites it:

1. creates a brand-new empty database called `vib3_social_test_<random>` on the same server,
2. builds the schema there (`drizzle-kit push` plus every `migrations/add_social_events*.sql`),
3. runs the suites against it,
4. drops it (even if a suite fails).

The only things sent to your real database are `CREATE DATABASE` and `DROP DATABASE` for a name the runner
generated itself; it refuses to drop anything that doesn't match `vib3_social_test_<8 hex>`. Each suite also
refuses to start unless the database name contains `test`. Needs a Postgres role that may create databases
(Railway's default can). Use `TEST_ADMIN_DATABASE_URL` to point at a different server.

Nothing is emailed or texted: SMS is stubbed, and e-mail is given a dummy key.

## What each suite covers

| Suite | File | What it proves |
|---|---|---|
| 2 | `test-social-events-phase2.ts` | Private events: creation rules, no leakage into discovery, link-based RSVP without an account, capacity under 12 simultaneous RSVPs, host-only guest list + audit log |
| 3 | `test-social-events-phase3.ts` | Public events and abuse controls: link/contact blocking, new-account review and weekly limit, phone OTP, report-to-takedown, strikes and phone/device bans, age gate, host approval of the address, featured eligibility |
| 4 | `test-social-events-phase4.ts` | Admin side: moderation queue and actions, host controls, config, reveal grants (expiry, revocation, scope, no re-delegation), audit immutability, roles, MFA (when switched on), SLA alerts, metrics |
| 5 | `test-social-events-phase5.ts` | Privacy: only name/answer/plus-one stored, notice, opt-out, retention + bounded case hold, account deletion, no guest-list export |
| 6 | `test-social-events-phase6.ts` | Cross-cutting: real CSRF middleware on every write route, every registered route swept for missing auth and wrong-role access, address/invite-link leak sweep over a multi-actor journey, the price-0 ticket path, markup/SQL sanitising, flood limiting, token strength, listing endpoints, startup backfill |

## Things to know

- Each group gets its own database on purpose: the admin queue suites assert on queue-wide state, so leftovers
  from another suite would make them lie.
- Admin MFA ships **switched off** (`ADMIN_MFA_REQUIRED` unset). The admin suite switches it on for itself to
  keep the dormant code covered, then checks the default.
- If a run is killed hard, a `vib3_social_test_*` database may be left behind. It is safe to drop.
- A failing check prints the label plus the value it got. Suites 4 and 6 write the offending request path.
