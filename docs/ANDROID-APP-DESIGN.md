# ZapTill — Android App and Owner Mobile Design

Status: **design approved in outline (2026-10-10); Q1, Q3, Q5, Q6 decided (2026-10-11); build not started.** Register item **A354**.
Revision 2: rewritten with the owner on 2026-10-10. Supersedes the 2026-09-28 proposal: bill-number ranges are
gone, discovery is the A427 broadcast, a till signs in as itself (A415), an owner mode is added, and the work is split
into stages. Companion to `DESKTOP_DESIGN.md`, `BRANCH_AUTHORITY_AND_SYNC_DESIGN.md` and `PHASE5-NODE-AUTHORITY.md`.

Terminology matches the desktop docs: **node** (the branch server), **peer**, **till**, **office**,
`node_queue`/`sync_queue`, `idempotency_key`, enrolment (D4), node-brokered auth (A160). Where a desktop mechanism
already exists, this document names it rather than inventing a parallel one.

---

## 0. What we are building, in one page

The owner asked for two things (2026-10-10): "an Android app … not just a till: an owner can log in and still perform
some basic tasks and get reports", and to "go with PWA for iPhone".

| Product | Who uses it | On what | How it is installed |
|---|---|---|---|
| **ZapTill Android app — Till mode** | Cashiers and managers at the counter | A shop tablet (consumer Android, Samsung class) | Direct APK from ZapTill, not the Play Store (Q3, §1.4) |
| **ZapTill Android app — Owner mode** | Owners, and managers for their own branches (Q6) | The owner's own Android phone or tablet | The same APK |
| **ZapTill Owner on iPhone (PWA)** | Owners and managers with iPhones | Safari, "Add to Home Screen" | No store; it is the web dashboard's owner screens |

- **One Android app, two modes**, chosen on first launch and fixed until the app is reset (§2).
- **One set of owner screens**, written once in the web dashboard and used three ways: in the browser, as the iPhone
  PWA, and inside the Android app's owner mode (§3).
- **The till is a real Android app, not a PWA**, because a browser cannot print to a network printer, hear the
  branch server's broadcast, keep working with the screen locked, or keep unsent sales safe (§1).
- **No iPhone till and no App Store app for now.** Apple allows no installing outside its store in Kenya; the PWA
  covers owners. A store-listed iPhone owner app can come later by wrapping the same screens (§1.3).

---

## 1. Platform decision (recorded 2026-10-10)

### 1.1 Android: one app built with Capacitor

A real Android app (APK) whose screens are the existing React code (web POS and dashboard), with native code only
where the hardware needs it. Neither a plain PWA nor a fully native rewrite.

| A till needs to | PWA (browser) | Capacitor app |
|---|---|---|
| Print raw ESC/POS to a network printer (TCP 9100) | ❌ browsers cannot open raw sockets | ✅ native plugin |
| Hear the branch server's broadcast (UDP 4199, A427) | ❌ no UDP in a browser | ✅ native plugin |
| Print to Bluetooth printers (classic and BLE) | ⚠️ some BLE only, Chrome only, prompt each time | ✅ native plugin |
| Keep printing and syncing with the screen locked | ❌ paused in the background | ✅ foreground service |
| Keep unsent sales safe | ⚠️ the browser may clear storage when space is low | ✅ app storage (SQLite) |
| Keep secrets in the Android Keystore | ❌ | ✅ |
| Lock the tablet into ZapTill (kiosk) | ❌ | ✅ |

**Why not fully native (Kotlin screens):** every POS change (order notes, blind close, delivery, kitchen voids …)
would be built twice. The native parts are small and bounded — printing transport, discovery, background service,
Keystore — and everything else is the screens we already build and test.

### 1.2 iPhone: the owner screens as a PWA

The dashboard's owner screens become an installable PWA: the owner opens the dashboard in Safari and taps
Share → Add to Home Screen. It gets the ZapTill icon, opens full-screen and stays signed in. Nothing from Apple, no
review, updates the moment we deploy.

Honest limits, stated to clients:
- Push alerts work only on **iOS 16.4 or newer** and only after Add to Home Screen. Older iPhones rely on email and
  Telegram.
- No fingerprint/face prompt of our own; Safari's saved password with Face ID covers it.
- Safari may clear a home-screen app's stored data after weeks unused; the owner then signs in again. Nothing
  financial is stored on the phone, so nothing is lost.

