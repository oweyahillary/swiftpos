# Morning report — 3 November 2026

Last night: M-Pesa payment notifications (A621), CI cut from about 11 minutes to about 5, and `dev` brought into
`shared-components`. Nothing is committed or deployed. 1.0.23 was released last night (see section 5).

## 1. M-Pesa payment notifications (A621) — on `dev`, uncommitted

A customer who won't give their number pays the branch's Paybill or Till directly. Safaricom tells the cloud, and the
cashier taps the payment to put it on the bill. Your decisions: always a tap, never matched by amount; part of the
online licence; next release, not 1.0.23. Full write-up: `docs/A621-mpesa-payment-notifications.md`.

**At the POS (desktop and web):**
- A notice when a payment arrives: "KES 1,080 received — JOHN — QJK7XT3L5P". On the desktop it pops up within seconds;
  POSs behind a branch server and the web POS see it in the payment screen, checked every 5 seconds while it is open.
- Under an M-Pesa payment: **Payments received** — the branch's payments of the last 30 minutes not used yet, the exact
  amount first (on a Paybill, a payment whose account number is the bill or table number comes first).
- **Tap → the sale completes and prints by itself,** as the M-Pesa prompt does now. Only payments that match the bill
  are listed (your answer to decision 2).
- Two cashiers tapping the same payment: the first gets it, the second sees "Another POS has just taken that payment."
- Closing the payment screen without a sale gives the payment back. Typing the code by hand still works and also marks
  the payment used.

**Setup:** Settings › Business › Integrations › M-Pesa, under the M-Pesa prompt details, per branch: **Payment
notifications** on, the store number for Buy Goods, **Register with Safaricom**, and in sandbox **Send a test payment**.
**Reports › M-Pesa unmatched** lists the days' payments nobody used.

**Safety:** Safaricom's calls carry a random secret per branch in the address (only its hash is kept); a full phone
number is never stored; one branch per M-Pesa number; registering warns that a bank or accounting system already
receiving the number's notifications stops receiving them.

**Tests:** 43 cloud, 17 desktop, 16 for migration 188; the M-Pesa prompt, payment screen and order tests re-run green.
Two things the full CI caught, fixed: two new dashboard screens formatted money by hand (they now use the shared
formatter), and the desktop's table of cloud routes lacked the new one.

**To keep the desktop POS's main file under its 450 kB budget,** the order detail panel (opened from History) now loads
when opened, as most screens do. Nothing visible changes.

## 2. CI: about 11 minutes → about 5

The server job ran its named steps, every migration test and every `tests/*.test.mjs` one after the other (~10½
minutes). The migration tests (in two halves) and the loop over every test file now run as jobs of their own, at the
same time. Same tests, nothing dropped. The repository is public, so the extra jobs cost nothing.

- `scripts/run-migration-tests.mjs` takes `--shard 1/2` / `--shard 2/2`; its self-test proves the halves are every file,
  once.
- **Not fixed:** the desktop job sometimes waits 5–8 minutes after its last step ("Cleaning up orphan processes") —
  2 of the last 5 runs. Its steps take under 2 minutes; the wait is GitHub's. If it keeps happening I will look for a
  test that leaves a process behind.

## 3. Shared components — `dev` merged into the branch, uncommitted

In `C:\swiftpos\pos-shared`:
- **The merge of `dev` (v1.0.23) is resolved and staged.** Dev's changes to five shared modules are carried into
  `packages/core`; A619's delivery platform prices moved there too (49 modules, no copies). Old-vs-new comparisons:
  offers 22,418, customer screen 33,319, themes 53,408 cases — 0 differ. The desktop main process build matches dev's
  apart from import lines.
- **Step 3, left unstaged:** the shared-code check now runs in the branch's CI. The money field and the cart lines were
  **not** moved: the two POS behave differently there (the web has quick-tender buttons, the desktop split payments;
  the cart lines differ in kitchen marks, add-ons, course picker), so sharing them would change one POS. They join the
  forecourt, fuel keypad and product tile on the list for your decision.
- **A621 reaches the branch with the next merge,** after you commit it on `dev` (a few minutes' work then).

**Full CI on the branch:** see section 6.

## 4. Your decisions

1. **Desktop main file on the branch: 450.4 kB, the budget is 450 kB.** Batch G's category panel (+0.6 kB) causes it;
   the merge adds nothing. Raise the budget to 451 kB, or undo the panel move. I'd raise it. (After A621 reaches the
   branch this goes away: A621 freed 6 kB on `dev` by loading the order detail panel on demand.)
