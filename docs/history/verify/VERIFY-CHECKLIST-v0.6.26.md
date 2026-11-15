# SwiftPOS v0.6.26 — rollout verification checklist

Interactive copy: `docs/checklists/VERIFY-CHECKLIST-v0.6.26.html`. 0.6.26: a void or refund made on the **web** of a sale the
**till** rang now reaches that till — its History, shift figures, Z-report and day close (A336 follow-up). It contains 0.6.25.
**Record** = send a screenshot/photo. A **Fail** needs a note.

You need a cashier PIN on T1, and an owner or manager signed in on the web dashboard. **Keep T1's shift open for all of §X.**

## §R — Rollout
Cloud first (it sends the reversals), then 0.6.26 on the till. No dashboard change.

### R0 — Cloud deployed from dev
1. Deploy the cloud.

**Expected:** The web POS and T1 sign in as before.

### R1 — The tag comes out as ONE pre-release · **Record**
1. Tag v0.6.26 → Actions → Release desktop green → Releases.

**Expected:** One v0.6.26 pre-release with latest.yml and the installer; v0.6.16 stays Latest.

### R2 — Approve B Foods for 0.6.26
1. Admin portal → B Foods → 0.6.26 → Approve; restart T1, close and reopen when the update is ready.

**Expected:** T1 reads 0.6.26.

## §X — A web void or refund of a till sale reaches the till — A336
Ring the sales on T1 (cash), wait for them to sync (about a minute), then reverse them on the web dashboard → Orders.

### X1 — A web refund of a till sale · **Record**
1. On T1 note the shift's expected cash, then ring a cash sale (e.g. 500).
2. Web dashboard → Orders → that sale → Refund (full), with the manager PIN.
3. Wait about 30 seconds on T1 (or press Sync).

**Expected:** T1's History shows the sale as refunded; the shift's expected cash is back where it was before the sale; the
Z-report shows the refund once.

### X2 — A web void of a till sale · **Record**
1. On T1 ring another cash sale (e.g. 300); wait for it to sync.
2. Web dashboard → Orders → that sale → Void (within the void window).
3. Wait about 30 seconds on T1.

**Expected:** T1's History shows it voided; the shift's sales count and expected cash drop it.

### X3 — A refund done on the till is counted once
1. On T1 refund a till sale from History.
2. Wait a minute (two web-sales pulls); look at the shift's expected cash.

**Expected:** The refund comes off once — the web copy of it changes nothing on T1.

### X4 — Web-rung sales unchanged
1. On the web POS (as T1) ring a sale; refund it on the web.
2. Look at T1 after about 30 seconds.

**Expected:** As on 0.6.25: the sale shows on T1 tagged "web", then refunded — counted once.

### X5 — The totals agree · **Record**
1. End the shift on T1 as usual.
2. Web dashboard → Shift Reports → that shift.

**Expected:** The till's expected cash and the web's agree (no gap from the web reversals).
