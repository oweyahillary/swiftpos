# MANIFEST — 2026-08-24-e

**Base commit:** batch -d (`f4aabc6`) on `audit/2026-08-23`. Applies **on top of -d**.
**Register IDs:** **A20** + **A24** — source passes. Both stay **OPEN P1** (analysis/
design only; target-only to build).
**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.
**Docs-only (rule 18):** no code changed, so no zip — the register diff + this manifest.
**Apply:** `git apply MANIFEST-2026-08-24-e.patch` · **Rollback:** `git apply -R MANIFEST-2026-08-24-e.patch`

Source-grounded analysis of the two remaining node-cluster findings (A19's pass shipped
in -t; A20/A24 were the ones the 08-23 handoff proposed next). No behaviour changes.

---

## Files

| # | Change | File | What |
|---|--------|------|------|
| 1 | **edit** | `docs/AUDIT-REGISTER.md` | A20 + A24 each gain a "SOURCE PASS 2026-08-24" section (confirmed-at-source state, structural finding, concrete change map); Last-updated note. Open tally **unchanged** — both remain OPEN P1. |
| 2 | **new** | `docs/MANIFEST-2026-08-24-e.md` | This manifest. |

## What the passes establish (verified in the tree, rule 5)
- `REPLICATED_TABLES` (`nodeIngest.ts:32`) = six **sales** tables only; `collectDistribution`
  (`:648`) fans them keyed on `device_id`+`seq`.
- The roster is node-local (`branch_staff`, `localDb.ts:95`; written by `storeBranchStaff`
  `branchStaff.ts:43` from the node's `/api/staff` cloud pull) and is **not** replicated;
  there is no `/node/roster`. A promoted peer (`tech:promoteToNode` `ipcHandlers.ts:2081`)
  therefore has every sale but cannot authenticate anyone. **(A20)**
- Every till reads all reference data from the CLOUD (`syncEngine.ts` `:602/:679/:690/:703/
  :715/:728/:750`); `nodeClient` pulls only sales distribution. An offline peer's catalogue,
  prices, staff and settings go permanently stale. **(A24)**

## The load-bearing finding (why this wasn't already trivial)
The filed one-liner — "extend `collectDistribution` downstream to carry users + catalogue"
— does not hold at source. That fan-out is origin-device/`seq`-based for append-mostly
sales. Reference data is cloud-authoritative, mutable, not device-originated and has no
per-device seq, so it **cannot ride the same channel**. Both A20 and A24 need a distinct
**node-authoritative snapshot channel** (versioned per table; peer replaces its copy on
change). A20 (roster) is a special case of it — so one channel closes A20 + A24 together
and complements A19 (upstream forward) and A17 (auth). Full change maps + the two A24
sub-bugs (`business_settings` has no `branch_id`; two kitchen-exclusion sources) are in
the register entries.

## Evidence (rule 7 / rule 9)
```
check-register-consistency   OK — header agrees with body (tally unchanged)
check-doc-refs               OK — every cited document resolves
```
Docs-only; no build/test surface touched.

## Could NOT be done here (rule 16)
Nothing to build on the bench — A20/A24 are target-only (need a live node + peer +
promotion/offline drill). These passes hand the implementer a source-accurate map; the
build and its verification stay on the target, and should follow A19 and ideally D3.
