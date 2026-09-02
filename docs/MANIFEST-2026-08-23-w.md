# MANIFEST — 2026-08-23-w

**Batch:** A152 — production incident logged (Render outage → tills couldn't sign in). **Docs-only — no zip** (rule 18). **P0, morning priority.**
**Cumulative:** follows -a…-v. Apply after -v.

**Base commit:** `f80f0e9` (`dev` tip). Applies on top of -a…-v.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `docs/AUDIT-REGISTER.md` | New entry **A152 · P0 · OPEN** (marked MORNING PRIORITY); header A-P0 tally 1→2 and Counts row updated. | Log the incident + confirmed root cause; rule 14. |
| `docs/MANIFEST-2026-08-23-w.md` | New (this file). | Rule 2. |

## What happened

Render (cloud) API was down; desktop tills could not sign in, though the desktop app is meant to keep trading offline.

## Confirmed root cause (source)

The cashier auth chain falls back to the offline authority **only when the cloud fetch throws** (a transport failure). `ownerFetch` (`ipcHandlers.ts:368`) returns the raw `Response` and doesn't throw on a 5xx, so a "down-but-responding" cloud (Render edge returns **502/503**) is treated as a *rejection*, not as *unreachable* — the node/cache fallback is never reached (`ipcHandlers.ts ~502–511`). This is the deployed-behaviour instance of the P0 that A17's note flagged.

## Fix direction (verify in the morning — money/auth path, do not build blind)

1. Treat 5xx / gateway / non-JSON as authority **unreachable** → fall through to node → cache; keep a clean 401/403 as FINAL.
2. Guard `res.json()` against non-JSON bodies.
3. Check the node step and the cloud-only `desktop-login`/session path (`ipcHandlers.ts:74`) for the same gap.
4. Confirm the PHASE5/A17 build is actually on the tills (D3 — no auto-update).

## Verification

- `check-register-consistency` → green (A-P0 now 2: A17, A152).
- No code changed.

## Rollback

```
git apply -R A152-incident-offline-auth.patch
```
