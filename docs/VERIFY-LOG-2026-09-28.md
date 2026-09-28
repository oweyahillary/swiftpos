# Verification log — 2026-09-28 (v0.6.16: A348 update approval, A349 money review, A345/A346 carried, A347 icon)

Till **T1** on desktop **0.6.16**; migration 108 on prod; cloud and admin portal deployed from `dev` `f9e7fe6`; v0.6.16 the
Latest GitHub release (one copy, latest.yml + installer). Tester Eugene. Checklist `docs/checklists/VERIFY-CHECKLIST-v0.6.16.html`.
Results as returned:

```
R1 PASS · R2 PASS · R3 PASS · R4 PASS · R5 PASS
U1 FAIL — till updated automatic to version 16 · U2 SKIP · U3 SKIP · U4 SKIP · U5 PASS
M1 SKIP · M2 SKIP · M3 SKIP · M4 SKIP · M5 SKIP · M6 PASS · M7 SKIP · M8 SKIP
N1 PASS · N2 PASS · N3 PASS
O1 PASS · O2 PASS · O3 PASS · O4 PASS · O5 PASS · O6 PASS · O7 PASS · O8 PASS
K4 PASS · F5 PASS · X5 SKIP
X1 SKIP · X2 SKIP · X3 SKIP · X4 SKIP
Summary: 20 pass / 1 fail / 15 skip / 0 not run (of 36) · Failed: U1 (Every client starts HELD) — till updated automatic to version 16
```

Owner: "i skipped most receipt test since i do not have a printer at the moment".

**Closed:** A345 (O1–O8, manager signed in offline), A346 (N1–N3, Stock only with the web POS), A347 (U5, teal icon),
A342 (K4 — every K check now passed), A335 (F5 — void and refund of a till sale from the till).

**U1 — read, not a defect.** The note describes the till going 0.6.15 → 0.6.16 on its own. That is R4 as designed: a 0.6.15 till
follows GitHub's latest normal release, and 0.6.16 was published as one precisely so every till picks up the approval check
(manifest 2026-09-28-n, rollout step 3 — "Old tills update to it on their next close"). The hold starts WITH 0.6.16: from here a
tagged build is a pre-release and a 0.6.16 till asks the cloud instead. U1 itself (admin portal → a client → Desktop updates reads
**Held**) was not looked at; it and U2–U4 are still to run. The real test of the hold is U4 on the next tag.

