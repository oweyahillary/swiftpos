# MANIFEST — 2026-08-19-b (A131 · delivery packaging uniformity)

Base commit: `7e4c0db` (dev). Follows the A129 batch (`-a`). **Cloud server code +
test only — no schema, no migration, no desktop change, no prod-migrate.** Ships
with the server on the next deploy from `main`.

## What this does

Closes the packaging gap A129's trace surfaced: cloud `applyStockEffects` deducted
`product_packaging` (Track C) only for `order_type === 'takeaway'`, while every
other stock track runs for all order types. Once A129 lets delivery orders reach
`POST /api/orders` (which runs `applyStockEffects`), their packaging went
uncounted. Per the owner's call, packaging now deducts uniformly for **to-go**
orders — takeaway **and** delivery — while dine-in stays excluded (eaten on-site).

## Files

| File | Changed | What / why |
|---|---|---|
| `apps/server/src/lib/stockEffects.ts` | changed | Track C gate `order_type === 'takeaway'` → `order_type === 'takeaway' \|\| order_type === 'delivery'`; comment updated. (A131) |
| `tests/stock-effects-parity.test.mjs` | changed | Model gate matched; §4 asserts delivery deducts packaging (−2) like takeaway, dine-in still 0; new **§6 reads the real `stockEffects.ts`** and pins the gate to `takeaway \|\| delivery` so the model can't silently drift from the code. (A131) |
| `docs/AUDIT-REGISTER.md` | changed | A131 entry (P3, closed) + changelog row + next-free-ID → A132. |

## Rollback

Nothing destructive; each file independently restorable:

```
git checkout 7e4c0db -- apps/server/src/lib/stockEffects.ts \
                        tests/stock-effects-parity.test.mjs \
                        docs/AUDIT-REGISTER.md
rm docs/MANIFEST-2026-08-19-b.md
```

(If applied on top of the A129 batch, restore `docs/AUDIT-REGISTER.md` from the
A129 working tree instead of `7e4c0db`, since both batches touch it.)

## Deploy

No prod-migrate — there is no DB change. The change is live when the server
redeploys from `main` (Render auto-deploy). No till rebuild (the desktop never
deducted packaging; stock is cloud-authoritative and pulled).

## Verified on the bench

- `tests/stock-effects-parity.test.mjs` — all pass, incl. the new delivery and
  source-pin checks.
- **Mutation-checked (rules 10, 23):** reverting `stockEffects.ts` to
  `order_type === 'takeaway'` turns §6 red, naming the actual gate
  (`order_type === 'takeaway'`); restoring it goes green. The model-only assertion
  stays green either way, which is exactly why §6 (source-pin) exists.
- Repo gates green (`check-register-consistency`, `check-doc-refs`, etc.).

## Not verified here

- `apps/server` `tsc` — not run on the bench (deps not installed); the change is a
  one-token boolean widening on a `string` field, TS-safe. Confirm on the CI
  type-check job or a local `cd apps/server && npm run build`.
- The live effect (a delivery order drawing down packaging-ingredient stock) —
  visible after deploy on a business that has `product_packaging` configured;
  add it as a spot-check to the A129 live checklist (§2: confirm the delivery
  order's packaging ingredient decremented).
