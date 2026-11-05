# ZapTill — Android App and Owner Mobile Design

Status: **design approved in outline (2026-10-10); Q1, Q3, Q5, Q6 decided (2026-10-11); Stage 0 built 2026-11-04 on the `android` branch (§10); Q2 decided and Till stage 1 built 2026-11-05 (§11).** Register item **A354**.
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

On first launch the app asks **"What is this device?"** — **Shop POS** or **Owner / manager phone** (the person reads
"POS", never "till"; the cloud calls the two surfaces `android-till` and `mobile`).

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

**Joining is done by a technician** (owner, 2026-11-05: "joining should be done by a tech"). ZapTill recommends a
dedicated branch server (backups, and printing set up once), but many clients have none, so a tablet joins either way
("build both in the meantime"). The broadcast reuses **A427** exactly as the desktop installer does:

```
first launch (Till mode) — the technician names the POS ("Front counter")
  → listen for the branch server's broadcast (UDP 4199, "ZAPTILL-SERVER/1") for a few seconds
     ├─ found → "Join the <name> server at <address>?" → the server's certificate and SECURITY CODE (A489), compared
     │           with the server's screen → POST /node/join over TLS pinned to that certificate
     │           someone at the server presses Allow → the server gets ONE enrolment code from the cloud
     │           (POST /api/pos/join-code) → the tablet collects it once (/node/join/status) and enrols itself
     └─ none  → "Enter the enrolment code from ZapTill": the business ID and the one-time code a ZapTill technician
                issues in the admin portal (A69, the branch's Enrol POS)
  → the POS now has its OWN session (A415) for that business and branch
```

- Till codes and the branch code are set exactly as today; joining never changes them.
- The tablet takes a **POS seat** and reports its role (`role='till'`), so the cloud counts it (D4, Q2 — decided).
- A branch server too old to have a certificate is not joined through (nothing secret crosses the shop network in
  plain HTTP); the technician enters the code instead.
- In Till stage 1 the tablet **sells through the cloud** either way; joined through a branch server it also **prints
  through it** (§11.4). Selling through the server is Till stage 3.
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

- Joining (§4.3), by a technician: A427 broadcast + Allow at the branch server, or the enrolment code from the admin
  portal; the POS's own session (A415); a POS seat.
- Selling with the web POS screens on a tablet layout: categories, sizes and add-ons, notes, discounts, held orders,
  delivery and rider, payment methods, split payments, the after-payment screen; staff PINs (online); shifts with
  declared amounts and blind close; kitchen voids.
- Printing: joined through a branch server → the whole ticket to the server (`POST /node/print`), printed with the
  server's stations, printers and spool (owner, 2026-11-05: "so that printing can be easier"); no server, or it does not
  answer → `shared/printing` bytes over the native TCP plugin with station routing; a printer that is off gives a clear
  error and the sale is kept.
- Without internet: a clear "No connection — can't sell".
- Built 2026-11-05: §11.

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
- **Discovery is automatic** (A427 broadcast + Allow), with a terminal code as the fallback. **A technician joins the
  tablet** either way; ZapTill recommends a dedicated branch server, but a tablet works without one. (2026-11-05)
- **A tablet takes a POS seat** (`role='till'`), like a desktop POS. (Q2, Till stage 1)
- **The cloud's gates treat a Shop POS (`android-till`) as a desktop POS.** (Till stage 1, §11.2)
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
| Q2 | ~~Till seat or web POS licence~~ | — | **Decided (owner-approved, Till stage 1):** a POS seat (`role='till'`), same as desktop (§11) |
| Q3 | ~~Play Store or direct APK~~ | — | **Decided 2026-10-11:** direct APK (§1.4) |
| Q4 | **Hardware:** which tablet models, the oldest Android version, which printers? | Till 1 | Android 10+; pick two tablet models and two printer models to certify |
| Q5 | ~~Every owner or cloud licence only~~ | — | **Decided 2026-10-11:** cloud licence (web access) only (§3.1) |
| Q6 | ~~Managers in owner mode~~ | — | **Decided 2026-10-11:** yes, own branches and permissions only (§3.1) |
| Q7 | **Till 2 before Till 3**, or the other way round? | Till 2 | Till 2 first, unless most clients have branch servers |
| Q8 | **Foreground service** always on, or only while the app is open? | Till 4 | Always on while a shift is open |
| Q9 | Branch server = existing desktop, or a dedicated office machine? | Till 3 | Support both; it is the same desktop app in server mode (A427) |
| Q10 | Retention window default — 30 days? | Till 2 | 30 days unless a client reviews more on the tablet |

