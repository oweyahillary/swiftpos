# MANIFEST 2026-09-03-g — A199 HOTFIX: device lists 500 after migration 97 (ambiguous `users` embed)

**Base commit:** `2fbd82c` (`dev`, the `-f` tip). **Priority: P1 hotfix — dev is currently broken.**
**Scope:** `apps/server/src/routes/devices.ts` only. No migration, no schema change, no client change.
**Working rules:** unchanged — `HANDOFF-2026-08-08-evening.md §0`.

## What broke and why
Migration 97 (A184 Tier 3 Phase 1) added `user_devices.retired_by REFERENCES public.users(id)` — a
**second** foreign key from `user_devices` to `users` (the first is `user_id`). PostgREST cannot
resolve a bare `users(...)` embed when two relationships exist, so the moment 97 was applied on the
dev DB, **both** device lists began returning 500:
- `GET /api/devices/fleet` — Terminals page (`users ( name )`)
- `GET /api/devices` — Devices tab (`users ( id, name, email, roles ( name ) )`)

This is why applying 97 "changed nothing": before 97 the fleet 500'd on the missing `retired_at`
column; after 97 it 500s on the now-ambiguous `users` embed. One 500 swapped for another.

## The fix
Disambiguate both embeds to the `user_id` relationship by its **constraint name** (confirmed in
`00_baseline.sql`): `users!user_devices_user_id_fkey ( … )`. The embed alias stays `users`, so the
existing `d.users?.name` mapping is unchanged. Swept repo-wide: these are the only two
`user_devices` queries that embed `users`; every other selects explicit columns and is unaffected.

## Files
| File | New? | Change |
|---|---|---|
| `apps/server/src/routes/devices.ts` | edit | Both `user_devices → users` embeds disambiguated to `users!user_devices_user_id_fkey(...)`. |
| `tests/devices-users-embed.test.mjs` | new | 4 mutation-checked guard checks: no bare `users(` embed remains; both lists disambiguated; alias unchanged; the migration-97 FK cause is pinned. |
| `docs/AUDIT-REGISTER.md` | edit | New entry A199 (P1, FIX BUILT) + header count 17→18 P1. |

## Verification (rule 7)
- `apps/server` `tsc --noEmit` **0 errors**.
- `tests/devices-users-embed.test.mjs` **4/4**, mutation-checked (revert either embed to a bare
  `users(` → 2 checks go red; restore → green).
- `check-api-routes` (288), `check-doc-refs`, `check-register-consistency`, `check-test-registration`,
  `check-root-clean` → green.

**Could NOT verify in-sandbox (rule 7):** PostgREST embedding itself — PGlite has no PostgREST layer,
so the definitive proof is the **redeployed dev API returning 200** on `GET /api/devices/fleet` and
`GET /api/devices`. That's the check to run after pushing: reload the Terminals **and** Devices tabs.

## Land it (base `2fbd82c`, from the repo root)
```bash
git checkout dev && git pull origin dev
git am 0001-A199-hotfix-disambiguate-user_devices-users-embeds.patch \
       0002-Register-A199-hotfix-MANIFEST-2026-09-03-g.patch
git push origin dev
```
This is a **forward fix on top of Phase 2** — it keeps the retire feature; no revert needed. (Discard
the earlier revert patches; this supersedes them.)

## Rollback
```
git checkout 2fbd82c -- apps/server/src/routes/devices.ts docs/AUDIT-REGISTER.md
rm tests/devices-users-embed.test.mjs docs/MANIFEST-2026-09-03-g.md
```
