# MANIFEST 2026-09-27-l — A345 a manager signed in offline · A346 Stock only with the web POS

**Base:** origin/dev `77a679f` (v0.6.14; CI #416 green; Release desktop #30 green), plus the docs commit on
`claude/modest-cray-f21ll5` (`29d931a` v0.6.14 checklist results). The owner fast-forwards `dev` onto this commit.
**Deploy: cloud, then desktop v0.6.15.** No dashboard change, no migration. (First delivered as till-only at `1ff27ce`;
the owner bumped 0.6.15 on `e88707b` and, before tagging, asked for A346 — see the addendum. Tag v0.6.15 on the addendum.)

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

4. **A346 — Stock only with the web POS (addendum, owner before tagging).**
   - Owner: "stock should not appear in the desktop app thats a web pos feature pro feature" → "stock should only appear if the web
     pos is enabled". Decisions: fold into 0.6.15; shown "while web is fully usable".
   - The cloud's catalogue pull (`/api/pos/init`) now says `webPosEnabled`: the business's web access is active or in its grace
     weeks (the same check as web sign-in). Reports-only, locked, never subscribed or suspended → no.
   - The till stores it (`device_config.web_pos_enabled`, local schema 56) and shows **Stock** in the manager menu only when it is
     yes and something tracks stock. Only the cloud pull can set it; never told = no; a branch node passes it to its tills.
   - Selling is unchanged: only the Stock screen is hidden.

## Files
| Area | Files |
|---|---|
| Till (main) | `main/offlineSession.ts` (NEW), `main/ipcHandlers.ts` (`persistCloudSignIn` + `verifyPinBody` shared by sign-in and upgrade; `manageFetch` offline words + upgrade; `manage:cachedMenu` / `manage:cachedStaff` NEW; void/refund; PIN wiped on lock / logout), `main/preload.ts`, `main/ipcSchemas.ts` |
| Till (screens) | `renderer/pages/MenuWorkbench.tsx` (offline read-only + `SavedItemDetail`), `renderer/pages/ManageTabs.tsx` (StaffTab offline), `renderer/components/PaymentMethodsPanel.tsx`, `renderer/lib/posApi.ts` (types) |
| A346 cloud | `routes/pos.ts` (`webPosEnabled` from `getWebAccess`), `lib/desktopSchema.ts` (REQUIRED 56) |
| A346 till | `main/deviceConfig.ts` (`web_pos_enabled`, `setWebPosEnabled`), `main/localDb.ts` (column, schema 56), `main/syncEngine.ts`, `main/referenceBundle.ts` (node relay), `renderer/pages/ManagerPage.tsx` (Stock gate), `renderer/lib/posApi.ts` |
| CI | `.github/workflows/ci.yml` steps "Desktop offline session", "Desktop Stock only with the web POS" |
| Tests | NEW `apps/desktop/test/offline-session.test.mjs` (34); `tests/till-name.test.mjs` (pin follows `verifyPinBody`); A346: NEW `tests/stock-web-pos.test.mjs` (8), NEW `apps/desktop/test/stock-web-pos.test.mjs` (13); `apps/desktop/test/web-sales.test.mjs` (schema pin ≥ 55) |
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
apps/desktop test/*.test.mjs → all 32 pass · tests/*.test.mjs → all 132 pass   (first delivery; this line said 33 — it was 32) · every static gate OK (ipc-parity,
ipc-validation, till-green, test-registration …) · ratchet OK · desktop main + renderer tsc · vite build
register-consistency OK with the 0.6.15 bump
Chromium: the checklist at 390 px (16 checks, no errors, no sideways scroll, progress kept).
```
A346 addendum:
tests/stock-web-pos.test.mjs → 8 (COMPILED /api/pos/init + real auth over HTTP: never subscribed no · flag yes · paid yes ·
  grace yes · reports-only no · locked no · suspended no · catalogue unchanged). 3 mutations bite.
apps/desktop test/stock-web-pos.test.mjs → 13 (real deviceConfig + SQLite + referenceBundle: schema 56, null = no, kept across a
  save, an older cloud leaves it, config:save cannot switch it on, node → peer relay, screen pins). 4 mutations bite.
Full re-run after the addendum: see the delivery message.
Not verified here (rule 16): the live till, and the two offline screens rendered (React not run on the bench).

## Rollout
1. Deploy the cloud (Render) from `dev` — BEFORE the tills (an older cloud says nothing, and the till then hides Stock).
2. Install 0.6.15 on every till; sign in online once so the catalogue sync brings the web POS answer.
3. Run `docs/checklists/VERIFY-CHECKLIST-v0.6.15.html` (20 checks: §R, §N, §O, the 3 skipped on 0.6.14, regression).

## Rollback
```bash
git revert <this commit>   # no schema change
```
