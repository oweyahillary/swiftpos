# MANIFEST 2026-09-23-t — docs only: retest recorded, 7 closed on target, A321 opened

**Base commit:** `a5a3a3f` (origin/dev, delivery -s; 3/3 checksums on the tip, gates exit 0, CI #382 green).
**No code, no deploy.**

**What.** The owner's retest of VERIFY-BRANDING-PHASE1 (Eugene, till mamangina — the client's own till — desktop 0.6.2,
cloud + dashboard from `a5a3a3f`): 18 PASS / 0 FAIL / 2 not run.
- **CLOSED on target:** A311, A312, A313, A316, A317, A318, A320 — each with the checklist lines that verify it.
- **Stay FIX BUILT:** A315 (web + paper verified; till half needs 0.6.3), A308 (A2, A5 not run), A319 (A5 not run).
- **A278 stays open:** B1's note — the price showed only after a cashier signed in and out.
- **NEW A321 (P2, OPEN):** the source diagnosis of that — one signal path of eight; the 20-s check fails silently;
  the lock screen never listens; `branch_prices` has no `updated_at` trigger. Fix planned for 0.6.3.
- **A295 stays OPEN** (correcting what was said in chat before checking its criteria): it closes when EVERY §10 item is
  verified; item 4 is now closed on target, items 5 (A2/A5) and 7 (propagation) are not.
- Open counts re-derived: A 20/19/25 → **19 P1 · 19 P2 · 20 P3**.

## Files (3)
| File | Change |
|---|---|
| `docs/VERIFY-LOG-2026-09-23.md` | NEW. Results as returned + what each closes (format of VERIFY-LOG-2026-09-15.md). |
| `docs/AUDIT-REGISTER.md` | 7 headings → CLOSED with evidence; notes on A315/A308/A319/A278; A295 §10 rows 4/5/7; new A321; Counts; Open; header; changelog. |
| `docs/MANIFEST-2026-09-23-t.md` | This file. |

## Verification
```
check-register-consistency → OK — header agrees with body (A: 0 P0 · 19 P1 · 19 P2 · 20 P3)
check-doc-refs / check-root-clean → exit 0
Every file:line cited in A321 read from the tip (index.ts:240/273/283, ipcHandlers.ts:165/578/581/1126/1138/1594,
syncEngine.ts:531, PinPage.tsx:48); branch_prices trigger absence from the migrations.
```

## Rollback
```bash
git checkout a5a3a3f -- docs/AUDIT-REGISTER.md && git rm -q --ignore-unmatch docs/VERIFY-LOG-2026-09-23.md docs/MANIFEST-2026-09-23-t.md && rm -f docs/VERIFY-LOG-2026-09-23.md docs/MANIFEST-2026-09-23-t.md
```
