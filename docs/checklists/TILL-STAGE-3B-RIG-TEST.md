# ZapTill — Till Stage 3b shared tables + manager take-over: two-till rig test

**What this closes:** Till Stage 3b — shared restaurant tables across tills (held orders on the branch node) **and** the v0.4.6 **manager take-over** of an actively-held table. All of it is **built and bench-green** (`branch-tabs-ux` 26/0, `android-till-tabs` 44/0, `node-tabs-claim` 31/0 including the force-claim gate; desktop, android and dashboard type-checks clean). It was held from the floor because the *live cross-till* behaviour — poll lag, a till dropping mid-service, two tills racing for one table, a manager stealing a live lock — is exactly what a bench test cannot prove (rule 16). **This hardware pass turns Stage 3b from BUILT into CLOSED.**

**You need:** a **branch node** (a desktop running as the branch server) on the LAN; **two Shop POS tablets on v0.4.6**, both **joined to that branch** (branch access code), business type **restaurant**; in the roster synced to the node, a **manager** — someone whose role has **Manage tables** (`tables.manage`; the owner's role always qualifies) — **and** a plain **cashier** whose role does **not** (know both PINs); and a way to take **one tablet off the network** (Wi-Fi off) while the node stays on the LAN.

> If a test **FAILS**, stop and send me the exact on-screen message **and** the node log line (Technician then View log) — for example `/node/tabs: MANAGER force-steal ...` or `force-claim: ... refused`. That is a real bug, not a checklist gap (rule 11: errors verbatim). Nothing here needs new code.

## Setup — do this first
1. Node online on the LAN; **both tablets joined** and **synced once** so each has the branch roster and catalogue.
2. On each tablet, confirm the version on the PIN screen reads **ZapTill v0.4.6**.
3. Open the **node's log** (Technician then View log) and leave it visible to watch the `node` / `/node/tabs` lines.
4. Sanity: both tablets show the **same restaurant table grid**.

## Test 1 — See: a table opened on A shows on B
- On **tablet A**: sign in, open a shift, open **Table 5**, add two items.
- Watch **tablet B's** table grid (stay on the grid).
- **Expect:** within **about 5 seconds** Table 5 reads **occupied** on B, labelled **"Held by (A's cashier)"**. Pass / Fail.

## Test 2 — Lock: B cannot edit A's live table (read-only)
- On **B**, tap **Table 5**.
- **Expect:** a **read-only "Held by (name)"** overlay showing A's items and total — no way to add to it or charge it. Pass / Fail.

## Test 3 — Idle auto-takeover (no manager needed)
- Leave **A's Table 5 untouched for more than 90 seconds** (do not tap it). Then on **B**, tap Table 5.
- **Expect:** B **auto-claims** it, opens with the cart, and shows a **"took over an idle table"** toast; no PIN is asked. On A's next action it is dropped to the grid. Pass / Fail.

## Test 4 — Manager take-over of a LIVE table (the v0.4.6 feature)
- On **A**: open **Table 6**, add items, and **keep it live** — tap or edit it within the last 90 seconds so its lease has **not** lapsed.
- On **B**: tap Table 6, then on the read-only overlay tap **Take over**, type the **manager's PIN**, and confirm.
- **Expect, all of these:**
  - B **opens Table 6** with A's cart and a toast **"Took over Table 6 — approved by (manager)"**.
  - **A's screen** shows **"This table was taken over on another POS"** and returns A to the table grid; **A's unsent additions are gone** (B's copy is now the live one).
  - Node log shows **`/node/tabs: MANAGER force-steal — ... approved by (manager)`**.
  - Pass / Fail.

## Test 5 — A wrong PIN is refused (no take-over)
- Set up A holding **Table 6** live again (as in Test 4). On **B**, Take over, type a **wrong PIN**.
- **Expect:** refused, with the message shown **under the field** ("That PIN was not recognised" or similar); **Table 6 stays with A** — A is **not** dropped and can keep editing. Pass / Fail.

## Test 6 — A non-manager is refused (the permission gate)
- A still holding **Table 6** live. On **B**, Take over, type the **plain cashier's** PIN (the role **without** Manage tables).
- **Expect:** refused — **"(name) is not allowed to take over another waiter's table."** Table 6 stays with A. Pass / Fail.

## Test 7 — Rate limit on PIN guessing (optional)
- On **B**, Take over, type a wrong PIN **about 11 times quickly**.
- **Expect:** after about 10 tries, **"Too many PIN attempts — wait a minute and try again."** Pass / Fail.

## Test 8 — Charge and clear remove the shared tab on both
- Take a held table (for example Table 6, now on B) to payment and **charge** it.
- **Expect:** it disappears from **both** grids. Pass / Fail.
- On another held table, **clear or fully void** it.
- **Expect:** gone on both; the node log shows the **clear audit** (who opened, who changed, who cleared). Pass / Fail.

## Test 9 — Never blocks a sale (offline fallback)
- Turn **tablet B's Wi-Fi off** (the node stays on the LAN). On B, tap a table and ring a sale.
- **Expect:** B falls back to its **own local tables**, selling continues, **no crash**. Turn Wi-Fi back on and B re-syncs — the shared grid returns. Pass / Fail.

## Regression sanity — the important negatives
- A **server-less** tablet (not joined to any branch) and the **browser** POS behave **exactly as before** — no shared-tables overlay, no "Held by", no Take-over button. Pass / Fail.
- A **non-restaurant** business (for example retail or minimart) on a joined tablet shows **no** shared-table behaviour at all. Pass / Fail.
- **Two tills never both hold one table:** have A and B tap the **same free table** at nearly the same instant — **exactly one** gets it, the other sees "Held by ...". No double-open, no double-charge. Pass / Fail.

## Copy this back to close Stage 3b
Fill in the result and a note for each; build tested is **v0.4.6**.

| # | Check | Result | Note |
|---|---|---|---|
| T1 | See: table on A shows occupied / "Held by" on B (about 5 s) | PASS / FAIL | |
| T2 | Lock: B gets read-only "Held by", cannot edit | PASS / FAIL | |
| T3 | Idle over 90 s auto-takeover, no PIN, "idle" toast | PASS / FAIL | |
| T4 | Manager take-over of a LIVE table, holder dropped, node log | PASS / FAIL | |
| T5 | Wrong PIN refused, table stays with the holder | PASS / FAIL | |
| T6 | Non-manager (no `tables.manage`) refused | PASS / FAIL | |
| T7 | Rate limit after about 10 PIN tries (optional) | PASS / FAIL | |
| T8 | Charge and clear remove the tab on both, clear audited | PASS / FAIL | |
| T9 | B offline falls back to local, no crash, re-syncs | PASS / FAIL | |
| REG1 | Server-less / browser / non-restaurant unchanged | PASS / FAIL | |
| REG2 | Never two holders on one table (no double-charge) | PASS / FAIL | |

**Scope note (by design, not a gap):** only **restaurant tables** are shared in v1 — parked **retail, petrol pump and parking bay** orders stay local to the till that opened them (owner decision). Once every test above passes, Stage 3b is **CLOSED** and clear for the floor.
