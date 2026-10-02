# MANIFEST 2026-09-09-f — live print session: 16 items CLOSED on the dev till

**Base:** `origin/dev` @ `61c4eef`. **Register only — NO code change.** Records the owner's live
verification session on the dev flavour (SwiftPOS Dev 0.5.39) with a real thermal printer.

## What was verified (on the till, by the owner)
The full print-parity sweep and the P1 split-bill were exercised on real hardware and passed.
Sixteen FIX BUILT items → CLOSED:

### P1 (4)
- **A242** — kitchen ticket (KOT) prints on the thermal printer (v4 bridge contract).
- **A254** — paper cuts, has a bottom margin, and the master KOT prints as a kitchen copy.
- **A268** — no double printing: kitchen fires once on Send, receipt once on Charge.
- **A151** — by-item split bill collects the exact order total (no under-collection).

### P2 (9)
- **A244** — "Send test receipt" and station test buttons reach the printer.
- **A248 / A252 / A250** — combo components route to the right station (food→kitchen,
  drink→bar) and kitchen exclusions drop drinks from the kitchen ticket.
- **A246 / A255 / A269** — Print Bill prints silently as a marked proforma (no fiscal
  number, no drawer); the payment receipt carries branch + owner header/footer + credit +
  a real Bill No. and opens the drawer once.
- **A253** — send-vs-pay timing: kitchen/dispatch on Send, receipt on Charge.
- **A231** — end-of-day Z report prints and matches the on-screen totals.

### P3 (3)
- **A247** — Print-Bill station order is kitchen → customer → dispatcher.
- **A232** — printed documents carry the company logo.
- **A233** — the stock-take count sheet prints and is usable.

## Register changes
| Change | Detail |
|---|---|
| 16 headings | FIX BUILT → **CLOSED 2026-09-09** with a verified-on-till note |
| Counts | A-P1 23→19, A-P2 38→29, A-P3 20→17; the 16 IDs removed from the Counts row |
| Changelog | 2026-09-09 (f) line |

## Files
| File | Change |
|---|---|
| `docs/AUDIT-REGISTER.md` | 16 items CLOSED + counts + changelog |
| `docs/MANIFEST-2026-09-09-f.md` | this record |

## What ran (rule 7)
```
check-register-consistency   OK — header re-derived from the body agrees (A-P1 19 / A-P2 29 / A-P3 17)
check-doc-refs               OK — every cited document present
```
Verification itself was the owner's live print session on SwiftPOS Dev 0.5.39 (rule 16 satisfied
on hardware). No code changed in this delivery.

## What's still open on the print/POS side
Nothing from the thermal-print sweep remains. The remaining desktop opens are unrelated: D1
(P0 two-business login), D9/D10 (P3), D18 (P2), and the offline/sync cluster (A19/A20/A24/
A160–A164/A129/A179/A168) which needs the two-till LAN session.

## Apply
```
git pull origin dev
# extract this zip over the repo root, then:
node scripts/check-register-consistency.mjs && node scripts/check-doc-refs.mjs
git add docs/AUDIT-REGISTER.md docs/MANIFEST-2026-09-09-f.md
git commit -m "Live print session: close 16 print-parity + split-bill items verified on the dev till"
git push origin dev
```
Rollback: revert this commit — register only.
