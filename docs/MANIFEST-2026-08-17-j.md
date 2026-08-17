# MANIFEST 2026-08-17-j — A119 admin portal: edit business + change owner email

**Base:** built on top of **A118** (same two files). Register ID **A119**.
Implements two more unblocked plan items — **G5** (edit business) and **G6**
(change owner email). Still no owner decision needed; D1/D2 items untouched.

> **Cumulative note:** `admin.ts` and `AdminPortal.tsx` here include the A118
> changes too (revoke till / rotate reveal code / health chart). Apply A118 first,
> then A119 — extracting A119's copies over A118 is safe (they're a superset). If
> you somehow skipped A118, A119's files still carry all of it.

## Files (2 code + manifest)

| File | A119 change |
|---|---|
| `apps/server/src/routes/admin.ts` | **G5** — `PATCH /clients/:id` now also accepts `type`. **G6** — new `POST /clients/:id/change-owner-email` (updates the owner auth email, auto-confirmed, + the business contact email; audited; does **not** reassign ownership). |
| `apps/admin/src/AdminPortal.tsx` | **G5** — "Edit" button on the client header → inline edit panel (name / type / currency) → `saveEdit` (PATCH). **G6** — "Change Email" button → `changeOwnerEmail` (mirrors the reset-password flow). |

## Verified (bench)

- Server `tsc` clean (pinned TS 5.9.3 via `npm ci`).
- Admin `vite build` clean.
- Type errors: **+3 vs A118, all the benign `S.input` inline-style `CSSProperties`
  class** the file already has 59 of (now 62) — added by three styled inputs;
  consistent with the file's existing pattern, esbuild-ignored. The one *real*
  type looseness I introduced (`askPrompt` `unknown` → `trim`) was fixed with
  `String(em)`. No new error class; pre-existing `unknown` errors unchanged (3).
- Gates green: supabase-catch, permission-parity, register, doc-refs, table-usage.

## NOT verified — needs a click-test (admin app has no tests)

- **G5:** open a client → Edit → change name/type/currency → Save → detail updates
  and persists on reload.
- **G6:** Change Email → enter a new email → owner can then log in with it. (Auth
  email is auto-confirmed server-side.)

## NOT included (deliberately)

- **Reassign ownership** (transfer `owner_id` to a different user) — bigger, more
  sensitive; left as a separate item. G6 is email-change only.
- G1/G2/G7 (need D1/D2); G9 (marginal — deferred to avoid a count inconsistency).

## Rollback

Per file: `git checkout -- apps/server/src/routes/admin.ts apps/admin/src/AdminPortal.tsx`.
