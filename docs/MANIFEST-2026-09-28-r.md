# MANIFEST 2026-09-28-r — A351 the manager menu in groups (desktop 0.6.17)

**Base:** origin/dev `64e23bd` (v0.6.16 checklist recorded). The owner fast-forwards `dev` onto this commit, then bumps **0.6.17**.
**Deploy: desktop only.** No migration, no cloud, dashboard or admin change.

Owner, 2026-09-28: "this menu is too long can we collapse some items like settings can have printer and staff, close branch and
close day, orders and shift" → lead-dev proposal (tabs inside one page) → **"go with it, build 0.6.17"**.

## What changed
1. **The manager sidebar, from 11 items to at most 7.**
   - Overview · **Sales** · Expenses · **Close** · Menu · **Settings** · Stock (Stock only with the web POS, as before).
   - Open POS and Lock till stay at the bottom.
2. **A group opens as one page with tabs across the top.**
   - **Sales:** Orders · Item Mix (restaurants only) · Current shift · Shift report.
   - **Close:** Close Day · Close Branch. It opens on Close Day; Close Branch is a deliberate second tap.
   - **Settings:** General (24-hour operation, payment methods) · Printing (Stations, Printers, Exclusions, Receipt) · Staff.
3. **Nothing about who may do what changed.**
   - Every tab keeps the permission it had as its own sidebar item.
   - A role that may open only one tab of a group gets the page with no tab bar. A role that may open none doesn't see the group.
   - Cashiers still have no route to the manager screen.
4. **Each group remembers its last tab** while the manager screen is open. For example, Settings reopens on Printing.
   Menu → Import keeps Menu highlighted.
5. **The pages themselves are unchanged.** Only the menu around them moved.

## Files
| Area | Files |
|---|---|
| Till | `renderer/lib/managerNav.ts` (NEW — the groups and rules), `renderer/pages/ManagerPage.tsx` (sidebar and tab bar from it; the two A105 pair wrappers removed) |
| CI | `.github/workflows/ci.yml` step "Desktop manager menu groups" |
| Tests | NEW `apps/desktop/test/manager-nav.test.mjs` (11); `apps/desktop/test/shift-reports.test.mjs` (Expenses pin reads managerNav.ts) |
| Docs | `docs/AUDIT-REGISTER.md` (A351, Tree v0.6.17), `docs/checklists/VERIFY-CHECKLIST-v0.6.17.html` + `docs/VERIFY-CHECKLIST-v0.6.17.md` (NEW, 26 checks), this file |

## Verification (bench: Linux, Node 22)
```
apps/desktop test/manager-nav.test.mjs → 11/11 (the real rules, type-stripped: an owner's seven items and their tabs; a shop
  without Item Mix or Stock; per-tab permissions; a cashier-level role sees no Close/Menu/Settings; Close opens on Close Day;
  last tab remembered and forgotten when no longer allowed; Import under Menu; each page in exactly one group; source pins).
  5 mutations bite.
Every desktop test (non-Electron) · tests/*.test.mjs · every static gate (till-green unchanged) · schema audit ·
desktop typecheck + renderer build. The checklist page opened in Chromium: 26 checks, no script errors.
check-register-consistency: TREE LINE STALE (v0.6.17 vs package.json 0.6.16) until the owner's bump — as every release.
```
Not verified here (rule 16): the screen on a real till.

## Rollout (owner)
1. Fast-forward `dev`, bump **0.6.17**, push; wait for CI green.
2. Tag **v0.6.17**. **Leave it a pre-release.** Don't untick it and don't install it by hand.
3. Run `docs/checklists/VERIFY-CHECKLIST-v0.6.17.html`:
   - §R: one release.
   - §U: the hold, end to end (U1 Held → U2 nothing moves → U3 approve your business → U4 your till updates, others don't).
   - §G: the menu.
   - §M: the printer-free money checks.

## Rollback
```bash
git revert <this commit>   # the flat sidebar returns; no data involved
```
