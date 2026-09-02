# MANIFEST 2026-08-31-o — A3 fault 1 (KDS token) — client slice (option ii)

**Base commit:** `189bfc2` (dev). Dashboard only. Pairs with the server slice (`-n`).

## What
The `/kds` display and the owner generator, completing fault 1 (the display can now
authenticate and load). Option (ii): the token is pasted once and stored locally, never
in the URL.

| File | Change |
|---|---|
| `apps/dashboard/src/pages/kds/KDSPage.tsx` | Reads a KDS token from localStorage (one-time paste setup screen); derives its branch from the token (not the URL); sends `Authorization: Bearer` on the load, 30s-poll, realtime re-fetch, and status PATCH; "Unlink" control to reset. |
| `apps/dashboard/src/pages/settings/KitchenDisplayTab.tsx` | **NEW.** Owner generator: pick a branch → `POST /api/kitchen/kds-token` → copy the token. |
| `apps/dashboard/src/pages/settings/DevicesPrintersPage.tsx` | Add the "Kitchen display" tab. |
| `apps/dashboard/src/App.tsx` | Lazy-import + route the tab under Settings → Devices. |
| `docs/AUDIT-REGISTER.md` | A3: fault-1 client slice recorded (fault 1 done, pending browser). |
| `docs/MANIFEST-2026-08-31-o.md` | This file. |

## Verification (rule 7)
```
cd apps/dashboard && npm run build   → exit 0 (KDSPage + KitchenDisplayTab bundles)
node scripts/check-api-routes.mjs    → OK (285 calls; the new kds-token call matches)
node scripts/check-register-consistency.mjs / doc-refs → OK
```

## Could NOT be verified here (rule 16 — browser). This is the A3 acceptance test:
1. As owner → Settings → Devices and printers → **Kitchen display** → pick a branch →
   **Generate token** → Copy.
2. Open **`/kds`** on a screen → paste the token → **Save & start**.
3. Confirm the board **loads that branch's tickets** (no more 401), the 30s poll
   refreshes, and advancing a ticket (Start/Ready/Collected) works.
4. Confirm a non-owner can't generate (403), and the token only works on `/kds`.
5. **Fault 3 (realtime):** with migration 95 applied, watch whether a new ticket appears
   instantly (realtime) vs within 30s (poll). If only the poll works, realtime RLS is
   enforced on the stream — a separate follow-up; KDS is still functional on the poll.

## Rollback
```
git restore apps/dashboard/src/pages/kds/KDSPage.tsx apps/dashboard/src/pages/settings/DevicesPrintersPage.tsx apps/dashboard/src/App.tsx docs/AUDIT-REGISTER.md
rm apps/dashboard/src/pages/settings/KitchenDisplayTab.tsx docs/MANIFEST-2026-08-31-o.md
```
