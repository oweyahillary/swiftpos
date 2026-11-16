# A59 — till permission keys: what's actually true, and the phase

**Read this before touching the register entry.** The A59 diagnosis was written
from a grep and is now partly stale. Verified against source and the migration
seeds, 2026-08-12.

## What the register says vs what the code does

A59 says the renderer has *"no permission-key plumbing at all"* and *"every till
gate is a role test."* That is no longer true — a prior session (the A46/A45
work) already built most of it:

- **Keys are delivered to the till, online and offline.** `POST /api/auth/verify-pin`
  returns `permissions` as a `Record<string, boolean>` map (`auth.ts`,
  `effectivePerms` = role_permissions + user_permissions overrides). The main
  process stores it in `staff_session.permissions`, **caches it for offline**
  (`pinCache.ts`), and hands it to the renderer via `auth:verifyPin` /
  `auth:getStaffSession`. `StaffSession.permissions` already exists in `posApi.ts`.
- **A renderer `hasPermission` already exists.** `ManagerPage.tsx:1030`:
  `has(key) = perms['*'] === true || perms[key] === true` — identical to the
  dashboard (`POSAuthContext.tsx:134`) and the cloud.
- **The offline case is already decided.** `has()` reads whatever is in the
  session; offline that map comes from the pin cache. No new decision needed.

So A59 is **re-point the gates that still use the coarse `isManagerRole` onto the
keys the cloud enforces — where a cloud counterpart and a grant exist.**

## The seed reality that constrains everything (checked, not assumed)

`migration 59` grants **manager / supervisor / branch_manager** *"everything
except `settings.manage`"*; `settings.manage` is **owner/admin-only** (migration
27's precedent). This decides which re-points are additive-safe:

- A tab keyed on `settings.manage` alone is **invisible to managers.**
- A tab keyed on a narrow A46 key (receipt.manage, stations.manage, …) is
  invisible to managers **until a migration grants that key to those roles.**

## Gate inventory (ManagerPage nav)

| Tab | Gated on | Cloud gate | Status |
|---|---|---|---|
| Menu | canManageProducts | products.manage | already keyed |
| Staff | canManageStaff | staff.manage | already keyed |
| **Receipt** | canManageReceipt = receipt.manage OR settings.manage | requireAnyPermission('receipt.manage','settings.manage') (business.ts:124) | **re-pointed — pairs with migration 78** |
| **Printers** | ~~isManagerRole~~ -> has('stations.manage') | requireAnyPermission('stations.manage','products.manage') (stations.ts) | **keyed — migration 79** |
| Close Day | isManagerRole | none (cash op) | left role-gated |
| Close Branch | isManagerRole | none (cash op) | left role-gated |

## Done this session

**Receipt → `has('receipt.manage') || has('settings.manage')`**, mirroring the
cloud gate exactly and closing the A45 symptom in the till. **This is additive-
safe only with migration 78**, which grants `receipt.manage` to manager roles —
managers hold neither key otherwise. 78 and this re-point ship together.

**`check-permission-parity` now scans the till.** The comparator matched
`hasPermission(` / `can(` / `permission:` but not the till's bare `has(` helper,
so the till's keys were invisible — the "pattern drifted from the code" blindness
the gate exists to catch. Added a fourth UI pattern with a negative lookbehind
(so `Set`/`Map`.`has(` cannot misfire). Verified: UI-named keys 10 -> 12, the
four till keys now seen (products.manage, receipt.manage, settings.manage,
staff.manage), gate still green, baseline unchanged. This is what keeps
`receipt.manage` from surfacing as an A45-class divergence once 78 grants it.

**Renderer typechecks clean.** `npm install --ignore-scripts && npx tsc --noEmit
-p tsconfig.json` in `apps/desktop` -> exit 0, zero errors. (The bench can
typecheck the desktop even though it cannot *run* it — the native
`better-sqlite3` build is skipped, which typecheck does not need.)

## Deliberately left on the role gate

- **Close Day / Close Branch** stay on `dayService.isManager()` (see next).
- **Close Day / Close Branch.** Cash operations the code explicitly says *"must
  not hide behind settings.manage"*, gated on `dayService.isManager()`.

## Cloud inconsistencies surfaced (not fixed here)

- `stations.manage` is registered (migration 75) but **enforced on no route** —
  the cloud's station CRUD gates on `products.manage`.
- `POST /shifts/:id/force-close` gates on `settings.manage`, not the registry's
  `shifts.force_close`.

## The only steps that need your environment

1. **78's grant scope (needs the DB).** Confirm migration 78 grants
   `receipt.manage` to **manager AND supervisor AND branch_manager** — not just
   "Manager" — or those roles lose the Receipt tab (admin/owner are covered by
   `settings.manage`). Query:

   ```sql
   SELECT b.name AS business, r.name AS role,
          bool_or(p.key = 'receipt.manage')  AS has_receipt,
          bool_or(p.key = 'settings.manage') AS has_settings
   FROM   public.roles r
   JOIN   public.businesses b ON b.id = r.business_id
   LEFT JOIN public.role_permissions rp ON rp.role_id = r.id
   LEFT JOIN public.permissions p
          ON p.id = rp.permission_id AND p.key IN ('receipt.manage','settings.manage')
   WHERE  lower(replace(r.name,' ','_')) IN ('manager','supervisor','branch_manager')
   GROUP  BY b.name, r.name ORDER BY b.name, r.name;
   ```
   Any manager-type row with both columns false -> extend 78's grant before shipping.

2. **Smoke-test the till on Windows.** Sign in as a manager who holds
   `receipt.manage`; confirm the Receipt tab appears and Save succeeds (the A45
   loop). The bench can typecheck but cannot run Electron.

Everything else is done and verified on the bench.
