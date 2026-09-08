# MANIFEST 2026-09-07-n — A254: print bug-fixes (cut/margin, KOT-as-kitchen, blank tickets)

**Base:** origin/dev @ 9b132f4 (fresh pull). **Web-only.** No migration. No exe rebuild.

## Why (hardware-reported)
- Paper never cut (continuous receipts) and no bottom margin on every ticket.
- "2 dispatch, missing kitchen" — Master KOT printed as a second dispatch.
- Similar: a kitchen/bar station with no matching items printed a blank ticket.

## Fixes
1. **cut/feed/drawer** — every renderer now goes through `emit()` which passes
   `{cut, feedBeforeCut, openDrawer}` from the station config to `toEscPos`. These were
   being dropped, so `ESC d` (feed) and `GS V 66 0` (cut) were never emitted.
2. **Master KOT** — render config is now derived from the printer TYPE:
   `kitchen`/`bar` = routed kitchen, `kot` = all-items KITCHEN copy, `expeditor` = dispatch,
   `receipt` = receipt. Previously `kot` and `expeditor` both mapped to dispatch.
3. **blank routed tickets** — `printRouted` skips a routed (kitchen/bar) station with no
   content; all-items stations always print.

## Files
| File | Change |
|---|---|
| `scripts/escpos-renderer/entry.ts` | `emit()` passes cut/feed/drawer; type-aware station config; `stationHasContent`; drop unused kitchen/dispatch renderers |
| `apps/dashboard/src/lib/escposRenderer.js` | regenerated — byte-reproducible |
| `apps/dashboard/src/lib/printRouted.ts` | type-aware routing (kot=kitchen), skip empty routed stations |
| `tests/tiny-bridge-printing.test.mjs` | 24 → 27 (cut/feed, KOT-as-kitchen, empty-skip guards) |
| `docs/AUDIT-REGISTER.md` | A254 entry; A-P1 18→19 |
| `docs/MANIFEST-2026-09-07-n.md` | this manifest |

## What ran + output (rule 7)
```
smoke: Master KOT -> KITCHEN header ; Dispatcher -> DISPATCH header (one of each)
       feed (ESC d) + cut (GS V 66 0) present on receipt/kitchen/dispatch
       empty bar station -> skipped ; grill (matching) -> prints
tiny-bridge-printing.test.mjs -> 27/27 green
escposRenderer.js -> byte-reproducible
esbuild transpile (entry, printRouted) -> clean
register-consistency · doc-refs · root-clean -> green
```
NOT verified here (rule 16): the physical cut + full station set on the till.

## Rollback (rule 2)
Web-only. `git revert <this commit>`.

## Apply
1. Extract over repo root.
2. `node --test tests/tiny-bridge-printing.test.mjs` -> 27 green; register/doc gates.
3. Redeploy the dashboard. Re-run a combo order: confirm each ticket CUTS with a bottom
   margin, Master KOT prints a KITCHEN copy, Dispatcher a DISPATCH copy (no duplicate), and
   a kitchen/bar station with no matching items prints nothing.
