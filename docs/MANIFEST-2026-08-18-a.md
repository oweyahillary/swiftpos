# MANIFEST 2026-08-18-a — A128 custom-method sales silently never sync (cloud `payments.method` domain)

**Base:** `origin/dev` (`46ad3ae`, A127). Register ID **A128**. Cloud-only: one
migration + one type-only schema comment + register/doc. **No desktop change**, no
`LOCAL_SCHEMA_VERSION` bump (stays 52) — the till already writes the right value and
already has the drain path.

## The bug (field report)

A bill paid with a business's **custom payment method** (A95 — "Coop Card", "Airtel
Money", a house account) stays on the till and **never appears on the cloud /
dashboard**. Reported as a desktop sync fault; it is a cloud-schema fault.

## Root cause

The custom `code` is written to `payments.method`. But the **cloud** column is:
- value-CHECK-constrained by `payments_method_check` — only `cash | mpesa | card |
  credit | glovo` (`00_baseline.sql`, last widened `46_payment_method_glovo.sql`);
- typed `character varying(20)`, while `payment_methods.code` is `varchar(40)`.

`create_order_atomic` (migration 69) runs `INSERT INTO public.payments (… method …)
VALUES (leg->>'method' …)`. For a custom-method sale that INSERT fails — **23514**
(unknown code) or **22001** (code longer than 20 chars) — the atomic RPC aborts,
`POST /api/orders` returns an error, and the till's sync engine parks the order in
`sync_queue` (5 retries → `failed`, surfacing "⟳ N failed"). It is **silent** because
the till's LOCAL `payments.method` is plain `TEXT` — the cashier sees a completed
sale. `room_charge` (migration 07) hit the same wall; migration 86's "free string…
never breaks either way" note is half true (not an FK, but IS check-constrained).
Register's recurring shape: two schemas that must agree, nothing comparing them.

## Files (2 code + 1 doc-correction + register + manifest)

| File | Change |
|---|---|
| `migrations/89_payment_method_free_text.sql` | **NEW.** (1) `ALTER COLUMN method TYPE varchar(40)`; (2) `DROP CONSTRAINT IF EXISTS payments_method_check`; (3) add `payments_method_format_check CHECK (method ~ '^[a-z0-9_]{1,40}$')`, guarded by `pg_constraint` (idempotent). `public.`-qualified (A62). REVERT in header. |
| `apps/server/src/lib/schemas.ts` | `PaymentSchema.method` `z.enum(['cash','card','mpesa','loyalty','split','other'])` → `z.string().regex(/^[a-z0-9_]{1,40}$/)` + comment. This enum was a THIRD disagreeing list and **unwired** (`CreateOrderSchema` is referenced only in a `validate.ts` docstring, applied to no route) — rewritten so it can't silently reject every custom-method order if anyone later wires it. Type-only, additive. |
| `migrations/86_payment_methods.sql` | Header **correction note only** — no SQL change (86 is applied). Records that its "free string… never breaks" claim was half true and points to 89. |
| `docs/AUDIT-REGISTER.md` | A128 changelog row + `Last updated` line. |

## The fix, and why it is not a loosened gate (rule 20)

The A95 design decision (migration 86) is that `method` is free text. The fixed-value
check was the stale artefact that never got reconciled with it. Migration 89 does not
remove the guard to admit one value — it swaps a **wrong-shaped** gate (a value enum,
where the domain is per-business and dynamic) for a **right-shaped** one (a format
check). It still rejects empty strings, whitespace, mixed case, and over-length junk.
Cash reconciliation is untouched: every drawer query filters `method = 'cash'`
specifically, so widening the domain cannot move a count (same argument as migration 46).

## Recovering the parked sales

No data entry, no desktop build. After the prod-migrate, each affected till taps
**"⟳ N failed"** (`retryFailedOrders()` re-arms the queue). Push carries
`X-Idempotency-Key: order_id`, so a resend inserts once and dedups — the backlog drains
itself.

## Verified — against real Postgres (PGlite), by running it

- **The actual migration file** applied to a seeded `payments` (existing `cash`/`mpesa`
  rows) — **twice**, no error (idempotent); existing rows validate under the new check.
- After: `character_maximum_length = 40`; constraints are `payments_method_format_check`
  (+ the not-null).
- **Mutation-checked the gate (rule 23), not just the fix:**
  - pre-fix: `coop_card` → 23514, `room_charge` → 23514, 24-char code → 22001;
  - post-fix ACCEPTED: `cash`, `coop_card`, `room_charge`, 24-char code;
  - post-fix still REJECTED: `''`, `Bad Method`, 41-char value.
- **`apps/server` `tsc` clean** — deps installed and `tsc --noEmit` run on the bench,
  exit 0 (the `schemas.ts` regex-string edit type-checks).
- **Gates green:** `check-register-consistency` (89 entries, header agrees with body),
  `check-schema-drift` (migrations and DB agree), `check-doc-refs` (every cited doc,
  incl. this manifest, is in the tree).

## NOT verified on the bench / owner action

- **PROD-MIGRATE 89** via the `DB migrate (production)` Action, which runs on **`main`**.
  `dev` is currently ahead of `main` (A113→A127 unpromoted) — 89 will not reach prod
  until it is on `main`. Until then the fix is inert in production.
- **One real custom-method sale** end-to-end on a till after the migrate, then confirm
  the parked backlog drains on "⟳ N failed".
