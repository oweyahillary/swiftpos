# Verification log — 2026-09-27 (v0.6.9: A273 follow-up, A334, A332 on target)

Till **T1** on desktop **0.6.9**; cloud and dashboard deployed from `dev` `7d786f0`; web POS in a browser. Checklist as sent
(A–E). Results as returned by the owner:

```
A1 - pass A2 -Pass b1 to b4 pass d1 - d4 pass c1-c5 pass b5 -b7 not correct
```

| # | Check | Result |
|---|---|---|
| A1 | Web picker shows "T1 — <setup name>", not "SwiftPOS till" | **PASS** |
| A2 | Devices ✎ tooltip: a till's own name replaces a rename at its next sign-in | **PASS** |
| B1 | Web POS, Cashier A opens a shift on T1 with a float | **PASS** |
| B2 | Till, Cashier A → straight to selling, no prompt | **PASS** |
| B3 | Till, Cashier B → "T1 — … is already open — opened by Cashier A …" → Continue, no second drawer | **PASS** |
| B4 | One cash sale on the web, one on the till | **PASS** |
| B5 | Till shift panel: expected = float + till sale + web sale | **FAIL** — see below |
| B6 | Close on the till balances at that figure | **FAIL** (follows B5) |
| B7 | Dashboard shows the shift closed at the same expected cash, one drawer for T1 | **FAIL** (follows B5) |
| C1–C5 | Desktop opens first; web joins (no float); a web sale is in the till's close | **PASS** |
| D1–D4 | Web POS light mode: hover, white labels, themed focus ring, red Delete | **PASS** |
| D5, E1–E3 | Theme on/off screenshots; back office light mode; sign-in page; dark mode unchanged | not reported |

## B5–B7 — what the owner saw, and the cause

Owner's screenshots (till orders, till shift panel, cockpit, cloud orders, reports): float **3,000**, a till sale **1,490**, a web
sale **230** on the same drawer. The till's shift panel showed expected cash **6,210**; the right figure is 3,000 + 1,490 + 230 =
**4,720**. The difference (1,490) is the till's own sale counted a second time as "the web's".

**Cause (reproduced on the bench, then fixed):** the cloud gives every order its own id and keeps the till's local id as
`idempotency_key` (`routes/orders.ts`, `X-Idempotency-Key`). The till tells `POST /api/shifts/:id/foreign-cash` the order ids it
holds — its LOCAL ids — and the rule matched them against the cloud ids only, so none matched and every till sale was counted as
foreign. `tests/foreign-cash.test.mjs` had assumed the ids were equal (rule 24: the test mirrored the bug). C5 passed because no
sale was rung on the till in section C — only a till sale can be counted twice.

**Fixed in delivery 2026-09-27-d:** the rule also matches `idempotency_key` (the route fetches it); the owner's case is now a
test (3,000 + 1,490 + 230 = 4,720), and the id-only mutation reddens it. With the same delivery the web's sales are downloaded onto
the till (cross-sync stage 1, A336), so they show in the till's orders and shift panel as well as in its cash.

**Owner also asked:** syncing "instant like 30sec not a minute" — in the same delivery shift changes push at once and the backstop
is 30 s (was 60 s).

**Closed:** none yet — A273 follow-up and A334 close after B5–B7 pass on 0.6.10; A332 closes after D5.

## Rollout 2026-09-27 — migration 107 on prod (A338)
Owner ran migration 107 and pasted the `pg_indexes` result for `shifts`:

```
| shifts_open_by_terminal | CREATE INDEX shifts_open_by_terminal ON public.shifts USING btree (business_id, shift_terminal_key(device_id, terminal_code, branch_id)) WHERE (status = 'open'::text) |
```

**R1: PASS** — the plain index is in, `shifts_one_open_per_terminal` (unique) is gone. (Not via the "DB migrate (production)"
workflow — its last run is #4 on 2026-09-02; applied by hand.) The remaining rollout checks and every open item are in
`docs/checklists/VERIFY-CHECKLIST-v0.6.13.html`.

## Checklist v0.6.13 on target (tester Max, T1 on 0.6.13) — 31 pass / 0 fail / 8 skip
Results as returned (`docs/checklists/VERIFY-CHECKLIST-v0.6.13.html`):

```
R1 PASS · R2 PASS · R3 PASS · R4 PASS
H1 PASS — pending is zero · H2 PASS · H3 PASS · H4 PASS
J1 SKIP · J2 PASS · J3 PASS · J4 PASS
B1 PASS · B2 PASS · B3 SKIP · B4 PASS · B5 PASS · B6 SKIP · B7 PASS
F1 PASS · F2 PASS · F3 SKIP · F4 SKIP · F5 SKIP · F6 SKIP
G1 PASS · G2 PASS · G3 PASS · G4 PASS · G5 PASS
D5 PASS · E1 PASS · E2 PASS · E3 PASS
X1 PASS · X2 PASS · X3 PASS · X4 PASS · X5 SKIP
Summary: 31 pass / 0 fail / 8 skip / 0 not run (of 39) · Failed: none
```

**Closed:** A338 (sync never blocked), A340 (managers cannot make owners), A337 (reports), A332 + A333 (light mode).
**B5 PASS** — the double count reported on 0.6.9 (6,210 for 4,720) is fixed on target.
**Still open, for their skipped checks:** A339 (J1 offline manager), A334 (B3, B6), A336 (F3, F4, F6), A335 (F5).
Owner's follow-ups the same day → NEW A342 (closing on the till closes the web's drawer), A343 (a cashier's own web shift), A344
(payment method colours).

## Checklist v0.6.14 on target (tester Eugene, T1 on 0.6.14) — 24 pass / 0 fail / 5 skip
Results as returned (`docs/checklists/VERIFY-CHECKLIST-v0.6.14.html`):

```
R1 PASS · R2 PASS · R3 PASS
K1 PASS · K2 PASS · K3 PASS · K4 SKIP
L1 PASS · L2 PASS · L3 PASS · L4 PASS · L5 PASS · L6 PASS
M1 PASS · M2 PASS · M3 PASS · M4 PASS
J1 PASS · B3 PASS · B6 PASS · F3 PASS · F4 PASS · F5 SKIP · F6 PASS · X5 SKIP
X1 SKIP · X2 SKIP · X3 PASS · X4 PASS
Summary: 24 pass / 0 fail / 5 skip / 0 not run (of 29) · Failed: none
```

**Closed:** A343 (web till, L1–L6), A344 (payment colours, M1–M4), A339 (offline manager reaches the manager screen, J1),
A334 (B3 + B6 — every B check now passed on target).
**Still open:** A342 (K1–K3 PASS; K4 — a web close never closes the till's shift — not yet run), A336 (stage 1 fully verified:
F1–F4, F6; stages 2–3 not built), A335 (F5). X1/X2 (normal sale, kitchen ticket) and X5 (second till) not run this round.

**Owner's note with the results (three screenshots, manager signed in OFFLINE on T1 0.6.14):** "we can sell this as an option
fully offline till, thats why the manager has to log in confirm this is true full offline once registered". Screens: Staff and
Menu show "This till is not signed in. Ask a manager to sign in." (Menu: "0 of 0 items"); Settings → Payment methods says it
cannot reach the cloud and shows the till's active methods. Read in the code → **NEW A345** (see the register). Selling, shifts,
expenses, orders, reports and day close run from the till's own database and work offline; the lists the cloud owns (menu, staff,
payment methods, stations, receipt text) are edited on the cloud only, and the offline sign-in's message about them is wrong.
