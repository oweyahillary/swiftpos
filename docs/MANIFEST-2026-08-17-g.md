# MANIFEST 2026-08-17-g — A114 tech reveal code (stable, auto-provisioned, self-healing)

**Base:** apply on top of A108–A113. Register ID **A114**. Server + desktop + one
**data migration**. The `st2.` Ed25519 token path is untouched.

Fixes the "Incorrect code" lockout and settles the offline-till access design:
one stable reveal code per branch (the doorknock) + the existing per-tech,
offline-verifiable token (the real credential).

## Files (5)

| File | Change | Why |
|---|---|---|
| `apps/server/src/routes/tech.ts` | `branch-config` auto-mints + persists a reveal code when missing (imports `generateRevealCode`) | a branch must always expose a code so the till caches a real one; stable thereafter, never rotated here. |
| `apps/desktop/src/main/syncEngine.ts` | `syncAll` refreshes the tech config after each catalogue pull (best-effort) | tills self-heal the cached reveal code + public key on any online sync — no owner-login needed (the UI has none). |
| `migrations/87_backfill_branch_reveal_code.sql` | **NEW** — backfill `tech_reveal_code` for every branch where it's NULL | existing branches get a stable code now, visible in admin, ready to hand to a tech. |
| `docs/AUDIT-REGISTER.md` | A114 entry | rule 14. |
| `docs/MANIFEST-2026-08-17-g.md` | this file | |

## Design (agreed with owner)

- **Reveal code** = one per branch, **stable, never rotated** (rotation is what
  strands offline tills). Cached at enrolment/sync; shown in the admin portal.
- **Token** = per-tech, per-access, 48h, Ed25519 — verified **offline** against
  the cached public key. This is how a never-online till is serviced: tech mints
  a token online on their phone, walks it in, pastes it. Unchanged.
- **Rejected**: a shared symmetric secret to encrypt tokens — it would let a
  stolen till forge access, the exact risk the asymmetric design removes.

## Verified (Node 22 bench)

- `apps/server` and desktop-main `tsc` clean.
- Migration codes match `generateRevealCode()` (8 chars, `A–Z2–9` minus
  confusables); schema-qualified `public.branches` per A62.
- Gates green: schema-drift, sql-binds, table-usage, register, supabase-catch.

## NOT verified here (rule 9)

- The on-till refresh + reveal-stage pass need a real **online sync** on a device.
- The migration touches **prod data** — run it through the prod-migrate step and
  eyeball a few branches' codes against the till (uppercase/trim normalisation).

## Rollback

Per file: `git checkout -- <path>`; delete `migrations/87_*.sql`. To undo the
backfill: `UPDATE public.branches SET tech_reveal_code = NULL WHERE ...` (the
affected ids). No schema change.
