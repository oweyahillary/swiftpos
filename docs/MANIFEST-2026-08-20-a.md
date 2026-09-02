# MANIFEST 2026-08-20-a — A133 · Settings menu consolidation (owner dashboard, Slice 1)

**Register:** A133 · P2 · owner dashboard Settings regrouped into three tabbed sections
**Base commit:** `e575e00` (A129) · branch `dev`
**Scope of THIS slice:** owner dashboard (`DashboardLayout` surface) only.
Manager dashboard parity is **Slice 2 — specified below, not built** (rule 12: the
manager is a 1,357-line flat, PIN/permission-gated tab switcher with a different
auth/data context; folding it into the same taxonomy is its own verified change,
not a rider on this one).

Nothing here is merged or pushed. This is a reviewable before/after for sign-off.

---

## What changed and why

The dashboard sidebar had a single flat **Setup** group carrying eight unlike
things (Branches, Printers, Print stations, Terminals, Table Turnover, KRA eTIMS,
Staff Management, [vertical] Setup, KDS). Two of those weren't settings at all
(Table Turnover is a report; KDS is a live screen), one estate pair was split
(Terminals top-level vs Devices buried inside Staff Management), and Payment
methods sat under **Menu**. This slice regroups the genuine settings into a
**Settings** group with three items, each opening its own tabbed page — the same
sidebar-group→page pattern the app already uses for Menu, Stock, Finance.

### New Settings taxonomy (owner)

- **Users and access** → Staff members · Roles and permissions
- **Devices and printers** → Terminals · Devices · Printers · Print stations
- **Business** → Branches · Tax & compliance · Payments · [vertical] Setup · Integrations

### Non-settings items moved to where they belong

- **Table Turnover** → Finance group (it is a report). Route `/dashboard/turnover` unchanged.
- **KDS** → top level near POS (it is a live operational screen). Route `/kds` unchanged.
- **Payment methods** → Business › Payments (tender config, not catalogue).

---

## Decisions taken (flagged for your review)

1. **Branches placed under Business.** It is company structure; Business is the
   vertical-neutral home. Old `/dashboard/branches` redirects there; branch detail
   `/dashboard/branches/:id` is unchanged (its links are absolute, so it works from
   either location).
2. **Profile deferred to A134 (opened, not built).** The mockup's Business ›
   *Profile* tab is the one genuinely NEW page — business name, currency, receipt
   header, 24-hour operation. It needs its field list agreed before it is built, so
   per rule 20 it is intentionally not shipped here. The other four Business tabs are
   pure regroupings of existing pages and ship now. Tell me the fields and A134 adds it.
3. **Vertical Setup is one tab, resolved by `business.type`** (Restaurant / Café /
   Minimart / Parking / Petrol) instead of five separate menu entries.

---

## Files

### New (6) — all under `apps/dashboard/src/pages/settings/`

| File | What it is |
|---|---|
| `SettingsSection.tsx` | Reusable shell: section title + horizontal NavLink sub-tab bar + `<Outlet>`. Tabs are URL-addressable (deep links + back button work). |
| `UsersAccessPage.tsx` | Users-and-access section. Default export = the shell; named `StaffMembersRoute` / `RolesRoute` wrap the existing `StaffTab` (fed branches via Outlet context) and `RolesTab`. |
| `DevicesPrintersPage.tsx` | Devices-and-printers section shell; named `DevicesRoute` wraps existing `DevicesTab`. Terminals/Printers/Print stations are the existing standalone pages, mounted as child routes. |
| `BusinessPage.tsx` | Business section shell (`useBusinessTabs()` builds the vertical-aware tab list); named `VerticalSetupRoute` (switches settings page by `business.type`) and `IntegrationsRoute` (Webhooks + Report scheduler). |
| `ReportSchedulerTab.tsx` | Extracted **verbatim** from `SettingsPage` so Integrations reuses one copy, not a second that drifts (rule 17). |
| `WebhooksTab.tsx` | Extracted **verbatim** from `SettingsPage`, same reason. |

### Modified (2)

| File | Change |
|---|---|
| `apps/dashboard/src/App.tsx` | Replaced flat `settings` / `printers` / `stations` routes with three nested sections (`settings/users`, `settings/devices`, `settings/business`, each with an index-redirect + child routes). Added back-compat redirects for every old deep link (see below). Swapped the `SettingsPage` lazy import for the eight new container/wrapper imports; removed the four now-unused vertical-page imports (they moved into `BusinessPage`). `terminals`, `payment-methods`, `branches` became redirects. |
| `apps/dashboard/src/components/DashboardLayout.tsx` | Replaced the dead static Setup group **and** the runtime `setupGroup` rebuild (and the now-orphan `TYPE_SETTINGS` map) with a static three-item **Settings** group. Moved KDS to top level, Table Turnover into Finance, dropped Payment methods from Menu. Vertical filtering / relabels / Inventory-folding logic untouched. |

`SettingsPage.tsx` is now **unrouted** (its five tabs are redistributed). Left in
place, not deleted — flagged as a cleanup candidate so this slice stays additive.

### Back-compat redirects (no old link 404s)

```
/dashboard/settings              → /dashboard/settings/users/staff
/dashboard/terminals             → /dashboard/settings/devices/terminals
/dashboard/printers              → /dashboard/settings/devices/printers
/dashboard/stations              → /dashboard/settings/devices/stations
/dashboard/payment-methods       → /dashboard/settings/business/payments
/dashboard/branches              → /dashboard/settings/business/branches
/dashboard/settings/etims        → /dashboard/settings/business/tax
/dashboard/settings/{restaurant,minimart,parking,petrol} → /dashboard/settings/business/setup
```

---

## Verification

Ran on this bench (deps installed — Node v22.22.2), so this slice is verified
further than A132 could be (which noted dashboard tsc was not run):

- `npx tsc --noEmit` in `apps/dashboard` — **clean, 0 errors** (baseline before edits was also 0; no new errors).
- `npm run build` (vite production build) — **green, `✓ built in ~8s`**; new chunks (`BusinessPage`, `DashboardLayout`, …) emit, so the lazy imports and nested-route wiring bundle correctly.

**NOT verified on this bench (needs a browser — rule 16):**

- Visual rendering of the three sections — in particular a possible **double-heading**
  where a full standalone page (Printers, Terminals, Payments, vertical Setup) renders
  inside a section that also shows its own title. Compiles fine; looks-right is unconfirmed.
- Runtime nav behaviour: Settings group opening on load for a `/dashboard/settings/*`
  route, active-item highlight via prefix match, and the redirects actually bouncing.
- That each section's first tab loads its data (StaffTab branches fetch, etc.).

Please confirm these in `npm run dev` before merge.

---

## Rollback

Single revert of this slice's files restores the prior menu exactly:

```
git checkout e575e00 -- apps/dashboard/src/App.tsx apps/dashboard/src/components/DashboardLayout.tsx
rm apps/dashboard/src/pages/settings/{SettingsSection,UsersAccessPage,DevicesPrintersPage,BusinessPage,ReportSchedulerTab,WebhooksTab}.tsx
```

(`SettingsPage.tsx` is untouched, so the old `/dashboard/settings` page returns intact.)

---

## Register entry (added to AUDIT-REGISTER.md in this change)

A133 closed (this slice) + A134 opened (Profile tab, deferred pending field list).
See the register body and changelog rows dated 2026-08-20.
