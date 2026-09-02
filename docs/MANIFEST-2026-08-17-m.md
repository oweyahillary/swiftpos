# MANIFEST 2026-08-17-m — A122 suspend timestamp (grace-period foundation, D2)

**Base:** built on top of **A120 + A121** (`admin.ts` is cumulative — includes the
create + close/reopen branch work). Register ID **A122**. This is the **safe,
non-destructive foundation** for the D2 grace-period purge — it does NOT purge
anything.

> **Apply order:** k (A120) → l (A121) → **m (A122)**. A122's `admin.ts` supersedes
> the copies in k/l (it's a superset). A122 does **not** change `AdminPortal.tsx`
> (that stays as delivered in l).

## Files (1 code + 1 migration + manifest)

| File | Change |
|---|---|
| `migrations/88_add_business_suspended_at.sql` | **NEW** — `ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS suspended_at timestamptz`. NULL = not suspended. |
| `apps/server/src/routes/admin.ts` | suspend now sets `suspended_at = now()`; activate clears it to NULL. (Plus the cumulative A120/A121 branch endpoints.) |

## Why

D2 = suspend is the client end-state; long-suspended clients are purged after a
grace window. Today suspend records no timestamp (`updated_at` is unreliable), so
the grace period can't be measured. This adds the clock. **No purge logic yet** —
that waits on the decisions below.

## Verified (bench)

- Server `tsc` clean; schema-drift gate green (migration 88 `public.`-qualified,
  A62); register / doc-refs / supabase-catch green.
- Requires the **prod-migrate** step for migration 88 (data-layer, additive,
  reversible by dropping the column).

## NOT included — the purge itself (needs decisions, see the plan / chat)

The destructive purge is deliberately not built. It needs: grace length; auto vs
admin-confirmed trigger; and a **scope that respects Kenyan tax retention** (KRA
generally requires ETIMS/invoice/tax records kept ~5 years) — so a purge likely
clears operational data (orders, products, staff, devices) while retaining or
anonymising financial records, or the grace window must exceed the retention rule.

## Rollback

`git checkout -- apps/server/src/routes/admin.ts`; delete `migrations/88_*.sql`.
To undo the column in prod: `ALTER TABLE public.businesses DROP COLUMN suspended_at`.
