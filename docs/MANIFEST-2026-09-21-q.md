# MANIFEST 2026-09-21-q — CONSOLIDATED push: A307 + A278 + A19 + A308 (one commit)

**Supersedes -l, -n, -o, -p** (Rule 3) — folds the unpushed backlog into ONE consistent delivery
so a single push brings `dev` to a coherent state (the register counts stay in step).

**Base commit:** `c7bbc52` (`dev` tip). **Register:** rebuilt from `origin/dev`'s exact content,
so it carries all four entries with correct counts (Open P3 17 → 19).

## What's in it

| Item | Code on dev already? | This delivery adds | ID |
|---|---|---|---|
| A307 in-app menu template (Large-fries upgrade + Read me) | **Yes** (MenuUpload + test + `-l` manifest pushed earlier) | the missing **register entry** only | A307 |
| A278 live catalogue refresh (web→till, no restart) | No | code (index/preload/posApi/POSPage) + test + register + `-n` | A278 |
| A19 node→cloud peer-sale relay | Relay built since 2026-08-25 | **re-grade OPEN→FIX BUILT** (the 09-18 note was wrong) + `-o` | A19 |
| A308 web Branding settings page (SCOPE §6) | No | code (BrandingTab + App + BusinessPage) + test + register + `-p` | A308 |

## Files (exactly the diff vs `origin/dev`)

```
apps/dashboard/src/App.tsx                              (A308)
apps/dashboard/src/pages/settings/BrandingTab.tsx       (A308, new)
apps/dashboard/src/pages/settings/BusinessPage.tsx      (A308)
apps/desktop/src/main/index.ts                          (A278)
apps/desktop/src/main/preload.ts                        (A278)
apps/desktop/src/renderer/lib/posApi.ts                 (A278)
apps/desktop/src/renderer/pages/POSPage.tsx             (A278)
tests/catalogue-refresh.test.mjs                        (A278, new)
tests/branding-web-page.test.mjs                        (A308, new)
docs/AUDIT-REGISTER.md                                  (A307+A278+A19+A308)
docs/MANIFEST-2026-09-21-n.md / -o.md / -p.md / -q.md   (delivery docs)
```
(A307's MenuUpload + `menu-template.test.mjs` + `-l` are already on `dev`, so not re-shipped.)

## Verification (Rule 7) — all run together on this consolidated tree

- Source-guard tests: `menu-template` 7/7 · `catalogue-refresh` 6/6 · `branding-web-page` 7/7.
  (A19's `peer-relay` 28/28 verified separately; unchanged here.)
- Desktop `tsc` (main + renderer) → 0 errors on changed files; dashboard `tsc` → 0 errors.
- **17/17 gates green** incl. register-consistency (P3 19, header = body), doc-refs,
  test-registration, ipc-parity/validation, table-usage, root-clean.

**Target-only, unchanged (Rules 16):** A278 (edit a price on web, watch a till refresh ~20s),
A308 (the page on screen + a real save), A19 (pilot node+peer+cloud test).

## Rollback (Rule 2)

```bash
git checkout c7bbc52 -- apps/dashboard/src/App.tsx apps/dashboard/src/pages/settings/BusinessPage.tsx \
  apps/desktop/src/main/index.ts apps/desktop/src/main/preload.ts \
  apps/desktop/src/renderer/lib/posApi.ts apps/desktop/src/renderer/pages/POSPage.tsx docs/AUDIT-REGISTER.md
rm -f apps/dashboard/src/pages/settings/BrandingTab.tsx tests/catalogue-refresh.test.mjs \
  tests/branding-web-page.test.mjs docs/MANIFEST-2026-09-21-n.md docs/MANIFEST-2026-09-21-o.md \
  docs/MANIFEST-2026-09-21-p.md docs/MANIFEST-2026-09-21-q.md
```

## Commit — ONE commit, explicit paths (never `git add -A`)

```bash
cd /c/swiftpos/pos && git checkout dev && git pull        # confirm c7bbc52

git add apps/dashboard/src/App.tsx apps/dashboard/src/pages/settings/BrandingTab.tsx \
        apps/dashboard/src/pages/settings/BusinessPage.tsx \
        apps/desktop/src/main/index.ts apps/desktop/src/main/preload.ts \
        apps/desktop/src/renderer/lib/posApi.ts apps/desktop/src/renderer/pages/POSPage.tsx \
        tests/catalogue-refresh.test.mjs tests/branding-web-page.test.mjs \
        docs/AUDIT-REGISTER.md docs/MANIFEST-2026-09-21-n.md docs/MANIFEST-2026-09-21-o.md \
        docs/MANIFEST-2026-09-21-p.md docs/MANIFEST-2026-09-21-q.md

git status --short        # expect exactly the 14 lines above — NOT package.json, NOT lockfiles
node tests/branding-web-page.test.mjs && node tests/catalogue-refresh.test.mjs && node scripts/check-register-consistency.mjs && node scripts/check-doc-refs.mjs

git commit -m "feat: consolidate branding web page (A308) + live catalogue refresh (A278) + menu template (A307) + A19 relay re-grade"
git push
```

After push: CI green on `dev`; the branding requirement is met end-to-end (cloud store → sync →
till lock screen → dashboard editor). A278/A308/A19 close on their target tests.
