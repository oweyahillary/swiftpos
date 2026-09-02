# MANIFEST 2026-08-27-b — A167 + A168 (+ A169 recorded)

**Base commit:** `6d50d2d` (dev). Cumulative — **supersedes `-a`** (rule 3).
**Artifact:** `swiftpos-2026-08-27-b.patch`, verified `git apply --check` clean at `6d50d2d`. Patch only, no zip: `ipcHandlers.ts` and `syncEngine.ts` have moved in the tree, so whole-file overwrites would be wrong (rules 4, 18).

## What ships

**A167 (P0) — offline PIN sign-in throws `NOT NULL constraint failed: staff_session.token`.**
`signInLocal` wrote `token=NULL` into a `NOT NULL` column, so every offline/5xx
fallback died on the write. Fix: write `''` (readers already coerce it). No
migration (rule 13). See register § A167. Screens: PIN pad (raw) + lock curtain
("Cannot check that PIN right now").

**A168 (P2) — order-push 401 refreshed the wrong token for an offline shift.**
The 401 path called `refreshStaffToken()` unconditionally; an offline shift
pushes under the owner token, so there was nothing to refresh and the order sat
`pending`. Fix: refresh the token the push actually sends, via a new pure
`selectPushRefresh(staffToken)` in `authTransport.ts`. Deliberately NOT the price
path's `staff || owner` fallthrough — orders are cashier-attributed and that
would reattribute a staff sale (that hazard is A169).

**A169 (P1) — RECORDED, NOT FIXED.** The server sets `cashier_id = req.userId`
(token subject), so offline sales — pushed under the owner token — are credited
to the owner, not the cashier. Not a one-liner (the server can't trust a blind
payload cashier claim; rule 20). Blocker named in the register; fix is the A164
desktop device-grant cutover or a signed roster claim.

## Files

| File | ID | Change |
|------|----|--------|
| `apps/desktop/src/main/ipcHandlers.ts` | A167 | `signInLocal`: `token=''` (was NULL) in INSERT + ON CONFLICT UPDATE. |
| `tests/offline-signin-write.test.mjs` | A167 | NEW. Runs the real `signInLocal` INSERT against the real `staff_session` schema; mutation-checked (NULL → red). |
| `apps/desktop/src/main/authTransport.ts` | A168 | NEW export `selectPushRefresh(staffToken)` — pure, no Electron deps. |
| `apps/desktop/src/main/syncEngine.ts` | A168 | Import `selectPushRefresh`; 401 path refreshes staff-or-owner by the token sent; rename `triedStaffRefresh`→`triedAuthRefresh`. |
| `tests/push-refresh-selection.test.mjs` | A168 | NEW. Imports and runs the real `selectPushRefresh` (staff→staff, empty→owner, mutation). |
| `docs/AUDIT-REGISTER.md` | — | A167/A168/A169 entries; changelog; Open `A: 3 P0 · 18 P1 · 19 P2 · 7 P3`; Counts updated. Gate green. |
| `docs/MANIFEST-2026-08-27-b.md` | — | This file. |

## Verification run (rule 7)

- A167: reproduced the throw against the real schema, applied fix, `node tests/offline-signin-write.test.mjs` → **5 passed** (incl. NULL mutation red).
- A168: `node tests/push-refresh-selection.test.mjs` → **4 passed** (incl. mutation). Runs the REAL exported function, not a model.
- `apps/desktop` `npx tsc --noEmit` → exit 0, clean.
- `check-register-consistency`, `check-doc-refs`, `check-test-registration` → all green.
- Bench engine: `node:sqlite` / plain node, Linux/Node 22 — **not** the target's better-sqlite3 under Electron 35 / Node 20 (rule 9). CI runs these at Node 24 (TS type-stripping for the `.ts` import is available there).

## NOT verified here (rule 16 — target-only)

- A167: a real offline sign-in with the cloud down, and the lock-curtain unlock, on a Windows till.
- A168: the full 401 → refresh → retry loop inside `pushPendingOrders` (needs Electron + SQLite + a live 401).
- These are what move A167/A168 from OPEN → CLOSED.

## Rule 15 note

Desktop change → bump the desktop version and **tag after the build**; that bump is not in this patch (rule 22). Batch A167 + A168 into one bump.

## Rollback

```
git apply -R swiftpos-2026-08-27-b.patch
```

One statement in `ipcHandlers.ts` (A167) and one 401 branch + one small pure export (A168); register/manifest edits are additive.

## Item investigated, no patch — "synced on the till but KES 0 on the cloud"

Source finding: `orders.sync_status='synced'` is written in exactly ONE place
(`syncEngine.ts` `markSynced`), only after the cloud at `_serverUrl` returns
`res.ok`/409. So "synced" is truthful — the order reached the cloud the till
pushes to. The till window title shows that cloud is **`localhost:4000`** (a DEV
build; `getServerUrl()` = the cloud URL, rule 21). The cockpit computes "today"
as a fixed UTC+3 day (`reports.ts:54`) and offline orders keep their original
`created_at`, so a booked-yesterday offline sale correctly shows KES 0 for today.

Most likely explanation, in order: (1) the browser cockpit points at a different
cloud than the till's `localhost:4000`; (2) the synced orders booked under a
different day (offline `created_at`) or branch than the cockpit's Today / Main
Branch filter; (3) no orders were created under a working sign-in (A167 blocked
it). None is a code defect provable from the screenshots, so no patch. To
disambiguate, run on the till's cloud DB:
`SELECT branch_id, count(*), sum(total), min(created_at), max(created_at) FROM orders GROUP BY branch_id;`
and confirm the URL the cockpit browser is hitting. If that shows rows the hosted
cockpit never receives, it becomes a real finding and gets an ID.
