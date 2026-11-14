# ZapTill for Android — changelog

The version shows on the PIN screen (`ZapTill v<x.y.z>`) and in the APK filename (`ZapTill-<x.y.z>-debug.apk`). It is set
in one place — `apps/android/package.json` `version` — and bumped per build the owner tests, so one install is never
mistaken for the next. Newest first.

## 0.4.5 — Till stage 3b (shared tables wired into the selling screen)
**Shared tables are now live on the restaurant POS (when a branch server is joined):**
- The **table grid shows every till's open tables**, not just this one's — a table held on another till reads **occupied**,
  refreshed every ~5 s while you're on the grid.
- Opening a **free** table registers it on the branch and takes its lock; your edits **renew the 90 s lease** (with a ~60 s
  heartbeat so an open-but-idle table isn't lost), and leaving it (**← Tables**) releases the lock for the next till.
- Tapping a table **held on another till** opens a **read-only browse** of its order with **"Held by &lt;name&gt;"**. A table
  left **idle > 90 s frees itself**, so you can then open it normally.
- **Charge** removes the shared tab; **clear / full void** removes it with an audit.
- **Never blocks a sale:** any branch-server hiccup falls back to this till's own local tables.
- **Unchanged** on the browser, a server-less tablet, or a non-restaurant POS (the shared-tabs host is null there).
- **Flagged follow-up:** a *manager-approved take-over of an actively-held* table (a force-steal) is **not** in this build —
  it needs the node to verify the manager PIN (it trusts the caller today) and a decision on which permission authorises it.
  The idle-auto-takeover above covers an abandoned table without a manager. See `docs/BUILD-TILL-STAGE-3B-CLIENT.md`.

## 0.4.4 — Till stage 3b (shared held orders: the POS client + bridge)
**Branch server (Stage 3b, client foundation):**
- When this POS has **joined a branch server**, it can now talk to the branch's **shared held-order store** — a tab (held
  order) opened on one till is **registered** to the branch node so another till can **see** it, and editing/charging it
  takes its **lock** (a 90-second lease; two tills can never both hold it). The client covers list, register, claim, a
  manager **force-claim** (take over a live tab), lease-renewing edit, release, and delete (charged vs cleared), all over
  the pinned TLS of the server this POS joined — the lock holder is proven by the device.
- **Server-less is unchanged:** the shared-tabs host is installed only when a branch server is joined, so a plain tablet
  (or the browser) never sees it and the selling screen behaves exactly as before.
- This build lands the **client + the web-POS bridge seam**; wiring the selling screen's table flow to it (the
  see-it-then-take-over UX) is the next step — see `docs/BUILD-TILL-STAGE-3B-CLIENT.md`.

## 0.4.3 — Till stage 3 (session refresh through the branch server)
**Branch server (Slice D of Till stage 3):**
- When this POS has **joined a branch server**, its **session renewal** (the quiet, automatic one that keeps a signed-in
  POS from being logged out) now goes **through that server** (`/node/refresh`, then the acknowledgement `/node/refresh/ack`,
  over the pinned TLS of the server it joined). The server passes the renewal on to the cloud and hands back the cloud's own
  answer — so renewal keeps working over the shop network even when the tablet's own route to the internet is flaky, as long
  as the server has internet.
- **Fallback:** the cloud's own answer is used as-is — including a refusal, which still makes the POS sign back in with its
  device secret, exactly as before. Only a transport-like problem — the server does not answer, is on an older build, or
  tells us it cannot reach the cloud — makes the POS renew **straight from the cloud** instead. A POS with no branch server
  joined renews direct, unchanged.
- The POS's key for the branch server is **never** forwarded as the cloud's (the cloud checks this POS's own machine).
- **Next in Till stage 3:** shared tables / held orders across devices (Stage 3b).

## 0.4.2 — Till stage 3 (verify a PIN at the branch server)
**Branch server (Slice C of Till stage 3):**
- When this POS has **joined a branch server**, a staff PIN sign-in is now **checked by that server first** (`/node/verify-pin`,
  over the pinned TLS of the server it joined). The branch server's roster is the **LAN authority** — kept fresh on every
  catalogue pull and by relayed staff changes — so it is a better answer than this POS's own cached verifier, and it works
  with **no internet at either end** (purely over the shop network).
- **Fallback, in order:** a plain **no** from the server (a wrong or shared PIN) is **final** — it is never re-asked of the
  cloud. Any *other* problem — the server is unreachable, on an older build, busy, or cannot prove which POS is asking — is
  treated as transport-like: the POS falls back to the **cloud** sign-in, and then to the **Stage-2 offline** PIN check. A
  POS with no branch server joined behaves exactly as before.
- A POS that has **joined a server but not yet cached a roster** can now sign in **offline** too (the server verifies it),
  instead of the old "no staff saved on this POS yet" wall.
- The verified person's sales are posted under this POS's **own till token** (carrying their cashier id), exactly as online
  — the server mints no separate token. **Next in Till stage 3:** session refresh through the server (Slice D), then shared
  tables across devices.

## 0.4.1 — Till stage 3 (sell through the branch server): the branch aggregate
**Branch server (Slice B of Till stage 3):**
- A completed sale on this POS is now also **pushed to the joined branch server** (`/node/sync`): the server keeps it in
  the **branch's own records** (so a desktop POS at the branch shows this POS's sales in the branch report, over the LAN)
  and **relays it to the cloud** on this POS's behalf — so a sale reaches the cloud **through the server even when this
  POS has no internet of its own**. Faithful: the exact order the POS rang (its items, payments and figures) is what the
  server relays, so the cloud re-prices it identically. A durable outbox retries until the server has it; a POS with no
  branch server joined is unaffected.
