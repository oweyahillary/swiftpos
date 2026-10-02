# MANIFEST 2026-09-05-b — true up AUDIT-REGISTER header (header==body)

**Base:** `origin/dev` @ `6533ae2` (built directly on the pushed bytes).
**Why:** commit `87a9fd1` landed the A211–A215 entries + A206 CLOSED in the body,
but the header counts were never updated, so `check-register-consistency` was RED
on `dev`. A follow-up `sed` (my bad instruction) edited the wrong line (`| Counts |`,
which the gate does not read) and corrupted it. This corrects the line the gate
actually reads and cleans the other.

## Files (extract over repo root)
| File | Change | Rollback |
|---|---|---|
| `docs/AUDIT-REGISTER.md` | `\| Open \|` numeric line: `15 P1 -> 17 P1`, `17 P2 -> 19 P2` (the line the gate reads). `\| Counts \|` ID line rebuilt clean: removed the duplicated `A211 A215`, un-mashed `A189 A188`, dropped `A206` (now CLOSED), added `A212 A213 A214`. | `git checkout 87a9fd1 -- docs/AUDIT-REGISTER.md` |
| `docs/MANIFEST-2026-09-05-b.md` | NEW — this manifest. | delete file |

## Verified (this batch)
```
node scripts/check-register-consistency.mjs   -> exit 0
  "OK — no duplicate IDs, and the header agrees with the body."
```
No code touched — docs only. D-side counts unchanged (1 P0 · 2 P1 · 2 P2 · 3 P3).

## Still outstanding (unchanged by this fix)
- Rotate the two credentials pasted earlier (Supabase DB password, GitHub PAT).
- Confirm which DB migration 99 hit (run under `env=unspecified` with a "Prod"-named string).
- Decide the two stray files in 87a9fd1 (`docs/SIGNAGE-DESIGN.md`, `scripts/functions-index.json`).
- Browser-reverify A133/A205 against the migrated DB, then flip them to CLOSED.
