# MANIFEST 2026-09-23-s — docs only: HTML retest checklist for Branding Phase 1

**Base commit:** `5afe60b` (origin/dev, delivery -r; 3/3 checksums on the tip, gates exit 0, CI #381 green).
**No code, no deploy.** Register: header + changelog only; counts unchanged.

**What.** `docs/checklists/verify-branding-phase1.html` — the interactive checklist the tester fills in, updated for the
retest. The first run's copy was an untracked file on the owner's machine (never in the repo, so never seen here); this
one replaces it at the same path and is committed like the other checklists.
- **Look and controls:** the house style of `docs/checklists/VERIFY-CHECKLIST-v0.6.0.html` (light/dark, sticky bar,
  progress saved in this browser, Generate + Copy).
- **Content:** `docs/VERIFY-BRANDING-PHASE1.md` after -r — A1–A5, B1–B2, C1, D1, F1–F6, G1–G5 (20 items); `changed`
  badges on A1, A5, B1, F5 and all of G; always-visible "Record:" prompts on A1, A5, B1, G2.
- **Output:** the first run's report format (`## A. …` / `A1: PASS — note` / `Summary: n PASS · n FAIL · n SKIP · n not run`
  / `Failed: …`), with Pass/Fail/**Skip** as that run used. A Fail without a note is flagged in the bar.
- A banner states the prerequisite: cloud AND dashboard deployed from `67a5480` or later; till stays 0.6.2.

## Files (3)
| File | Change |
|---|---|
| `docs/checklists/verify-branding-phase1.html` | NEW (tracked): the interactive retest checklist. |
| `docs/AUDIT-REGISTER.md` | Header Last-updated + changelog row. |
| `docs/MANIFEST-2026-09-23-s.md` | This file. |

## Verification (headless Chromium, file:// as the tester opens it)
```
20 rows render · meta + marks + notes survive a reload (localStorage)
a FAIL with no note → bar shows "note needed: A2"; the Record box shows on A5 before marking; plain items hide theirs
Generate → "VERIFY-BRANDING-PHASE1 — results (retest)" / "By: … · Desktop: 0.6.2 · Cloud/dashboard from: 67a5480"
  / "## A. Web Branding page → till (closes A308)" / "A1: PASS — Saved. appeared: yes" … / "Summary: 2 PASS · 1 FAIL · 1 SKIP · 16 not run" / "Failed: A2"
page errors: none · 390 px wide: no horizontal overflow · dark mode screenshot checked · no "server" wording (rule 21)
check-register-consistency / check-doc-refs / check-root-clean → exit 0
```

## Rollback
```bash
git checkout 5afe60b -- docs/AUDIT-REGISTER.md && git rm -q --ignore-unmatch docs/checklists/verify-branding-phase1.html docs/MANIFEST-2026-09-23-s.md && rm -f docs/checklists/verify-branding-phase1.html docs/MANIFEST-2026-09-23-s.md
```
