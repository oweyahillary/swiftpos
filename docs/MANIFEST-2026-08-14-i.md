# MANIFEST 2026-08-14-i — fleet-health "Terminals" page made reachable (A73)

**Delta on your pushed `dev`** (base `a9d7be6`). One-line nav fix. No desktop
change, no version touch, `package.json` not shipped.

**Register:** A73 opened (P2, OPEN). Header A-P2 5→6.

---

## Files

| File | What |
|---|---|
| `apps/dashboard/src/components/DashboardLayout.tsx` | Restore the "Terminals" link in the rendered (dynamic) Setup group. |
| `docs/AUDIT-REGISTER.md` | A73 entry + header. |
| `docs/MANIFEST-2026-08-14-i.md` | this file. |

## What it does
`FleetPage` — the "Terminals" screen showing each till's build and **when it last
synced** (stale-first, with "N terminals not syncing" banners) — was already built
and routed at `/dashboard/terminals`, but the nav never linked to it: two Setup
definitions in `DashboardLayout` had drifted, and the one actually rendered had
dropped the link. Restored. Now: **Setup → Terminals** opens the fleet view. This
is the big brother of the A72 stale badge — the at-a-glance "who's offline" screen.

Nothing else needed — the page and its `/api/devices/fleet` endpoint were already
complete.

## Deploy
Dashboard (Vercel) only. No cloud change, no desktop rebuild.

---

## Rollback
```bash
cd /c/swiftpos/pos
git checkout a9d7be6 -- apps/dashboard/src/components/DashboardLayout.tsx docs/AUDIT-REGISTER.md
rm docs/MANIFEST-2026-08-14-i.md
```

## Verified on the bench (rule 7 — Linux, Node 20; rule 9)
- `apps/dashboard` `tsc`: **0 errors**. Both Setup definitions now list Terminals.
- Gates green: register-consistency, doc-refs.

## NOT verified here — live (rules 9, 16) — closes A73
- "Terminals" appears under Setup and opens the fleet table with real rows.
- `node scripts/run-all.mjs` before shipping.

## Latent risk flagged, not fixed (rule 12)
`DashboardLayout` still has two Setup definitions (static + dynamic rebuild) that
duplicate each other and will drift again. They should be one source. That's a
separate refactor — say the word and I'll dedupe them so this can't recur.
