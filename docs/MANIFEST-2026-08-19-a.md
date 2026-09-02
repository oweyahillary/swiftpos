# MANIFEST — 2026-08-19-a (A129 · A130 · A125–A127 catch-up)

Base commit: `d70fa0e` (dev, post-A111). This batch is **cloud/DB + gate + docs
only — no desktop change**, so no till rebuild is required for it.

## What this batch does

Closes the A128 *class* rather than a second instance of it. A128 fixed
`payments.method`; the sweep that followed found the same shape on
`orders.order_type` (**A129**) and a dead report riding on the same root cause
(**A130**), and added the durable guard that makes the whole class fail CI. It
also fills the rule-14 register gap for **A125/A126/A127** (shipped in git without
entries).

## Files

| File | New/Changed | What / why |
|---|---|---|
| `migrations/90_order_type_delivery_check.sql` | **new** | Re-admits `delivery` to `orders_order_type_check` (dropped by migration 58 while the feature stayed live). DROP + guarded ADD, idempotent, REVERT block. **The only prod-affecting file — needs prod-migrate.** (A129) |
| `scripts/check-push-domain-parity.mjs` | **new** | Gate: diffs every push-table value-list CHECK against the reviewed producer set; catches the A128/A129 class (cloud domain tighter than the till's free-TEXT column). (A129) |
| `scripts/push-domain-producers.json` | **new** | Reviewed set of values each push-table column can be given, each with a source citation. Data for the gate above. (A129) |
| `scripts/test-migration-90.mjs` | **new** | PGlite test for migration 90 (9/9, mutation-checked: delivery → 23514 without the fix). Auto-discovered by `run-migration-tests.mjs`. (A129) |
| `.github/workflows/ci.yml` | changed | Adds one step, "Push-table domain parity", beside "Schema parity". (A129) |
| `docs/AUDIT-REGISTER.md` | changed | A129/A130 body entries + §A; A125/A126/A127 catch-up entries; header Open 9→10 P1 / 6→7 P2; Counts (+A50 correction, +A129, +A130); Tree v0.5.34→v0.5.35 + migrations→90; changelog rows; next free ID A131. |

## Rollback

Code/gate/docs (everything except the DB) — nothing is destructive; each file is
independently restorable:

```
git checkout d70fa0e -- .github/workflows/ci.yml docs/AUDIT-REGISTER.md
rm migrations/90_order_type_delivery_check.sql \
   scripts/check-push-domain-parity.mjs \
   scripts/push-domain-producers.json \
   scripts/test-migration-90.mjs \
   docs/MANIFEST-2026-08-19-a.md
```

Database (only if a prod-migrate has already been applied and must be undone —
re-breaks delivery sync, so only under direction):

```
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_order_type_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_order_type_check
  CHECK (order_type = ANY (ARRAY[
    'dine_in'::varchar,'takeaway'::varchar,'retail'::varchar,
    'parking_session'::varchar,'fuel_sale'::varchar]));
```

## Prod-migrate (item 2 — the only prod-affecting step)

Migration 90 does **not** run from a laptop (the 08-17 lesson: prod is migrated
only by the Action, which reads `DATABASE_URL` from the `production` GitHub
Environment). Sequence:

1. Commit this batch on `dev`, open the `dev → main` PR, get CI green (the new
   gate now runs there too), merge to `main`.
2. The push to `main` touches `migrations/**`, so **`DB migrate (production)`**
   triggers automatically and **pauses for the required reviewer** — approve it
   in the Actions tab. It then runs, in order: `migrate.mjs --plan` (expect it to
   report **only `90_order_type_delivery_check` pending**, taking prod 86 → 90 —
   if the plan lists 87/88/89 too, those are the earlier already-shipped ones and
   are fine), `migrate.mjs`, then `verify-db-schema.mjs`.
3. After it's green, each till that has parked delivery orders taps **"⟳ N
   failed"** — `retryFailedOrders()` re-pushes with `X-Idempotency-Key: order_id`,
   so the resend inserts once and dedups. No data entry, no duplicates.

No Vercel/Render redeploy is needed (no server or web code changed), and no till
build (no desktop change).

## Verified on the bench (Linux, Node 22, PGlite)

- `check-push-domain-parity.mjs` — **red** naming `orders.order_type emits
  {delivery}` before migration 90; **green** after; does not flag `payments.method`
  (A128's format check). Its own parse-floor and DROP-before-ADD resolution
  exercised.
- `test-migration-90.mjs` — **9/9**, mutation-checked (§0 reproduces 23514 without
  the fix; '', 'aggregator', 'nonsense' still rejected post-fix; idempotent).
- All **18** `check-*.mjs` gates green (17 prior + the new one);
  `check-register-consistency` green (header agrees with body); `check-doc-refs`
  green (this manifest present); `run-migration-tests.mjs` discovers 19 tests.

## Not verified here (needs the owner / the Action)

- The **prod-migrate itself** (86 → 90) — runs only via the Action against the
  `production` environment; the plan/apply/verify output is the proof.
- The **end-to-end delivery sale reaching the dashboard** — provable only on a
  live till + prod DB after the migrate: ring a delivery order, confirm it lands
  in cloud `orders` with `order_type='delivery'` and shows on the dashboard.
- **A130** is a decision, not a change in this batch — left open.
