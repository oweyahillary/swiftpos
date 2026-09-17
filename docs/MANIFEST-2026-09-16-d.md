# MANIFEST 2026-09-16-d  (cumulative — supersedes -c)

**Base commit:** dev @ the v0.5.41 line (A284 + A283 landed). Extract over the
project root `/c/swiftpos/pos`. Carries A288 (config) PLUS the new A289 + A290.
Bench-reviewed only — not tsc-compiled here; the CI build typechecks (rule 9).

## Files
- `apps/desktop/electron-builder.config.js` — A288: NSIS-only target (portable +
  unused shortName removed). Also carries A284 (extraMetadata) + A283 (nsis.include).
  Included so -d is cumulative; a no-op if A288/-c was already committed.
- `apps/desktop/src/main/index.ts` — A289: `cloudBadgeTitle()` gates the cloud host
  in the window title. DEV flavour (and unpackaged dev) always show the host; PROD
  hides it for hosts in `PROD_CLOUD_HOSTS` but STILL shows an unexpected host as a
  misconfig warning. Seeded `PROD_CLOUD_HOSTS = ['swiftpos-20c2.onrender.com']` —
  update if prod uses a different cloud. Needs A284 (per-flavour app.getName()).
- `apps/desktop/src/main/managerReports.ts` — A290: `getTableOccupancy()` fails soft
  (returns [] on a schema error) instead of throwing.
- `apps/desktop/src/renderer/pages/ManagerPage.tsx` — A290: Overview uses
  `Promise.allSettled` + per-call handling so one failing query no longer blanks
  revenue/payments/top-sellers (the old shared try/catch did).
- `docs/MANIFEST-2026-09-16-d.md` — this manifest.

## Why Overview was blank (root cause)
Overview ran salesSummary + topProducts + tableOccupancy in one Promise.all with a
single catch. On an older/migrated local db, tableOccupancy's SELECT hit a missing
column and threw; the shared catch then zeroed the ENTIRE Overview even though
sales were fine. A290 isolates the calls and hardens tableOccupancy.

## Apply (from repo root)
    cd /c/swiftpos/pos
    # extract -d over the tree (overwrites the 5 files)
    # paste the A289 + A290 register lines below into docs/AUDIT-REGISTER.md, then:
    git add apps/desktop/electron-builder.config.js apps/desktop/src/main/index.ts \
            apps/desktop/src/main/managerReports.ts \
            apps/desktop/src/renderer/pages/ManagerPage.tsx \
            docs/MANIFEST-2026-09-16-d.md docs/AUDIT-REGISTER.md
    git commit -m "A289 title host-gate by flavour; A290 Overview resilient (allSettled + soft tableOccupancy); A288 nsis-only"
    git push origin dev

## Rollback
    git checkout -- apps/desktop/electron-builder.config.js apps/desktop/src/main/index.ts apps/desktop/src/main/managerReports.ts apps/desktop/src/renderer/pages/ManagerPage.tsx
    # after commit: git revert <sha>

## Register (rule 14)
    A289 → FIX BUILT — window-title cloud host gated by flavour: prod hides known
    PROD_CLOUD_HOSTS, dev flavour always shows, unexpected host still shown on prod
    (D17 misconfig safety kept). Confirm on the 0.5.41+ build (needs A284 getName).
    A290 → FIX BUILT — desktop Overview no longer blanks when one KPI query throws:
    getTableOccupancy fails soft; ManagerPage uses Promise.allSettled per-call.
    Root cause: shared catch + tableOccupancy schema mismatch on a migrated db.

## Open / next (not in this zip)
- A286 (tz filter labels) — revisit against real timestamps; may be non-bug.
- A287 (shift-rejection reason on till panel + 409 disambiguation + token-always-
  expired refresh cadence + Render node cold-start keepalive).

## Not carried (rule 22)
- No package.json / version.
