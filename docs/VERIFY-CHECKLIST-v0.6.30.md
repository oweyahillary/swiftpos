# SwiftPOS v0.6.30 — rollout verification checklist

Interactive copy: `docs/checklists/VERIFY-CHECKLIST-v0.6.30.html`. 0.6.30 (A336 stage 3): the owner sets the void window
(default 30 minutes) and, for a till that is offline, which payment methods it may refund (default cash) and whether it may also
reverse web sales; the till voids and refunds offline with a manager's PIN and sends it to the cloud when it reconnects.
**Record** = send a screenshot/photo. A **Fail** needs a note.

## §R — Rollout
Cloud and dashboard first (no migration in this release), then the till.

### R0 — Deploy the cloud, the dashboard and the admin portal · **Record**
1. Deploy all three from dev; hard-refresh.
2. Dashboard sidebar: the release line.

**Expected:** “SwiftPOS v0.6.30 · <commit>” and “cloud v0.6.30 · <commit>”, not amber.

### R1 — Tag v0.6.30, approve B Foods
1. Tag v0.6.30 → Release desktop green.
2. Admin portal → B Foods → 0.6.30 → Approve; T1 updates.

**Expected:** T1 reads 0.6.30 (top-left).

## §W — The owner's rules (web and till) — A336
Only the owner changes them; everyone on the manager screen can read them.

### W1 — Web: Settings › Business › Voids & refunds · **Record**
1. Dashboard (Eugene) → Settings → Business → Voids & refunds.

**Expected:** Void window 30 minutes; Cash ticked (M-Pesa, Card, Credit and any custom method unticked); “Offline: also web sales” off.

### W2 — Change the window on the web
1. Set the void window to 10, press Enter.
2. Reload the page.

**Expected:** “Saved”; after reload it still reads 10 (“10 minutes now”). 0 or 2000 is refused with a message.

### W3 — Till: Manager → Settings as Eugene · **Record**
1. Sign in on T1 as Eugene → Manager → Settings.
2. Look at “Voids & refunds”. Change the window to 15.

**Expected:** Same three rules as the web (10 minutes, Cash, web sales off) — editable; after the change the web page shows 15 on reload.

### W4 — Till: Manager → Settings as a manager
1. Sign in on T1 as a manager → Manager → Settings.

**Expected:** “Voids & refunds” visible but greyed: “Only the owner can change these rules.”

## §V — The window, online — A336
Window = 15 from W3. Use a cash sale.

### V1 — History follows the window · **Record**
1. Ring a cash sale; wait 16 minutes (or use an older sale from today).
2. As a manager: POS → History.

**Expected:** The heading says “void within 15 minutes”; the sale older than 15 min offers only “Refund”; a newer one “Void / Refund”.

### V2 — The cloud refuses a late void
1. Open “Void / Refund” on a sale just under 15 min old; wait until it passes 15; Confirm Void with a manager PIN.

**Expected:** Refused: “… only be voided within 15 minutes of the sale — refund it instead”; the window switches to Refund.

### V3 — Put it back
1. Web or till as Eugene: set the window to 30.

**Expected:** History says “void within 30 minutes”.

## §O — Offline void and refund (T1 network unplugged) — A336
Ring three sales first while online: two cash, one M-Pesa. Let them sync (no pending). Then unplug T1's network. Sign in as a manager.

### O1 — Offline void, within the window · **Record**
1. History → a cash sale → Void / Refund → reason → manager PIN → Confirm Void.

**Expected:** “Voided on this till while offline — approved by <manager>. It goes to the cloud as soon as the till reconnects.” → Done; History shows Voided; the sync badge shows 1 pending.

### O2 — Offline refund, cash · **Record**
1. The other cash sale → Refund → reason → manager PIN.

**Expected:** Same message; History shows Refunded; Shift panel: expected cash is lower by the sale.

### O3 — Offline refund, M-Pesa — not allowed · **Record**
1. The M-Pesa sale → Refund → reason → manager PIN.

**Expected:** Refused: “Offline, this till can refund only cash. This sale was paid by M-Pesa — refund it when the till is back online.” Nothing changes.

### O4 — A cashier's PIN does not approve
1. Any sale → Void / Refund → enter Test Cashier's PIN.

**Expected:** “That PIN was not recognised. Enter the PIN of a manager (or the owner) on duty.”

### O5 — Reconnect — it reaches the cloud · **Record**
1. Plug T1 back in; wait ~1 minute.
2. Dashboard → Orders: find the two sales.

**Expected:** The void shows Voided and the refund a refund, approved by the manager; the till's sync badge is clear (nothing pending, nothing parked).

### O6 — The owner allows M-Pesa offline (optional)
1. Web: tick M-Pesa. Wait ~1 min so T1 hears it, then unplug again.
2. Refund the M-Pesa sale offline.

**Expected:** Allowed this time; reaches the cloud on reconnect. Untick M-Pesa afterwards.
