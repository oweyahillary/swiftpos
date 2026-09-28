# MANIFEST 2026-09-28-n — A348 desktop updates approved per client (held by default) · A349 money review · A347 teal icon

**Base:** origin/dev `cb3e315` (v0.6.15; CI #418 green; Release desktop #31 green), plus `d355bed` (A347 teal icon, on the
session branch). The owner fast-forwards `dev` onto this commit, then bumps **0.6.16**.
**Deploy: migration 108 → cloud + admin portal → desktop v0.6.16** (published ONCE as a normal release). No dashboard change.

Owner, 2026-09-28: "since i am rolling the update to a client is is it possible to prevent auto update untill i confirm … to
avoid breaking a working system?" · "can i find a way of picking only one client to run the update not all the clients?" · "i
want to turn the repo into a private repo can that still work with auto update?" → **"hold by default, per business, build
0.6.16"**.

## What changed
1. **Every client is held until you approve a version.**
   - New in the admin portal: client detail → **Desktop updates**, showing "Held" or "Approved: <version>", a list of versions,
     and **Approve** / **Hold** buttons.
   - Versions missing a file can't be picked (they show what's missing).
   - Every change is in the audit log (`desktop_update.approve` / `.hold`).
2. **Tills (0.6.16+) ask the cloud, never GitHub.**
   - At launch and every hour, a till asks the cloud which version its business is approved for.
   - Held, the same version or older: nothing happens (never a downgrade).
   - A newer approved version: it downloads just that one, through the cloud, which checks the approval again and redirects to
     the GitHub file.
   - It installs when the till is next closed, as before.
   - Offline, or talking to an older cloud: it quietly holds.
3. **Builds are published as pre-releases.**
   - Tills on 0.6.15 and older only follow GitHub's latest *normal* release, so a pre-release reaches none of them.
   - **0.6.16 is the exception:** publish it once as a normal release, so the old tills pick up the approval check.
   - After that, leave every build as a pre-release and approve clients in the portal.
4. **Duplicate-draft protection.** When a tag's release is created twice (v0.6.15 was), the cloud serves the copy that has all
   three files and never a half release.
5. **Going private later.**
   - Put a read-only GitHub token on the cloud (`GITHUB_RELEASES_TOKEN`). It stays there; tills never see it.
   - Once every till is on 0.6.16 or later, the repository can go private and updates keep working.
6. **A347:** teal app icon (committed earlier as `d355bed`; ships in this version).

7. **A349 — pre-release money review.** Owner, before pushing: "make sure Catering levy(CTL) especially on the desktop app,
   does it appear on receipt? or reports? add it in overview … money math and reporting they have to be spot on … check of
   errors how they are captured … i dont want surprices".
   - **Fixed: a discounted sale's receipt never printed on the till.** It failed silently, and could drop the order's later
     tickets. It now prints with a Discount line, and the taxes are on the discounted amount (the figures stored).
   - **Fixed on the web POS:** thermal receipts failed for tipped or discounted sales and never showed CTL. The web's VAT display
     was a fixed 16% before discount.
   - **Tips:** now on the printed receipt (after Total; PAY = total + tip). The on-screen "Round Off −tip" is gone.
   - **CTL** is now in the Overview and the Z-report (screen and paper). No "CTL (0%)" line for businesses without it.
   - **Refunds** are now taken off everywhere on the till: Overview, Z-report, Daily report (headline, hours, dine-in) and CSV.
     VAT and CTL are reduced by the refunded share, the same rule as the cloud (`main/orderMoney.ts`).
   - **The Overview hourly chart** is in local time (it was UTC, 3 hours off).
   - **Payment shares** are of what was paid. **The CSV** has CTL, refunds and tips.
   - **Errors:** a ticket that can't be produced is now told to the cashier ("The sale is saved, but this did not print: …"), and
     never takes the other tickets down.
   - **Checked and correct, unchanged:** change handling, refund cash, the discount ceiling, the till's and the cloud's tax
     formula, and the cloud's reports.