- **Not yet:** showing the *whole branch's* orders on this POS when the cloud is unreachable (`/node/since`) is deferred —
  the POS reads the branch's orders from the cloud today, and a LAN branch-wide view is a screen of its own (see
  docs/BUILD-TILL-STAGE-3B.md). Next in Till stage 3: PIN sign-in and session refresh through the server, then shared
  tables across devices.

## 0.4.0 — Till stage 3 (sell through the branch server): the gateway
**Branch server (in progress — Slice A of Till stage 3):**
- When this POS has **joined a branch server**, its cloud traffic now goes **through that server** (`/node/cloud`, A410)
  over the pinned TLS of the server it joined — so a whole branch (desktop tills + tablets) can run on **one internet
  connection**, like the desktop peers already do. It falls back to this POS's **own** cloud automatically if the server
  is unreachable, has no internet itself, is on an older build, or refuses this POS (a preference, not a lock-in), and to
  the offline buffer if neither can be reached. A POS with no branch server behaves exactly as before.
- On open and on reconnect the POS checks the server's protocol (`/node/health`) and will not route through a server too
  new for it (it says to update the POS instead).
- Next in Till stage 3: selling and syncing through the server's own store (`/node/sync`, `/node/since`), PIN sign-in and
  session refresh through the server, then shared tables across devices.

## 0.3.1 — Offline sign-in sells into the running shift
- Offline, a cashier signing in now **sells into the shift that is already open**, instead of being forced to open a new
  one. The current-shift check is cached (like the catalogue), so when the live check can't reach the cloud, the Shop POS
  reads the last-known open shift and goes straight in.

## 0.3.0 — PIN-first offline sign-in + device-id visibility
**Sign-in:**
- Offline sign-in is now **PIN-first**, the same as online and the same as the desktop POS: the person keys their PIN and
  the cached bcrypt verifier resolves it to the one person — **no name list**. This matches the online experience, drops a
  tap, and stops the offline screen from showing who works here. A wrong PIN is refused on the spot; a PIN shared by two
  people is refused the way the cloud refuses it (ask a manager to reset).

**Device / reinstall:**
- The **This device** page (long-press the PIN-screen header) now shows this POS's **device id**, and flags it in red if
  it ever drifts from the seat the POS joined as — so a technician can confirm on a live till that a reinstall keeps the
  same seat, without resetting. (The reinstall "new seat" cause — a random id before the fixed debug key — is resolved;
  the id is now a stable `Settings.Secure.ANDROID_ID`.)

## 0.2.0 — Till stage 2 (keeps selling offline) + fixes
**Offline (Till stage 2):**
- Keeps selling with no connection — sales are buffered and replay when the connection returns.
- Cold start offline: the POS opens and shows its catalogue from a cold boot with no internet (cached pos/init, tables,
  pumps, printers, order mode).
- Offline sign-in: pick your name from the cached roster and enter your PIN; the PIN is checked **locally with bcrypt**
  (a wrong PIN is refused at the till), and verified again with the cloud on reconnect — no second PIN entry.
- Offline **table-move** and **fire-course**: a restaurant keeps moving tables and firing courses during an outage.

**Fixes (owner device test, 2026-11-11):**
- Removed the old "No connection — can't sell" cover that wrongly blocked the (now working) offline sign-in and
  contradicted the "Offline — sales are saved" banner.
- After settling a bill, **New order** now lands on the **tables** grid (the phone cart sheet closes), instead of an empty
  "Select a table" cart sheet.
- Roster now also caches right after an online sign-in, so the next offline sign-in reliably finds the staff list.
- **Server:** the branch-staff roster route was gated to the desktop surface only, so the Android Shop POS (surface
  `android-till`) was silently 403'd and its offline roster stayed empty ("No staff are saved on this POS yet"). The gate
  now accepts any POS device (desktop or android-till), as the stage-2 design intends. No app change — the dev API carries
  the fix; sign in online once after it deploys and the roster caches for offline use.

**Housekeeping:**
- Versioning: the build shows on the PIN screen; this changelog tracks what changed.
- Reinstall keeps the same seat (fixed, committed debug key); offline cold-start device test pending.

## 0.1.0 — initial Android builds
Till stage 0/1: native shell, status-bar insets, join (enrol code / branch server), PIN sign-in (online), the embedded
web POS, printing to a network printer, in-app update, device page, UI-polish batches 1–4c, device-id hardening.
