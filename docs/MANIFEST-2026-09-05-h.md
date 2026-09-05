# MANIFEST 2026-09-05-h — POS back-to-portal (A222) + stock picker (A218, from -g)

**Base:** `origin/dev` @ `440b81e` (A221 + A218 merged). **CUMULATIVE — supersedes the `-g` zip.**
Carries the `-g` stock-picker work (which wasn't pushed) plus the new A222 back button, so it's one clean
push. If you have since pushed `-g`, tell me and I'll ship A222 alone.

## What's in it
- **A222 (new)** — the cashier screen (opened via "Open POS") now has a "← Manager portal" button in the
  header, shown only to users who have a portal (`resolveRoute … === '/manager'`). Parity with desktop.
- **A218 stock picker (from -g)** — the create-transfer picker shows live per-branch stock, caps each
  input at what's on hand, rejects over-sending before POST.
- **Decision (from -g, no code)** — reorder "min" stays manager-editable.
- **Recommendation recorded (A222 note, no code)** — do NOT duplicate manager features (Receiving,
  Transfers) into the POS ☰ Menu; it's already permission-driven, and POS=selling / portal=managing is
  the right split. The back button completes the switching pattern.

## Files
| File | Change | Finding | Rollback |
|---|---|---|---|
| `apps/dashboard/src/pages/pos/CashierScreen.tsx` | header "← Manager portal" button (manager-only) | A222 | restore from `440b81e` |
| `tests/pos-back-to-portal.test.mjs` | NEW — back-button source guard (mutation-checked) | A222 | delete file |
| `apps/dashboard/src/pages/manager/ManagerReceivingTab.tsx` | transfer picker: live per-branch stock + cap | A218 | restore from `440b81e` |
| `tests/manager-initiate-transfer.test.mjs` | +3 stock-picker guards (11/11) | A218 | restore from `440b81e` |
| `docs/AUDIT-REGISTER.md` | A222 entry; A218 stock-picker note; A215 min decision; counts P3 8→9 | — | restore from `440b81e` |
| `docs/MANIFEST-2026-09-05-g.md` | -g manifest (stock picker) | — | delete file |
| `docs/MANIFEST-2026-09-05-h.md` | NEW — this manifest | — | delete file |

## What ran + output (rule 7)
```
tests/pos-back-to-portal.test.mjs          all green (3 passed)
  mutation (remove button)                 FAIL → restored
  mutation (break nav target)              FAIL → restored
tests/manager-initiate-transfer.test.mjs   all green (11 passed)   [A218 + stock picker]
apps/dashboard  npx tsc --noEmit           exit 0
check-permission-parity · register · doc-refs   exit 0
```
Could NOT verify here: browser pass (back button returns to portal; picker stock correct).

## Apply
1. Extract over root; run gates. 2. `git add` the 7 files; commit; push. 3. Deploy dashboard (no migration).
