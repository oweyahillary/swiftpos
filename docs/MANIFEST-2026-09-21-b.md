# MANIFEST 2026-09-21-b — desktop: A301 test fix (driver-agnostic UPSERT section)

**Supersedes 2026-09-21-a** (Rule 3, cumulative/lettered). `-a` is already committed to
`a301-branding-write` at `311e41e`; this ships the one follow-up fix on top of it.

**Base commit:** `311e41e` (`a301-branding-write` — the pushed `-a` slice).
**Scope:** one file, `apps/desktop/test/branding-set.test.mjs`. No production code, no schema,
no other file. The shipped `setBranding`/guard/IPC code is unchanged from `-a`.
**Working rules:** unchanged — `HANDOFF-2026-08-08-evening.md §0` (24 standing rules).
**Register ID:** A301 (as `-a`).

## What changed and why

| File | New? | Change | ID |
|---|---|---|---|
| `apps/desktop/test/branding-set.test.mjs` | edit | The UPSERT/merge section called `db.transaction()`, a **better-sqlite3-only** API. The `node:sqlite` stand-in (the plain-Node fallback, Register A13) has no such method, so that path threw `db.transaction is not a function` and the fallback was dead. Rewritten to run the read-merge-write **statements sequentially** — driver-agnostic — so the section runs on both drivers. The REAL `setBranding` keeps its transaction (a concurrency guarantee); the test only checks MERGE SEMANTICS. | A301 |

Found by running the test (Rule 7) — it passed the guard part and threw on the DB part.

## Verification (Rule 7 — what was run, and what was NOT)

**Environment:** Linux, Node 22, in-sandbox — **weak green** (Rule 9). Till target is Windows /
Electron 43.4.0 / Node 20 with better-sqlite3.

Run on the bench this session:
- **`node apps/desktop/test/branding-set.test.mjs` → 18/18.** 14 guard assertions on plain Node
  (real compiled `dist/main/brandingGuard.js`); 4 UPSERT/merge assertions via the **`node:sqlite`
  stand-in** — row upserted, accent-only keeps logo, null clears logo (accent kept), one row per
  business. Before this fix the merge section threw; after it, green.
- **18 source-scanning gates green**, incl. the three this slice touches: `check-ipc-parity`,
  `check-ipc-validation`, `check-table-usage` (plus root-clean, doc-refs, register-consistency,
  shared-sync, client-parity, auth-retry, permission-catalogue/parity, …).
- **Type-check (main `tsconfig.main.json` + renderer `tsconfig.json`):** none of the A301 files
  introduce a type error on either project.

**Could NOT verify here (Rules 7/9/16 — target-only):**
- The merge ran on the `node:sqlite` **stand-in, not the real driver/ABI** (A13). Run under
  Electron: `ELECTRON_RUN_AS_NODE=1 npx electron test/branding-set.test.mjs`.
- Full **mutation-check** of every mutation listed in the test header, on the compiled `dist`.
- `build:all` + full `test:desktop` + `pack`; the IPC gates re-run on target.
- **`prepareRasterLogo.ts` remains completely unexercised** (needs a DOM/Canvas).
- The **visual** lock-screen check (write an accent/logo, see it render).
- Main-project full type-check could not complete in-sandbox because the `@swiftpos/printing`
  shared package was not linked (an `--ignore-scripts` install artifact, not an A301 issue).

## Rollback (Rule 2)

One tracked file; restore it to the `-a` state:
```bash
git checkout 311e41e -- apps/desktop/test/branding-set.test.mjs
```

## Commit (explicit path — never `git add -A`)

```bash
git checkout a301-branding-write
git add apps/desktop/test/branding-set.test.mjs
git status --short          # expect exactly: M apps/desktop/test/branding-set.test.mjs
git commit -m "test(desktop): A301 — make branding-set UPSERT section driver-agnostic"
git push
```
No version bump / lockfile in this delivery (Rule 22).