2. **A payment bigger than the bill:** *answered — only payments that match the bill are listed* (more or less: not
   listed; the cashier can type the code by hand). Done: the partial-payment path is gone from both POS.
3. **A payment held by a POS whose sale never reaches the cloud:** *answered — yes.* Done: the owner has a **Release**
   button in Reports › M-Pesa unmatched (owner only; tested).
4. **One design for both POS** before these can be shared: cash entry, cart line, product tile, fuel entry, forecourt,
   and the three windows (note, weight, kitchen void).

## 5. 1.0.23

Released last night: `ZapTill-1.0.23.exe` (64-bit and 32-bit in one installer), a pre-release like the others.
Migrations 179–187 ran on production through the merge workflow, each `ok`. POSs only download it once you approve
1.0.23 per business in the admin portal — B Foods first, then the rest.

## 6. Checks

**`dev` (A621 + the CI split), full local CI:**
- CI steps: 282 run, 7 failed, all known noise on this PC or fixed: no `python3` (schema audit); the migration halves
  (this PC's runner cannot fill in GitHub's `matrix.part` — the migration tests ran in full separately); the offline loop
  and `update-stuck-a541` (the two fixes in section 1, both green now); money reports (the time-zone case); A503 30/30
  and A554 41/41 (the exit crash after passing).
- Per-file run: 325 OK; `format.test` fixed; the rest the exit crash after "N passed, 0 failed".
- Migration tests: 103 of 104 (41–42, the usual case). Doc refs OK. Secret scan of every new and changed file: no leaks.

**`shared-components` (the merge + step 3), full local CI:**
- CI steps: 274 run, 9 failed. **Three are decision 1** — lazy-load-a517, customer-display-a606 and
  customer-details-a607 each fail only their main-file size check (450.4 kB against 450). The other six are the usual
  noise: no `python3`, the migrations `npm install`, the offline loop and A503 / A554 (the exit crash after passing),
  money reports (the time-zone case).
- Per-file run: 324 OK; the other three (petrol web 17/17, report-collected 5/5, void-owner-row 5/5) the exit crash
  after passing.
- Migration tests: 102 of 103 (41–42, the usual case). Doc refs OK. Shared-code check: 49 modules, no copies.

## 7. Your steps

**1. Commit A621 and the CI split on `dev`:**

```bash
cd /c/swiftpos/pos
git add -A .github apps docs migrations scripts shared tests
git status --short
git commit -m "M-Pesa payment notifications (A621, migration 188): a customer pays the branch's Paybill or Till directly, Safaricom tells the cloud (a secret per branch in the address, kept once per M-Pesa code), the POSs are told, and the cashier taps the payment on the M-Pesa leg (Payments received: only payments that match the bill; the first POS to tap gets it; the sale completes and prints; given back if the payment screen closes); Settings > Business > Integrations > M-Pesa: notifications per branch, store number, Register with Safaricom, a sandbox test payment; Reports > M-Pesa unmatched with the owner's Release for a payment a POS still holds; online licence only; the order detail panel loads on demand (desktop main chunk 443.9 kB). CI: the migration tests (two halves) and the offline suites run as jobs of their own beside the server job (about 11 minutes to about 5)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin dev
```

**2. Run migration 188 on dev** (Supabase SQL editor, or psql with options before the address):

```bash
psql.exe -v ON_ERROR_STOP=1 -f migrations/188_mpesa_c2b.sql "$DEV_DB_URL"
```

**3. Try it on dev (sandbox, no real money):** Settings › Business › Integrations › M-Pesa as B Foods → Payment
notifications on for the branch → Register with Safaricom → Send a test payment → it shows on the POS → tap it → the
sale completes and prints. Then try a second POS tapping the same payment, and closing the payment screen.

**4. Commit the shared-components merge, then step 3:**

```bash
cd /c/swiftpos/pos-shared
git commit -m "Merge dev into shared-components (v1.0.23, A611-A620): dev's changes to customerScreen, offers, release, syncTopics and themes carried into packages/core, their app copies deleted; A619 platformPrices moved to packages/core; imports in dev's new and changed files switched to @zaptill/core; dev's new tests read packages/core" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git add -A
git commit -m "Shared components: check-shared-sync runs in CI; step 3 after A619 - the money field / tender keypad and the cart lines left (the two POS differ in behaviour); plan section 8h (merge proof, desktop main chunk 450.4 kB against the 450 kB budget for the owner)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin shared-components
```

**5. Tell me your answers to section 4,** and I'll bring A621 into the branch.
