# MANIFEST 2026-09-09-d — A272: register hygiene (five OPEN → FIX BUILT)

**Base:** `origin/dev` @ `8356a6e` (after both A271 commits). **Register only — NO code change.**
Just the audit register and this manifest.

## Why
A code-vs-register audit (reading the source at the current HEAD, not trusting the entries)
found five items whose headings said `OPEN` while the code showed the work had landed. That is
the register's own failure mode — a heading disagreeing with reality — in the direction that
hides progress and makes the board misleading for planning. Each was re-verified against
`8356a6e` and re-graded `OPEN` → `FIX BUILT`.

`FIX BUILT` derives to OPEN in `check-register-consistency` (only CLOSED/PARTLY CLOSED/STRUCK/
FIX SHIPPED count as closed), so these stay in the open counts — the header math is unchanged.
The point is accuracy, not closing them: each is built but still needs one live check, noted in
its entry.

## The five (each re-verified at this HEAD)
| ID | Was | Now | Evidence in code | Live check still needed |
|---|---|---|---|---|
| D17 | OPEN | FIX BUILT | `electron-builder.config.js` + `resources/icon.dev.*` + `scripts/release-both.mjs`; all 4 artefacts built v0.5.39 on 2026-09-09 | install dev flavour → confirm `%APPDATA%\SwiftPOS Dev` is separate from prod |
| A151 | OPEN | FIX BUILT | server rejects unbalanced legs — `orders.ts` `PAYMENT_MISMATCH`; both panels build N legs → one `/pay` | one by-item split with an odd cent |
| A188 | OPEN | FIX BUILT | `CashierScreen.tsx` `hasLayout` grid fallback | restaurant POS on a branch with no saved layout |
| A146 | OPEN | FIX BUILT | `settings/WebhooksTab.tsx` mounted in SettingsPage + BusinessPage | create + test-delivery from the UI |
| A139 | OPEN | FIX BUILT | `91_branch_settings.sql` + resolution in pos.ts/branches.ts + `BranchReceiptOverrides.tsx` | set an override, confirm branch receipts + till honour it |

**A151 also had its heading + description corrected:** the original "under-collects / pay loop
never advances past guest 1" is FALSE against the code — the loop is gone and the server
guards leg reconciliation, so money cannot be under-collected. Only by-item verification
remains.

**A146 note:** flagged a duplicate inline `WebhooksTab` in `SettingsPage.tsx` (~line 162)
alongside the imported one — reconcile before closing A146.

## Files
| File | Change |
|---|---|
| `docs/AUDIT-REGISTER.md` | 5 headings OPEN→FIX BUILT + notes; A151 desc corrected; A272 entry; changelog |
| `docs/MANIFEST-2026-09-09-d.md` | this record |

## What ran (rule 7)
```
check-register-consistency   OK — header agrees with body (counts unchanged; FIX BUILT = open)
check-doc-refs               OK — every cited document present
```

## Apply
```
git pull origin dev
# extract this zip over the repo root, then:
node scripts/check-register-consistency.mjs && node scripts/check-doc-refs.mjs
git add docs/AUDIT-REGISTER.md docs/MANIFEST-2026-09-09-d.md
git commit -m "A272: register hygiene — re-grade 5 built-but-OPEN items to FIX BUILT (no code change)"
git push origin dev
```
Rollback: revert this commit — register only.
