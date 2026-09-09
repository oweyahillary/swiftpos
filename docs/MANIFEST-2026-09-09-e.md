# MANIFEST 2026-09-09-e — live verification: D17 CLOSED + A271/D7 order:create confirmed

**Base:** `origin/dev` @ `e054c0e` (after A272). **Register only — NO code change.** Records the
results of verifying the dev flavour on real hardware (SwiftPOS Dev 0.5.39).

## What was verified (on the machine, by the owner)
1. **D17 — dev/prod flavour.** The dev build installed and runs; it shows as **"SwiftPOS DEV"**
   with the **amber dev icon**, visibly distinct from prod; and it writes to
   `%APPDATA%\SwiftPOS Dev`, a **separate data folder** from production's `%APPDATA%\SwiftPOS`.
   All four artefacts had built at v0.5.39 via `release:both none`. → **D17 CLOSED.**
2. **A271 / D7 — `order:create` (the one bench-unverifiable channel).** A real sale on the dev
   build went **through the validated `order:create` IPC boundary, saved to local SQLite, AND
   synced to the cloud.** The schema written against `createLocalOrder` is correct in practice,
   not just in shape. → the `NEEDS_LIVE_TEST` caveat is **cleared; D7 is fully closed.**

## Register changes
| Entry | Change |
|---|---|
| D17 | FIX BUILT → **CLOSED 2026-09-09** (verified-on-hardware note added) |
| Header counts | D-P3 `D9 D10 D17` → `D9 D10`; D summary `3 P3` → `2 P3` |
| A271 | `NEEDS_LIVE_TEST` caveat marked **cleared** with the live-sale confirmation |
| Changelog | 2026-09-09 (e) line |

## Files
| File | Change |
|---|---|
| `docs/AUDIT-REGISTER.md` | D17 closed + counts; A271 live note; changelog |
| `docs/MANIFEST-2026-09-09-e.md` | this record |

## What ran (rule 7)
```
check-register-consistency   OK — header agrees with body (D-P3 2, D17 now CLOSED)
check-doc-refs               OK — every cited document present
```

## Still open on the desktop (unchanged, for the next reader)
D1 (P0 — two-business owner login), D9/D10 (P3), D7 is now CLOSED, D18 (P2). The dev flavour is
now available as the rig for the rest of the testing checklist (thermal printing, POS payment
flow, etc.).

## Apply
```
git pull origin dev
# extract this zip over the repo root, then:
node scripts/check-register-consistency.mjs && node scripts/check-doc-refs.mjs
git add docs/AUDIT-REGISTER.md docs/MANIFEST-2026-09-09-e.md
git commit -m "Live verification: D17 CLOSED + A271/D7 order:create confirmed on the dev flavour"
git push origin dev
```
Rollback: revert this commit — register only.
