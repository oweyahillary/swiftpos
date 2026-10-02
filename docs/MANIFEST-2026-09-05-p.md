# MANIFEST 2026-09-05-p — A228 manager PO creation (cumulative: A225→A228)

**Base:** `origin/dev` @ `7a6defc`. **CUMULATIVE** — carries A225 (reprint), A226 (doc styling),
A227 (history) and A228 (manager PO), none pushed yet. One zip delivers all. If you've pushed any, tell me.

## What A228 does (option a — straight to Ordered, no approval)
A "New PO" button in the manager Receiving tab: branch locked to the manager's own branch (server-enforced),
optional supplier, searchable ingredient lines with qty + unit cost, expected date + notes. Creates the PO
then marks it Ordered, so it lands in the open supplier-deliveries list to receive. Server already permitted
this (`inventory.receive`); this is UI exposure only.

## Files (A228 delta)
| File | Change | Rollback |
|---|---|---|
| `apps/dashboard/src/pages/manager/ManagerReceivingTab.tsx` | New PO button + create modal + createPO (POST then PATCH ordered) | restore from `7a6defc` |
| `tests/manager-create-po.test.mjs` | NEW — source guards (5/5, mutation-checked) | delete file |
| `docs/AUDIT-REGISTER.md` | A228 entry; counts P2 18→19 | restore from `7a6defc` |
| `docs/MANIFEST-2026-09-05-p.md` | NEW — this manifest | delete file |

Also in this cumulative zip: A225+A226+A227 files and manifests m/n/o.

## What ran + output (rule 7)
```
tests/manager-create-po.test.mjs  5/5  (mutations: drop PATCH ordered → red · wrong branch_id → red)
tests/manager-history.test.mjs    5/5   document-styling 8/8   reprint 5/5
apps/dashboard  npx tsc --noEmit  exit 0
register · doc-refs · parity · catalogue   exit 0
```
Could NOT verify here: browser (create a PO as a manager → appears Ordered → receive it).

## Apply
1. Extract over root; run gates. 2. `git add` the A225→A228 files (manifests m/n/o/p); commit; push. 3. Deploy dashboard.
