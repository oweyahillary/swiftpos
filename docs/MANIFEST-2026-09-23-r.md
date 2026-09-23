# MANIFEST 2026-09-23-r — docs only: VERIFY-BRANDING-PHASE1 updated for the retest

**Base commit:** `67a5480` (origin/dev, delivery -q; 4/4 checksums on the tip, gates exit 0, CI #380 green).
**No code.** No deploy. Register: header + changelog only; counts unchanged.

**Why.** The owner asked whether the same checklist serves the retest. Not as it stood:
- **A5 was wrong.** It expected `#777777` to be rejected. The till's rule (`shared/contrast.ts`) accepts it with black
  Enter text (4.10:1 on the lock surface), and since -p the web agrees — a correct system would be marked FAIL.
  The rejected example is now `#1e293b` (falls back on both).
- **A2 and B1 could not tell causes apart.** A1 now records whether "Saved." appeared (A316 made logo saves fail); B1
  now uses the product's Edit form on an empty-description product and records that it did (A317) — so a pass/fail
  says whether A278 itself works.
- **Today's other fixes had no checks.** New §G: A318 (Edit/Delete on every Family Meals row), A317 (web + till
  Manager › Menu), A320 (spaces-only name refused), A315 (web receipt one thank-you; paper `out/receipt-80.bin`).
- A retest banner (prerequisites: cloud + dashboard deployed from `67a5480` or later; till stays 0.6.2), an F5 note (the
  web's closing block changed; the till's waits for 0.6.3), and a results template to paste back.

The tester's separate HTML checklist (`docs/checklists/verify-branding-phase1.html`, untracked on the owner's machine,
not in the repo) is NOT updated by this — use the markdown, or regenerate the HTML from it.

## Files (3)
| File | Change |
|---|---|
| `docs/VERIFY-BRANDING-PHASE1.md` | Retest banner; A1, A5, B1 changed; F5 note; new §G; results template. |
| `docs/AUDIT-REGISTER.md` | Header Last-updated + changelog row. |
| `docs/MANIFEST-2026-09-23-r.md` | This file. |

## Verification
```
Every label the checklist names was checked in source: "Saved." (BrandingTab), "Legible ✓" and the "isn't legible"
warning (BrandingTab), "name: Cannot be empty" (A257 field message format + productName), Manager › Menu (ManagerPage
tab 'menu' → MenuWorkbench). #F5B800 / #1e293b / #777777 verdicts from resolveBranding on #0d1424 (bench, -p).
check-register-consistency / check-doc-refs / check-root-clean → exit 0
```

## Rollback
```bash
git checkout 67a5480 -- docs/VERIFY-BRANDING-PHASE1.md docs/AUDIT-REGISTER.md && git rm -q --ignore-unmatch docs/MANIFEST-2026-09-23-r.md && rm -f docs/MANIFEST-2026-09-23-r.md
```