### 1.3 Why there is no iPhone app file

Outside the EU and Japan an iPhone installs apps only through Apple. Every Apple route (TestFlight, ad hoc, the
Enterprise programme, Custom apps through Apple Business Manager, the public App Store) needs a paid developer account,
a Mac to build, and Apple's review; TestFlight builds expire after 90 days, ad hoc is 100 phones a year, and the
Enterprise programme is for a company's own staff only. **If clients ask for a store app later**, the owner screens are
wrapped with Capacitor and published on the App Store — Apple's setup and review, not new screens.

### 1.4 Distribution: a direct APK, not the Play Store (Q3, decided 2026-10-11)

The app is downloaded from ZapTill (a link on our site and in the admin portal's client page), not from the Play
Store.

- **Signed by ZapTill.** One release key, kept by ZapTill only and backed up offline; every update must carry the same
  signature or Android refuses it. Losing the key means every device reinstalls, so it is treated like the Ed25519
  technician key.
- **Updates follow A348.** The app asks the cloud which version this client is approved for, downloads only that APK,
  checks its SHA-256 against the cloud's answer, and asks Android to install it. Android always shows its own
  "Update this app?" prompt; a till updates **only between shifts** (never mid-service), an owner's phone whenever the
  owner taps Update.
- **First install needs "Install unknown apps"** allowed once for the browser or file manager used. The technician
  does this on till tablets; owners get a one-page guide with screenshots. **Play Protect** may show a warning for an
  app it has not seen; the guide says what to tap.
- **No Play Store review or policy forms** (for example the foreground-service justification in pinch point 5). The
  cost is that Android's automatic updates do not apply — our A348 updater does the job.
- **Kept open:** a Play Store listing later for owner mode alone, if clients ask for it; the till stays a direct APK.

---

## 2. One app, two modes

On first launch the app asks **"What is this device?"** — **Shop till** or **Owner / manager phone**.

| | Till mode | Owner mode |
|---|---|---|
| Device | Shop tablet, enrolled to one branch | A person's own phone or tablet |
| Signs in as | **The till itself** (A415): `{ userId: null, deviceId, till: true, businessId, branchId }`; staff use PINs | **A person**: email + password + one-time code (A391/A398), like the web dashboard |
| Offline | Sells offline (Till stage 2) | Read-only "Last updated 14:32 — no connection" |
| Prints | Yes | No |
| Talks to | The branch server if there is one, else the cloud | The cloud only |
| Licence | A till seat (Q2) | The business's web access (cloud licence) — Q5, §3.1 |

**The rule (from A415, not relitigated):** a person's sign-in never lives on a till, and a till's sign-in never
belongs to a person. So:
- Switching a device between modes requires **Reset app**, which wipes everything local. A till with unsent sales
  refuses the reset until they are sent, or until a technician confirms (same guard as the desktop Rejoin).
- An owner at a till still uses their **PIN** for manager screens, as today; they do not sign in as themselves there.
- A lost owner phone is signed out with **Log out everywhere**; a lost till is **retired** from the dashboard or owner
  mode, and its cached PIN verifiers stop working on the next PIN rotation (§9).

---

## 3. Owner mode

### 3.1 Sign-in and session

- Email + password, then the one-time code (authenticator or emailed, A391/A398/A403). Same cloud routes as the
  dashboard's `/login`.
- After the first sign-in, Android biometric unlock (fingerprint/face) opens the app; the refresh token is kept in the
  Keystore and released only after the biometric check. The app locks after **5 minutes** in the background.
- The session is a person's session with a new surface **`mobile`** (Android app and PWA alike), listed in the
  person's devices and ended by "Log out everywhere" and by a password change.
- Permissions are the cloud's permission keys (A59), checked by the cloud on every call. The app hides what the person
  may not do but never relies on hiding.
- **Who may sign in (Q6, decided 2026-10-11):** owners, and managers. A manager sees and does only what their
  permission keys allow, for **their own branches** (A426 `worksAtBranch` rule: no branch assigned = every branch).
  **Cashiers cannot use owner mode.**
- **Cloud licence only (Q5, decided 2026-10-11).** Owner mode follows the business's web access exactly as the web
  dashboard does (`lib/webAccess.ts`, one clock: `businesses.web_access_expires_at`):

  | Web access | Owner mode |
  |---|---|
  | `active`, `grace` | Everything in §3.2–§3.4 |
  | `reports_only` | Reports only; quick tasks show "Renew your licence to make changes" |
  | `locked`, `none` | Sign-in refused: "This business has no web access — renew the licence"; alerts stop |

  A client with only desktop tills (no web access) does not get owner mode. Their tills are not affected.

### 3.2 Reports (Owner stage A — read-only)

Every figure comes from a **cloud route**, so the phone, the PWA and the dashboard always agree. Where the dashboard
today calculates a figure in the browser, the calculation moves to a cloud route first and the dashboard uses it too.

| Screen | Shows |
|---|---|
| **Today** | Sales, orders, average order, by payment method; all branches or one (branch picker); business-day cut-off respected (A382) |
| **Compare** | Today vs yesterday and vs the same day last week; this week vs last week |
| **By hour** | Sales by hour, local time |
| **Items** | Top items by quantity and value; slow movers |
| **Shifts and days** | Who is on which till now; closed shifts with declared vs expected and the difference; day (Z) reports |
| **Voids and refunds** | Voids, refunds and kitchen voids with who, reason and amount |
| **Expenses** | Expenses and pay-outs by type and payment method |
| **Stock** | Low stock; batches expiring soon (A413) |

Offline: the last fetched figures stay on screen with **"Last updated <time> — no connection"**. A partial number is
never shown as a total.

### 3.3 Quick tasks (Owner stage B)

Each uses the permission the web uses and is written to the audit log with the surface `mobile`.

- **Confirm shifts** waiting for a manager (A365) — declared vs expected per method, then confirm.
- **Close the day remotely** (A275), with the dashboard's checks.
- **Menu quick edits** — change a price, hide an item, sold out / available again. Tills pick it up on their next
  pull.
- **Record an expense** — type, amount, payment method.
- **Devices** — approve or reject a till waiting to join; retire a lost till.
- **Staff** — turn a staff member off now; reset a PIN.

Anything larger (menu uploads, staff set-up, settings, suppliers, stock counts) stays on the web dashboard; the app
links to it.

### 3.4 Alerts to the owner's phone (Owner stage B)

Today the watchdog alerts (A392) go to **ZapTill** (Telegram, critical ones by email), and owners get the daily
summary email (A50). Owner alerts are new:

- **Critical, at once:** a till not syncing; repeated failed sign-ins; a till's session lost (A407); a refund or void
  above an amount the owner sets; a shift difference above an amount the owner sets.
- **Daily:** yesterday's takings, one notification.
- Each person chooses which alerts they get; each alert is sent once per event, not once per device check.
- Delivery: Firebase Cloud Messaging for the Android app; Web Push for the PWA (Android Chrome, and iPhone on iOS 16.4+).

---

## 4. Till mode

### 4.1 The one rule everything hangs off

**The tablet is a leaf peer. It is never a node, never an authority, and never holds data on behalf of another
device.**

- It **sells** (`canSell() === true`, role `till` — never `office`, never `node`).
- It **always syncs up** to a server — the branch server on the LAN, or the cloud.
- It is **never a promotion target.** It does not serve peers, does not hold the branch roster for anyone else, and is
  excluded from `REPLICATED_TABLES` distribution as a *source*.

Its local database is only ever two things: an **outbound buffer** (sales not yet acknowledged by a server) and a
**read cache** (menu, staff verifiers, its own recent sales for reprints and its own report). Once a server
acknowledges a sale, the tablet's copy is cache — and that decides retention (§4.8).

> **A till asks the nearest authority that can answer, and is only bounded when it can reach none of them.**

For a tablet the order is **branch server (LAN) → cloud → local cache**, and unlike a desktop peer it can never become
one of those authorities.

### 4.2 The two setups

**Setup 1 — with a branch server (recommended).** The tablet is another peer on the existing node protocol. The branch
server is the authority, the central print spool and **the only link to the cloud** (A410).

```
                         ┌──────────────┐
                         │    CLOUD      │  backup, cross-branch, owner mode
                         └──────▲───────┘
                                │  the branch server is the ONLY uplink (A410)
   ═════════════════ BRANCH LAN (cabled backbone) ═══════════════════
                                │
                         ┌──────┴────────┐
                         │ BRANCH SERVER │  always on (A427 server mode), cabled, UPS
                         │  authority    │  tables, held orders, staff roster (A426),
                         │  central SPOOL│  central print spool, sync_queue
                         └──┬────┬───┬───┘
     render → POST bytes ───┘    │   └── TCP 9100 ──┬─ Kitchen printer
     to /node/print              │ /node/since      ├─ Dispatch printer
        ┌───────────────┐        │ (state push)     └─ Receipt printer
        │ Tablet (peer) │ ...    │
        │  node_queue   │────────┘
        └───────────────┘   speaks the SAME /node/* protocol a desktop peer does
```

**Setup 2 — no branch server, cloud required.** The cloud is the authority when reachable. "No branch server **and**
no cloud" is not a steady state — only the temporary window covered by the tablet's buffer (§4.6).

```
                    ┌──────────────┐
                    │    CLOUD      │  ← AUTHORITY when online
                    └──────▲───────┘    tables, staff, stock, reports
    internet (may blip)    │
   ════════════════════════╪═══════ BRANCH LAN ═══════════════════
     ┌──────────┬──────────┴───────┬──────────┐
 ┌───┴────┐ ┌───┴────┐        ┌────┴───┐  ┌────┴───────┐
 │Tablet 1│ │Tablet 2│  ...   │Tablet N│  │  Network    │
 │ buffer │ │ buffer │        │ buffer │  │  printer    │
 └───┬────┘ └───┬────┘        └───┬────┘  └──▲──────────┘
     └──────────┴─────────────────┴──────────┘
        each tablet: render + local spool + DIRECT TCP 9100
```

The tablet is built **once** against two seams — an *authority target* and a *print target*. Setup 1 points both at
the branch server; Setup 2 points them at the cloud and the printer. Adding a branch server to a Setup-2 branch later is
a re-point, not a rewrite (pinch point 11).

### 4.3 Joining and discovery

Discovery is automatic and reuses **A427** exactly as the desktop installer does:

```
first launch (Till mode)
  → listen for the branch server's broadcast (UDP 4199, "ZAPTILL-SERVER/1") for a few seconds
     ├─ found → "Join <branch> server at <address>?" → POST /node/join
     │           someone at the server presses Allow → the server gets ONE enrolment code from the cloud
     │           (POST /api/pos/join-code) → the tablet collects it once (/node/join/status) and enrols itself
     └─ none  → the technician enters a terminal (enrolment) code, as on desktop
  → the till now has its OWN session (A415) for that business and branch
```

- Till codes and the branch code are set exactly as today; joining never changes them.
- The tablet takes a **till seat** and reports its role (`role='till'`), so the cloud counts it (D4, Q2).
- At every start the tablet tries the configured branch server first, then the cloud, then its buffer. It falls back
  **only when an authority could not be reached, never when one answered no** — a 401 is final wherever it comes from.

### 4.4 Sign-in chain and credential storage

```
branch server set?  → POST /node/verify-pin
                       answered (ok OR refused) → honour it
                       transport failure        → fall through
cloud reachable?    → POST /api/auth/verify-pin   (with the till's own session, A415)
                       answered → honour it; on success, cache the verifier
                       transport failure → fall through
local cache         → offline PIN check (Till stage 2)
```

Secrets (the till session, the device secret A407, the branch server's access code, cached PIN verifiers) are kept
with **Android Keystore**-backed encryption — the Android parallel to Electron `safeStorage`/DPAPI. The honest limit
is the same as PHASE5 §5:

> The Keystore defeats a copied database, a stolen backup and a pulled flash chip. It does **not** defeat code running
> as the app on an unlocked, rooted device. A lost tablet is a reason to **rotate PINs** — a runbook step, not an
> assumption.

`PIN_CACHE_TTL_DAYS` means, as on desktop, days since **any** authority was reached.

### 4.5 Order numbers

**Decided: no bill-number ranges.** The 2026-09-28 proposal's pre-allocated ranges are dropped. Order numbers are
already unique **per device** (A181/A183): every order carries its own uuid and its device, so two tablets cannot
collide online or offline, numbering never blocks a sale, and there is nothing to top up.

### 4.6 Printing

**One renderer, two last hops.** The `shared/printing` renderer is reused as-is (it already runs in a browser for the
settings preview); only its byte output changes from `Buffer` to `Uint8Array`.

```
            order ──▶ shared/printing renderer ──▶ ESC/POS bytes
                                                       │
                        ┌──────────────────────────────┴───────────────┐
        Setup 1: POST bytes to the branch server   Setup 2: native plugin
        /node/print (its spool sends over TCP)     sends direct (TCP or Bluetooth)
```

- **Setup 1:** `/node/print` takes the `apps/print-server` contract (`{ target, data(base64) }`) into the branch
  server's SQLite spool with the retry/backoff of `printWorker.ts`. One queue per printer (port 9100 takes one
  connection at a time), and a job survives the tablet that created it going to sleep.
- **Setup 2:** the tablet prints **direct to the printer address** through the native TCP plugin, with its own
  persistent spool and **jittered connect-retry (50–500 ms)** for printers shared by several tablets.
- **Bluetooth** (classic SPP and BLE, Till stage 4): the tablet's own paired printer; BLE output chunked and paced to
  the MTU. One printer per tablet; it does not share.
- **Break-glass:** the TCP plugin is built even for Setup 1; if the branch server is down, the tablet prints direct.
- Kitchen routing by station (A411) as on desktop.
- **Never Android `PrintManager` / `WebView.print()`.** That rasterises to a bitmap — the slow, mangled-column path
  `transport.ts` was written to escape. Raw ESC/POS bytes, end to end, always.

### 4.7 Offline: store-and-forward (Tier 1)

| Tier | Works offline | Cost |
|---|---|---|
| 0 — online-only | nothing; a blip means no sales | cheapest (Till stage 1) |
| **1 — store-and-forward** ✅ | keep taking orders, queue, print, reconcile | moderate (Till stage 2) |
| 2 — full offline till | shared state offline too | this is what a **branch server** gives; never rebuilt per tablet |

The tablet's database is a **buffer, not a mirror**: sales, order lines, payments, voids/refunds, expenses, wastage,
shift events, `sync_queue`, plus a cached menu and staff verifiers. No reports engine, no other tablets' sales, no
branch totals.

**Reconnect:** (1) refresh the session (through the branch server, A160, in Setup 1); (2) pull server time, menu
(with A425 choice pruning), staff, table and held-order state; (3) push `sync_queue` **in creation order**, idempotent
by order uuid / `idempotency_key`; (4) resolve automatically, asking a person only where a sale's *linkage* is
contested; (5) mark acknowledged rows `synced`.

| What the tablet did offline | Conflict? | Resolution |
|---|---|---|
| Completed / paid sale | No | Idempotent upsert by uuid. **A sale is never lost.** |
| Stock change | Soft | Sent as **deltas, not totals**; oversell is reported as variance, never un-sold. |
| **Seated a dine-in table** | **Yes** (the only real one) | The server wins the *table*; the tablet **keeps the order** and asks: "Order #3012 was on Table 5, now taken — move it?" |
| Held order created offline | No | Its uuid is the tablet's own. |
| Void / refund | No | Append-only event on a uuid; the server accepts it in the same batch as its order. |

Rules: orders are facts — replay, never drop; deltas not totals; the server wins contested state but the sale is
kept and a person is asked; **never trust the tablet's clock** for "who was first" — anchor to server time.

**M-Pesa:** STK push needs the internet and the cloud's callback, so offline it is always recorded by hand (the
cashier marks it paid). Do not promise offline M-Pesa. The payment record carries `method` + `status` so STK slots in
later.

