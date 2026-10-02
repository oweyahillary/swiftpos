# MANIFEST 2026-09-07-i — A251: print parity Phase 2b (desktop adopts shared routing)

**Base:** on top of -g (A249) + -h (A250). **Apply after both.**
**Delivery:** zip, extract over repo root. **Desktop-only.** No migration. No web change.

## Why
A249 put the routing logic in `shared/printing`; the desktop still had its own
identical copy in `escposBridge.ts`. Phase 2b removes the duplicate so web and
desktop run ONE copy that cannot drift.

## What changed (behaviour-preserving)
- `escposBridge.ts` imports `toUnits`, `stationsForCategory`, `idsByKind`,
  `isExcludedFromKitchen` from `@swiftpos/printing` and builds the routing tables
  from its local DB once per sale (`buildCategoryRouting` = the same two reads,
  `category_stations` + `categories.is_kitchen`, that lived inside the private
  `stationsForCategory`). Private copies deleted; unused `UnitAttribute`/`StationIds`
  imports dropped. Kept local: `escposEnabled`/`setEscposEnabled`/`kitchenExclusions*`.

## Files
| File | Change | ID |
|---|---|---|
| `apps/desktop/src/main/escposBridge.ts` | use shared routing; delete private copies; `buildCategoryRouting` | A251 |
| `docs/AUDIT-REGISTER.md` | A251 entry; A-P3 14→15 | A251 |
| `docs/MANIFEST-2026-09-07-i.md` | this manifest | — |

## What ran + output (rule 7)
```
esbuild transpile escposBridge.ts            -> clean
shared characterization test (routing.test)  -> 11/11 (pins the logic desktop now uses)
no external importer of the deleted symbols  -> confirmed (only printSale/escposEnabled/kitchenExclusions* consumed)
register-consistency · doc-refs · root-clean -> green
```
**NOT verified here (rule 16/9):**
- Desktop `tsc -b` — CI runs it on push (`noEmitOnError`); the `@swiftpos/printing`
  dist rebuilds via `tsconfig.main.json`'s project reference.
- Runtime print on hardware. **Release gate applies:** a till build carrying a routing
  change trades a full shift on the **dev flavour** across two tills before production
  (a bad routing build is a site visit) — even though this change is behaviour-preserving.

## Rollback (rule 2)
`git revert <this commit>` — restores the private copies. Desktop-only.

## Apply
1. Ensure -g (A249) and -h (A250) are in first (this imports the A249 shared module).
2. Extract over repo root.
3. On push, CI builds shared/printing then the desktop (`tsc`) — watch it stays green.
4. Build the **dev flavour**, trade a full shift on two tills, then promote to production.
