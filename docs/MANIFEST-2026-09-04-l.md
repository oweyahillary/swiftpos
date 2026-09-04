# MANIFEST 2026-09-04-l — A206: manager "Open POS" opens nothing (cashier-screen guard)

**Base:** stacks on the A133/A205 work (same session). **Scope:** one dashboard file + test + register.
**Working rules:** unchanged.

## Bug
The manager dashboard's "Open POS" button navigates to `/pos/cashier`, but `CashierScreen`'s mount
guard redirected anyone whose `resolveRoute` home wasn't `/pos/cashier`. A manager resolves to
`/manager`, so it bounced them right back — the button opened nothing. Managers hold `orders.create`
and `/pos/cashier` is their only route to the till (login also sends them to `/manager`), so they
could never ring sales.

## Fix
The guard now redirects **only the owner** (`dest === '/'`, who uses the full web dashboard, not the
POS terminal). Managers and cashiers stay. Cashier/owner behaviour is unchanged — only managers,
previously bounced, now remain on the cashier screen. Exit back to `/manager` via Lock / End shift.

| File | Change |
|---|---|
| `apps/dashboard/src/pages/pos/CashierScreen.tsx` | guard: `if (dest !== '/pos/cashier')` → `if (dest === '/')` — redirect only the owner. |
| `tests/pos-manager-open.test.mjs` | 3 mutation-checked checks (managers resolve to /manager; guard redirects only owner; Open POS button intact). |
| `docs/AUDIT-REGISTER.md` | A206 opened + FIX BUILT. Counts A-P2 14→15. |

## Verification (rule 7)
- dashboard `tsc` 0, `vite build` exit 0.
- `tests/pos-manager-open.test.mjs` 3/3, mutation-checked (restore the over-broad guard → red).
- register/doc/test gates green.
- **Could NOT verify here:** the browser — a manager clicks Open POS → the cashier screen opens; a
  cashier/owner is unaffected.

## Rollback
```
git checkout <base> -- apps/dashboard/src/pages/pos/CashierScreen.tsx docs/AUDIT-REGISTER.md
rm tests/pos-manager-open.test.mjs docs/MANIFEST-2026-09-04-l.md
```
