# MANIFEST 2026-08-14-g — owner device view enriched (A71)

**Delta on your pushed `dev`** (base `a9d7be6`). No desktop change, no version
touch, `package.json` not shipped.

**Register:** A71 opened (P3, OPEN). Header A-P3 3→4.

---

## Files (whole, over base — `git status` first, rule 4)

| File | What |
|---|---|
| `apps/server/src/routes/devices.ts` | `GET /api/devices` now selects `branch_id, device_role, terminal_code, created_at` and returns `branch_name` (resolved in one round-trip). |
| `apps/dashboard/src/pages/settings/DevicesTab.tsx` | Row gains a detail line: branch, role, terminal, **absolute last-active date+time**, app version, enrolled date. |
| `docs/AUDIT-REGISTER.md` | A71 entry + header. |
| `docs/MANIFEST-2026-08-14-g.md` | this file. |

## What changed and why
The Settings → Devices list showed only the cashier's name + a generic label
("SwiftPOS till"). The data for a fuller view was already in `user_devices`; the
endpoint just wasn't selecting it. Now the owner sees, per device: **branch**,
role (till/node/office), terminal code, **last active as a real date + time**
(not "2h ago"), app version, and enrolled date. The person/label/status line is
unchanged — this is purely additive.

Why the person's name still leads: this screen is the per-user *cashier-login
approval* view (migration 14). The device name is the auto-label. **Renaming a
device to something meaningful was deliberately NOT built** — it needs an editable
label + a PATCH (a data change), so it's left as your decision (see below).

## Deploy
Redeploy **cloud (Render) first** (new fields on `/api/devices`), then **dashboard
(Vercel)**. No desktop rebuild.

---

## Rollback
```bash
cd /c/swiftpos/pos
git checkout a9d7be6 -- apps/server/src/routes/devices.ts \
  apps/dashboard/src/pages/settings/DevicesTab.tsx docs/AUDIT-REGISTER.md
rm docs/MANIFEST-2026-08-14-g.md
```

## Verified on the bench (rule 7 — Linux, Node 20; rule 9)
- `apps/server` `tsc`: **0 errors**. `apps/dashboard` `tsc`: **0 errors**.
- Gates green: register-consistency, doc-refs, supabase-catch, table-usage, own-rows.

## NOT verified here — live (rules 9, 16) — closes A71
- The device row shows the right **branch name**, a real **last-active timestamp**,
  role, and version once the deployed dashboard loads a real device.
- `node scripts/run-all.mjs` before shipping.

## Open decision — device renaming
If you want the owner (or admin) to give a device a human name ("Front Till",
"Bar 2") instead of the auto-label, say so and I'll add an editable `device_label`
+ a small PATCH endpoint + the edit control. It's a data change, so I left it for
you to green-light rather than assume.
