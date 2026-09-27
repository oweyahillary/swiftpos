# MANIFEST 2026-09-27-g — A339 offline manager sign-in; A340 managers cannot make owners

**Base commit:** `c7c24e5` (origin/dev = desktop v0.6.12; CI #413 green; Release desktop #28 green). One commit on
`claude/modest-cray-f21ll5`; the owner fast-forwards `dev`. **Deploy: cloud + dashboard + desktop v0.6.13.** No migration of its
own — **migration 107 (0.6.12, A338) is still owed on prod** and goes first.

## What changed
1. **A339 — offline manager sign-in.** Offline, a manager landed on the cashier screen. The PIN screen routes on the sign-in
   answer's top-level `role`, and the offline answer didn't carry it. It does now, the same as online.
2. **A340 — a manager cannot make an owner.** One rule, in the cloud (`lib/roleCeiling.ts`): only the owner (or admin) can hand out
   owner / admin / manager / supervisor. Anyone else can hand out other roles only, and can grant only permissions they hold.
   - `POST /api/staff/invite` had **no** role or branch check, so a manager could invite someone as owner. It now has both.
   - Per-user permission overrides (create and edit): a manager can no longer grant what they don't hold (e.g. `settings.manage`).
   - A manager can no longer create a custom role named "Owner", "Admin" and so on.
   - The role list marks each role `assignable` for whoever is asking. The till's Staff screen and the dashboard's Staff tab show
     only those, so a manager never sees Owner. The owner sees everything, as before.

## Files (11)
| File | Change |
|---|---|
| `apps/desktop/src/main/ipcHandlers.ts` | Offline sign-in answer carries `role`. |
| `apps/server/src/lib/roleCeiling.ts` | NEW — the rule. |
| `apps/server/src/routes/staff.ts` | Invite guards; overrides ceiling; role-name rule; `assignable`. |
| `apps/dashboard/src/pages/settings/StaffTab.tsx` | Picker shows assignable roles only. |
| `apps/desktop/src/renderer/pages/ManageTabs.tsx` | Picker shows assignable roles only. |
| `apps/desktop/test/offline-manager-signin.test.mjs` | NEW — 8 checks (real IPC handler). |
| `tests/staff-role-ceiling.test.mjs` | NEW — 13 checks (compiled router, real auth, over HTTP). |
| `.github/workflows/ci.yml` | Step "Desktop offline manager sign-in". |
| `docs/AUDIT-REGISTER.md` | A339, A340; header; Tree row v0.6.13; changelog. |
| `docs/MANIFEST-2026-09-27-g.md` | This file (NEW). |

## Verification (bench: Linux, Node 22)
```
tests/staff-role-ceiling.test.mjs → 13 passed. Run against the OLD routes (dev), 7 red: a manager's INVITE of an owner succeeds —
  the owner's report. Rule mutation (non-owner may assign anything) → 2 red.
apps/desktop test/offline-manager-signin.test.mjs → 8 passed; mutation (role removed) → 3 red — the owner's report reproduced.
tests/*.test.mjs → all pass · every desktop test → pass · scripts/test-* → pass · ratchet server/dashboard/admin OK ·
  desktop + dashboard builds OK · every static gate OK · register-consistency OK with the 0.6.13 bump
```
Not verified here (rule 16): the live dashboard, cloud and till.

## Rollout — in this order
1. **Prod-migrate 107** (if not already done): Actions → DB migrate (production) → Run workflow → branch dev → approve.
2. **Deploy the cloud** (Render) and **the dashboard** from `dev`.
3. **Install 0.6.13** on every till (it includes everything in 0.6.12).

## Owed on target
- **J1.** Till offline (Wi-Fi off), sign in with a manager PIN that has signed in online before. You land on the **manager screen**.
  A cashier PIN still lands on the till.
- **J2.** As a manager, on the till: Manage → Staff → Add. The role list has **no Owner, Admin, Manager or Supervisor**.
- **J3.** As a manager on the dashboard, in Settings or Users & Access → Staff:
  - the role list has no Owner, Admin, Manager or Supervisor;
  - "Invite by email" as a cashier works.
- **J4.** As the owner: every role is listed, and creating or inviting an owner still works.

## Rollback
```bash
git revert <this commit>   # no schema change
```
