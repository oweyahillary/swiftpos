# MANIFEST 2026-09-07-g — A249: print parity Phase 2a (shared routing module)

**Base:** on top of delivery -f (A248). **Ship after -f.**
**Delivery:** zip, extract over repo root. **Additive — nothing consumes it yet.** No migration.
No exe rebuild. No behaviour change on desktop or web.

## Why
The desktop's proven station-routing + unit-expansion lived only in
`escposBridge.ts`, reading SQLite — so the web couldn't reuse it without a second,
weaker copy. Phase 2 lifts it into `shared/` as one DB-free copy, so web (Phase 3)
and desktop (Phase 2b) run identical routing.

## What changed
- **NEW `shared/printing/src/routing.ts`** — `toUnits`, `stationsForCategory`,
  `idsByKind`, `describeFromText`, `isExcludedFromKitchen` lifted **verbatim** from
  `escposBridge.ts`; the only change is `stationsForCategory` takes a
  `CategoryRouting` argument (`byCategory` + `kitchenCategories`) instead of reading
  SQLite. Pure/browser-safe.
- Exported from `shared/printing/src/index.ts`.
- **NEW `shared/printing/test/routing.test.ts`** (11 characterization cases) wired
  into the package `test` script.

## Files
| File | Change | ID |
|---|---|---|
| `shared/printing/src/routing.ts` | **new** — shared DB-free routing | A249 |
| `shared/printing/src/index.ts` | export routing | A249 |
| `shared/printing/test/routing.test.ts` | **new** — 11 characterization cases | A249 |
| `shared/printing/package.json` | test script runs routing.test | A249 |
| `docs/AUDIT-REGISTER.md` | A249 entry; A-P2 28→29 | A249 |
| `docs/MANIFEST-2026-09-07-g.md` | this manifest | — |

## What ran + output (rule 7)
```
shared/printing/test/routing.test.ts (via tsx)  -> 11/11 green
shared sample generator                          -> reproduces SAMPLE-OUTPUT.txt (no drift)
register-consistency · doc-refs · root-clean · test-registration -> green
```
NOT run here: `shared/printing` full `tsc -b` / `test` compile (CI does that on push).

## Scope / next
- Phase **2a** (this) = shared module + proof. Additive; desktop keeps its identical
  private copy for now, so no behaviour change.
- Phase **3** = the web bundles `routing.ts` (like it bundles the renderer) and loads
  `category_stations` + exclusions from the API to route kitchen/dispatch properly.
- Phase **2b** = desktop swaps its private copy for the shared one — needs a
  `@swiftpos/printing` dist rebuild + a full desktop regression (do it where the
  desktop builds).

## Rollback (rule 2)
Additive; nothing imports it yet. `git revert <this commit>`.

## Apply
1. Extract over repo root.
2. `cd shared/printing && npm test` (compiles + runs routing.test alongside the rest), or
   `npx tsx shared/printing/test/routing.test.ts` for a quick check.
3. Repo gates: register-consistency, doc-refs, root-clean.
