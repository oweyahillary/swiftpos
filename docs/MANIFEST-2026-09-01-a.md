# MANIFEST 2026-09-01-a — A191 (session-loss on /kds) + deploy-gap note

**Base:** current dev. Docs only.

## What
Processes the 2026-09-01 browser reports. Key finding: the test ran against a **stale
dashboard deploy** — A185/A188/Orders-view/webhook-log were present, but A190, A187
void/refund, A3, A184, A146-email, A144 came back "absent" because their committed code
is not in the deployed dashboard. Those are NOT code failures.

Genuine new bug logged: **A191** — visiting `/kds` (old route) clears owner+POS tokens
app-wide via `clearAllTokens()` on a 401; the A3 rewrite (undeployed) likely fixes it.

| File | Change |
|---|---|
| docs/AUDIT-REGISTER.md | A191 added (P1); header A-P1 19→20; deploy-gap note. |
| docs/MANIFEST-2026-09-01-a.md | This file. |

No items closed: the "FAIL/absent" verdicts are deploy-gap, to be re-verified after the
dashboard is redeployed from current dev.

## Action needed (see chat)
1. Confirm all zips (-a..-r) applied + committed + pushed to dev; redeploy the DASHBOARD.
2. Void the two stranded cash orders once owner is signed in (or via backend).
3. A141 needs the permission backfill (the "manage ingredients" key isn't on any role).
