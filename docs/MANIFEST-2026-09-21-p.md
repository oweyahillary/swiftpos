# MANIFEST 2026-09-21-p — dashboard: A308 web Branding settings page (SCOPE §6)

**Supersedes 2026-09-21-o** (Rule 3).

**Base commit:** `c7bbc52` (`dev` tip). **Scope:** dashboard only + one root test + the register.
No server (uses the existing A303 endpoint), no migration. **Register ID:** A308.

## Why

The client-facing branding piece SCOPE §6 called for: an owner/admin sets their accent + logo from
the **dashboard**, instead of only via the till technician gate (A302) or the raw API (A303).

## What changed

| File | Change | ID |
|---|---|---|
| `apps/dashboard/src/pages/settings/BrandingTab.tsx` | **new** — Settings › Business › Branding: SCOPE §8.A vetted 8-accent palette + custom hex with a WCAG legibility guard; PNG/JPEG logo upload resized client-side to the 250 KB cap (shrink-not-crop, SVG rejected); **live lock-screen preview**; saves via `PUT /api/business/branding` (A303). | A308 |
| `apps/dashboard/src/App.tsx` | Lazy-import + route `settings/business/branding`. | A308 |
| `apps/dashboard/src/pages/settings/BusinessPage.tsx` | "Branding" tab in the Business nav. | A308 |
| `tests/branding-web-page.test.mjs` | **new** — 7 source-guards (GET/PUT, palette, legibility guard, 250 KB resize, preview, route+tab). Auto-registered by the CI glob. | A308 |
| `docs/AUDIT-REGISTER.md` | A308 entry + Open `17 P3`→`18 P3` + Counts + a `2026-09-21 (brand-web)` line. | A308 |

**Deferred (noted):** SCOPE §6's **receipt preview**. Receipt-logo printing (monochrome
`logo_receipt`) isn't built — the receipt renderer prints no logo today — so a receipt preview
would show a non-existent feature. It becomes required when that slice lands. This page ships the
lock-screen half, which is the live feature.

## Verification (Rule 7)

- **`node tests/branding-web-page.test.mjs` → 7/7** (mutation-checked).
- **Dashboard `tsc` → 0 errors.** `check-register-consistency` OK.

**Could NOT verify here (target-only):** the page on screen + a real save round-trip and the till
adopting it. (The chain underneath — A303 store, A304 sync, A301 read — is verified end-to-end.)

## Rollback (Rule 2)

```bash
git checkout c7bbc52 -- apps/dashboard/src/App.tsx apps/dashboard/src/pages/settings/BusinessPage.tsx docs/AUDIT-REGISTER.md
rm -f apps/dashboard/src/pages/settings/BrandingTab.tsx tests/branding-web-page.test.mjs
```

## Commit (direct to dev, explicit paths — never `git add -A`)

```bash
git checkout dev && git pull                     # confirm c7bbc52
git add apps/dashboard/src/pages/settings/BrandingTab.tsx apps/dashboard/src/App.tsx \
        apps/dashboard/src/pages/settings/BusinessPage.tsx tests/branding-web-page.test.mjs \
        docs/AUDIT-REGISTER.md docs/MANIFEST-2026-09-21-p.md
git status --short                               # expect exactly these six
node tests/branding-web-page.test.mjs && node scripts/check-register-consistency.mjs
git commit -m "feat(dashboard): A308 web Branding settings page — owner sets accent + logo (SCOPE §6)"
git push
```

## ⚠ Unpushed backlog (register drift)

`origin/dev` is at `c7bbc52` with A277 landed but these earlier deliveries **not pushed**, each of
which also edits `AUDIT-REGISTER.md`:
- **-l (A307)** in-app menu template (Large-fries upgrade)
- **-n (A278)** live catalogue refresh (web→till, no restart) — *A308's "~20s" note relies on this*
- **-o (A19)** node→cloud relay re-grade

A308's register is based on `c7bbc52` and does **not** include those. Push them in order (`-l`, `-n`,
`-o`, then `-p`); each manifest says to re-apply its small register edits if `dev` moved. If you'd
rather, I can produce **one consolidated register** folding A307+A278+A19+A308 so a single push
makes it consistent — say the word.