**Still open:**
- A348 — U1–U3 (admin portal), U4 (the next tag reaches no till until approved).
- A349 — M1, M2, M7, M8 need a printer; M3 (Overview VAT/CTL), M4 (refund taken off everywhere), M5 (Z-report on screen) do not.
- A350 — the next tag must come out as ONE pre-release (release workflow's "Verify the release" step).
- X1–X4 regression and X5 (second till) not run this round.

## Checklist v0.6.17 on target (tester Eugene, T1 0.6.16 → 0.6.17 through the approval)
Results as returned, over several messages (`docs/checklists/VERIFY-CHECKLIST-v0.6.17.html`):

```
R1 PASS (one pre-release, verified on GitHub) · R2 FAIL → corrected (v0.6.17 had been unticked to a normal Latest release;
  re-ticked the same day; harmless — every till was already on 0.6.16, which asks the cloud)
U1 PASS (Held; list showed 0.6.17 after GITHUB_RELEASES_TOKEN was set — first read was "GitHub releases: HTTP 403")
U2 PASS (held: the till stayed on 0.6.16) · U3 PASS (desktop_update.approve in the audit log)
U4 PASS (the till updated to 0.6.17) · U5 PASS (desktop_update.hold; the till stayed on 0.6.17)
G1 PASS · G2 PASS · G3 PASS · G4 PASS · G5 PASS · G6 PASS · G7 PASS (screenshots: the grouped sidebar, Sales tabs, Settings tabs)
M3 PASS · M4 SKIP ("i cant find where a manager refunds" → A355) · M5 PASS · M1 M2 M7 M8 SKIP (no printer)
X1 PASS · X2 PASS ("works fully no item is skipped or missed") · X3 PASS · X4 PASS · X5 SKIP
```

**Closed:** A348 (U1–U5 — the per-client hold end to end), A351 (G1–G7). A350: R1 here + R3 on v0.6.18 (below) — closed.
**Found:** A355 (M4: no refund after 30 minutes; the approval wanted a second PIN), A356 (the portal's "HTTP 403"), A357 (VAT twice).

## Checklist v0.6.18 on target (tester Eugene, T1 0.6.18, web POS, admin portal)
Results as returned (`docs/checklists/VERIFY-CHECKLIST-v0.6.18.html`), with nine screenshots:

```
R1 PASS · R2 PASS · R3 PASS (one pre-release; v0.6.16 stays Latest — verified) · R4 PASS
V1 FAIL — "The cashier should be able to see their orders currently history is not available on the cashiers window"
V2 PASS · V3 PASS (a 1h-old sale refunded; "refunded" tag) · V4 PASS
V5 FAIL — "no refund option in orders or order history" (the WEB POS / dashboard lists; the till's History did offer
  Refund on the web-tagged sales — screenshot)
V6 SKIP
K1 PASS (till: no soda on the kitchen ticket) — "but sauces still print in kitchen printer"
K2 FAIL → PASS by configuration: "I had to add a kitchen printer i selected categories to be printed and it worked"
K3 SKIP
F1 PASS · F2 PASS (screenshots)
E1 FAIL — "Desktop app does not have the add type field" (looked on the manager's Expenses page) · E2 SKIP · E3 SKIP
M1 PASS (VAT in the box only; the strip shows CTL KES 146.26) · M2 PASS
A1 PASS · A2 SKIP
X1 PASS · X2 PASS · X3 PASS · X4 PASS · X5 SKIP
```

**Closed:** A276 (drinks off the kitchen ticket — K1 on the till; K2 once the web had a Kitchen station), A279 (F1, F2),
A356 (A1), A357 (M1).
**Read and fixed (delivery 2026-09-28-v, desktop 0.6.19):**
- V1 — my 0.6.18 bug: the History BUTTON was gated with the reversal buttons. Owner: cashiers see **all** orders → A358.
- V5 — the web never had refunds on the manager's lists (POSOrderHistoryTab). Owner: "yes add web refund" → A359.
- K1 sauces — by design in 0.6.18 (a dish named after its sauce must stay); B Foods sells sauces as items in a "Sauces"
  category. Owner: "sauce rule ok" (a name that IS a sauce/dip leaves the kitchen) → A358.
- E1 — "+ Add type" lived in POS → Shift → Expenses only. Owner: "add it here under expense but leave it under shifts
  also" → A358 (and shown to manager roles, the cloud still deciding).
- K2 — the web's kitchen printer was a whole-order type; a Kitchen station with categories fixed it (no code).
**Still open:** A349 (M1, M2, M7, M8 — printed receipts with a discount / tip / web CTL / no CTL), A355 (V1 → 0.6.19),
A336 (stage 3, offline reversals), A341 (E1 → 0.6.19).

## Checklist v0.6.19 on target (tester Eugene, T1 0.6.19, web POS, printer)
Results as returned (`docs/checklists/VERIFY-CHECKLIST-v0.6.19.html`), with five screenshots (the till's History as a manager —
"Void / Refund" / "Refund" on every completed sale, web-tagged ones included, "refunded" on T1--46; a web-POS refund
"Refunded KES 2,500.00 — hand it back in the tender it came in." with the −2,500 cash leg and the "refunded" tag; the
Expenses page: "Expense types" with "+ Add type", "\"Transport\" is already an expense type.", "Expense type \"Sugar\" added"):

```
R1 PASS · R2 PASS (one pre-release — verified) · R3 PASS
H1 PASS · H2 PASS · H3 PASS
W1 PASS · W2 PASS · W3 PASS · W4 PASS · W5 PASS
K1 PASS · K2 PASS · K3 PASS
E1 PASS · E2 PASS · E3 PASS · E4 PASS
P1 PASS · P2 PASS · P3 PASS · P4 PASS
X1 PASS · X2 PASS · X3 PASS · X4 PASS · X5 SKIP
Summary: 26 pass / 0 fail / 1 skip (of 27) · Failed: none
```

**Closed:** A355 (refunds from History, the manager's own PIN — V2–V4 on 0.6.18 + H1–H3), A358 (H1–H3, K1–K3, E1–E4), A359
(W1–W5), A341 (E1–E4 — expense types from the till), A349 (P1–P4 — the printed receipts: discount, tip, web CTL, no CTL — the
last open part of the 0.6.16 money review).
**Still open:** A336 — stage 2 verified (the till's History reversing web sales, H2 + 0.6.18 V5 screenshot; the web lists,
W1–W5); stage 3 (offline void/refund queued on the till) not built. X5 (a second till) not run this round.
