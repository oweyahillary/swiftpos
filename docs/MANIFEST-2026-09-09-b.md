# MANIFEST 2026-09-09-b — A271: IPC payload validation across all 149 channels + coverage gate (closes D7)

**Base:** `origin/dev` @ `53cb960` (after A270). **Desktop-only.** No migration, no server
change, no dashboard change. No runtime code path is altered — every handler keeps its exact
behaviour; a validation layer is added in front of it and a gate is added to CI.

## Why
Register D7: `check-ipc-parity` proves a channel is bridged AND handled, but nothing proved the
two sides agreed on the PAYLOAD. 149 channels crossed the preload boundary unchecked — a renderer
sending the wrong shape became an undefined-dereference deep in a handler, or a silent wrong write.
Four channels had been hand-validated; the rest were open. You asked for a close, not a safe batch —
so every channel is validated, and a gate keeps it closed.

## What shipped
1. **Extended the validator** (`ipcValidate.ts`): added `enum`, `any`, nested `object`, and
   `objectArray` field specs, plus bare-value guards `expectString/Number/Boolean/Enum`. The old
   validator only described flat scalar bags; these describe the shapes IPC actually carries,
   including the nested sale payload — so no channel has to be left unvalidated for lack of a spec.
2. **Central registry** (`ipcSchemas.ts`, new): all **149** channels, each with exactly one
   explicit decision — a Schema, a Bare descriptor, or `NO_PAYLOAD`. This is the single source of
   truth for what every channel's payload must look like.
3. **Boundary wiring** (`ipcGuard.ts`, new): `installValidatedHandle(ipcMain)` returns a generic
   `handle(channel, fn)` that validates the payload against the registry, then delegates. Renamed
   all 138 `ipcMain.handle(` in `ipcHandlers.ts` and 11 in `printWorker.ts` to route through it —
   a pure rename, generic typing, no casts, no per-handler boilerplate. `ipcMain.on('app:version')`
   (sync, no payload) is left as-is and listed sync-exempt in the gate.
4. **The gate** (`check-ipc-validation.mjs`, new, wired into CI after `check-ipc-parity`): fails the
   build if any handled channel is missing a registry entry, or if a registry entry is stale. This
   is what makes D7 a close rather than a snapshot — a channel added tomorrow cannot ship unvalidated.
5. **`check-ipc-parity.mjs`** taught to recognise the `handle(` wrapper as well as raw
   `ipcMain.handle(`, so it still sees all 149 channels after the rename.

## The one caveat (rule 16)
`order:create` — the primary sale path — is validated against `createLocalOrder`'s real shape
(the required money fields + the nested `items[]`, each item's `product.{id,name}` / unitPrice /
quantity / lineTotal). But it is listed in `NEEDS_LIVE_TEST`: it could not be exercised on the bench
(no Electron, no live sale). **Ring ONE real order on a dev-flavour till and confirm it goes through
before promoting to production.** It is validated and gated like every other channel; it simply
carries this single confirmation the others don't. If that one order fails validation, the schema in
`ipcSchemas.ts` (`orderCreate`) is the only thing to adjust.

## Files
| File | Change | ID |
|---|---|---|
| `apps/desktop/src/main/ipcValidate.ts` | +enum/any/object/objectArray specs; +expectString/Number/Boolean/Enum | A271 |
| `apps/desktop/src/main/ipcSchemas.ts` | NEW — registry: all 149 channels → schema/Bare/NO_PAYLOAD; order:create + NEEDS_LIVE_TEST | A271 |
| `apps/desktop/src/main/ipcGuard.ts` | NEW — guardChannel + installValidatedHandle (validate then delegate) | A271 |
| `apps/desktop/src/main/ipcHandlers.ts` | import guard; install wrapper; 138× ipcMain.handle → handle | A271 |
| `apps/desktop/src/main/print/printWorker.ts` | import guard; install wrapper; 11× ipcMain.handle → handle | A271 |
| `scripts/check-ipc-validation.mjs` | NEW — coverage gate (handled ⇔ registered) | A271 |
| `scripts/check-ipc-parity.mjs` | recognise the `handle(` wrapper | A271 |
| `.github/workflows/ci.yml` | run check-ipc-validation after ipc-parity | A271 |
| `tests/ipc-validate.test.mjs` | 25 → 52 checks (new specs + order:create shape + registry/guard/gate guards) | A271 |
| `docs/AUDIT-REGISTER.md` | A271 entry; D7 → CLOSED; counts D-P2 2→1 | — |
| `docs/MANIFEST-2026-09-09-b.md` | this delivery record | — |

## What ran + output (rule 7)
```
desktop main tsc   npx tsc -p tsconfig.main.json --noEmit   0 errors
check-ipc-parity        149 channels bridged, 149 handled   OK
check-ipc-validation    149 handled, 149 with a schema, 1 sync-exempt   OK
tests/ipc-validate.test.mjs                                 52/52 checks pass
gates                   register-consistency, doc-refs, root-clean, test-registration   OK
offline suites          for f in tests/*.test.mjs           96/96 suites pass
```

### Mutation-checks (rule 10/23/24)
| Guard | Reintroduced defect | Result |
|---|---|---|
| check-ipc-validation | add a handled channel with no registry entry | RED (names the channel) |
| check-ipc-validation | add a registry entry for an unhandled channel | RED (stale entry) |
| ipc-validate truth table | nested/array/enum specs (positive + negative cases) | RED on each bad shape |

## NOT verified here (rule 16)
- `order:create` validation on ONE live sale (the caveat above).
- The desktop runtime suite (`apps/desktop/test/*`, via `npm run test:desktop`) — a target-machine
  step (needs Electron-as-node / better-sqlite3). The offline `tests/ipc-validate.test.mjs` ran and
  passed here; the runtime suites did not.
- The `admin` workspace was not built here; it is untouched by this change.

## Apply
```
git pull origin dev            # base 53cb960
# extract this zip over the repo root, then:
cd apps/desktop && npm ci && npx tsc -p tsconfig.main.json --noEmit   # 0 errors
cd ../.. && node scripts/check-ipc-parity.mjs && node scripts/check-ipc-validation.mjs
node tests/ipc-validate.test.mjs
node scripts/check-register-consistency.mjs && node scripts/check-doc-refs.mjs
git add -A && git commit -m "A271: validate all 149 IPC channels + coverage gate (closes D7)"
git push origin dev
# then: ring ONE order on a dev-flavour till to confirm order:create's schema (NEEDS_LIVE_TEST).
```
Rollback: revert the A271 commit — the wrapper rename and the new files are one commit.
