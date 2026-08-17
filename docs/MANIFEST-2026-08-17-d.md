# MANIFEST 2026-08-17-d — A111 standardise on Node 24 LTS

**Base:** apply on top of A108–A110. Register ID **A111**. Config-only: engines
+ CI, no code, no deps, **no lockfiles**.

Follows A108 (which moved off Node 20 to 22). Owner standardised local on Node 24
LTS; Electron 43 (A108) already bundles a Node-24-era runtime, so the stack now
aligns on 24.

## Files (9)

| File | Change |
|---|---|
| `package.json` | `engines.node` `>=22` → `>=24` |
| `apps/dashboard/package.json` | `engines.node` `22` → `24` |
| `apps/admin/package.json` | `engines.node` `22` → `24` |
| `apps/server/package.json` | `engines.node` `22` → `24` |
| `apps/print-server/package.json` | `engines.node` `>=22` → `>=24` |
| `.github/workflows/ci.yml` | all `node-version` 22 → 24 (incl. node:sqlite lane; comment updated) |
| `.github/workflows/db-migrate-prod.yml` | `node-version` 22 → 24 |
| `docs/AUDIT-REGISTER.md` | A111 entry |
| `docs/MANIFEST-2026-08-17-d.md` | this file |

Desktop is untouched (no `engines`; Electron owns its bundled Node).

## After applying — sync lockfiles on Node 24

No lockfiles are shipped; the engines line in each re-syncs on install:

```
for d in apps/server apps/dashboard apps/admin apps/print-server; do (cd "$d" && npm install); done
```

Commit the resulting `package-lock.json` changes (one engines line each) if you
want them in git.

## Verified (bench, Node 22)

- All five `package.json` parse; both workflow YAMLs lint; dashboard `vite build`
  clean; `check-register-consistency` + `check-doc-refs` green.
- `npm install` now emits the EXPECTED `EBADENGINE required:{node:24}
  current:v22` — confirms the pin is live (silent on Node 24).

## NOT verified here

- No real Node-24 runtime on the bench (nodejs.org not on the allowlist; apt
  offers only 22). Real proof is the owner's local + the CI run on 24. 22→24 is
  a low-risk modern step; the code already built + tested clean on 22 (A108).
- Confirm each Vercel project's Node.js Version UI offers 24; Render reads
  `engines`.

## Rollback

Per file: `git checkout -- <path>`.
