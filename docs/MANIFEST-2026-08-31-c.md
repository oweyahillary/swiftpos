# MANIFEST 2026-08-31-c — reconcile the register against the 2026-08-31 browser test

**Base commit:** `189bfc2` (dev — the A185 push). **Docs only, no code, no build.**
The `AUDIT-REGISTER.md` here is cumulative: it also contains the A186 entry from
`-b`, so applying this file is correct whether or not `-b` was committed. Both
`MANIFEST-2026-08-31-b.md` and this file are included so the tree has them either way.

## What this records (from the Claude-agent browser test, report dated 2026-08-31)

**Closed (browser-confirmed PASS):**
| ID | Result |
|---|---|
| A8 (P2)  | Split Bill opens the same PaymentModal; no dead modal. |
| A73 (P2) | Terminals table reachable + clean. |
| A130 (P2)| No Aggregators tab — retirement confirmed. |
| A140 (P2)| Folded into A165 Menu upload; parses. Superseded by A165. |
| A142 (P3)| Bulk images matched 2/2. |
| A165 (P2)| Menu upload parses a 2-row xlsx. |
| A166 (P2)| Bulk price +10% preview exact, cancelled. |

**New:**
- **A187 (P1)** — owner dashboard has no reachable Order History / void. The void
  endpoint (`POST /orders/:id/void`) and `POSOrderHistoryTab` exist but are wired only
  into the Manager dashboard + POS drawer, not the owner surface. A live order
  (`ORD-MTH76LLB-001WV`, KES 790) is stranded as a result.

**Updated (stay OPEN, browser evidence added):**
- A151 — even-split money mechanics CONFIRMED correct (KES 790, 3 legs, one order,
  table freed). By-item not tested (blocked by the A187 void gap).
- A146 — FAIL root cause: `POST /webhooks/:id/test` never writes a `webhook_deliveries`
  row, so test pings don't appear in the Deliveries log.
- A141 — CORRECTION: it *is* built (`BulkIngredientImport` wired into `IngredientsPage`
  behind an "Import CSV" button, `canManage` + specific-branch gated). Agent saw no CTA
  → `canManage` false in that session; re-test needed. Not a missing feature.
- A184 — confirmed NOT-PRESENT (all tills read "SwiftPOS till"). Genuine build work.
- A133 — Slice 1 confirmed (3 sections, defaults); manager view + redirects + Slice 2 pending.
- A143 — 3 of 6 tabs export; no Inventory report tab.
- A144 — create dialogs open/cancel; receive/resend untested (no rows).

**Count change:** A-P1 18→19 (+A187); A-P2 23→17 (−A8,A73,A130,A140,A165,A166);
A-P3 7→6 (−A142). Header Open + Counts updated to match.

## Files
| File | Change |
|---|---|
| `docs/AUDIT-REGISTER.md` | 6 closes, 1 new (A187), 7 updates, header Open + Counts. |
| `docs/MANIFEST-2026-08-31-c.md` | This file. |
| `docs/MANIFEST-2026-08-31-b.md` | Included in case `-b` wasn't committed. |

## Verification (rule 7)
```
node scripts/check-register-consistency.mjs  → OK, header agrees with body, exit 0
node scripts/check-doc-refs.mjs              → OK, every cited doc in tree, exit 0
```
Closes are recorded from the agent's observed figures (see the report); the A146 and
A141 diagnoses were confirmed by source read (`routes/webhooks.ts`, `IngredientsPage.tsx`).

## Ops action (NOT in this zip — real data)
Void `ORD-MTH76LLB-001WV` (KES 790, Main Branch) via a manager POS session → Order
History → Void (`POST /orders/:id/void` reverses stock + flags voided). Close Bill's
open shift (float KES 1,000). No raw SQL.

## Rollback
Before commit: `git restore docs/AUDIT-REGISTER.md && rm docs/MANIFEST-2026-08-31-c.md`
(and the b manifest if you added it). After push: `git revert <sha> && git push origin dev`.

## Before you commit (rule 20)
```
node scripts/check-register-consistency.mjs
node scripts/check-doc-refs.mjs
```
Both green in the sandbox.
