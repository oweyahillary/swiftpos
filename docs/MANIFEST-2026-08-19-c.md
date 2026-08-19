# MANIFEST — 2026-08-19-c (A132 · dashboard nav UI)

Base commit: `7e4c0db` (dev). Follows `-a` (A129) and `-b` (A131). **Dashboard
frontend + docs only — presentation change, no routes/data/business logic, no
server/DB/desktop change, no prod-migrate.** Ships when the dashboard redeploys
from `main` (Vercel).

## What this does

Reshapes the owner dashboard sidebar to feel like the desktop app, keeping the
existing menu arrangement:

1. **Accordion** — one group open at a time; only the group holding the current
   route opens on load; persisted in `localStorage`. Fixes the old
   everything-expanded wall and removes the stale `DEFAULT_OPEN` set.
2. **Desktop icons** — ~30 emoji/unicode glyphs replaced with a monochrome
   outline SVG set (`NavIcon` + `ICONS`) matching the till's icon style. Includes
   the sidebar's light/dark toggle (sun/moon) and the notification icons
   (warning/bar-chart/bell) — the whole sidebar is now emoji-free.
3. **Naming — unchanged.** An earlier pass aligned labels to the desktop
   (POS→Till, Terminals→Tills, …); on owner review the renames read as confusing
   in the web's single sidebar (Till the sell-screen vs Tills the device fleet),
   so they were **reverted in full**. Every menu label is exactly as it is on the
   current dashboard. Only the icons and accordion change.

## Files

| File | Changed | What / why |
|---|---|---|
| `apps/dashboard/src/components/DashboardLayout.tsx` | changed | `NavIcon`+`ICONS` set; `activeGroupLabel`; controlled-accordion `NavGroupItem`; parent open-group state (persisted); `DEFAULT_OPEN` removed; icon keys across NAV / TYPE_SETTINGS / setupGroup / packagedStockItem; theme-toggle + notification icons ported to the SVG set (`NavIcon` gains an optional `size`); **menu labels unchanged** (naming pass reverted per owner review). (A132) |
| `docs/AUDIT-REGISTER.md` | changed | A132 entry (P3, closed) + changelog row + next-free-ID → A133. |

## Rollback

```
git checkout 7e4c0db -- apps/dashboard/src/components/DashboardLayout.tsx docs/AUDIT-REGISTER.md
rm docs/MANIFEST-2026-08-19-c.md
```

(If applied on top of `-a`/`-b`, restore `docs/AUDIT-REGISTER.md` from the combined
working tree instead of `7e4c0db`, since the batches share it.)

## Deploy

No prod-migrate, no server, no till. Live when the dashboard redeploys from `main`.

## Verified on the bench

- **esbuild** bundles the edited TSX clean (exit 0) — syntax, JSX, and structure
  sound; no bracket/paren/JSX errors.
- Repo gates green (`check-register-consistency`, `check-doc-refs`, …).
- `nav-preview.html` renders the redesigned sidebar (icons + accordion; original labels).

## Not verified here

- The dashboard's own **`tsc`** — deps aren't installed on the bench (rule 9).
  Confirm on the CI type-check job or `cd apps/dashboard && npm run build`. The
  change is contained to one component and adds no new imports.
- **Rendered look in the real app** — the preview mirrors the classes, but eyeball
  it in the running dashboard after deploy (icon crispness, active-state colour,
  accordion feel). Type-specific labels (Café/Minimart/Parking/Petrol Setup icons)
  only appear for that business type.

## Optional follow-ons (not in this batch — say the word)

- An icon-only collapsed rail (hover-to-expand) if you want to go further toward
  the desktop feel.
