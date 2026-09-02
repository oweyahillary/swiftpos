# MANIFEST — 2026-08-24-b

**Base commit:** batch -a (`A153`/`A154`) applied on `fa35595`. This batch applies
**on top of -a**.
**Register IDs:** **A155** (CLOSED — greened `check-doc-refs`) · **A153** follow-up
(pruned the two orphaned cart exports flagged in -a).
**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.
**Apply:** `git apply MANIFEST-2026-08-24-b.patch` · **Rollback:** `git apply -R MANIFEST-2026-08-24-b.patch`

Two housekeeping fixes folded together: green the last red gate on the branch tip,
and complete the deletions-only follow-up from -a. No behavioural code changed.

---

## Files

| # | Change | File | What / why |
|---|--------|------|------------|
| 1 | **edit** | `docs/HANDOFF-2026-08-23.md` | Lines 74 + 162: reworded the two references to the outputs-only money-path live-test checklist so they are no longer dangling `.md` citations. Greens `check-doc-refs`. (A155) |
| 2 | **edit** | `apps/dashboard/src/lib/cart.ts` | Removed the two now-orphaned exports `computeUnitPrice` / `computeLineTotal` (their only consumer, the dashboard `VariantModal`, was deleted in -a). Types import stays (`CartItem` still uses them). (A153 follow-up) |
| 3 | **edit** | `docs/AUDIT-REGISTER.md` | A155 entry (CLOSED); A153 updated in-place to record the cart-export prune; Last-updated note. Open tally **unchanged** (A155 is CLOSED). |
| 4 | **new** | `docs/MANIFEST-2026-08-24-b.md` | This manifest. |

**Not touched (rule 22):** no `package.json` version, no lockfile, no `CHANGELOG`.

## Why the desktop cart.ts is NOT touched
`computeUnitPrice` / `computeLineTotal` also exist in `apps/desktop/src/renderer/lib/cart.ts`
and are **live** there (desktop `VariantModal` + `POSPage`). `cart.ts` is not in the
`check-shared-sync` SHARED set, so the dashboard and desktop copies legitimately
differ; pruning the dashboard copy does not desync anything.

## Evidence (rule 7 — what ran, what it printed; rule 9 — where)
Bench: **Linux, Node v22.22.2** (static/type/build level only).

```
apps/dashboard  tsc --noEmit         0 errors (after cart.ts prune)
apps/dashboard  npm run build        ✓ built (vite)
check-doc-refs                       OK — every cited document is in the tree (546 citations)
check-register-consistency           OK — header agrees with body
run-all.mjs                          full suite green (unit + migration + gates + type-checks)
```

Branch-tip gate suite is now **fully green** (the pre-existing `check-doc-refs`
failure noted in -a is resolved here).

## Could NOT be verified here (rule 16)
Nothing gating. Both changes are doc-hygiene and dead-export removal — no on-target
runtime behaviour to confirm.
