# MANIFEST 2026-09-21-c — desktop: A301 register the branding test (CI fix)

**Supersedes 2026-09-21-b** (Rule 3). Fixes a red CI check on PR #9.

**Base commit:** `21dc1e8` (`a301-branding-write` tip — the `-b` test fix).
**Scope:** one file, `apps/desktop/package.json` (scripts block only). No production code, no
version bump, no lockfile — so Rule 22 does not apply (it bans shipping the *version* field /
lockfiles, not a scripts edit).
**Working rules:** unchanged — `HANDOFF-2026-08-08-evening.md §0` (24 standing rules).
**Register ID:** A301.

## Why

CI (`Desktop row scope`) failed `check-test-registration` (register A31):

```
WRITTEN BUT NEVER RUN:
  apps/desktop/test/branding-set.test.mjs
```

A test file that no script/CI/runner invokes is not coverage. `branding-set.test.mjs` was added
in `-a` but never wired to a runner. **My miss:** this session I ran 18 gates against the branch
but not `check-test-registration` — it had passed on the pre-change clone, so I didn't re-run it
after adding the file. Rule 20 says a green from *every* gate is part of "not broken"; I skipped
one. CI caught exactly that.

## What changed and why

| File | New? | Change | ID |
|---|---|---|---|
| `apps/desktop/package.json` | edit | Register the test the same way the sibling pure test (`contrast`) is registered: add `"test:branding": "node test/branding-set.test.mjs"` and insert `&& npm run test:branding` into the `test:desktop` chain (right after `test:contrast`). | A301 |

## Verification (Rule 7 — what was run)

**Environment:** Linux, Node 22, in-sandbox (weak green, Rule 9).
- **`node scripts/check-test-registration.mjs` → OK** (127 files, all invoked) — the exact check
  that was red on CI is now green.
- **Re-ran the FULL static gate set — 19/19 exit 0**, this time including `check-test-registration`
  (also ipc-parity, ipc-validation, table-usage, root-clean, doc-refs, register-consistency,
  shared-sync, client-parity, auth-retry, permission-catalogue/parity, own-rows, sql-binds,
  row-attribution, header-keys, notnull-writes, api-routes).
- **`npm run test:branding` → 18/18** — the new script runs the test green.
- `package.json` re-parsed as valid JSON.

**Could NOT verify here (target-only, unchanged):** the Electron `test:desktop` run on the real
better-sqlite3 ABI; the visual lock-screen check; `prepareRasterLogo.ts` (needs a DOM).

## Rollback (Rule 2)

```bash
git checkout 21dc1e8 -- apps/desktop/package.json
```

## Commit (explicit path — never `git add -A`)

```bash
git checkout a301-branding-write
git pull                                       # get 21dc1e8 if this clone is behind
git add apps/desktop/package.json
git status --short                             # expect exactly: M apps/desktop/package.json
git commit -m "test(desktop): A301 — register branding-set test in test:desktop (fix check-test-registration)"
git push
```

After the push, PR #9's `Desktop row scope` job should go green. Re-check the other CI jobs too.
