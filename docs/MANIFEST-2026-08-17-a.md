# MANIFEST 2026-08-17-a — Node 22 runtime + npm vulnerability sweep (A108, pending)

**Base commit:** `40e5714` (`dev`). Register ID **A108** to be opened on apply
(rule 14). This batch changes the deploy runtime and desktop toolchain; it does
**not** touch schema, IPC, or business logic.

**Zip extracts over the repo root.** After extracting, run `npm install` in each
changed app to materialise `node_modules` from the shipped lockfiles, then the
per-app build/gates below.

## Files (14)

| File | Change | Why |
|---|---|---|
| `package.json` | `engines.node` `>=20` → `>=22` | Vercel drops Node 20. |
| `apps/dashboard/package.json` | `engines.node` `20` → `22`; react-router bumped by audit fix | Vercel surface; 4 vulns → 0. |
| `apps/dashboard/package-lock.json` | react-router-dom → 7.18.2 (semver) | resolved tree for the above. |
| `apps/admin/package.json` | added `engines.node: 22` | Vercel surface; had no engines field. |
| `apps/admin/package-lock.json` | postcss 8.5.26, nanoid 3.3.18 (semver) | 2 vulns → 0. |
| `apps/server/package.json` | `engines.node` `20` → `22`; `nodemailer` `^8` → `^9.0.5`; `overrides.exceljs.uuid ^11.1.1` | Render surface; 6 vulns → 0. exceljs kept at 4.4.0 (npm's "fix" was a bogus 3.4.0 downgrade). |
| `apps/server/package-lock.json` | body-parser/brace-expansion/ip-address safe fixes + nodemailer 9 + uuid override | resolved tree. |
| `apps/print-server/package.json` | `engines.node` `>=20` → `>=22` | consistency. |
| `apps/print-server/package-lock.json` | **NEW** — was missing entirely | supply-chain hygiene; 0 vulns. |
| `apps/desktop/package.json` | `electron` `35.7.5` → `43.4.0`; `electron-builder` `^25` → `^26.15.7`; `electron-rebuild@^3` → `@electron/rebuild@^4.2.0`; `better-sqlite3` `^11.10` → `^13.0.3`; `overrides.exceljs.uuid ^11.1.1` | Electron 43 (Vercel/Node direction) + native ABI; 24 vulns → 0. |
| `apps/desktop/package-lock.json` | resolved tree for Electron 43 toolchain | reproducible install. |
| `apps/desktop/src/main/printService.ts` | `PrinterInfo.isDefault` read defensively (Electron 43 removed the field) | the ONLY source change in the 8-major Electron jump; display-only value. |
| `.github/workflows/ci.yml` | `node-version` `20` → `22` (4 jobs; the `node:sqlite` job was already 22) | CI matches new engines. |
| `.github/workflows/db-migrate-prod.yml` | `node-version` `20` → `22` | same. |

## Verified on the Linux bench (Node 22)

- dashboard: `npm audit` 0, `vite build` OK.
- admin: `npm audit` 0, `vite build` OK.
- server: `npm audit` 0, `tsc` OK, runtime smoke (exceljs writeBuffer 6427 B; nodemailer 9 `createTransport`/`sendMail`) OK.
- print-server: `npm audit` 0.
- desktop: `npm audit` 0; renderer `tsc` clean; main `tsc` clean (only the pre-existing benign `TS2688` node-types line); shared/printing `tsc` clean; 8/9 test suites green; `test:pin` 8/8 is the pre-existing plain-node baseline (needs `safeStorage`, provided only by `test:pin:electron`) — proven identical on the un-patched tree; `better-sqlite3@13` (N-API 10, ABI-stable) compiles + loads + runs WAL/FK/prepare/transaction.

## NOT verified — needs real hardware (rule 9)

- Desktop **must trade a shift on a Windows build** (`npm run pack:dev`, VS Build Tools present) before any prod till build: app launch, `swiftpos.db` open, sign-in, thermal print, and the printer "(default)" label.
- Server **nodemailer 9 needs a real SMTP send on Render** (bench proves construction only; `RESEND_API_KEY` still unset — A54).
- Confirm each Vercel project's **Node.js Version** UI setting is not pinned to 20 (it overrides `engines`).

## Rollback

Per file: `git checkout -- <path>`. Nothing touched schema/IPC/business logic;
`printService.ts` is a one-line revert. `apps/print-server/package-lock.json` is
new — `rm` it to undo.
