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
