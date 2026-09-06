# MANIFEST 2026-09-05-v — A236 print-bridge exe build (+ require-path fix); cumulative with A235

**Base:** `origin/dev` @ `20db143`. **CUMULATIVE** — also carries A235 (silent receipt), which wasn't
pushed. One zip delivers **A235 + A236**. If you've since pushed A235, tell me and I'll ship A236 alone.

## What A236 does
- **Fixes broken require paths** in `apps/print-server/src/index.js` (`dist/src/…` → `dist/…`) — the bridge
  now loads `shared/printing`; it failed to even from source before. Verified: the bundle runs, `/health`
  returns `{ok, version 2.0.0}`, and it prints the pair token.
- **Finishes the .exe build**: `build-exe.mjs` (build shared/printing → esbuild bundle → SEA blob → copy
  node runtime → postject inject → `build/SwiftPOS-PrintServer.exe`), `sea-config.json`, `package.json`
  scripts + devDeps (esbuild, postject), `build/` gitignored. Build/run docs in PRINT-SERVER-SETUP.md.

## Files (A236)
| File | Change | Rollback |
|---|---|---|
| `apps/print-server/src/index.js` | require paths `dist/transport.js` / `dist/index.js` | restore from `20db143` |
| `apps/print-server/build-exe.mjs` | NEW — full SEA build pipeline | delete file |
| `apps/print-server/sea-config.json` | NEW — SEA config | delete file |
| `apps/print-server/package.json` | build:win/build:exe/bundle scripts + esbuild/postject devDeps | restore from `20db143` |
| `apps/print-server/.gitignore` | ignore `build/` | restore/remove |
| `docs/PRINT-SERVER-SETUP.md` | + exe build section | (A235 file; keep) |
| `docs/AUDIT-REGISTER.md` | A236 entry; counts P2 20→21 | restore from `20db143` |
| `docs/MANIFEST-2026-09-05-v.md` | NEW — this manifest | delete file |

Also in this cumulative zip: all A235 files + `docs/MANIFEST-2026-09-05-u.md`.

## What ran + output (rule 7)
```
shared/printing build + esbuild bundle → build/bridge.cjs (62 KB)
  node build/bridge.cjs  → /health {ok, version 2.0.0}, prints pair token   ✓ self-contained
silent-receipt.test.mjs   7/7   [A235]
register · doc-refs · parity · catalogue   exit 0
```
**NOT runnable here:** the SEA/postject/`.exe` steps (need Windows + Node ≥ 24) — run `npm run build:win`
on the till/dev Windows box. dashboard tsc: A235 verified earlier (this batch adds no dashboard change).

## Apply
1. Extract over root; run gates + `node tests/silent-receipt.test.mjs`. 2. `git add` the files; commit; push.
3. Deploy dashboard with `VITE_PRINT_SERVER_URL` (A235). 4. On a Windows box: `cd apps/print-server && npm i && npm run build:win`.