## Files
| Area | Files |
|---|---|
| Database | `migrations/108_desktop_approved_version.sql` (NEW) |
| Cloud | `lib/desktopReleases.ts` (NEW), `routes/desktopUpdate.ts` (NEW), `routes/index.ts` (mount), `routes/admin.ts` (`GET /desktop-releases`, `PATCH /clients/:id/desktop-version`), `lib/env.ts` + `.env.example` (`GITHUB_RELEASES_TOKEN`, `DESKTOP_RELEASES_REPO`, optional) |
| Admin portal | `apps/admin/src/AdminPortal.tsx` (Desktop updates box) |
| Till | `main/autoUpdate.ts` (cloud approval check, generic feed, hourly), `main/index.ts` (comment), `electron-builder.config.js` (pre-release), `resources/icon*` (A347) |
| CI | `.github/workflows/ci.yml` step "Desktop updates only when approved" (migration test glob-discovered) |
| Tests | NEW `tests/desktop-update.test.mjs` (20), NEW `apps/desktop/test/update-approval.test.mjs` (16), NEW `scripts/test-migration-108.mjs` (5) |
| A349 (money) | `shared/printing/src/{types,money,render,shiftReport}.ts`, `apps/desktop/src/main/{orderMoney.ts (NEW),managerReports,shiftService,dailySalesReport,reportExport,escposBridge,print/printWorker,ipcHandlers}.ts`, `renderer/{pages/ManagerPage,pages/POSPage,components/ReceiptView,components/ZReportView,lib/printShiftReport,lib/posApi}.tsx?`, web `lib/{cart,buildReceiptOrder,printRouted,reprintReceipt,escposRenderer.js}`, `pages/pos/{CashierScreen,PaymentModal,ReceiptView,MinimartPOS}.tsx`, `types/index.ts`; tests `shared/printing/test/receipt-money.test.ts` (8), `apps/desktop/test/money-reports.test.mjs` (17), `tests/web-receipt-money.test.mjs` (5) |
| Docs | `docs/AUDIT-REGISTER.md` (A349, A348, Tree v0.6.16, migrations → 108), `docs/DESKTOP-AUTOUPDATE.md` (A348 note), `docs/checklists/VERIFY-CHECKLIST-v0.6.16.html` + `docs/VERIFY-CHECKLIST-v0.6.16.md` (NEW), this file |

## Verification (bench: Linux, Node 22)
```
tests/desktop-update.test.mjs → 20 (the real rules + COMPILED /api/desktop-update and admin routes over HTTP, a fake GitHub:
  held by default · per business · only the approved version · only its three updater files · split drafts → the complete copy ·
  pre-releases served · a hand-edited value = held · the token only ever sent to GitHub · incomplete → 404 and refused in admin ·
  audited approve/hold · a till token refused on admin · GitHub cached). 7 mutations bite.
apps/desktop test/update-approval.test.mjs → 16 (compiled runUpdateCheck, fake cloud + updater: hold, update with the till's
  token to exactly /v/<approved>/, no downgrade, 401 refreshed once, offline / older cloud → hold, no token → nothing asked;
  no GitHub poll left; hourly; no differential). 4 mutations bite.
scripts/test-migration-108.mjs → 5 (PGlite: all held, new held, x.y.z only, idempotent). 2 mutations bite.
A349: receipt-money 8/8 · money-reports 17/17 (Nairobi time) · web-receipt-money 5/5 · 11 mutations bite; golden receipt
samples byte-identical.
Every desktop test (35) · tests/*.test.mjs (135) · shared/printing npm test · all 31 migration tests · every static gate · ratchet · server, desktop
(main + renderer), admin and dashboard builds.
Library behaviour read in node_modules (electron-updater 6.8.9): the Authorization header is stripped on a cross-host
redirect; with allowPrerelease=false the GitHub provider follows /releases/latest (pre-releases and drafts excluded).
```
Not verified here (rule 16): a real Windows till downloading through the cloud, the admin portal on screen, GitHub's
signed-link redirect with a real token.

## Rollout (owner)
1. Apply **migration 108** to prod (Supabase SQL editor, or the migrate workflow).
2. Deploy the **cloud** and the **admin portal** from `dev`.
3. Tag **v0.6.16**. On GitHub, keep the complete copy if there are two, **untick "pre-release"**, set it as latest, and publish.
   Old tills update to it on their next close.
4. Run `docs/checklists/VERIFY-CHECKLIST-v0.6.16.html` (36 checks — §M is the money review).
5. From then on: tag → the pre-release reaches nobody → approve your own business → test → approve each client when ready.
6. Before making the repository private: set `GITHUB_RELEASES_TOKEN` on Render (fine-grained, this repository, Contents: read
   only), and confirm every till reads 0.6.16 or later.

## Rollback
```bash
git revert <this commit>   # the column stays (additive); tills on 0.6.16 then hold (the route is gone → they stay put)
```
