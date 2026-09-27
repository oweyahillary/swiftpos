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