---

## 10. Stage 0 — built (2026-11-04, branch `android`)

Everything in §5 "Stage 0 — Foundation", on the `android` branch (from `dev` at c5048fc0). No owner screens and no selling
yet: each mode lands on a screen that says what comes next.

### 10.1 What was built, and where

| Part | Where | What it does |
|---|---|---|
| Shared rules | `packages/core/src/androidApp.ts` (`@zaptill/core/androidApp`) | The two surfaces (`android-till` = Shop POS, `mobile` = owner / manager phone) and their words; x.y.z versions; the release layout (tag `android-v<x.y.z>`, asset `ZapTill-<x.y.z>.apk`); the cloud's answer (`AndroidUpdateStatus`); **`updateVerdict`**, the one rule for the updater (never past the approved version, never "down"; a Shop POS only with no shift open; an owner's phone whenever the owner taps Update); the error-report shape. Used by the cloud, the admin portal and the app. |
| The app | `apps/android` (Capacitor 8.6, app id `com.zaptill.app`, name **ZapTill**, Android 10+ = minSdk 29, target / compile SDK 36) | `src/`: the app's own screens (React + Vite, bundled into the APK): **What is this device?** (Shop POS / Owner or manager phone, then a confirm step), each mode's placeholder, **Updates**, **Reset app**. `android/`: the native project. |
| Mode and Reset app | `src/device/mode.ts`, `src/device/reset.ts` | The mode in the app's preferences (not a secret). Reset app clears every preference, every secret and every downloaded update, then asks the question again. `resetBlocker()` is Till stage 2's hook (unsent sales); Stage 0 has none. |
| Secure storage | `src/device/secrets.ts` over `@aparajita/capacitor-secure-storage` 8.0.1 | See 10.2. Stage 0 stores no secret yet; the names a later stage may use are listed there, so Reset app and a reader see them all. |
| Cloud client | `src/cloud/client.ts`, `src/config.ts` | Every call through **CapacitorHttp** (the native HTTP stack): no web origin, so the cloud's CORS list needs no entry for the app. The base is `VITE_API_URL` at build time, else `https://api.zaptill.co.ke`: the one "authority target" seam (pinch point 10). |
| Update feed | `apps/server/src/routes/appUpdate.ts`, `lib/androidReleases.ts`, `lib/androidApproval.ts`, migration **189** | `GET /api/app-update/android/status?surface=`: the approved version (null = held), the newest release, and the **offer** (version, file name, **SHA-256**, size, download path) when the approved APK can be handed out. Signed in, the business and the surface come from the **session** (a POS's own session → `android-till`, a person's → `mobile`), never from the query. Signed out (Stage 0): held, the newest release named. `GET /api/app-update/android/v/:version/apk` (signed in): only the version approved for this business and surface → 302 to the APK's short-lived GitHub link; otherwise 403. |
| Approval per client | `apps/server/src/routes/adminAndroid.ts`, `apps/admin/src/AndroidAppCard.tsx`, `androidVersions.ts` | The admin portal's client page, tab **Updates** (renamed from "Desktop updates"; it now holds both apps), card **ZapTill for Android**: each surface approved or held on its own (super admin only, audited `android_update.approve` / `.hold`; only a complete, published release); **Get download link**: the APK's short-lived link and its SHA-256 for installing a new device (any admin for the newest or the client's approved version; a super admin any; audited `android.apk.download`). |
| In-app updater | `src/updates/updater.ts`, `ApkUpdaterPlugin.java`, `ApkDownloader.java` | Asks the cloud, applies `updateVerdict`, downloads the offer natively into the app's private `cache/updates/`, hashing while it streams; a mismatch keeps nothing ("does not match its SHA-256 — it was not installed"). The session header goes **only** to the cloud's own host, never to the host it redirects to; every redirect must be https. Then Android's installer through the app's FileProvider, which shares only that folder. Without "Install unknown apps" for ZapTill the app opens that setting first. `shiftIsOpen()` is the Shop POS hook (Stage 0: no shifts). |
| Crash and error reports | `src/errors/reporter.ts`, `CrashReporter.java`, `CrashReportsPlugin.java`, `apps/server/src/routes/appErrors.ts`, `lib/appErrors.ts` | See 10.3. |
| Version | `apps/android/package.json` → `app/build.gradle` | One place: `versionName` = the package version, `versionCode` = x·1,000,000 + y·1,000 + z. |
| CI | `.github/workflows/android.yml`; `ci.yml` step "ZapTill for Android, cloud side" | 10.5. |
| Install guide | `docs/Manuals/ANDROID-INSTALL.md` (+ `.docx`, `.html`) | For owners and technicians: download, "Install unknown apps", Play Protect, first launch, checking the SHA-256, updates, Reset app, troubleshooting. |

### 10.2 Decisions made while building

1. **Secure storage: `@aparajita/capacitor-secure-storage` (8.0.1, Sept 2026, Capacitor 8), not a plugin of our own.**
   Read before choosing: each value is encrypted with **AES-256-GCM** under its own key generated in the
   **AndroidKeyStore** (the key never leaves it); only the ciphertext is stored, in the app's private preferences; `clear()`
   serves Reset app. Rejected: `capacitor-secure-storage-plugin` (0.13, slower to follow Capacitor); AndroidX
   `EncryptedSharedPreferences` (deprecated by Google in 2025); our own plugin (the same Keystore code to own and review,
   for no gain). Its npm package lists `@capacitor/ios` and `@capacitor/keyboard` as dependencies; they are installed but
   not built into the APK (Capacitor builds only the app's own direct plugins; the build lists three). With it, the
   manifest opts out of Android backups and device-to-device transfer (`allowBackup="false"`,
   `xml/data_extraction_rules.xml`): a copied session would break A415, and Keystore keys do not travel anyway.
2. **Two approval columns** (`businesses.android_till_approved_version`, `mobile_approved_version`, migration 189), not
   one: a client's shop tablets can stay on a version that works while the owner's phone takes a newer one. NULL = hold,
   the default, as A348.
3. **Releases live on GitHub Releases** beside the desktop's, tagged `android-v<x.y.z>` (never mixed with `v<x.y.z>`),
   one asset `ZapTill-<x.y.z>.apk`. **The SHA-256 is GitHub's own record of the asset** (its `digest`), not a file next to
   the APK that anyone with upload rights could replace along with it; a release without a digest is incomplete and
   cannot be approved. `ANDROID_RELEASES_REPO` can point elsewhere (default: the desktop's repository). The Android list
   reads the newest 100 releases (the desktop's pre-releases share the repository). When the files move to the VPS
   (platform move), this follows A570's next step: the feed resolves through our own download server.
4. **A signed-out device asks with `?surface=` and gets "held"** plus the newest release. This is what Stage 0's "gets a
   version answer" means: there is no sign-in yet, so no business, so nothing can be approved for it. **Consequence:** a
   Stage 0 install does not update itself; the next version (Owner A / Till 1) is installed from a new link, like the
   first. From the first signed-in version on, the app updates itself.
5. **Crash reports: a new route, `POST /api/app-errors`.** There was no client error route to reuse: the desktop keeps its
   errors in its own log (A299) and sends the log only when support asks (A519, A533). The Android app has no technician
   beside it, so it reports by itself, into the existing admin alerts (A589's bell) under a new category **`app_errors`**
   ("Android app crashes and errors", client group: the bell and the Alerts page, never an email per crash). 10.3.
6. **Install through `ACTION_VIEW` + FileProvider**, not the `PackageInstaller` session API: the same Android prompt, a
   tenth of the code. Revisit if a later Android refuses it.
7. **The app's screens are its own small Vite bundle** for Stage 0 (the mode question and the placeholders exist nowhere
   else). Owner A loads the dashboard's owner screens and Till 1 the web POS screens: shared, not copied.

### 10.3 Crash and error reports

- **What is sent:** a native crash (the handler installed first thing in `MainActivity` writes `files/crash/pending.txt`
  — a crashing process cannot be trusted with the network — and the app sends it at its next start), and the app's own
  script errors and uncaught promise rejections. `{ surface, kind: crash|error, appVersion, message, stack, device }`,
  where `device` is "Android 14 (API 34), samsung SM-T220": make and model only, no serial number, no name.
- **App side:** at most 5 reports a run, each message once; reports wait until the mode is known; one that cannot be sent
  is dropped (no retry loop).
- **Cloud side:** no session needed (Stage 0 has none, and a crash before sign-in matters most), so: the global limiter
  plus 30 reports per address per 10 minutes; every field trimmed and passed through the log redactor
  (`@zaptill/core/logRedact`: tokens, keys, PINs, phone numbers); **one bell row per crash per 6 hours** however many
  devices send it (fingerprint: surface, version, kind, the first lines of the message and the stack; never the device);
  every report also in the cloud's log. With a session, the bell row names the business.

### 10.4 Tools installed on the build PC (2026-11-04)

| Tool | Where |
|---|---|
| Microsoft Build of OpenJDK 21.0.13 (winget `Microsoft.OpenJDK.21`) | `C:\Program Files\Microsoft\jdk-21.0.13.21-hotspot`; `JAVA_HOME` (user) |
| Android command-line tools 16111833 (SHA-1 checked against Google's index) | `%LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest`; `ANDROID_HOME` (user) = `%LOCALAPPDATA%\Android\Sdk` |
| Android SDK: platform-tools 37.0.1, platforms;android-36, build-tools;36.0.0 | `%LOCALAPPDATA%\Android\Sdk` (`sdkmanager` now hands over to Google's new `android` CLI: `android sdk install …`) |
| Gradle 8.14.3 (the wrapper's, downloaded on the first build) | `%USERPROFILE%\.gradle` |

No emulator (too heavy for this PC); the APK is tested on a real phone. Build it locally:

```
cd apps/android
npm ci
npm run apk:debug        # type-check, build the screens, cap sync, gradlew assembleDebug
# → apps/android/android/app/build/outputs/apk/debug/app-debug.apk
```

Built here on 2026-11-04: `app-debug.apk`, 9.1 MB, `com.zaptill.app` 0.1.0 (versionCode 1000), minSdk 29, target 36,
permissions INTERNET and REQUEST_INSTALL_PACKAGES; `ApkDownloaderTest` 6/6 (a mismatch kept → its test fails, checked).
The first build took ~14 minutes (Gradle's downloads); later ones about 30 seconds.

### 10.5 CI, signing and the release key

`.github/workflows/android.yml` runs on every push to `android`, on pull requests that touch the app, and on demand:
type-check and build the screens, the native unit tests (`ApkDownloaderTest`: the SHA-256 check, a mismatch keeping
nothing, the session never crossing hosts, only `ZapTill-x.y.z.apk` names), the **debug APK** always, and the **release
APK signed with ZapTill's key** when the key is in the repository's secrets (its certificate printed by
`apksigner verify --print-certs`, its SHA-256 beside it). The artifact is `zaptill-android` (kept 14 days). Nothing is
published yet: not in `release.yml`, no `android-v` tag (10.6). The cloud side runs in `ci.yml` (step "ZapTill for
Android, cloud side (Android Stage 0) and migration 189") and in the loop over every `tests/*.test.mjs`.

**The release key is the owner's alone.** It is never in the repository (`*.jks` and `*.keystore` are ignored under
`apps/android/android`), never printed, and reaches CI only as secrets, decoded into the runner's temporary folder for
the build and deleted after it. Losing it means every device must uninstall and reinstall (§1.4): keep it like the
Ed25519 technician key, two offline copies and the passwords in the password manager.

**One-time, by the owner** (on a PC with JDK 21 — the build PC has it; `keytool` asks for the passwords, so they never
appear in the command line or its history):

```
keytool -genkeypair -v -keystore zaptill-release.jks -alias zaptill -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=ZapTill, O=ZapTill, C=KE"
keytool -list -v -keystore zaptill-release.jks -alias zaptill
```

Note the second command's **SHA-256 certificate fingerprint**: CI prints the same one for every release APK. Then add
the four secrets (GitHub › the repository › Settings › Secrets and variables › Actions › New repository secret), or with
the GitHub CLI from Git Bash in the folder holding the key (`gh secret set NAME` without `--body` asks for the value, so
it stays out of the shell history):

| Secret | Value | With the GitHub CLI |
|---|---|---|
| `ANDROID_KEYSTORE_BASE64` | the .jks file, base64 | `base64 -w0 zaptill-release.jks \| gh secret set ANDROID_KEYSTORE_BASE64` |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password | `gh secret set ANDROID_KEYSTORE_PASSWORD` |
| `ANDROID_KEY_ALIAS` | `zaptill` | `gh secret set ANDROID_KEY_ALIAS` |
| `ANDROID_KEY_PASSWORD` | the key password | `gh secret set ANDROID_KEY_PASSWORD` |

A device with the **debug** APK cannot take the **release** APK as an update (different signatures): uninstall it first.

### 10.6 Publishing a version (by hand until the release step is added)

1. Set the version in `apps/android/package.json` (higher than the last one).
2. Run the **Android** workflow (with the secrets in place) and download `ZapTill-<version>.apk` from its artifact.
3. `gh release create android-v<version> ZapTill-<version>.apk --prerelease --title "ZapTill for Android <version>" --notes "…"`.
   GitHub records the SHA-256; the admin portal shows the release as complete within 5 minutes (or at once with **Refresh**).
4. Approve it per client in the admin portal (Updates › ZapTill for Android).

The release step (tag and upload from the workflow, like the desktop's `release.yml`) is added when the owner says the
first version is ready (batch releases).

### 10.7 What the owner checks (Stage 0's "done when")

1. Run migration **189** on dev (`migrations/189_android_approved_versions.sql`; additive, every client held). Until it
   runs the cloud answers "held" with a warning naming it, and the admin card says so.
2. Install the APK on a test phone or tablet (`docs/Manuals/ANDROID-INSTALL.md`): it shows **What is this device?**;
   after a choice, **Updates** says "ZapTill answered. Updates start once this device is joined to your business": the
   version answer. A build talks to `https://api.zaptill.co.ke` unless built with `VITE_API_URL` (for dev:
   `VITE_API_URL=<dev cloud> npm run apk:debug`).
3. **Reset app** brings the question back.
4. In the admin portal, a client's **Updates** tab shows the **ZapTill for Android** card (held on both surfaces; no
   release yet until 10.6 is done once).

### 10.8 Open items and decisions for later stages

- ~~**Till stage 1: the gates for an `android-till` session.**~~ Decided and built: the same as a desktop POS, each
  check extended to both surfaces — every place listed in §11.2.
- **A Stage 0 install never updates itself** (10.2 item 4): fine for test devices; say so to anyone given the APK.
- **A download link on our website** (§1.4) is not built; the admin portal's link is.
- **The release step** in CI (10.6).
- **Play Protect** may warn on the first install; the guide says what to tap. A Play Store listing for owner mode stays
  open (§1.4).

---

## 11. Till stage 1 — built (2026-11-05, branch `android`)

The online Shop POS (§5 "Till stage 1"): a technician joins the tablet — through the branch server or with the
enrolment code — staff sign in with their PINs, and they sell with **the web POS screens themselves** (one POS design,
the desktop as its base — owner, 2026-11-04), online only. Tickets print through the branch server when the tablet
joined one, else straight to the network printers. No migration.

### 11.1 What was built, and where

| Part | Where | What it does |
|---|---|---|
| Shop POS screens | `apps/android/src/screens/shop/` | **ShopPos** (not joined → joining; joined → the router on the web POS's own paths: `/pos` the PIN pad, `/pos/cashier` the web POS, `/pos/device` this tablet), **JoinScreen** (for the technician: name the POS; the branch server found on the network with its security code, or "Enter the enrolment code from ZapTill"), **PinScreen** (PIN pad; arriving there removes the last person's tokens), **ShopDevice** (business, branch, branch server, the receipt printer saved and test-printed, updates, Join again, Reset app), **NoConnection** ("No connection — can't sell", a cover that closes nothing: an order on screen survives a blip), **PrintNotice** (what did not print, in words). |
| The POS's own session | `src/shop/tillSession.ts` | `POST /api/auth/enrol/redeem` naming `surface: 'android-till'`, `device_role: 'till'`; the token pair, business and branch in the Keystore (`pos.session`), the device secret (`device.secret`); renewal a minute before expiry with the A477 ack; a refused session signs back in with the device secret (`/device-token`), else "a technician joins it again". One renewal at a time. |
| Joining through the branch server | `src/shop/branchServer.ts`, `BranchServerPlugin.java`, `PinnedTls.java` | The A427 beacon (UDP 4199, with Android's multicast lock), the server's certificate from `/node/tls` (a plain socket: the certificate is public), its **security code**, then `/node/join` and `/node/join/status` over TLS trusting that certificate **byte for byte** (A489). The grant's code enrols at **this app's cloud only** (a grant naming another cloud is refused — the desktop's A494 check). The server address, its certificate, the branch access code and this POS's device key there are kept in the Keystore (`branch.server`). A server without a certificate is not joined. |
| Staff PINs | `src/shop/pinSignIn.ts` | `POST /api/auth/verify-pin` with the POS's own session → the person's session (`pinSignIn`, surface `android-till`), handed to the web POS screens (`storeCashierSession`). Owners and managers use their PIN too, as at a desktop POS (§2). |
| The web POS screens, not copied | `apps/dashboard/src/shopPos/ShopPosScreens.tsx` (the ONE way in), `apps/android/vite.config.ts` | The app's bundle includes the dashboard's own CashierScreen and everything it opens. Their packages resolve from the app's `node_modules` (one React); the dashboard's Supabase client is swapped for a stub (`src/shop/supabaseStub.ts`: no Supabase address or key in the APK). Tailwind with the dashboard's own theme (`tailwind.config.cjs`). The app's strict type-check never reaches the dashboard's files: `src/env.d.ts` declares the three exports it uses. Capacitor's `CapacitorHttp` sends the screens' `fetch` through the native HTTP stack (no CORS entry). |
| The seam in the web POS | `apps/dashboard/src/lib/shopPos.ts`, `posTerminal.ts`, `localPrintServer.ts`, `printRouted.ts`, `api.ts`; `CashierScreen`, `ShiftModal`, `PaymentModal` | Set once by the app (`setShopPosHost`); in a browser nothing is set and nothing changes. On a Shop POS: the POS is **its own drawer** (no "Which POS are you selling on?", it covers no other POS, every request names it — `x-device-id`); whoever signs in sells into its running shift and an owner stays on the POS (as at a desktop POS); tickets go to the branch server first (`printOrder`), else as bytes to the network printer (`printBytes`). |
| Printing on the tablet | `src/shop/printing.ts`, `RawPrinterPlugin.java`, `RawPrinterSpool.java` | 11.4. |
| Print relay on the branch server | `apps/desktop/src/main/nodePrintRelay.ts`, `nodeServer.ts` (`POST /node/print`), `ipcHandlers.ts` (registers the server's own `queueThermal`) | 11.4. |
| Updates | `src/updates/updater.ts` | The update feed asked with the POS's own session (so the business's approval for `android-till` applies); a Shop POS updates only when its drawer is closed — asked of the cloud; when it cannot be told, it waits. |
| Cloud gates | `apps/server/src/lib/posSurface.ts` and the places in 11.2 | 11.2. |

### 11.2 The cloud's gates for an `android-till` session (decision taken: as a desktop POS)

`lib/posSurface.ts` says once which surfaces are a POS device's: `desktop` and `android-till`. Every place that keyed on
`desktop` was decided explicitly:

**Extended to the Shop POS (a gate):**

| Place | Gate | Now |
|---|---|---|
| `lib/terminalWrites.ts` | A159 terminal-write guard | Both surfaces. The POS's own session: the till's writes only. A person's PIN sign-in: + the manager screens' writes, + on a Shop POS only **`SHOP_POS_WRITES`** — the writes the web POS screens make live that a desktop sends through its sync push (open shift, a float or pay-out, clock in, parking sessions, the M-Pesa prompt, matching a C2B payment, a low-stock level). A desktop PIN sign-in is still refused those. `tests/android-till-stage1.test.mjs` reads every write in the web POS screens and fails when one is not covered. |
| `lib/cloudPlan.ts` `lapseGateApplies` | A581 lapsed plan | Both. |
| `lib/cloudPlan.ts` `backupGateApplies` | A601 desktop-only cut-off | Both — so a Shop POS of a business without the online licence cannot sell from the cut-off (it keeps nothing offline in stage 1); see the licence door below. |
| `lib/cloudPlan.ts` `accessRefusal` | A612 paused branch | Both. |
| `lib/cloudPlan.ts` `webGateApplies` | A584 web pause | Neither POS (each has the gates above). |
| `middleware/auth.ts` `branchPauseBlocked` | A612 branch narrowing | Neither POS (refused whole by `accessRefusal`). |
| `middleware/auth.ts` `requireWebSurface` | the web portal's features (reports, analytics, exports, attendance, loss alerts) | Both kept off — **except** a Shop POS's `GET /api/reports/eod` (`shopPosOwnRead`): the drawer's Z report at close, which the web POS screens read from the cloud (a desktop prints its own). |
| `lib/onlineLicence.ts` `desktopWithoutLicence` | premium features (activate a pump, loyalty points) | Both. |
| `routes/auth.ts` `/verify-pin` | the branch's POS licence (`desktop_licensed`) | Both — a tablet takes a POS seat (Q2). |
| `routes/auth.ts` `/verify-pin` | recording the POS (`registerDesktopTerminal`, role `till`) | Both. |
| `routes/auth.ts` `/verify-pin` | `pinSignIn` on the person's token (A159 tells a person from the device) | Both. |
| `routes/pos.ts` `/pos/init` | the branch's POS licence | Both. |
| `lib/tillSessions.ts` `sessionKind` | an owner's revoke never ends a POS's own session | Both are `device`. |
| `lib/webPosSignIn.ts` `dashboardSessionKind` | A608: never exchanged for a web POS session | Neither POS. |
| `lib/deviceGrant.ts` `buildDeviceTokenPayload` | the POS's own token | Takes the surface (`deviceSurfaceOf`: anything but `android-till` is `desktop`, so every desktop build is unchanged); `/enrol/redeem`, `/device-token` and the renewal carry it. |
| `routes/appUpdate.ts` `surfaceOfSession` | the update feed | A person's PIN sign-in on a Shop POS asks for `android-till` (never `mobile`). |

**New on the Shop POS's door:** `/verify-pin` from a Shop POS refuses a business without the online licence (403
`ONLINE_LICENCE_REQUIRED`, "A Shop POS tablet sells through the ZapTill cloud, which needs the ZapTill online licence") —
it would otherwise sign in and then have every sale refused from the A601 cut-off. Owner decision (11.6).

**Kept the desktop's (its protocol, not a gate)** — the Shop POS sells live through the web POS screens, so these answer
it as they answer the web POS:

| Place | Why it stays `desktop` |
|---|---|
| `routes/auth.ts` `offlineAuth` (the person's PIN hash) | Offline sign-in is Till stage 2; no PIN hash goes to a tablet now. |
| `lib/deviceGrant.ts` `isOwnerEraTillPayload` | Pre-A415 desktop sessions only. |
| `routes/orders.ts` `tillMadeSale`, the sale's own time (`created_at`, `soldAt`) | A desktop's offline replays; a Shop POS's sale is live, timed by the cloud. |
| `routes/orders.ts` SHIFT_CLOSED (a sale into a closed drawer) | A desktop sale may have been rung offline; a Shop POS is online, so it is refused and asked for a new shift, as the web. |
| `routes/orders.ts` the rider's fee paid from the drawer | The web POS has the cloud pay it; a desktop records its own pay-out. |
| `routes/orders.ts` credit sale source | `web` for a Shop POS (it sells through the web POS's routes). |
| `routes/shifts.ts` (close / confirm replays with their own times, the till's count, siblings' cash) | A desktop's replays; a Shop POS closes live, as the web POS (blind close, declared amounts, reasons). |
| `routes/sync.ts`, `routes/backfill.ts` | The desktop's sync push; Till stage 2. |
| `routes/modifiers.ts`, `routes/variants.ts` (the whole-menu shortcut) | A desktop's menu pull; the web POS screens ask per product. |
| `routes/reports-monthly.ts` (a desktop manager's monthly pack) | The desktop's manager screens; a Shop POS falls to `requireWebSurface` (refused). |
| `routes/wastage.ts` `fromTill` | The desktop's offline record fields. |
| `lib/drawerBell.ts` `webOnly` | A desktop's own writes reach its branch server; a Shop POS's people's writes ring the drawers like the web's. |
| `lib/liveHub.ts`, `lib/branchDrawers.ts`, `routes/pos.ts` (`/branch-staff`, `/join-code`, `/credit-customers`) | The desktop POS's and the branch server's own channels. |

### 11.3 Joining (by a technician)

The joining screen is worded for the technician. **Through the branch server** (recommended where there is one): the
tablet lists the servers it hears; the technician taps **Join the <name> server at <address>?**, compares the **security
code** with the server's screen, taps **Ask to join**, and someone at the server presses **Allow** — the desktop's A427
flow and its checks as they are (a request lives 10 minutes; a device already holding a key there is refused unless it
proves it; the notices are rate-limited). **Server side: nothing changed for joining** — a tablet's request is a POS's
request. **With the enrolment code**: the technician issues it in the admin portal (client › Branches › the branch ›
**Enrol POS**) and types the business ID and the code.

### 11.4 Printing — and two tablets on one printer

- **Through the branch server** (`POST /node/print`, behind the branch access code checked for every `/node/*` route and
  a **proven device key**, like `/node/verify-pin`): the tablet sends the whole ticket — the order as the desktop's own
  sale screen prints it — with a job (`receipt`, `kitchen`, `proforma` = Print bill, `void` = a kitchen void). The server
  prints it with **its own** stations, category routing, printer assignments (a USB printer on the server PC too) and
  spool: `nodePrintRelay.relayPrint` → `queueThermal` → `escposBridge.printSale` → `printWorker`, one queue per printer.
  The answer names any station with no printer, in words the tablet shows. The desktop's own sales are byte-for-byte
  unchanged (`queueThermal` is not touched; `apps/desktop/test/node-print-relay.test.mjs` compares the tickets).
- **Directly** (no server, or it did not print): the web POS screens render the ESC/POS bytes with `shared/printing` and
  route them by station from the branch's printers, exactly as on the web; the tablet sends them over TCP 9100. A
  printer's address is its name in the web dashboard's **Settings › Printers** ("192.168.1.50" or "192.168.1.50:9100");
  the receipt printer is set on the tablet (**This device › Receipt printer**).
- **Two tablets, one printer (pinch point 2):** on one tablet, a fair lock per printer sends one ticket at a time, in
  order; each ticket goes on **a connection of its own**, written whole and closed — nothing of another ticket ever
  shares it, so tickets cannot interleave on the paper. A second tablet finds the printer busy (refused or timing out) and
  waits a random **50–500 ms** before each of up to 6 tries. A ticket cut off half-way is never re-sent by itself (a
  second partial copy is worse). Through a branch server, the server's own spool serialises every tablet.
- A printer that is off is said in words ("The printer at 192.168.1.50 is not answering…"); the sale was saved in the
  cloud before anything printed — the cashier reprints from History.

### 11.5 How to test on hardware (the owner, or a technician)

1. Build and install the debug APK (§10.4; `VITE_API_URL=<dev cloud>` for dev). Choose **Shop POS**.
2. **Join with the code:** in the admin portal (dev), Enrol POS on a branch with a POS licence; on the tablet name it,
   type the business ID and code → the PIN pad shows the business and branch. The admin portal lists the POS.
3. **Join through a branch server:** reset the app, run a desktop in branch-server mode on the same Wi-Fi; the tablet
   lists it; compare the security codes; Allow at the server → joined. Check the server lists the tablet under its
   points of sale.
4. **Sell:** a cashier's PIN → open a shift with a float; ring a restaurant order with sizes, add-ons and a note; hold it;
   send to kitchen; take a split payment (cash + M-Pesa KES 1 only — the STK sandbox takes real money); see the
   after-payment screen; a kitchen void; close the shift blind with declared amounts. Repeat on a retail and a
   petrol-station business.
5. **Print:** (a) with the server: kitchen and receipt print on the server's printers; switch the server off → the next
   ticket prints straight to the network printer and the notice says so. (b) without: set the kitchen printer's name to
   its address in Settings › Printers and the receipt printer on This device; switch a printer off → the notice; the sale
   is in History.
6. **Two tablets, one printer:** ring and pay on both at the same moment, ten times — every ticket prints whole, none
   garbled; every sale reaches the cloud exactly once (the dashboard's Orders).
7. **No connection:** pull the router's internet → "No connection — can't sell" covers the screen; plug it back → the
   order on screen is still there.

### 11.6 What the owner checks, open items and decisions

- **No migration.** Run CI; build the APK (`.github/workflows/android.yml` now also runs `RawPrinterSpoolTest` and
  `PinnedTlsTest`); the hardware tests in 11.5. A branch server must run a desktop build with `/node/print` to print for
  tablets — an older one answers 404 and the tablet prints directly.
- **Decision — the online licence at the Shop POS's door** (built: refused without it). The tablet sells only through
  the cloud, and A601 refuses a desktop-only business's POS sales from the cut-off. Recommendation: keep it until Till
  stage 3 lets a tablet sell through a branch server.
- **Decision — printer addresses.** Directly, a printer's *name* in Settings › Printers is its network address; a branch
  that also prints from the web POS on a PC (the print bridge needs the OS printer name) cannot share one printer entry.
  Recommendation: a branch server for mixed branches now; a separate "network address" field on branch printers (a
  migration) when the first mixed client needs it.
- **Decision — the drawer's Reports tab** (`/api/reports/sales`) stays refused on a Shop POS like on a desktop
  (web-portal reports); only the Z report reads. Recommendation: keep.
- **Open:** the tablet sends no machine identity (A477 guid / serial), so its session is not bound to the hardware — Till
  stage 2 should send a hash of Android's device id. The web POS's **? Help** opens nothing useful in the app, and the
  customer display (A606) is not offered on a tablet. A web POS covering a POS skips the open-bill sold-out re-check
  (`routes/orders.ts`, a request naming a device) — a Shop POS does too. **Q4 (hardware)** stays open: Android 10+ tablets
  and generic network ESC/POS printers, nothing certified yet.
- **Not in stage 1:** offline selling (Till stage 2), selling through the branch server (Till stage 3), Bluetooth and the
  foreground print service (Till stage 4).
