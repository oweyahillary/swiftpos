# MANIFEST 2026-09-22-d — A306 main-side manager gate · A159 flag documented

**Base commit:** `e84b744` (origin/dev after -c). No file below has moved since; all ship whole.
**Register:** A306 (hardened, stays FIX BUILT), A159 (docs note, stays OPEN). No new ID.
**Environment:** Linux, Node 22.22.2, no Electron binary — desktop tsc is a real check here; the
running-till behaviour is not (rule 9/16).
**Desktop change → version bump at build, tag after the build (rule 15).** `package.json` is NOT in
this zip (rule 22).

## Files (7)

| File | Change |
|---|---|
| `apps/desktop/src/main/ipcHandlers.ts` | `update:installNow` refuses `{ok:false, reason:'manager_required'}` unless `dayService.isManager()` — the gate closeDay uses. Additive; the banner's PIN path is unchanged. |
| `apps/desktop/src/renderer/pages/UpdateBanner.tsx` | Reads the `installNow()` result and shows the refusal instead of ignoring it. |
| `apps/desktop/src/main/autoUpdate.ts` | Comment corrected: gate is in the handler AND the banner. |
| `apps/server/.env.example` | `TERMINAL_WRITE_ENFORCE` documented (dry-run until "true"). |
| `render.yaml` | `TERMINAL_WRITE_ENFORCE: "false"` pinned with the flip instruction. Additive; deploy behaviour unchanged. |
| `tests/update-ux-wiring.test.mjs` | +3 assertions: gate present, gate before install, banner surfaces refusal. Comment-stripped before indexing (rule 24). |
| `docs/AUDIT-REGISTER.md` | A306 hardening note, A159 docs note, changelog row, Last-updated. Counts unchanged. |
| `docs/MANIFEST-2026-09-22-d.md` | This file. |

## Verification (rule 7)

```
node --no-warnings tests/update-ux-wiring.test.mjs        16 passed, 0 failed
  mutation 1 (gate removed)        → FAIL "refuses unless isManager()" + "gate runs BEFORE"   (14/2)
  mutation 2 (gate after install)  → FAIL "gate runs BEFORE installUpdateNow()"             (15/1)
  mutation 3 (banner ignores)      → FAIL "banner surfaces a main-side refusal"              (15/1)
  restored                         → 16 passed, 0 failed
apps/desktop: tsc -b tsconfig.main.json --force   exit 0
apps/desktop: tsc -p tsconfig.json --noEmit       exit 0
check-ipc-parity        OK — every channel is bridged and handled.
check-ipc-validation    OK — 153 handled, 153 with a schema, none stale
test-print-resilience   55/0 · test-office-role 26/0 · test-branch-close 28/0
run-all.mjs             == GREEN == 113 passed, 0 skipped
check-register-consistency OK · check-doc-refs OK · check-root-clean OK
```

Note for the record: the first version of the "gate runs BEFORE" assertion passed mutation 2 because it
indexed the handler's comment (which names `isManager()`), not the code. Rule 24. Fixed before shipping.

## NOT verified (target-only)
- The refusal on a real till when a cashier (not manager) session is current.
- The banner + manager restart on the next auto-update (the A306 check still owed from 0.6.1).

## Rollback
```bash
git checkout e84b744 -- apps/desktop/src/main/ipcHandlers.ts apps/desktop/src/renderer/pages/UpdateBanner.tsx apps/desktop/src/main/autoUpdate.ts apps/server/.env.example render.yaml tests/update-ux-wiring.test.mjs docs/AUDIT-REGISTER.md
git rm -q docs/MANIFEST-2026-09-22-d.md
```
