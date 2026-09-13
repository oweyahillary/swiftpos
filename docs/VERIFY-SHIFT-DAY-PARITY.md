# Target verification — shift/day web parity (A273 · A274 · A275)

Everything in this cluster was built and guarded on the bench, but nothing is
CLOSED until it passes on the target (rule 16). This is the floor checklist:
concrete steps and a clear **PASS** line for each. Tick every box, note anything
that fails, and only then move the finding from FIX BUILT to CLOSED in the
register with the evidence.

**Environment reminder:** the real target is Windows / Node 20 / better-sqlite3
under Electron for the till; the cloud is the deployed server; the web POS is a
browser. A green on Linux/bench is a weaker claim than a green here.

Legend: **[UI]** = check on screen · **[DB]** = quick query · **[CI]** = pipeline.

---

## 0. Pre-flight (before touching a till)

- [ ] **[CI] server typecheck** — run the typecheck ratchet. **PASS:** no new errors above baseline.
- [ ] **[CI] dashboard typecheck** — the dashboard build is esbuild-only (no type-check in build, the A265 class), so run `tsc` explicitly. **PASS:** clean, or no new errors above baseline.
- [ ] **[CI] migration tests** — `run-migration-tests` including `test-migration-102`. **PASS:** all green.
- [ ] **[cloud] apply migration 102** — deploy so `day_close_instructions` exists. **PASS:** `\d public.day_close_instructions` shows the table and the `day_close_instructions_one_pending` partial unique index.
- [ ] Have at least one **enrolled, approved, non-retired till** in the test branch, and note its `device_id` and `terminal_code` for the checks below.

---

## 1. A274 — web shift hard-gate (no `shift_id:null` sale)

- [ ] **[UI]** Open the web POS with **no shift open**. **PASS:** Charge is disabled and shows "Open a shift to start selling."; Send-to-Kitchen and Room-charge are also disabled/blocked.
- [ ] **[UI]** Force a `/api/shifts/current` failure (e.g. drop the network briefly, then load the cashier screen). **PASS:** the screen prompts to open a shift — it does **not** land on a sellable screen; no sale can be rung.
- [ ] **[UI]** Open a shift, ring one sale. **PASS:** Charge works and completes.
- [ ] **[DB]** Inspect that order. **PASS:** `orders.shift_id` is **not null** and points to the open shift.
- [ ] **[DB]** Search recent web orders. **PASS:** none have `shift_id = null` created after this build.

---

## 2. A273 — web covers a chosen till (Option B)

- [ ] **[UI]** On web shift-open, the **"Which till are you covering?"** picker appears and lists the branch's enrolled tills (terminal_code / label). **PASS:** the test till is in the list.
- [ ] **[UI]** Pick the test till, open a shift. **[DB]** **PASS:** the new `shifts` row has `device_id` = the **till's** `device_id` (not empty, not `web:<branch>`).
- [ ] **[DB]** **PASS:** `GET /api/shifts/current` from that web session returns that shift (resolves by the till's key).
- [ ] **Two-surface fold-in:** open a drawer **on the physical till**, then open the web POS **covering that same till**. **PASS:** the web does **not** create a second drawer — it folds into the till's open shift (one-open-per-terminal); the web shows the same shift.
- [ ] **[UI/DB]** Ring a sale on the web while covering the till. **PASS:** the sale lands on the **till's** drawer/day; `orders.device_id` (if recorded) = the till's device_id; the till's shift/day totals include it.
- [ ] **Behaviour change to confirm (owner):** in a branch with **no enrolled till**, try to open a web shift. **PASS (expected):** you cannot — the picker is empty and open is blocked with the "no tills enrolled" hint. ⚠️ If you actually need web-only selling with no till, this is the point to ask for the generic-web-register fallback instead.
- [ ] **[UI]** Close the web shift. **PASS:** the next web shift-open makes you pick a till again (covered identity cleared on close).
- [ ] **Offline path (important):** with the **till powered off**, open the web POS covering that till, ring a sale, then bring the till back online and let it sync. **PASS:** no duplicate/second open drawer appears; the day/drawer reconciles as one; the till's totals absorb the web sale without conflict. *(This is the riskiest path — watch the till's shifts/business_days after it re-syncs.)*

---

## 3. A275 — remote day close (Option i-A)

- [ ] **[UI]** As a manager on the web (with `shifts.force_close` or `settings.manage`), open **Manager → Shifts → Remote day close**. **PASS:** tills with an **open** trading day are listed with their date.
- [ ] **[UI]** Queue a close for the test till: enter the counted cash (the amount the cashier counted at the till) and confirm. **PASS:** the row shows "Queued — waiting for the till to sync".
- [ ] **Let the till run one cloud sync.** **PASS:** the row advances to "Delivered", then "Closed — variance N".
- [ ] **[DB on the till]** **PASS:** the till's local `business_days` row for that date is `closed`, with `expected_cash` and `cash_variance` **computed by the till** (consistent with its own shifts), and `counted` = the amount the manager entered. The **cloud did not write the close** — it arrived via the till's push after the local close.
- [ ] **Date-mismatch refusal:** queue a close whose `business_date` does **not** match the till's open day (e.g. clocks disagree). **PASS:** the till **refuses**; the row shows a failed ack naming the mismatch; the day stays **open** (no wrong-day close).
- [ ] **Idempotency:** queue a close, let the till close it, then cause the ack to be re-offered (e.g. interrupt connectivity right after the local close). **PASS:** on the next sync the till acks **success** without double-closing; the day is closed exactly once.
- [ ] **One-pending-per-till-per-day:** queue two closes for the same till+day (different amounts) before the till syncs. **PASS:** only the **latest** is live; the till executes one count, not two.
- [ ] **No-count safety:** confirm there is no path that closes a day on estimated cash. **PASS:** every close carries a real counted amount; an uncounted day stays open.

---

## Sign-off

| Finding | Verified by | Date | Result | Notes / evidence |
|---|---|---|---|---|
| A274 | | | pass / fail | |
| A273 | | | pass / fail | |
| A275 | | | pass / fail | |

When a finding passes, move it to CLOSED in `docs/AUDIT-REGISTER.md` with a one-line
note of what ran and what it showed (rule 7/16). If any box fails, leave the finding
FIX BUILT and record the exact failure — a failing floor check is the signal, not a
nuisance.
