# MANIFEST 2026-08-17-p — A125 purge Stage 2: dry-run preview (non-destructive)

**Base:** clean `origin/dev` (1b4cd3c, has A120–A124). Register ID **A125**.
Purely additive (+85, 2 files). **Deletes nothing.** This is the sign-off artifact
for the destructive purge — the execute is deliberately NOT built.

## Files (2 code + manifest)

| File | Change |
|---|---|
| `apps/server/src/routes/admin.ts` | explicit `PURGE_RETAIN_TABLES` / `PURGE_REVIEW_TABLES` / `PURGE_TABLES` classification + `countFor()` + new `GET /clients/:id/purge-preview` (counts rows per table in each group; read-only). |
| `apps/admin/src/AdminPortal.tsx` | "Preview purge" button (on purge-due clients) → panel showing the three groups with per-table counts. |

## What it does

- **Counts only.** Shows, per table, how many rows a 6-month purge *would* delete,
  grouped: **PURGE** (would be deleted — conservative operational set), **REVIEW**
  (ambiguous — accountant/DPO must classify), **RETAIN** (financial/tax/referenced —
  never deleted). Deletes nothing.
- `branches` is in RETAIN on purpose — retained `orders.branch_id` references it.

## Why the destructive execute is NOT here

Of ~60 business-scoped tables, several operational-looking ones are financial/audit
records (`shifts`, `expenses`, `parking_sessions`, `clock_events`,
`goods_received_notes`) or are FK-referenced by retained data (`branches`,
`customers`). Classifying all 60 is an accountant/DPO judgement, and an irreversible
multi-table delete **cannot be tested on this bench** (no DB, admin app has no tests).
So Stage 2 ships as the preview; the execute (Stage 3 of the plan) is built only after:
1. the RETAIN + REVIEW classification is signed off against real preview counts,
2. the PII-in-retained-records decision (anonymise vs leave), and
3. the financial retention number — **and** it must be tested on a backup/staging
   client first.

## Verified (bench)

- Server `tsc` clean; admin `vite build` clean; type errors unchanged at **65**.
- Gates green: supabase-catch, permission-parity, register, doc-refs, table-usage.

## NOT verified — click-test

- On a purge-due client → "Preview purge" → panel lists PURGE/REVIEW/RETAIN tables
  with counts, and nothing is deleted. (Counts depend on migration 88 being live.)

## Rollback

Per file: `git checkout -- apps/server/src/routes/admin.ts apps/admin/src/AdminPortal.tsx`.
