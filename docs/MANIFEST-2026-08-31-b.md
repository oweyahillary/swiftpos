# MANIFEST 2026-08-31-b — A186: log the Windows migration-suite teardown crash

**Base commit:** `189bfc2` (dev — the A185 push).
**Register:** A186 (P2, OPEN). Entry added in this same change (rule 14).
**Kind:** docs only. No code, no build (rule 18: normally no zip for a docs-only
change — packaged here only because the delivery convention is one zip/patch + commands).

## Files

| File | Change |
|---|---|
| `docs/AUDIT-REGISTER.md` | A186 entry added above A185; header Open A-P2 22→23; Counts A-P2 gains A186. |
| `docs/MANIFEST-2026-08-31-b.md` | This file. |

## Why this is a finding, not a fix

The migration assertions PASS on both platforms. Windows crashes in libuv's
async-handle close path (`src\win\async.c`) during process teardown, which flips
`run-all.mjs` to `== 1 FAILED ==` and masks the real result. Logged so the red
stops reading as a mystery. Candidate fixes are noted in the A186 entry but not
built — a fix needs a proving mutation showing the suite still goes red on a real
migration regression (rule 23).

## Verification (rule 7 — what ran and what it printed)

```
npm i --no-save @electric-sql/pglite     # sandbox
node scripts/run-migration-tests.mjs
  → "All 20 migration test file(s) passed", exit 0, no crash   (Linux, Node 24)
node scripts/check-register-consistency.mjs  → OK, header agrees with body
node scripts/check-doc-refs.mjs              → OK, every cited doc in tree
```

Contrast: the Windows run (this session's A185 push) crashed at
`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94`
after the same assertions printed `all green`.

## Could NOT be verified here (rule 9)

- The crash itself: it is Windows-libuv-specific and does not reproduce on Linux.
  Confirmation that it pre-dates A185 is by inspection (A185 touches no native code)
  + the clean Linux run, not by reproducing it on this box.

## Rollback

Before commit:
```
git restore docs/AUDIT-REGISTER.md
rm docs/MANIFEST-2026-08-31-b.md
```
After commit/push:
```
git revert <sha> && git push origin dev
```

## Before you commit (rule 20)

```
node scripts/check-register-consistency.mjs
node scripts/check-doc-refs.mjs
```
Both were run in the sandbox and were green.
