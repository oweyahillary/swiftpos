# MANIFEST 2026-09-30-b — desktop 0.6.25 + cloud: the client logo everywhere — screens, sidebar, receipt, every document — and it stays (A368)

**Base:** origin/dev `6b12bed` (0.6.24). **Delivered as a patch:** `swiftpos-2026-09-30-v0.6.25.patch`. It **includes the version
bump** (apps/desktop → 0.6.25). **Cloud + dashboard change too** (the write guard; the web receipt logo). No migration.

Owner, 2026-09-30 (PIN screen screenshot with the new B FOODS badge): "on this screen can we increase the size of the logo abit, i
feel its too small the white space is big".

Owner, same day: "when u upload the logo in the desktop app it removes it after a while … is it that the web config overrides
it?" · "the size on the printer should not be too small" · (manager screen) "Where its b foods can we add the logo there".

## What changed
- **The logo no longer disappears (A368).** Branding is remote-wins: every sync copied the cloud's branding over the till's, and
  the tech screen's upload was saved on the till only. Now it is **also saved to the cloud** (owner's decision), so every till
  and receipt gets it. Offline, it waits and goes with the next sync, and until then syncing keeps the till's logo. If the cloud
  refuses it, the tech screen says why. Cloud: the till write guard allows exactly `/api/business/branding`.
- **The logo in the manager sidebar**, beside "B Foods" (a small white tile; 40 px when the sidebar is collapsed).
- **A bigger printed logo.** A small logo is now scaled **up** to fill the receipt box (it printed at its own size), and the box
  is 384 × 288 dots (48 × 36 mm) — was 240 high. A square logo prints 36 mm. Same on the web. **Re-save the logo once** (web
  Branding, or the till's tech screen) to regenerate the receipt version.
- **The logo on every document, and a corporate look** (owner: "add the logo in all documents being generated from the system
  beautify the documents make them bit cooporate"). The A4 documents (purchase orders, goods received notes, transfer notes,
  shift reports, stock-take and report exports) now take the **Branding** logo (they only knew the old profile "Logo image
  URL", which B Foods never set), and are restyled: a larger logo beside the business name and contacts, the document title in
  the document's colour, the details in a shaded panel, a shaded table header with zebra rows, a boxed total, a notes panel,
  signature lines with "Name, signature & date", and a footer (business · document · printed at). The **thermal Z-report**
  (till and web) prints the receipt logo at the top (same switch as the receipt); the web **end-of-day Z-report** page is
  headed by the logo. Not changed: the customer receipt layout (owner-approved) beyond the logo it already carried; the emailed
  daily summary.
- **PIN screen:** the client logo is now up to **160 px tall × 240 px wide** (was 88 × 220), and the white card around it is
  tighter (8 × 10 px padding, was 12 × 18). A square logo such as the badge is now as tall as the SwiftPOS default mark.
- **Lock screen ("Till locked"):** the same treatment, up to 150 × 240, so the two screens match.
- A wide logo is limited by the 240 px width, so it grows less than a square one.

## Files
| Area | Files |
|---|---|
| Till (screen) | `apps/desktop/src/renderer/pages/PinPage.tsx`, `components/LockCurtain.tsx`, `pages/ManagerPage.tsx` (sidebar logo), `pages/BrandingEditor.tsx` (says saved / pending / refused), `lib/posApi.ts` |
| Till (main) | `syncEngine.ts` (`queueBrandingPush`, `pushBrandingNow`, `brandingPushPending`; the pull skips branding while pending; the upload goes before the pull), `ipcHandlers.ts` (`branding:set` also saves to the cloud), `brandingGuard.ts` (288) |
| Receipt logo | `shared/printing/src/raster.ts` (`RECEIPT_LOGO_MAX_HEIGHT` 288), `apps/desktop/src/renderer/lib/prepareRasterLogo.ts` (scale up), `apps/dashboard/src/pages/settings/BrandingTab.tsx` (scale up), `apps/dashboard/src/lib/escposRenderer.js` (rebuilt, `--check` OK) |
| Cloud | `apps/server/src/middleware/auth.ts` (write guard: `/api/business/branding`) |
| Documents | `apps/dashboard/src/lib/printDocument.ts` (`buildDocumentHtml`, the Branding logo, the restyle), `pages/pos/ZReportModal.tsx`, `lib/printShiftReport.ts`; `shared/printing/src/shiftReport.ts` (`logoRaster`); `apps/desktop/src/main/print/printWorker.ts` |
| Version | `apps/desktop/package.json`, `package-lock.json` → 0.6.25 |
| Tests | `apps/desktop/test/lock-curtain-brand.test.mjs` (9; +4), NEW `apps/desktop/test/branding-cloud.test.mjs` (9; CI step), `tests/terminal-write-guard.test.mjs` (+3), NEW `tests/document-branding.test.mjs` (9), `tests/logo-and-stocktake.test.mjs` + `tests/shift-confirm.test.mjs` (pins moved with the restyle), `apps/desktop/test/branding-set.test.mjs` and `shared/printing/test/raster.test.ts` (288) |
| Docs | `docs/AUDIT-REGISTER.md` (Tree v0.6.25), `docs/checklists/VERIFY-CHECKLIST-v0.6.25.html` + `.md`, this file |

## Verification (bench)
```
lock-curtain-brand 9/9 · branding-cloud 9/9 · terminal-write-guard 27/27 · 9 mutations bite (either screen logo back to 88 × 220;
the sidebar logo; the receipt scale-up; the pull applying while pending; pull before push; 5xx clearing / 4xx keeping pending; the
guard entry; the document's Branding logo, footer and escaping; the Z-report logo). A sample goods received note rendered to PDF. Before/after and the sidebar rendered with the built CSS and the badge. Printing npm test (golden files unchanged).
Every desktop test · every gate · desktop typecheck, main and renderer builds.
```

## Rollout (owner)
1. Apply, commit, push; CI green. Deploy the **cloud** (write guard), then the **dashboard** (web receipt logo).
2. Tag **v0.6.25** → approve B Foods → T1 updates (0.6.24 need not be approved first — 0.6.25 contains it).
3. Re-save the logo once (web Settings → Branding, or the till's tech screen) so the receipt version is regenerated bigger.
4. Checklist v0.6.25 (and v0.6.24's §C and §N, which ride along).

## CI fix (after `0673b03`)
CI #440 failed in *Server suites → Run offline suites*: `tests/document-branding.test.mjs` loaded `shared/printing/dist`,
which that job never builds (my bench had it built). The runtime check moved to `shared/printing/test/shift-report-logo.test.ts`
(the package's `npm test`, run by CI's *Receipt closing block* step); the cloud suite now pins the source line. Re-run on a clean
copy of dev with `shared/printing` NOT built: all `tests/*.test.mjs` pass.

## Rollback
```bash
git revert <the owner's commit>   # screen sizes only
```