### 4.8 Data retention — two clocks

- **Unsent data: kept until the server acknowledges it**, however old. Never deleted by age.
- **Sent data: kept 30 days** (setting), for reprints and the tablet's own report; then removed — it lives on the
  server.

The two conditions are independent: remove only rows that are *sent AND older than the window*. Offline, a receipt
older than the window cannot be reprinted.

### 4.9 Manager on the till: two views

| View | Scope | Offline? | Source |
|---|---|---|---|
| **This device** | what this tablet rang up (shift/day) | ✅ always | local, within the retention window |
| **Branch** | all tills | ❌ needs a connection | branch server or cloud |

Offline, the branch view says "Needs connection — last updated 14:32", never a partial number dressed as a total.
Opened with a manager PIN, gated by permission keys (A59), auto-locks on timeout.

### 4.10 Consolidated reporting — what to tell a client

| Set-up | Branch report | Cross-branch, owner mode | Cloud licence? |
|---|---|---|---|
| Tablets only, offline for good | ❌ per tablet only | ❌ | — |
| Tablets → cloud | ✅ | ✅ | Yes |
| Tablets → branch server | ✅ on site | ❌ until the cloud is added | No |
| Tablets → branch server → cloud | ✅ | ✅ | Yes |

**Owner mode and the iPhone PWA read the cloud**, so they need the cloud licence (Q5). A branch with only a branch
server gets its reports on the server and the tills, not on the owner's phone (decided 2026-10-11).

