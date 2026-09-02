# MANIFEST 2026-08-27-p — A183: per-device order-number uniqueness (the durable fix for A181)

*Reconstructed 2026-08-29 to restore the citation trail — `docs/AUDIT-REGISTER.md`
(A183) and `HANDOFF-2026-08-28.md` both cite this file. The original `-p` patch
never entered the repo: it failed to apply on the owner's box (register drift +
`migrations/94_order_number_per_device.sql` already existed). Migration 94 is live
in prod and has since been committed by hand; **`tests/order-number-per-device.test.mjs`
was reconstructed alongside this manifest on 2026-08-29 (6/6, real SQLite, with a
mutation block), closing the A183 repo-debt.***

**Base:** `d5bd396` + the A175–A182 chain (follows `-o`). **Cloud-only DDL —
applied on the cloud; no server or desktop code change, and no version bump
(rule 22).**
**Artifact:** `swiftpos-2026-08-27-p.patch`. The durable fix for A181's silent
order loss; A182 attacks the same root from the identity side.

## Why

A181 lost sales silently because the cloud enforced
`UNIQUE (business_id, branch_id, order_number)`, but an order number is a per-TILL
display value (`terminal_code--localSeq`). Two tills at one branch — a second
machine, or a reinstall re-named "T1" — mint the same numbers; the second till's
orders were rejected (409) and the client wrongly recorded the 409 as `synced`, so
the sale never reached the cloud. A182 stops the reinstall case (MAC restores the
old code); **this removes the trap entirely** so distinct terminal codes become a
human-clarity nicety, not the only thing standing between the shop and lost sales.

## Fix

Migration 94 replaces the branch-wide constraint with a per-device unique index
`(business_id, branch_id, COALESCE(device_id, ''), order_number)`. `device_id` is
already on every till order (`buildCloudOrderPayload`), so two tills' identical
numbers now coexist by device instead of colliding; the server still dedupes a
genuine re-push by `idempotency_key`; and web/legacy NULL-device orders keep their
branch-wide uniqueness via `COALESCE`. Strictly MORE permissive — existing rows,
already unique under the stricter key, cannot violate the new index; nothing
references the dropped constraint by name, and no query looks an order up by
`(branch, order_number)` expecting a single row (both checked). No server or
desktop code change: the 23505 handler already returns 409 only for a true
same-bucket conflict.

```sql
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_business_id_branch_id_order_number_key;

CREATE UNIQUE INDEX IF NOT EXISTS orders_biz_branch_device_ordernum_uidx
  ON public.orders (business_id, branch_id, COALESCE(device_id, ''::text), order_number);
```

## Files

| File | Change |
|------|--------|
| `migrations/94_order_number_per_device.sql` | NEW. Drop the branch-wide order-number constraint; add the per-device unique index. |
| `tests/order-number-per-device.test.mjs` | NEW (6/6, real SQLite mirroring the index; prefers better-sqlite3, falls back to node:sqlite). Reconstructed 2026-08-29. |
| `docs/AUDIT-REGISTER.md` | A183 entry; changelog; next free ID → A184. |
| `docs/MANIFEST-2026-08-27-p.md` | This file. |

## Verification (rule 7) and what is NOT (rule 16)

- `order-number-per-device.test.mjs` — 6/6 against a real SQLite engine mirroring
  the index: two tills MAY share a number; the same till MAY NOT; a NULL-device
  order stays branch-unique. A sixth block is the mutation (rules 10, 23): under the
  pre-94 branch-wide constraint the two-till collision returns and the suite exits
  non-zero, so the assertions measure the index rather than nothing. Reconstructed and
  run 2026-08-29 (`node:sqlite` fallback in the sandbox; better-sqlite3 in CI).
- No code changed, so server + desktop `tsc` are unaffected.
- **Target-only (rule 16), and DONE 2026-08-28:** the DDL was applied on the live
  cloud `orders` table (a `CREATE UNIQUE INDEX` on a real table — run in a
  transaction, row count confirmed unchanged). `orders_biz_branch_device_ordernum_uidx`
  is present in prod; offline-accrued orders on a real v0.5.38 till synced clean on
  reconnect with no collision. **A183 verified and closed.**

## Deploy

1. Apply migration 94 on the cloud via `scripts/migrate.mjs`; confirm
   `node scripts/migrate.mjs --plan` shows it once and the row count is unchanged.
   *(Done on prod 2026-08-28.)*
2. No server build and no desktop build required.

## Apply / rollback

```
git apply --check swiftpos-2026-08-27-p.patch && git apply swiftpos-2026-08-27-p.patch
node scripts/migrate.mjs --plan            # expect 94 → pending 0 after apply
node tests/order-number-per-device.test.mjs

# DB rollback — ONLY if ever needed, and ONLY safe while no two devices share an
# order number (the new index is what lets them; re-adding the old constraint will
# fail if any cross-device duplicate exists):
#   DROP INDEX IF EXISTS public.orders_biz_branch_device_ordernum_uidx;
#   ALTER TABLE public.orders
#     ADD CONSTRAINT orders_business_id_branch_id_order_number_key
#     UNIQUE (business_id, branch_id, order_number);

# file rollback: git apply -R swiftpos-2026-08-27-p.patch
```
