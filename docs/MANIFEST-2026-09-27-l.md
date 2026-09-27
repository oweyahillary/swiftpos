# MANIFEST 2026-09-27-l — A345 a manager signed in offline: the right words, the saved lists, unlocking by itself

**Base:** origin/dev `77a679f` (v0.6.14; CI #416 green; Release desktop #30 green), plus the docs commit on
`claude/modest-cray-f21ll5` (`29d931a` v0.6.14 checklist results). The owner fast-forwards `dev` onto this commit.
**Deploy: desktop v0.6.15 only.** No cloud or dashboard change, no migration.

Owner, 2026-09-27, with the v0.6.14 results (screenshots of T1 with the manager signed in offline — Staff and Menu said "This
till is not signed in", Menu "0 of 0 items"): "we can sell this as an option fully offline till, thats why the manager has to log
in confirm this is true full offline once registered". Answer given: selling and the day run fully offline; the lists the cloud
owns (menu, staff, payment methods, stations, receipt text) are edited on the cloud, and the message about them was wrong. Owner:
"build all three as 0.6.15".

## What changed
1. **The right words.**
   - An offline sign-in has no cloud token. Every cloud-owned editor now says: "You signed in while offline. Menu, staff and
     settings changes are saved on the cloud — once the till is online they unlock by themselves (or lock the till and sign in
     again). Selling is not affected."
   - It used to say "This till is not signed in".
   - Nobody signed in still gets "not signed in".
   - The till's online void and refund say the same, and try the upgrade (3) first.
   - Settings → Payment methods passes that wording through, and says "cloud" instead of "server".
2. **The saved lists, read-only, while offline.**
   - **Menu:** an amber box with the reason, then "Showing the menu saved on this till — read-only", with a Try again button.
     - It lists the items, categories and prices the till sells.
     - Prices can't be edited and Import / export is hidden.
     - An item opens as a read-only card (name, category, price, description, comes with).
   - **Staff:** the same box.
     - A branch node lists its branch roster; any other till lists the people who have signed in on it.
     - Names and roles only. No Add, no Deactivate.
   - Shown only when the reason is being offline (an offline sign-in, or no connection). A refusal (403) or any other cloud
     answer is shown as it is, never replaced by the saved list.
3. **Unlocking by itself.**
   - An offline sign-in keeps the PIN in the till program's memory only: never on disk, never on screen.
   - When the network is back (at the next menu / staff / void / refund call, and every 30 s), the till checks it with the cloud
     using the same request as a normal sign-in. The session then becomes a normal cloud sign-in, with no second PIN entry.
   - The cloud's answer is used only if it names the same person.
   - What happens to the held PIN:
     - no network or a 5xx answer: kept, and the till keeps trying;
     - the cloud refuses it: dropped, and the offline session carries on as before (nobody is signed out by this);
     - locking the till, another sign-in, or signing the till out: wiped.

## Files
| Area | Files |
|---|---|
| Till (main) | `main/offlineSession.ts` (NEW), `main/ipcHandlers.ts` (`persistCloudSignIn` + `verifyPinBody` shared by sign-in and upgrade; `manageFetch` offline words + upgrade; `manage:cachedMenu` / `manage:cachedStaff` NEW; void/refund; PIN wiped on lock / logout), `main/preload.ts`, `main/ipcSchemas.ts` |
| Till (screens) | `renderer/pages/MenuWorkbench.tsx` (offline read-only + `SavedItemDetail`), `renderer/pages/ManageTabs.tsx` (StaffTab offline), `renderer/components/PaymentMethodsPanel.tsx`, `renderer/lib/posApi.ts` (types) |
| CI | `.github/workflows/ci.yml` step "Desktop offline session" |
| Tests | NEW `apps/desktop/test/offline-session.test.mjs` (34); `tests/till-name.test.mjs` (pin follows `verifyPinBody`) |
| Docs | `docs/AUDIT-REGISTER.md` (A345 FIX BUILT, Tree v0.6.15), `docs/checklists/VERIFY-CHECKLIST-v0.6.15.html` + `docs/VERIFY-CHECKLIST-v0.6.15.md` (NEW), this file |

## Verification (bench: Linux, Node 22)
```
apps/desktop test/offline-session.test.mjs → 34 (REAL compiled IPC handlers + SQLite + bcrypt, a fake cloud; the renderer's
  humaniser RUN): offline words on the Staff list, menu, payment methods, saving receipt text, adding staff and a void; the
  saved menu (combo contents, inactive hidden) and staff (names/roles, no hash); the upgrade by the sign-in's own request under
  the owner token, the list then read under the MANAGER's own token, once only; a 403 never falls back; a 401 asked once then
  dropped; a 503 kept then upgraded; a different person never adopted; locking wipes the PIN; a refund upgrades first.
  6 mutations bite.
tests/till-name.test.mjs → 12 (the sign-in's body now from verifyPinBody; a field removed → red)
apps/desktop test/*.test.mjs → all 33 pass · tests/*.test.mjs → all 132 pass · every static gate OK (ipc-parity,
ipc-validation, till-green, test-registration …) · ratchet OK · desktop main + renderer tsc · vite build
register-consistency OK with the 0.6.15 bump
Chromium: the checklist at 390 px (16 checks, no errors, no sideways scroll, progress kept).
```
Not verified here (rule 16): the live till, and the two offline screens rendered (React not run on the bench).

## Rollout
1. Install 0.6.15 on every till (nothing to deploy on the cloud or the dashboard).
2. Run `docs/checklists/VERIFY-CHECKLIST-v0.6.15.html` (16 checks: §R, §O, the 3 skipped on 0.6.14, regression).

## Rollback
```bash
git revert <this commit>   # no schema change
```
