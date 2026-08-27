# MANIFEST 2026-08-27-d — A170: NOT NULL write gate

**Base commit:** `d7b20a5` (dev tip after the A167/A168 push). Applies on top of
the committed A167/A168 work — it does not re-touch those files.
**Artifact:** `swiftpos-2026-08-27-d.patch`, verified `git apply --check` clean.

## What ships

**A170 (P3, CLOSED) — the rule-6 gate A167 earned.** A167 was a literal `NULL`
written into a `NOT NULL` local column, fatal at runtime and invisible to `tsc`.
This gate parses the NOT NULL columns out of `localDb.ts` and flags any literal
`NULL` written into one (INSERT VALUES aligned by position, UPDATE SET, ON
CONFLICT DO UPDATE SET). Sweep result: A167 was the only instance — the gate is
green on the tree.

## Files

| File | Change |
|------|--------|
| `scripts/check-notnull-writes.mjs` | NEW gate. Default = scan; `--self-test` = mutation self-check. Exposes `parseNotNullColumns` / `analyzeSql` so the self-test drives the real analyzer (rule 24). |
| `.github/workflows/ci.yml` | Runs the gate and its `--self-test` next to the other gates. `run-all.mjs` already auto-discovers `check-*.mjs`, so no change there. |
| `docs/AUDIT-REGISTER.md` | A170 entry (CLOSED) + changelog; next free ID → A171. Open counts unchanged (A170 is closed). Gate green. |
| `docs/MANIFEST-2026-08-27-d.md` | This file. |

## Verification run (rule 7)

- `node scripts/check-notnull-writes.mjs` → `167 NOT NULL columns across 45 tables. OK`.
- `node scripts/check-notnull-writes.mjs --self-test` → **6 passed, 0 failed** (INSERT/UPDATE/ON-CONFLICT A167 shapes fire; nullable NULLs stay silent).
- Mutation on the REAL file (rule 10/23): reintroducing `token=NULL` in `ipcHandlers.ts` → gate red naming `ipcHandlers.ts:415 staff_session.token` (INSERT + ON CONFLICT), exit 1.
- `check-register-consistency`, `check-doc-refs`, `check-test-registration` → green.
- Node 22 on the Linux bench; the gate is pure text analysis (no runtime deps), so this is not a target-limited claim.

## Nothing target-only here

Unlike A167/A168, this gate is pure static analysis — fully verifiable on the
bench and CI. It closes on delivery.

## Rollback

```
git apply -R swiftpos-2026-08-27-d.patch
```

Two new files and one CI block; the register edits are additive. No desktop
code changed, so no version bump (rule 15 not triggered).