---

## 5. The stages

```
Stage 0 ─┬─ Owner A ── Owner B
         │     └── the iPhone PWA ships with Owner A (same screens)
         └─ Till 1 ── Till 2 ── Till 3 ── Till 4
```

Each stage is its own release, register item, tests and per-client approval, like desktop. None needs a later stage to
be useful. **Owner A ships first** (online-only, no printing — quickest value, lowest risk, and it proves the app,
signing, updates and sign-in on real phones). Till 1 starts alongside it once Stage 0 is done.

### Stage 0 — Foundation

- `apps/android`: Capacitor shell; first-launch mode choice (§2); Reset app.
- Keystore-backed secure storage plugin.
- App version check against the cloud, approved per client like desktop (A348); the cloud learns the surfaces
  `android-till` and `mobile`.
- Direct-APK distribution (§1.4): the APK and its SHA-256 published per release; the in-app updater (download the
  approved version, verify, hand to Android's installer; tills only between shifts); a download link on the admin
  portal's client page; the install guide for owners.
- CI: build and sign the APK; signing key held by ZapTill only.
- Crash and error reports into the existing alerts.

**Done when:** the signed APK installs on a test tablet, shows the mode choice and gets a version answer.
**Size:** small–medium.

### Owner stage A — Reports (Android owner mode + iPhone PWA)

- Owner screens in the dashboard, phone-first layout (§3.2), behind their own route.
- Dashboard made an installable PWA: web manifest, icons (including Apple touch icons), iOS meta tags, a service
  worker that caches the app shell only (never sales data), "Add to Home Screen" help for iPhone.
- Android owner mode loads the same screens, plus biometric unlock (§3.1).
- Cloud: the `mobile` surface for sessions; sign-in for owners and managers only, gated by web access (§3.1);
  managers limited to their own branches; report routes for any figure the dashboard computes in the browser.

**Tests:** phone figures equal the dashboard's for the same period and branch; a cashier cannot open owner mode; a
manager sees only their branches; `reports_only` web access shows reports and refuses tasks; `locked`/`none` refuses
sign-in; Log out everywhere locks a phone out; the PWA installs and opens full-screen on an
iPhone.
**Done when:** the owner checks last night's takings from their phone in under 10 seconds.
**Size:** medium.

### Owner stage B — Quick tasks and alerts

- Tasks in §3.3; any task without a cloud route gets one.
- Owner alerts (§3.4): a table of phone/browser registrations per person, FCM and Web Push senders, owner alert rules
  next to the watchdog's, per-person alert choices.

**Tests:** each task refuses a person without the permission; a price change reaches a till; an alert arrives once;
turning an alert off stops it; iPhone push on iOS 16.4+ after Add to Home Screen.
**Size:** medium (the push service is the only new infrastructure).

### Till stage 1 — Online tablet till

- Joining (§4.3): A427 broadcast + Allow, or a terminal code; the till's own session (A415); a till seat.
- Selling with the web POS screens on a tablet layout: categories, sizes and add-ons, notes, discounts, held orders,
  delivery and rider, payment methods, split payments, the after-payment screen; staff PINs (online); shifts with
  declared amounts and blind close; kitchen voids.
- Printing: `shared/printing` bytes over the native TCP plugin; station routing; a printer that is off gives a clear
  error and the sale is kept.
- Without internet: a clear "No connection — can't sell".

**Tests on hardware:** two tablets printing to one printer at once — both print, nothing garbled; every sale reaches
the cloud exactly once.
**Done when:** a branch with good internet runs a full day on a tablet.
**Size:** large.

### Till stage 2 — Keeps selling offline

- Local buffer and cache (§4.7); offline PIN check with Keystore verifiers; in-order, idempotent replay; stock as
  deltas; manual M-Pesa offline; retention (§4.8).
- A status bar: online/offline, sales waiting, last synced; refusals visible to managers.

**Tests on hardware:** unplug the router mid-shift, sell 50 orders, reconnect — exactly 50 arrive; kill the app while
offline — nothing lost; a PIN changed on the web is refused once the tablet reconnects; close a shift offline, then sync.
**Done when:** the internet is off for an afternoon and the cloud's figures match the till's afterwards.
**Size:** large — the riskiest stage; test slowly.

### Till stage 3 — With the branch server (Setup 1)

- The tablet as a peer: sync, session refresh and cloud access only through the branch server (A160, A410); PINs at
  `/node/verify-pin` from the roster (A426); shared tables and held orders; printing through `/node/print`.
- When the server is down: fall back to the cloud or the buffer, on transport failure only.
- Version checks so a tablet and its server speak the same `/node/*` protocol and `X-Schema-Version`.

**Tests on hardware:** a desktop server with two desktop tills and two tablets — tables, held orders and printing
across all; server off mid-service — tablets keep selling and catch up; internet down — the whole branch keeps working.
**Done when:** a mixed branch runs a busy evening on one server.
**Size:** medium.

### Till stage 4 — Reliability and extras

- Foreground service for the print spool and sync (Q8).
- Bluetooth printers, classic and BLE (chunked).
- Break-glass direct printing when the branch server is down.
- Manager "This device" and "Branch" views (§4.9).
- Optional kiosk mode.

**Tests on hardware:** a kitchen ticket queued with the screen locked for 10 minutes still prints; complete Bluetooth
receipts on two printer models; a retired tablet's cached PINs open nothing after a PIN rotation.
**Size:** medium.

---

## 6. Pinch points

1. **Table double-seating offline.** The one unsolvable shared-state conflict without a live authority. The server
   wins the table, the sale is kept, a person is asked (§4.7). A branch server removes it; Setup 2 offline cannot.
2. **Port 9100 takes one connection.** Several tablets printing to one printer contend. The branch server's spool
   serialises (Setup 1); direct print (Setup 2) needs jittered retry. Tolerable: jobs are under a kilobyte.
3. **A queued job dies with the tablet** in Setup 2 if the tablet sleeps or is killed before the printer recovers.
   Only the branch server's spool owns a job independently of its creator.
4. **The branch server is a single point for printing in Setup 1.** Mitigated by break-glass direct print, which loses
   the shared queue until the server is back.
5. **Android background limits (Doze).** Background sockets are throttled and the process is killed; a spool that must
   retry after the cashier switches apps needs a **foreground service** (with a notification — Q8; no Play Store
   justification is needed because the app is a direct APK, §1.4). Without it, queued tickets stall silently.
6. **Bluetooth is two protocols and a chunking trap.** SPP vs BLE are different APIs; BLE needs the receipt chunked and
   paced or the printer prints half. Permissions differ by Android version (`BLUETOOTH_CONNECT`/`SCAN` on 12+,
   location before). Budget real per-device testing.
7. **Consumer-tablet storage.** Why retention is bounded (§4.8).
8. **The Keystore's limit.** Like DPAPI, it does not defeat a rooted device running as the app. A lost tablet ⇒ retire
   it and rotate PINs.
9. **Offline M-Pesa is impossible** (§4.7).
10. **The seams are load-bearing.** The tablet talks to an *authority target* and a *print target*, never a hardcoded
    cloud URL or printer address, or adding a branch server becomes a rewrite. Enforced in review.
11. **Clock trust.** Any "newest wins" or "who was first" decision uses server-anchored time, never the tablet's clock.
12. **Mixed-fleet versions.** An Android peer and desktop peers at one branch must speak the same `/node/*` protocol and
    schema version — the same problem as a mixed-version desktop branch, handled with the same version-aware handshake.
13. **iPhone PWA limits.** Push only on iOS 16.4+ after Add to Home Screen; Safari may clear the stored sign-in after
    long disuse. Owner mode keeps nothing that matters on the phone, so the cost is signing in again.
14. **Two sign-ins on one device would break A415.** Mode is fixed per device; switching means Reset app (§2).

---

## 7. What reuses existing code

| Reused nearly as-is | Genuinely new |
|---|---|
| Web POS screens (Till mode) and dashboard screens (owner mode, PWA) | Capacitor shell, mode choice, tablet and phone layouts |
| `shared/printing` renderer (`Buffer` → `Uint8Array` only) | Native plugins: TCP print, Bluetooth print, UDP discovery |
| `/node/*` peer protocol, `node_queue`, idempotency, `/node/verify-pin`, `/node/print` contract | Foreground service (spool + sync) |
| A427 discovery and Allow, `/api/pos/join-code`; A415 till session; A407 device secret; A160 brokered refresh | Keystore storage (replaces `safeStorage`); biometric unlock |
| Sync routes and per-device order numbers (A181/A183); A425 choice pruning | Tablet buffer + replay client (Till stage 2) |
| Report routes, permission keys (A59), one-time codes (A391/A398) | Owner report routes where the dashboard computes in the browser; push (FCM + Web Push); owner alert rules |
| Version approval per client (A348) | The `mobile` and `android-till` surfaces; APK signing in CI |

The renderer surviving intact is the win: we re-solve **transport**, which is bounded, not **layout**, where the
subtle bugs live.

---

## 8. Decisions recorded (do not relitigate)

- **Android: one Capacitor app** reusing the web screens; native code only for hardware. Not a PWA, not a native
  rewrite. (2026-10-10)
- **iPhone: owners use the dashboard as a PWA.** No App Store app and no iPhone till for now. (2026-10-10)
- **Two modes, Till and Owner, fixed per device**; a person's sign-in never lives on a till (A415). (2026-10-10)
- **Owner screens are written once** in the dashboard and used in the browser, the PWA and Android owner mode.
- **Owner stage A ships first;** Till stage 1 runs alongside.
- **Distribution: a direct APK signed by ZapTill**, updated through the A348 per-client approval; not the Play Store.
  (Q3, 2026-10-11)
- **Owner mode needs the business's web access (cloud licence)**, following `lib/webAccess.ts` states. (Q5, 2026-10-11)
- **Managers may use owner mode** for their own branches and within their permission keys; cashiers may not.
  (Q6, 2026-10-11)
- **The tablet is a leaf peer.** Never a node, never promoted, never holds data for another device.
- **Two setups, one build:** with a branch server (recommended) or with the cloud. No steady state without either.
- **Discovery is automatic** (A427 broadcast + Allow), with a terminal code as the fallback.
- **No bill-number ranges;** order numbers are per device (A181/A183).
- **Setup-2 offline is Tier 1** (store-and-forward), not a full offline till.
- **Printing:** one renderer; the branch server's spool in Setup 1, direct + local spool in Setup 2, Bluetooth as a
  fallback, direct as break-glass. **Never** Android `PrintManager`.
- **Retention:** unsent kept until acknowledged; sent kept 30 days; independent conditions.
- **Manager on the till:** this device offline, branch online only.
- **Payment:** `method` + `status`; M-Pesa STK is online only, always.
- **Fall back on transport failure only, never on a refusal.**
- **Server-anchored time** for any conflict decision.

---

## 9. Open questions (need a call before the stage that needs them)

| # | Question | Needed before | Recommendation |
|---|---|---|---|
| Q1 | ~~Screen base~~ | — | **Decided:** Capacitor + web screens; iPhone PWA |
| Q2 | Does a tablet take a **till seat** or a web POS licence? | Till 1 | A till seat (`role='till'`), same as desktop |
| Q3 | ~~Play Store or direct APK~~ | — | **Decided 2026-10-11:** direct APK (§1.4) |
| Q4 | **Hardware:** which tablet models, the oldest Android version, which printers? | Till 1 | Android 10+; pick two tablet models and two printer models to certify |
| Q5 | ~~Every owner or cloud licence only~~ | — | **Decided 2026-10-11:** cloud licence (web access) only (§3.1) |
| Q6 | ~~Managers in owner mode~~ | — | **Decided 2026-10-11:** yes, own branches and permissions only (§3.1) |
| Q7 | **Till 2 before Till 3**, or the other way round? | Till 2 | Till 2 first, unless most clients have branch servers |
| Q8 | **Foreground service** always on, or only while the app is open? | Till 4 | Always on while a shift is open |
| Q9 | Branch server = existing desktop, or a dedicated office machine? | Till 3 | Support both; it is the same desktop app in server mode (A427) |
| Q10 | Retention window default — 30 days? | Till 2 | 30 days unless a client reviews more on the tablet |
