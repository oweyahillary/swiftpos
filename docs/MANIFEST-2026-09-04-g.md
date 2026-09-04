# MANIFEST 2026-09-04-g — A203 v2 (proactive same-user) + A204 filed

**Base:** stacks on the `-f` batch (A145/A148/A129). **Apply `-f` first, then this.** Scope: one
dashboard file + register. **Working rules:** unchanged.

## Why v2
The browser re-verify found the v1 A203 fix incomplete: a **blocking native dialog still fired for a
normal user** on "Mark received" (froze screenshot capture + unrelated fetches; only a physical Enter
cleared it), before the in-app modal could render. Stock debit/credit was correct; the "no native
dialog" promise wasn't delivered because v1 still routed through the server 409 → catch path.

## Fix (v2 — bulletproof)
`markReceived(t)` decides the same-user case on the **client**: if `t.despatched_by === user.id`
(the transfer list returns `despatched_by` via `select('*')`; `useAuth()` gives the id), it opens the
in-app modal **directly, before any server call** — so the `allowSameUser=false` request and its 409
(and any native dialog gating it) are never reached. A different user marks received straight through.
The "Mark received" button calls `markReceived`, not `advance`.

| File | Change |
|---|---|
| `apps/dashboard/src/pages/stock/StockTransfersPage.tsx` | `markReceived` proactive handler + `despatched_by` on the type + `useAuth`; button rewired. |
| `tests/transfer-receive-hang.test.mjs` | extended: the button must route through `markReceived` (mutation-checked). |
| `docs/AUDIT-REGISTER.md` | A203 v2 note; **A204** filed (Cancel native-confirm + missing reason). Counts A-P3 5→6. |

## Verification (rule 7)
- dashboard tsc 0, `vite build` 0. `tests/transfer-receive-hang.test.mjs` 4/4, mutation-checked.
- register/doc/test gates green.
- **Could NOT verify here:** the browser re-verify (single user completes Mark received via the modal
  with no hang).

## Owner flags
1. **Re-verify A203** after redeploy.
2. **Deploy/branch check:** v1's contradiction (a confirm firing though `dev`'s code had none on that
   path) suggests the dashboard may deploy from a different branch than `dev`. Confirm the topology.
3. **A204** (Cancel confirm + missing reason) is filed P3 — a small standalone fix when wanted.

## Rollback
```
git checkout <base> -- apps/dashboard/src/pages/stock/StockTransfersPage.tsx docs/AUDIT-REGISTER.md
git checkout <base> -- tests/transfer-receive-hang.test.mjs
rm docs/MANIFEST-2026-09-04-g.md
```
