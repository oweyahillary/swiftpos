# MANIFEST 2026-08-14-h — device naming + stale-sync badge (A72)

**Delta on your pushed `dev`** (base `a9d7be6`). No desktop change, no version
touch, `package.json` not shipped.

**Register:** A72 opened (P3, OPEN). Header A-P3 4→5.

---

## Files (whole, over base — `git status` first, rule 4)

| File | What |
|---|---|
| `apps/server/src/routes/devices.ts` | `PATCH /api/devices/:id/label` — owner renames a device (tenant-guarded, ≤60 chars). |
| `apps/dashboard/src/pages/settings/DevicesTab.tsx` | Inline rename (✎ → input → Save); "not synced >1d" badge. |
| `docs/AUDIT-REGISTER.md` | A72 entry + header. |
| `docs/MANIFEST-2026-08-14-h.md` | this file. |

## What it does
- **Chosen name:** click ✎ next to a device, type a name ("Front Till"), Save.
  Persists — registration only writes `device_label` on first insert, so a sign-in
  never clobbers the name. No migration. The **admin roster (A70) shows the chosen
  name automatically** (same column), so it's consistent everywhere.
- **Bundled extra — stale badge:** an approved device whose `last_sync_at` is over
  a day old gets an amber "not synced Xd ago" badge. This is the failure your fleet
  code calls out — a till that signed in then quietly stopped syncing looks fine by
  last-seen while takings go missing. Only devices that have ever synced can trip
  it (a browser cashier login won't). If you don't want it, it's a self-contained
  block in the row — easy to drop.

## Deploy
Cloud (Render) first (new PATCH route), then dashboard (Vercel). No desktop rebuild.

---

## Rollback
```bash
cd /c/swiftpos/pos
git checkout a9d7be6 -- apps/server/src/routes/devices.ts \
  apps/dashboard/src/pages/settings/DevicesTab.tsx docs/AUDIT-REGISTER.md
rm docs/MANIFEST-2026-08-14-h.md
```

## Verified on the bench (rule 7 — Linux, Node 20; rule 9)
- `apps/server` `tsc`: **0**. `apps/dashboard` `tsc`: **0**.
- Gates green: register-consistency, doc-refs, supabase-catch, table-usage, own-rows.

## NOT verified here — live (rules 9, 16) — closes A72
- A rename **sticks** after the till signs in again (the clobber test).
- A rename for **another business's** device is refused (tenant guard).
- The stale badge shows on a genuinely quiet till and not on a healthy one.
- `node scripts/run-all.mjs` before shipping.

---

## What else could bundle here (your pick — not built)
1. **Name a device at enrolment** — prompt for the name on step 3 of the install,
   so tills arrive named instead of "SwiftPOS till".
2. **Rename from the admin roster (A70)** — same for your support team, cross-tenant.
3. **A real fleet-health view** — surface `last_sync_at` prominently (there's
   already a `/api/devices/fleet` endpoint and a `FleetPage` that isn't in the nav);
   wiring it in gives you an at-a-glance "who's offline" screen.
4. **Device notes** — a freeform note per device ("cracked screen", "bar counter").
5. **Sort/filter the list** by branch, role, or last-active.

Say which and I'll fold them in.
