# MANIFEST 2026-08-18-b — A129 delivery/aggregator/other sales rejected at sync (orders_order_type_check regression)

**Base:** `origin/dev` (`46ad3ae`, A127). Register ID **A129**. Cloud-only: one
migration + register/manifest. **No client change** — the till already emits these
order types; only the cloud constraint regressed. No `LOCAL_SCHEMA_VERSION` bump.

**Cumulative note (rule 3):** this zip is lettered `-b` but contains ONLY the A129
files, not A128's. A128 (`payments.method`, migration 89) is a separate change whose
ship decision is the owner's and was not confirmed this session, so it is deliberately
NOT bundled here (a break from the strict cumulative rule, called out so it is a
decision not an omission). Say the word and I'll cut a combined `-b` with both.

## The bug (field report)

Till 1 / Beryl: after the trading-day conflict cleared and 14 of 15 orders synced, one
order — `T1--14`, an **mpesa delivery** sale — stayed `pending`. Verbatim server error
(rule 11):

    new row for relation "orders" violates check constraint "orders_order_type_check"

Not a payment-method or A128 issue: a `cash` and two `kcb` orders in the same 18th shift
synced fine. The discriminator is `order_type = 'delivery'`, not the tender.

## Root cause

`58_universal_business_types.sql` (lines 27–35) `DROP`s then re-`ADD`s
`orders_order_type_check` from an incomplete list — `dine_in, takeaway, retail,
parking_session, fuel_sale` — silently dropping the baseline's **`delivery`,
`aggregator`, `other`**. The client never stopped producing them: `POSPage.tsx` types
the selector `dine_in | takeaway | retail | delivery`, migration 35 shipped the whole
delivery-person feature, and `aggregator` is the Bolt/UberEats path. So those sales ring
on the till and then fail forever at the cloud INSERT (`23514`). Same class as A128 — a
client value the server's CHECK no longer permits, with nothing comparing the two.

## Files (1 migration + register + manifest)

| File | Change |
|---|---|
| `migrations/90_restore_order_types.sql` | **NEW.** `DROP CONSTRAINT IF EXISTS orders_order_type_check` then `ADD` it back with the full baseline set (retail, dine_in, takeaway, delivery, aggregator, parking_session, fuel_sale, other). `public.`-qualified (A62). Idempotent (drop-then-add). REVERT in header. |
| `docs/AUDIT-REGISTER.md` | A129 changelog row + `Last updated` line. |

## Rule 6 — swept the class, not just the line that shouted

`delivery` is what failed today, but migration 58 also dropped `aggregator` and `other`.
Both are latent-broken (any Bolt/UberEats or `other` sale would fail identically), so the
fix restores all three, not only `delivery`.

## Verified — real Postgres (PGlite), by running it

- **Reproduced (mutation check, rule 10):** on a table carrying migration 58's
  constraint, `delivery`, `aggregator`, `other` → `23514`; `dine_in/takeaway/retail`
  accepted.
- **After the actual migration file:** all 8 baseline types accepted; a `bogus_type`
  still `REJECTED` (gate restored, not loosened to garbage); seeded rows preserved
  (ADD CONSTRAINT did not fail on existing data); file applied **twice** with no error
  (idempotent).
- **Gates green:** `check-register-consistency` (header agrees with body),
  `check-schema-drift` (migrations and DB agree).

## NOT verified on the bench / owner action (rule 16)

- **Environment (rule 9):** bench is **Linux / PGlite**, not the target Postgres/Supabase
  — a weaker claim. Constraint semantics are faithful, but the real acceptance test is
  the prod-migrate + the on-till retry below.
- **PROD-MIGRATE 90** against the database the Render server actually uses (the same DB
  where `fix-sync.sql` cleared the trading day). Until 90 runs there, `T1--14` keeps
  bouncing.
- **On-till confirmation:** after the migrate, tap **"⟳ N failed"** on Till 1 and
  confirm `T1--14` flips to `synced` and the till's pending count reaches 0.

## Rollback

    psql "<server DATABASE_URL>" -c "ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_order_type_check; ALTER TABLE public.orders ADD CONSTRAINT orders_order_type_check CHECK (order_type = ANY (ARRAY['dine_in','takeaway','retail','parking_session','fuel_sale']::character varying[]));"

(Reverts to migration 58's set — which re-breaks delivery sync, so only to undo.)
