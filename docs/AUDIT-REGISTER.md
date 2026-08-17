# SwiftPOS — Audit Register

**Living document.** The single tracker for audit findings: what is open, what is
closed, and what was checked and found correct. Update in place; do not fork.

| | |
|---|---|
| Opened | 2026-08-07 |
| Last updated | **2026-08-17 — A119 closed (admin portal: edit business + change owner email) · A118 closed (revoke till + rotate code + health chart) · A117 opened (admin-portal plan + glass mockup) · A116 opened (digital-signage design proposal — TVs/displays; doc-only, not scheduled; `docs/SIGNAGE-DESIGN.md`) · A115 closed (health monitoring + direct Supabase keep-alive) · A114 closed (tech reveal code: stable-per-branch, auto-provisioned, self-healing) · A113 closed (tech-access: retire v1 HMAC tokens + default secret) · A112 closed (register header reconciled to the tree) · A111 opened (standardise on Node 24 LTS) · A110 closed (recharts v2 deprecation resolved repo-wide) · A109 closed (green CI: node:sqlite offline test fixture) · A108 opened (Node 20→22 runtime + npm vulnerability sweep to 0 across all five apps; desktop Electron 35→43, BLOCKED on the two-till build per rule 9). NOTE: the header Tree line (0215475 / v0.5.27) and the Open/Counts lines still predate A99–A108 — reconcile on next reading. — 2026-08-14 — A12 FIX APPLIED (recipes.ts now reads live per-branch stock via branchScope, mirroring stock.ts — Recipes drawer no longer shows stale "0"; open pending live check). D18 opened (tech token pasted into the reveal field was truncated by maxLength/upper-casing — onPaste now routes a `st2.` token straight to the token step) — A73 opened (fleet-health "Terminals" page was built+routed but unreachable — nav-drift between two Setup defs; link restored) — A72 opened (devices owner-nameable via PATCH /devices/:id/label, persists across registration; bundled "not synced >1d" badge) — A71 opened (owner Settings→Devices enriched: branch, role, absolute last-active, version, enrolled date; device rename left as a decision) — A69 extended (batch enrolment codes: one call mints N single-use branch-bound codes, admin prompts "how many tills?"; reusable branch code declined — unbounded blast radius) and A70 opened (enrolled-device roster in admin: `GET /clients/:id/devices` + Overview card). Test now 29 checks, batch guard mutation-checked. — A69 opened (enrolment issuance relocated to the admin portal, branch-bound + licence-gated + owner-resolved; owner `/api/enrol/code` retired to 410; desktop InstallPage locks the bound branch; billing reuses the existing branch-licence invoice; 25-check test rewritten + mutation-checked). Desktop = one-off per branch, unlimited tills, no trial; web = recurring, annually billed, with a 2-week trial (unchanged, confirmed). — A68 opened (deploy env badge: dashboard + admin favicon/title, env-driven per Vercel project) and D17 opened (desktop dev/prod build flavour: amber DEV icon + `electron-builder.config.js` + runtime cloud-host title). Both OPEN pending owner action (Vercel vars) and a Windows install check; see MANIFEST-2026-08-14-a.md. D3 gains a dev-channel note. — 2026-08-13 — session: D11 closed; A66 opened+closed (`LOCAL_SCHEMA_VERSION` 51→52); A67 closed. D4 implemented end-to-end (enrolment codes migration 81 + proven; issue/redeem endpoints; desktop InstallPage now Business ID + code) — OPEN pending one live test, closes D1 when it passes. D7 rollout advanced: shared IPC validator now on `escpos:setKitchenExclusions`, `auth:verifyPin`, `order:void`, `auth:enrolDevice` — ~132 channels remain, `order:create` deliberately not done blind; stays OPEN. D3 auto-update scaffold + runbook — stays OPEN. Windows render smoke-test still outstanding (A43).** |
| Tree | `dev`, post-A111 (last pushed `d70fa0e`; this edit commits on top), desktop **v0.5.34**, `LOCAL_SCHEMA_VERSION` **52**, web/cloud runtime **Node 24**, desktop **Electron 43** |
| Open | **A: 1 P0 · 9 P1 · 6 P2 · 5 P3 — D: 1 P0 · 2 P1 · 2 P2 · 3 P3** (re-derived from the body by `check-register-consistency`, not hand-counted) |
| Counts | A-P0: A17 · A-P1: A54 A18 A19 A20 A24 A3 A4 A12 · A-P2: A22 A23 A53 A8 A69 A73 · A-P3: A13 A68 A70 A71 A72 — D-P0: D1 · D-P1: D3 D4 · D-P2: D7 D18 · D-P3: D9 D10 D17 |
| Reconciliation 2026-08-17 (A99–A111) | The **Open** and **Counts** rows derive from the §A/§D open-item sections (A1–A73 + D-items) and remain accurate: **A74–A111 are recorded in the Changelog and were near-all closures**, so they add no open items. The current authoritative open list is `HANDOFF-2026-08-17.md` §7. Specifics: the open **P0 A17** (offline-auth day-15 lockout) is now carried by its built-but-**hardware-pending** fix **A99–A101** (two-till sign-off per PHASE5 §8) — so the P0 is a *fix awaiting verification*, not an unstarted finding; **A19/A20/A24** stay P1, blocked on that sign-off. **A108/A110/A111** moved the web/cloud runtime Node 20→22→24 and brought all five apps to **0 npm vulnerabilities** (shipped, CI green); the **desktop Electron 35→43** upgrade is merged but pending the same two-till build before any prod till. |
| Header correction | The previous header said **0 P0** while §A listed **A17 as `P0 · OPEN`** — the day-15 lockout, hidden by its own count. Re-derived by reading §A: A17 is the one open P0 (A1 struck). |
| Closed 08-10 (late) | **A5 · A6 · A9(triage) · A47 · A48 · A50 · A51 · A52 · D6.** A43 deletion ATTEMPTED AND REVERTED — it drops the only guard on a live field bug; see the entry. Corrected: A1 split, A7 re-characterised, A9 closed as never-true, A10 reopened, A12 raised to P1, A39 down to one document. Opened: **A49 · A53**. |

**Counts above were re-derived by reading this file, not carried forward.** The
previous header said 5 P2 where section A listed 3, and said `415e044 + this
session's work` for work committed at `a80c224`. A header that disagrees with its
own body is the same failure the register exists to catch.

**Every correction on 2026-08-10 (late) was verified by running or reading the
tree, never by reading this file.** Where the two disagreed, the tree won and the
entry says what was measured.

**Header corrections, 08-08.** The previous header said `415e044 + this session's
work`; the work is committed at `a80c224` (59 files, not 58). It said the counts
were 5 P2 where section A lists 3. **C6, E1-E4, F, G1-G2 and H1-H2 appear in the
changelog as opened and have no entry anywhere in this file** — lost in the 08-08
restructure. They are neither open nor closed; they are missing. Recover from
`git show 415e044:docs/AUDIT-REGISTER.md` before the next session re-audits them.

`HANDOFF-2026-08-08.md` stated desktop v0.5.24 while `apps/desktop/package.json`
said 0.5.23. Bumped to 0.5.24 — then `release:patch` bumped again during the
build, so **the shipped artifact is `SwiftPOS-0.5.25-x64.exe` and the tag is
`v0.5.25`**. `v0.5.24` was deleted: no installer exists for it, and a tag
pointing at a version you cannot produce is worse than no tag.

**Rule learned: the tag follows the build, never precedes it.** `release:patch`
runs `npm version patch`, so the version is decided BY the build. With no
auto-update the tag is the only record of which source produced the `.exe` on a
given till.

**Working rules** live in `HANDOFF-2026-08-08-evening.md` §0 — standing, not
per-session. Rule 14 is the one this file depends on: nothing ships without an ID
and an entry here, in the same change as the code.

**Rules 21-23 added 2026-08-10.** 21 (owner): say **node** or **cloud**, never
"server" on its own. 22: a delivery zip carries the change, never the version —
a zip overwrote a version bump and produced two different binaries with the same
number. 23: mutation-check the GATE, not only the fix — both gates written that
day failed their own first version, one silently. Two machines answer to that word and it has already cost an
afternoon. `getServerUrl()` returns the CLOUD url and should be renamed.

**Rules 17-20 added 2026-08-09** (owner): assume it is already built halfway and
sweep before designing; zip only when code changed; nothing but `README.md` in
the repo root; be sure before proceeding, and never loosen a gate to accommodate
your own change. Rule numbers are stable and never reused — 17-20 append rather
than slot in, because 9, 10, 14 and 15 are cited by ID throughout this file.

**How to use this.** IDs are stable and never reused. Closed items keep their
entry — half the value of this file is stopping the next session re-auditing
ground already covered. New findings append with the next free number.

**Method.** Every item verified by reading or running source, not by reading docs.

**Severity.** **P0** money/data loss or a false-confidence trap · **P1** wrong
numbers or silent divergence · **P2** correctness residue · **P3** hygiene.

---

## Status at close of session

```
server tsc  OK   dashboard  OK   desktop main  OK   desktop renderer  OK

check-schema-drift    OK   check-ipc-parity      OK   (126/126)
check-supabase-catch  OK   check-shared-sync     OK
check-rls-coverage    OK   check-table-usage     OK   ← new, proves B6
check-sql-binds       OK   check-client-parity   OK   ← new, proves B5
check-own-rows        OK   check-row-attribution OK

offline suites        17/17
print resilience      51/51
printing package      spooler 18 + tickets 30, all passing
sample output         byte-identical to SAMPLE-OUTPUT.txt
```

58 files changed across the session.

---

## TOMORROW — before shipping

Agreed plan, in order:

1. **Run a full service on 0.5.25** with thermal on. Nothing below matters more
   than one real trading period.
2. **Final code review** — business logic, error reporting, UI logic.
3. **Remove HTML printing.** Only after 1 and 2. See P-06 for exactly what goes.
4. **Then** the register's remaining P0/P1 items.

---
## A. OPEN — carried into tomorrow

### A1 · P0 · **CLOSED 2026-08-11 — packaging closed 08-10, rotation confirmed by owner**
**Owner, 2026-08-11: the key was rotated long ago.** That was the only half
outstanding. Entry retained in full below because IDs are never reused and the
packaging reasoning is still load-bearing.

This entry contradicted the rest of the file. §E and §4 of
`HANDOFF-2026-08-08-evening.md` both record the packaging fix as closed, while
this section still read OPEN. Verified 08-10:

```
package.json:10  "package":       "git archive --format=zip HEAD -o pos.zip"
package.json:11  "package:check": "node scripts/check-package.mjs"
scripts/check-package.mjs           present
```

`git archive` honours the index, so an ignored file physically cannot enter the
archive. **The packaging half is closed.** Two independent CI gates back it: the
tracked-`.env` assertion and gitleaks, and since 08-10 the `.env` check runs
FIRST so an action crash cannot skip both (A35).

**What remains open is the ROTATION half, and it is not a code question.**
`SUPABASE_SERVICE_ROLE_KEY` was exposed in a packaged zip on 2026-08-08. The
evening handoff's first "before anything else" item was to confirm it had been
rotated. **No document in this repo records that it was.** The script prevents
the next leak, not the last one. Until someone confirms the rotation in writing,
treat a P0 credential as live in an artefact that left the building.

### A54 · P1 · OPEN (blocked on the owner) · Mail still undelivered — and A50's recorded diagnosis was wrong
**Third recurrence of A50.** Production log, 2026-08-10 20:57 UTC, on `dev`
@ `0215475`:

```
[mailer] RESEND_API_KEY not set — SMTP is the ONLY path…
[mailer] SMTP FALLBACK IS DEAD — smtp.gmail.com:587
         (pinned to 74.125.195.108) — Connection timeout
```

**The A50 fix worked.** `74.125.195.108` is IPv4, so `resolveSmtpIPv4()` reached
the socket and the ENETUNREACH half is genuinely closed. **The timeout survived
it**, which falsifies the claim written into `mailer.ts` and into
`mailer-transport.test.mjs`'s header:

> *"`Connection timeout` in the same run is the same fault on a different IPv6
> route… **Not two problems; one.**"*

It was two. One is fixed; the second was never diagnosed, and the comment told
every future reader there was nothing left to find. That is a false-confidence
trap in the P0 sense of the severity scale, sitting in the file whose whole
purpose is that a dead mail path announces itself.

**Cause of the surviving half.** A connect-layer timeout against a valid IPv4
literal is a dropped SYN — the port is filtered upstream. It is not DNS, not
TLS, not credentials. Render blocks outbound 25/465/587 on **free** web services
(25 on every plan; they run on EC2). `render.yaml:8` declares `plan: starter`,
on which 465 and 587 are permitted.

**So the repo and the running instance disagree, and the repo cannot settle it.**
`render.yaml` also declares no `branch` and no `autoDeploy`, yet the deploy log
reads `Checking out commit … in branch dev` — so this service is dashboard-managed
and the blueprint is not proof of what runs. §L's shape again: two things that
must agree, with nothing comparing them.

**Owner decision, 2026-08-10: Gmail SMTP is the LIVE path, Resend later.** So
SMTP is not a fallback today and must work on its own. The provider order in
`sendEmail()` already matches that intent (Resend when keyed, SMTP otherwise)
and was **not** changed.

**Shipped in this batch — none of it can open a filtered port:**
- the falsified comment corrected, with the production evidence that disproved it;
- `classifySmtpFailure()` — the boot check printed one ENETUNREACH-shaped hint
  for every failure, which is how a timeout got read as more DNS trouble. Now
  routes by class: timeout → filtered port, check the instance plan; ENETUNREACH
  **on a v6 literal** → the pin regressed; EAUTH → Gmail App Password;
  ECONNREFUSED → wrong host/port; TLS → `servername`;
- an alternate-port probe (587↔465) that reports which port answers.
  **Diagnostic only** — `sendEmail` never passes the override, asserted, and
  mutation-checked by making it pass one;
- `secure` now follows the *effective* port. Probing 465 while `secure` still
  read `SMTP_PORT === 587` would hang and report "465 fails too" — a probe
  lying in the direction that hides the fix.

**BLOCKED ON THE OWNER — no code change reaches these:**
1. Confirm the live instance type in the Render dashboard. If Free, that is the
   whole cause; upgrade, or move mail off SMTP.
2. `SMTP_PASS` must be a 16-character Gmail **App Password**. An ordinary account
   password fails at AUTH once 2FA is on — the next failure after a port opens.
3. `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` are `sync: false` in `render.yaml`;
   nothing in the repo can confirm they are set.

**Still open after this batch**, and deliberately not built (rule 12 — it grew a
third concern): **nothing reports a failed DELIVERY.** `reportMailReadiness`
proves a socket opens at boot; `dailySummary.ts:61` still catches per business,
logs and moves on. Nine businesses went undelivered across **three distinct root
causes** without the product ever saying so. A boot check is not a delivery
check. Recommend a `mail_deliveries` outcome row or a per-run summary line — a
decision, not a chore, so it is recorded rather than slipped in.

**2026-08-12 — the SCHEDULING layer of this feature was fixed separately; see
A65.** The enable-toggle never persisted (missing read route) and the sender
ignored the schedule entirely; both are fixed and verified. That is orthogonal to
this entry. A54 is the TRANSPORT — mail that never leaves the instance because
the SMTP port is filtered — and it STAYS OPEN, blocked on the three owner checks
above. A correct scheduler still sends into a filtered port.

**2026-08-13 — the live log settles it: SMTP is dead on this host, use Resend.**
Boot log on `swiftpos-server.onrender.com`:

```
[mailer] RESEND_API_KEY not set — SMTP is the ONLY path…
[mailer] SMTP IS DEAD AND IS THE ONLY PATH — smtp.gmail.com:587
         (pinned to 172.253.117.109) — Connection timeout
[mailer] …and port 465 fails too: Connection timeout. Both submission ports
         blocked is the signature of the host filtering SMTP outright.
```

`172.253.117.109` is IPv4 — the A50 pin still holds. **Both 587 AND 465 time
out**, which is the both-ports signature the diagnostic added for: not a wrong
`SMTP_PORT` to toggle, but the host filtering SMTP outright. That falsifies the
2026-08-10 owner decision to run Gmail SMTP as the live path — it cannot work on
this instance. The viable path is **Resend** (HTTPS/443, which Render does not
block, and which is why the code has it as primary): set `RESEND_API_KEY` and a
`NOTIFY_FROM_EMAIL` on a *verified* domain (not free-mail — the code warns on
that). Still OPEN, now blocked on that Resend config rather than on an SMTP path
that has been shown three times over not to exist here.

**Verification tool added (08-13).** `POST /api/notifications/test-email`,
owner-only (`req.isOwner`), sends ONE real message to the owner's OWN address via
a new `sendEmailChecked()` in `mailer.ts` that RETURNS the outcome (provider that
delivered, or the exact provider error) instead of logging and swallowing it like
the fire-and-forget `sendEmail` the jobs use. So once Resend is keyed in, the
owner can prove delivery on demand — `{ ok: true, provider: "resend" }` — rather
than inferring it from the boot log. Self-only recipient, so no spam vector.
Pinned by `tests/mailer-transport.test.mjs` §7 (8 assertions); server `tsc` clean.
This does NOT close A54 — it is the tool to confirm the fix once the owner sets
the key. The delivery-outcome recording recommended above is still not built.

### A56 · P1 · CLOSED 2026-08-11 · The permission comparator exists — `check-permission-parity`
The gate A45 asks for and A46 is blocked on. **Built before the split, not after**,
which was the whole point: 45 route gates and every UI gate that mirrors them are
about to be re-pointed, and without a comparator the two sides drift again while
being changed.

Compares **three** surfaces, not the two A45 names:

| Surface | Read from | Count |
|---|---|---|
| ENFORCED | `requirePermission('k')` in `apps/server/src` | 13 keys, 84 files |
| REGISTERED | `INSERT INTO permissions` in `migrations/` (archive excluded) | 8 keys |
| UI | `hasPermission('k')` · `can('k')` · `permission: 'k'` | 10 keys, 148 files |

**Ratcheted, not pass/fail.** The ground is not green — 6 unregistered, 6 ungated,
2 phantom. A gate that is red on day one gets switched off, which rule 23 names as
worse than no gate. Semantics copied from `typecheck-ratchet.mjs` (rule 17 — this
repo had already solved this problem): rising fails, **and so does falling**, so a
fix must lower `scripts/permission-parity-baseline.json` rather than be absorbed
silently.

**What it will not do:** decide whether a UI gate is CORRECT — that the tab behind
`hasPermission('x')` is the same action the route enforces. A source scan cannot
know that. It answers the narrower question honestly: is the same key named on both
sides, and does it exist at all. A45's fault fails the second question alone.

**Three defects in my own gate, caught before it shipped:**
1. It walked `migrations/archive/**` — files that are **never run** — and reported
   `printers.manage`, `printers.view` and `ingredients.view` as registered on the
   strength of superseded legacy migrations. A49's shape precisely: a false claim
   in the position where a false claim silences the gate. Counts were unaffected
   (none is enforced); the correctness was the point.
2. Phantom keys were written as a **hard fail on the assumption that there were
   none**. There are two (A58). Measurement corrected the assumption; ratcheted.
3. Its first mutation check passed because the mutation used an *alias*
   (`requirePermission as _rp`), which the scanner correctly does not match — my
   mutation was wrong, not the gate. Re-run with a literal call: red, naming the key.

**Mutation-checked (rules 10, 23), each mutation confirmed present first:**
new route on an unregistered key → `UNREGISTERED ROSE: 6 -> 7` naming
`audit.export` · misspelt UI key → `UNGATED ROSE` + phantom listing ·
**seeding a missing key → `UNREGISTERED FELL: 6 -> 5`, asking for a lower
baseline** · and `stripComments` proven load-bearing: raw source yields a phantom
key `x` from a comment at `asyncHandler.ts:54`.

**A57 — the original finding, as opened by check-permission-parity.** Retained verbatim; its closure by migration 75 is recorded in the A57 entry below.
Found by A56 on its first run. The chain is three links and every one is in the tree:

```
role_permissions.permission_id -> permissions.id     FK, 00_baseline.sql:5212
requirePermission allows on isOwner | '*' | key      rbac.ts:20  (fails CLOSED)
```

A key with no `permissions` row can never be attached to a role, so it can never
reach `req.permissionKeys`, so **the route is owner-only and nothing says so.**

| Key | Routes | Seeded by any migration? |
|---|---|---|
| `products.manage` | 29 | **no** |
| `settings.manage` | 16 | **no** |
| `staff.manage` | 6 | **no** |
| `expenses.manage` | 6 | **no** |
| `expenses.view` | 3 | **no** |
| `orders.void` | 2 | **no** |

**READ THE SCOPE CAREFULLY. This does NOT say 62 routes are broken in production.**
The live `permissions` table is almost certainly seeded — these are the oldest keys
and `00_baseline.sql` is a schema-only dump with no INSERTs. What it says is that
**the repository cannot rebuild a working permission set**: a new tenant, a staging
rebuild, or a PGlite migration test produces a database where a manager cannot be
granted any of them. That is the A4 shape — migrations under-represent production —
and it is unfalsifiable from the repo alone, which is why it got a gate and not a fix.

**Not fixed here, deliberately.** The fix is a seed migration, and (a) rule 13 asks
whether a release is in flight, (b) it must not conflict with rows production may
already hold, and (c) A46's split is about to add seven more keys — seeding twice
is how two copies drift (rule 17). **Do it as part of A46, in one migration.**

**VERIFY IN PRODUCTION FIRST** — this is the query that settles it, and nothing in
the repo can:
```sql
select key from public.permissions
where key in ('products.manage','settings.manage','staff.manage',
              'expenses.manage','expenses.view','orders.void')
order by key;
```
Six rows: production is fine and this is a repo-rebuild gap only. Fewer: those
routes are owner-only in the field right now, and A45's "grant the role
`settings.manage`" unblock **cannot work**, because the key cannot be granted.

**A58 — the original finding, as opened by check-permission-parity.** Retained verbatim; the fix is recorded in the A58 entry below.
Found by A56's phantom check. `ManagerDashboard.tsx` `NAV_ITEMS`:

| Nav item | Gated on | Enforced by cloud? | In any migration? |
|---|---|---|---|
| Orders (`:68`) | `orders.view_all` | no | no |
| Turnover (`:73`) | `orders.view_all` | no | no |
| Inventory (`:69`) | `inventory.view` | no | no |

`hasPermission` is `session.permissions['*'] === true || session.permissions[key]
=== true` (`POSAuthContext.tsx:134`). A key with no `permissions` row can never be
granted, so **the gate is always false for anyone who is not the owner** and
`visibleNav` (`:1191`) drops all three.

This is A45 inverted and arguably worse: A45 shows a manager something the cloud
then refuses, so at least they see it and get an error. Here **three tabs are
simply not there**, with no error, no log, and nothing to report.

Same caveat as A57 and the same query settles it: if production seeds
`orders.view_all` and `inventory.view` and grants them to the manager role, the
tabs appear and this is a repo-rebuild gap. If it does not, no manager has ever
seen Orders, Turnover or Inventory. **Ask the owner whether managers can currently
open those three tabs** — one answer, thirty seconds, and it decides the severity.

### A57 · P1 · CLOSED 2026-08-11 · Registered by migration 75
Six keys covering ~62 routes now have `permissions` rows, so a role can actually
be granted them. `ON CONFLICT (key) DO NOTHING`, so it is a no-op where
production is already seeded — which is why it did not need to wait on the
production query, contrary to what the `-b` manifest said. That deferral was
over-cautious: migration 24 and 49 had already established the idempotent
pattern, and rule 17 should have found it sooner.

**Proven against real Postgres**, not read: `scripts/test-migration-75.mjs`, 11
assertions under PGlite, including that the migration runs twice with no
duplicates and that a row pre-existing with production's own label **keeps that
label** (DO NOTHING, not DO UPDATE). Mutation-checked: flipping to `DO UPDATE`
turns that assertion red.

**Still worth running in production**, because it decides whether this was ever
a live fault or only a rebuild gap:
```sql
select key from public.permissions
where key in ('products.manage','settings.manage','staff.manage',
              'expenses.manage','expenses.view','orders.void');
```

### A58 · P1 · FIX SHIPPED 2026-08-11, CONFIRMATION WANTED · Three manager nav items
Migration 75 registers `orders.view_all` and `inventory.view` and grants them to
manager / supervisor / branch_manager / admin / owner, following migration 49's
precedent and its stated reason: *a permission nobody holds gets granted to
everybody within a week*. Orders, Turnover and Inventory should now appear.

**This is the one behaviour change in migration 75, and it is separated into its
own block so it can be deleted before running.** Turnover shows branch revenue.
If a branch manager is not meant to see branch revenue, drop that block — the
keys stay registered and the tabs stay hidden. Revert line is in the migration.

### A45 · P1 · CLOSED 2026-08-11 (cloud side) — one grant away from fixed
`POST /business/settings` now accepts `receipt.manage` **or** `settings.manage`,
and narrows PER KEY inside the handler: anyone without full settings access may
write only `receipt_header` and `receipt_footer`.

**Why per-key and not a route swap.** That one handler writes every setting,
including `supervisor_pin` (bcrypt) and ENCRYPTED_SETTING_KEYS
(`mpesa_consumer_secret`, `mpesa_passkey`, AES-256-GCM). Widening the route gate
alone would have handed a manager the supervisor PIN and the merchant's M-Pesa
credentials. The guard is an ALLOW-LIST and runs **before** both branches —
asserted by index comparison, and mutation-checked by moving it below the bcrypt
branch, which turns that assertion red.

**No desktop change was needed.** `ReceiptTextTab` writes exactly those two keys
(`ipcHandlers.ts:1591-1592`), and the tab is already listed for managers. The
tab was never wrong; the cloud was.

**ONE STEP LEFT, and it is yours:** grant `receipt.manage` to the Manager role in
the dashboard Roles screen. The key was registered by migration 75, so this is a
tick-box, not a migration. Until then no one holds it and the tab still refuses.

**Not granted by migration, deliberately** — same reasoning migration 75 used for
A46's keys: which roles may edit what a customer sees on a receipt is a business
decision, and a migration is the wrong place to make it silently.

### A59 · P1 · CLOSED 08-13 · The till gates on ROLES; the cloud gates on PERMISSION KEYS
Found while closing A45, and it is the reason A45 happened rather than a detail of it.

`apps/desktop/src/renderer` contains **no permission-key plumbing at all** —
`grep -rn "permissionKeys\|hasPermission" apps/desktop/src/renderer` returns
nothing. Every till gate is a role test: `ManagerPage.tsx:1046`'s `isManagerRole`
decides Receipt, Close Day, Close Branch, Prices, Staff and the rest. The cloud
decides the same actions with `requirePermission` / `requireAnyPermission` on
seventeen keys.

So the two sides are not two gates disagreeing about one key — they are **two
different vocabularies**, with no translation and nothing comparing them. §L in
its purest form, and the most consequential instance found so far:

- A45 is one visible symptom. There are 14 role-gated tabs on that page and any
  of them can disagree with the cloud the same way.
- `check-permission-parity` **cannot see the till at all.** Its UI surface scan
  covers `apps/dashboard/src` and `apps/desktop/src/renderer`, and finds zero
  keys in the latter — so every till gate is invisible to the comparator built to
  catch exactly this.
- Granting a manager a narrow key changes what the CLOUD allows and nothing about
  what the till SHOWS. The two will keep drifting as A46 continues.

**Not fixable in a batch.** It needs permission keys delivered to the till (they
are not in the staff token today), a `hasPermission` on the renderer, and the 14
gates re-pointed — with the offline case decided, since a till that cannot reach
the cloud must still decide what to show. **Design decision first, then a phase.**

**UPDATED 2026-08-12 — the diagnosis above was written from a grep and is partly
stale; verified against source.** The plumbing already exists: `verify-pin`
returns `permissions` as a `Record<string,boolean>`, the main process caches it
for offline (`pinCache.ts`) and delivers it to the renderer, and
`ManagerPage.tsx:1030` already has `has(key) = perms['*'] || perms[key]` —
identical to the dashboard and cloud. **The offline case is therefore already
decided** (`has()` reads the cached map). The real work was re-pointing the four
gates still on the coarse `isManagerRole`:

- **Receipt → `receipt.manage || settings.manage`** — matches the cloud
  (`business.ts` `requireAnyPermission('receipt.manage','settings.manage')`); the
  A45 symptom, closed in the till. Grant via migration 78.
- **Printers -> `stations.manage`.** Migration 79 grants that key to the manager
  roles (registered by 75, it had been granted to no one and enforced nowhere —
  the "printers hid inside settings" dead key). The till Printers tab now gates on
  it and the cloud station routes enforce it additively
  (`requireAnyPermission('stations.manage','products.manage')`). Additive and
  verified (`test-migration-79`, 8 assertions; parity green; both tsc clean). This
  is the first batch of the permission-model decision (`docs/permission-model.md`).
- **Close Day / Close Branch — left on the role gate deliberately.** The code
  states they are cash operations that *"must not hide behind settings.manage"*,
  gated on `dayService.isManager()`. Re-pointing them would be a design change.

Two cloud-side inconsistencies surfaced and are **not** fixed here: `stations.manage`
is enforced on no route (stations CRUD uses `products.manage`), and
`POST /shifts/:id/force-close` gates on `settings.manage`, not the registry's
`shifts.force_close`. **Done this session:** `check-permission-parity` extended to
scan the till's `has()` helper (four keys now visible where zero were, baseline
unchanged), and the renderer typechecks clean (`tsc --noEmit`, exit 0).
**Grant now proven on the bench (08-13).** The one benchable gap — whether
migration 78 actually grants `receipt.manage` to manager AND supervisor AND
branch_manager, or those roles silently lose the Receipt tab — is closed:
`scripts/test-migration-78.mjs` runs 78 against real Postgres (PGlite), 7 checks,
**mutation-checked** (drop `branch_manager` from the grant set and two assertions
fail). It confirms all three manager-type roles are granted, the normalised match
catches "Branch Manager" with a space (A61), the grant is additive (an unrelated
Cashier grant is untouched) and idempotent, and — since 78 does not self-register
the key — that 75 must run first or the grant is inert.

**Closed on the same basis as A66/A43:** the permission model is proven (the grant
test, the `has()` gate, `check-permission-parity` now seeing the till), only the
render is not. **The one remaining step needs Windows:** sign in on a real till as
a manager holding `receipt.manage` and confirm the Receipt tab appears and Save
succeeds (the A45 loop). Two cloud-side inconsistencies surfaced here are OUT of
this finding's scope and recorded in the working note for a later pass:
`stations.manage` is enforced on no route (station CRUD gates on `products.manage`),
and `POST /shifts/:id/force-close` gates on `settings.manage` not the registry's
`shifts.force_close`. Full working note: `docs/A59-till-permission-keys.md`.

### A55 · P1 · CLOSED 2026-08-11 · `total_spent` was the last racy write on the customer row
`orders.ts` updated `customers.total_spent` by SELECTing the value and writing
back `current + amount`, in three places: order paid (`:800`), order voided
(`:1323`), payment recorded (`:1869`). Two tills serving the same customer at
once both read the old value and both wrote their own total, so one sale
silently vanished from lifetime spend and from every RFM / CRM segment built on it.

**It was the odd one out, which is what makes it a defect rather than a
tradeoff.** `loyalty_points` and `visit_count` on the SAME row have been atomic
since migration 53, and `awardLoyaltyPoints` calls that RPC about twenty lines
above. `adjust_product_stock`, `apply_credit_transaction` and
`increment_discount_usage` are RPCs for the same reason — the 08-08 session
converted three racy stock writes deliberately. The comment here read
*"inline — no RPC dependency"*, which was true and was the problem.

**Migration 77** adds `increment_customer_spend(uuid, numeric)` (signed, so the
void subtracts; floored at 0) and `adjust_customer_visits(uuid, int)`. Kept
separate for migration 67's stated reason: a payment recorded against an
existing order adds spend WITHOUT counting a second visit.

The void path wrote all three columns in one read-modify-write, so it now makes
three RPC calls — `adjust_loyalty_points` (migration 67, already existed),
`increment_customer_spend`, `adjust_customer_visits`. A partial fix would have
left a racy write in the same statement and read as if it had been handled.

**Proven by racing it, not by asserting about it** (`scripts/test-migration-77.mjs`,
13 assertions): the OLD shape banks 100 + 250 and records **250**; the new shape
keeps 350; twenty concurrent increments of 50 all land. An assertion that only
read the SQL would have passed against the racy version too.

**Also fixed in passing:** the void path's customer update had no
`.eq('business_id', …)`, unlike the other two writers. Safe because `order` was
fetched business-scoped, but it was the odd one out; the RPCs take the customer
id alone, so the inconsistency went with it.

### A60 · P1 · CLOSED 2026-08-11 · The register disagreed with itself — now gated
This file's preamble says *"a header that disagrees with its own body is the same
failure the register exists to catch."* It then did exactly that, twice over:

- **The header claimed `0 P0`** while §A carried `A17 · P0 · OPEN` — the day-15
  lockout, hidden by the count that decides what gets worked on next.
- **Ten audit IDs had two `###` headings each** — A4, A9, A25, A45, A46, A47,
  A50, A57, A58, D8, D14 — several with contradictory statuses. A57 said both
  OPEN and CLOSED in the same file.

**THREE OF THOSE DUPLICATES WERE CREATED ON 2026-08-11 BY THE SESSION THAT
CLOSED THIS ITEM** (A45, A57, A58), hours after criticising the same failure in
the same file. That is the argument for a gate rather than more care: at 2,200
lines, reconciling this register by reading is a session's work nobody schedules.

`scripts/check-register-consistency.mjs` now checks (a) no ID has two headings
and (b) the header's open P0–P3 counts match the body. All ten duplicates merged
into single authoritative entries, with the superseded text retained in place as
a labelled note rather than deleted. Header re-derived from the body, not
hand-counted.

**It deliberately does NOT check whether a status is TRUE** — whether something
marked CLOSED really is. Only running the code can tell you that, and a gate that
appeared to check it would be worse than one that admits it does not (A49).

**Also ratchets A53** (see that entry): 21 orphan audit-ID citations, may shrink,
may never grow.

### A61 · P1 · CLOSED 2026-08-11 · Role grants missed any business that typed the role name with a space
**A bug shipped by this session in migration 75, found by running the A58
verification query against a seeded database.**

`roles.name` is free text and per business (`roles.business_id` is NOT NULL).
Migrations 24, 49 and 75 all grant on:

```sql
lower(r.name) IN ('manager','supervisor','branch_manager','admin','owner')
```

A business that typed **"Branch Manager"** with a space never matched
`branch_manager` and silently received no grant. No error — the staff member
simply cannot receive stock, and the manager dashboard simply has fewer tabs.
The A58 shape exactly, which is how it surfaced.

**One bug in three migrations.** 24 shipped 2026-07 and 49 shipped 2026-08, so
`inventory.receive` and `inventory.transfer` have been missing from such a role
since then.

Fixed at source in 75 and backfilled by **migration 76** for the rows 24, 49 and
the pre-fix 75 already missed. Normalised with `lower(replace(name,' ','_'))` —
the SAME five names with punctuation variance. Deliberately NOT widened to
`ILIKE '%manager%'`, which would sweep in names nobody has looked at ("Trainee
Manager") and hand them stock and revenue access as a side effect of a backfill.

**76 restricts itself to roles whose NORMALISED name matches but whose RAW name
did not**, so it touches only the rows the bug skipped rather than re-deriving
every grant. The migration carries a SELECT showing exactly who is affected —
run it first if you want the blast radius before committing.

### A62 · P1 · CLOSED 2026-08-11 · Migration 76 failed in production — one unqualified table name
**Reported from the field, 2026-08-11:**

```
ERROR:  42P01: relation "role_permissions" does not exist
LINE 46: INSERT INTO role_permissions (role_id, permission_id)
```

The table exists. The session's `search_path` did not include `public` —
Supabase's hardened default in several contexts. **Line 46 was the only
unqualified name in the file**: every other reference was written
`public.…`, including one to the SAME table eleven lines below, inside the
`NOT EXISTS` guard. Mixed qualification in a single statement, shipped by this
session in batch `-e`.

**Reproduced before fixing** (`SET search_path TO ''` under PGlite), then all
three of 75/76/77 re-run under both `search_path = public` and `search_path = ''`
with identical results.

**Fixed by qualifying every table reference in 75, 76 and 77.** 77 was already
fully qualified. 75 was fully UNqualified, which is worth noting: it inherited
that from migrations 24 and 49. It would have failed the same way in the same
session — so if 75 appeared to succeed earlier, it ran somewhere with `public`
on the path, and its section 3 grant should be re-verified.

**The lucky failure, and the one to fear.** This aborted on its first statement,
so nothing committed. The dangerous shape is a file whose EARLY statements are
qualified and whose later ones are not: the early half commits, the run aborts
part-way, and whether `schema_migrations` records it depends on where the ledger
INSERT sits. That is a half-applied migration, the hardest state to diagnose later.

**Gated.** `check-schema-drift` check D flags unqualified DML targets, ratcheted
at 22 — 12 of 71 migrations predate the rule and have already run, and demanding
they change would be rewriting history to make a gate green. Table names are
read from `schema-index.json`, not guessed by regex, because a bare word match
reports `OF`, `ON` and `TO` as tables and a gate that cries wolf gets ignored.
Mutation-checked by reintroducing the exact production bug: it names
`role_permissions` at line 46.

### A63 · P2 · CLOSED 08-13 · The onboarding permission seeder never learned A61's lesson
`apps/server/src/lib/defaultRolePermissions.ts` decides a new role's grants by
**exact, un-normalised name match** — `nm === 'manager'`, `nm === 'branch_manager'`
(lower-cased only). The grant migrations 24/49/75 shipped this exact bug and
migration 76 fixed it by normalising `lower(replace(name,' ','_'))` (register
A61). The seeder is the same shape one layer up, un-fixed.

**Not triggered today, which is why it is P2 not P1.** Both onboarding paths
create simple names the exact match handles — self-service
(`onboarding.ts:119`) seeds `Admin / Manager / Cashier`, the agent path
(`admin.ts:406`) seeds `owner / manager / cashier`. Every one matches. The
`supervisor` / `branch_manager` branches in the seeder are dead for onboarding;
they exist only for a caller that passes those names.

**The latent failure.** If a default role name ever gains a space
(`Branch Manager`), or any caller passes such a name to `seedDefaultRolePermissions`,
that role falls through every tier to `false` and is created with **zero**
permissions — not a missing tab, an empty rights set and no staff access — with
no error, exactly A61's signature. Fix once, the same way 76 did: normalise the
name before the tier test (`lower(replace(role.name,' ','_'))`). Cheap now,
because onboarding's names are simple; a field incident the day someone renames a
default.

**Fixed 08-13.** The tier decision is extracted to `apps/server/src/lib/roleTier.ts`
as a pure `roleTier(name)` that normalises with the same `lower(replace(name,' ','_'))`
the migrations use; `defaultRolePermissions.ts` imports it. Kept free of any
supabase import so it loads and tests in isolation. Proven against the REAL
compiled function — `tests/role-tier.test.mjs`, 12 assertions, **mutation-checked**
(remove the space-normalisation and "Branch Manager" → `none` again), including
that a name merely *containing* a keyword ("Trainee Manager") is NOT swept in.
Server `tsc` clean. This makes the seeder and the grant migrations (76/78/82) share
one normalisation rule so they cannot drift about who is a manager.

### A64 · P3 · CLOSED 08-13 · Two manager deny-lists that should agree, don't
The default manager permission set is defined in **two** places with **different**
deny-lists:

- **Migration 59** (backfill for roles that existed then) grants managers
  *everything except* `settings.manage` — a one-key deny.
- **`defaultRolePermissions.ts`** (the seeder for roles created at onboarding)
  denies four: `settings.manage`, `inventory.adjust`, `ingredients.manage`,
  `reports.financial`, with a comment explaining each as owner-only (the last two
  are a theft vector and audit H6's financial reports).

The **code divergence is verified**; its **runtime effect is not**, and the
register does not assert what it has not run (A49). Whether 59 actually granted
the three extra keys to managers depends on whether each was registered when 59
ran, and `check-permission-parity`'s grant parser is blind to 59's
`CROSS JOIN … WHERE key <> …` form, so static analysis cannot answer it. Confirm
against a DB where 59 ran (dev has tenants; prod has none, so prod is unaffected
— its managers come only from the seeder):

```sql
SELECT r.name,
       bool_or(p.key='inventory.adjust')  AS adjust,
       bool_or(p.key='ingredients.manage') AS ingredients,
       bool_or(p.key='reports.financial')  AS fin_reports
FROM   public.roles r
LEFT JOIN public.role_permissions rp ON rp.role_id=r.id
LEFT JOIN public.permissions p ON p.id=rp.permission_id
WHERE  lower(r.name) IN ('manager','supervisor','branch_manager')
GROUP  BY r.name;
```

Any `true` means a backfilled manager holds a key the current policy makes
owner-only — an over-grant on existing tenants, not a break. The fix is to make
the two deny-lists a single shared constant so they cannot drift again, then
decide which policy is correct and reconcile the outliers.

**Owner decided 08-13 — the STRICT policy.** Managers *receive* stock and *see*
inventory and branch reports; they do NOT adjust/manage inventory or see financial
reports — that lives on the web only. So the seeder's four-key `MANAGER_DENY`
(`settings.manage`, `inventory.adjust`, `ingredients.manage`, `reports.financial`)
is authoritative, and migration 59's one-key deny was the over-grant. `MANAGER_DENY`
in `defaultRolePermissions.ts` is the single source of truth for the policy going
forward; any future grant/revoke migration must match it (a SQL migration and a TS
constant can't literally share, so this is a discipline note, enforced by review).

**Reconcile written and proven — `migrations/82_manager_deny_reconcile.sql`.**
Revokes the three over-granted keys from the `manager`/`supervisor`/`branch_manager`
role set (normalised names, A61), leaving owner/admin and every other manager grant
(`inventory.view`, `inventory.receive`, `reports.view`, …) untouched.
`scripts/test-migration-82.mjs` — 10 checks against real Postgres, **mutation-checked**
(drop the role scope and the owner-untouched assertion fails). Idempotent; the DELETE
is a no-op on a database where managers never held the keys, so it is safe to apply
regardless of the runtime uncertainty the query above could not resolve.
**Before applying to prod, run the blast-radius SELECT at the foot of the migration**
to see exactly which (business, role, key) rows it removes; a per-shop exception
that an owner wants kept is re-granted in the Roles screen afterward.

### A65 · P1 · CLOSED 08-12 · The daily-report scheduler: the toggle never persisted, and the sender ignored it
Same feature as A54 (the daily summary email), a different layer. A54 is
TRANSPORT — mail that never leaves the instance. This is SCHEDULING and CONFIG —
what the owner sets and whether the job honours it. Reported by the owner: *"save
send reports shows saved but reverts to off."* Two bugs.

**1. The read route did not exist.** The dashboard reads its toggle state from
`GET /api/business/settings/report-schedule`. There was no such route. The 404
was swallowed by a `.catch(() => {})`, so the control fell back to *off* on every
load — the value HAD saved (POST `/settings`, key `report_schedule`), it was
simply never read back. Fixed: added `GET /settings/report-schedule`
(`business.ts`) — reads the `business_settings` key, tolerant parse, defaults to
`{enabled:false, send_time:'21:00', recipients:[]}`.

**2. The sender ignored the config entirely.** `dailySummary.ts` ran one global
cron, emailed only the owner, and never read `enabled`, `recipients` or
`send_time`. Rewritten to decide per business: send only if `enabled`, at that
business's own `send_time` (EAT), **once per EAT day** (dedup via a
`report_schedule_last_sent` stamp written only after a successful send), to
**owner + active branch managers** (users joined to `roles`, name normalised to
`branch_manager`, with an email on file) **+ the schedule's added addresses**,
deduped. The cron now runs every 15 min so per-business times can be honoured.

**Owner decisions, 2026-08-12:** `enabled` is authoritative (off stops the mail);
recipients are owner + branch managers + the added list; `send_time` is
per-business.

**Verified on the bench:** server `tsc` green; the send decision was extracted to
`reportScheduleDecision.ts` (pure, no imports) and the REAL compiled function run
through 16 cases — disabled/null/undefined, dedup (sent-today vs sent-yesterday),
the time boundary (before/at/after), minute precision, non-padded and default
times, and dedup-beats-time. What the bench CANNOT prove and a live check must:
the cron firing, the branch-manager query against real rows, and actual delivery.

**Two behaviour changes, flagged deliberately:** (a) because the read was broken
no business has `enabled=true` persisted, so after deploy only businesses that
opt in are emailed — correct per the toggle, but the current always-on owner
email stops until each opts in; (b) if the prod env `DAILY_SUMMARY_CRON` is set
to a once-a-day value it DEFEATS per-business `send_time` — unset it.

**Not closed by this:** delivery. A working scheduler still sends into a filtered
port — that is A54, still blocked on the owner. The live report-schedule check
(enable for a test business, `send_time` a few minutes out) is also the cleanest
end-to-end exercise of A54's transport.

### A66 · P1 · CLOSED 08-13 · Kitchen exclusions never reached the till — and the local override that lets an offline till own them
Two things in one entry because the fix and the feature are the same code path:
a bug that made the cloud list silently vanish, and the local override built on
top of the now-working persistence.

**The bug — `saveDeviceConfig` dropped `kitchen_exclusions` on the floor.** The
column was in the `DeviceConfig` type, the read map and the merge object, but
**absent from the INSERT column list, the VALUES and the ON CONFLICT SET.** So
`syncEngine`'s `saveDeviceConfig({ kitchen_exclusions })` (the only writer)
merged the value and then wrote a statement that never named the column: on
insert it took the column default (NULL), on conflict it was not in the SET, so
the existing value stood. The till's `device_config.kitchen_exclusions` stayed
NULL forever, `escposBridge.kitchenExclusions()` returned `[]`, the printer
applied no exclusions, and the read-only box A43 shipped always showed empty —
the owner configured drinks-off-the-kitchen-ticket on the dashboard and the till
sent them anyway. `escpos_enabled` survives the same omission only because it has
its own dedicated `UPDATE`; `kitchen_exclusions` had no such fallback.
**Invisible to every gate:** `check-sql-binds` only balances placeholders, and
the statement was internally balanced — it simply never mentioned the column.
Proven by executing the file's own INSERT under `node:sqlite`: the value did not
land. Fixed by adding `kitchen_exclusions` (and the new override, below) to the
INSERT/VALUES/SET and the bound args; binds re-verified balanced.

**The feature — "cloud editable, local is final" (owner decision, 08-13).** Cloud
stays the **business-wide baseline**, edited on the web dashboard, refreshed on
every catalogue pull — unchanged, and now actually persisting. Each till gains a
**local override**: new `device_config.kitchen_exclusions_override`
(`LOCAL_SCHEMA_VERSION` 51 → 52, additive/idempotent via `migrateColumns`, no
replay). The reader resolves `override ?? baseline`. The override is editable on
**every** till, not gated to a deploy mode — a cloud-connected terminal may still
override the business default for its own printer — saved on blur, with a "Reset
to cloud default" that clears it. `syncEngine` keeps the baseline current and
**never touches the override**, so a local edit wins and survives every sync.
NULL override means "follow the cloud"; an empty-but-present override means "this
terminal excludes nothing, deliberately" — two different states, and the
clear-vs-empty distinction is load-bearing.

**Verified on the bench:** persistence + precedence proven by running the real
INSERT — `tests/kitchen-exclusions-local.test.mjs`, 17 assertions, `node:sqlite`,
**mutation-checked** (reverting the column from the INSERT fails 7). `check-ipc-parity`
138/138 (two new channels, `escpos:setKitchenExclusions` and
`escpos:clearKitchenExclusions`, both bridged and handled); `check-sql-binds`
green; renderer `tsc` clean; main `tsc` shows the identical pre-existing
`@swiftpos/printing` set and **zero new errors** (diffed against the stashed
tree). Recorded in `LOCAL-SCHEMA-VERSIONS.md` (v52).

**What the bench CANNOT prove — a live Windows check must, same limit as A43:**
that the box renders and edits; that the fixed baseline now actually reaches the
till; that the override wins after a sync and "Reset" returns to the dashboard
list. Closed on the same basis as A43 — the data path is proven, the render is
not — with the smoke test called out, not hidden.

**Two findings surfaced en route, recorded so they are not re-discovered:**
- **Cloud exclusions are business-wide by design.** `business_settings` is keyed
  `(business_id, key)` with no branch dimension, and `/api/pos/init` serves one
  list to every branch. Not a bug — a constraint to know before anyone asks for
  per-branch *cloud* lists (that would need a branch dimension + a dashboard
  selector). Local overrides are per-terminal, so per-branch granularity is
  already available that way.
- **A `deploy_mode: 'local'` till is not provisionable.** `InstallPage` hardcodes
  `mode = 'cloud'` (the picker was deliberately removed) and activation requires
  online owner sign-in, so nothing can *become* local yet. This feature works in
  BOTH modes, so it is not blocked on that — but a genuine non-cloud product is.
  Raise as a D-item if standalone provisioning moves into scope.

### A67 · P3 · CLOSED 08-13 · `check-register-consistency` read status from the whole heading, not the status field
Surfaced by D11. The gate decided OPEN/CLOSED by scanning the entire heading for
the words "closed"/"open"/"struck", so a title that merely contained one —
D11's *"…fails closed and kills the catalogue pull"* — was read as CLOSED. An
open item silently left the counts; the header balanced only by coincidence.

Fixed by matching a status LABEL at the start of a leading `·`-separated field
(the first two fields after the ID), never a substring in the free-text title.
Extracted to `scripts/lib/register-status.mjs` as a pure `deriveStatus(rest)` and
imported by the gate. Verified: `tests/register-status-parse.test.mjs`
(12 assertions incl. the D11 title → OPEN, plus REOPENED/PARTLY CLOSED/NOTE/bold
and an "Opening-hours" title that must not read as OPEN-the-status); and the gate
still reports the header agreeing with the body, so no existing entry's status
changed under the new parser. Not a ratchet — a correctness fix with a test.

### A17 · P0 · OPEN · A peer till cannot sell "offline forever" — it locks out on day 15
**Stated design (owner, 08-09):** the main/server till is registered online once;
client tills then rely on the server till and **can keep selling without
internet indefinitely.** The code does not support that today, in three ways.

1. **Authentication is cloud-only.** `ipcHandlers.ts auth:verifyPin` calls
   `ownerFetch`, and `ownerFetch` uses `getServerUrl()` — which is
   `device_config.server_url`, **the cloud**. `node_url` is a separate field
   (`nodeClient.ts:21`) and **the node exposes no auth route at all**: its API
   is `/node/{health,sync,since,report,cursors,instructions,time,tech-session}`.
   There is no `/node/verify-pin`.
2. **So the only offline door is `staff_pin_cache`, and it expires.**
   `PIN_CACHE_TTL_DAYS = 14`, and `cached_at` is written from exactly one place —
   `cacheStaffCredential`, called only after a **successful cloud** verify-pin
   (`ipcHandlers.ts:443`). LAN contact with the node cannot refresh it. **On day
   15 of no internet, every cashier on that till is refused and the shop cannot
   open**, with the message "Saved sign-in expired after 14 days offline."
3. **A cashier who has never signed in on that terminal while online can never
   sign in at all** (D16 caches per-terminal, deliberately), and
   `override_pin_hash` is never cached, so voids, discounts past the floor and
   refunds are impossible for the whole offline period.

The 14-day bound was a correct decision for a *cloud-attached* till — it bounds a
stolen or retired terminal. It is the wrong bound for a till whose authority is
meant to be the branch node.

**This is a design gap, not a bug to patch.** Do NOT simply raise the TTL — that
widens the stolen-till window without giving the node the role the design says
it has.

**DESIGN AGREED 08-09** — owner confirmed the node is the branch's source of
truth and sole cloud uplink, and that it may stay offline indefinitely and may
authorise. Specification in **`docs/PHASE5-NODE-AUTHORITY.md`**. Expiry is
redefined there as "days since ANY authority was reached", so a peer that sees
its node daily never expires and a node never expires at all.

### A18 · P1 · OPEN · `nodeServer.ts` documents an architecture that no longer exists
Its header states the node is *"the SOLE uplink to the cloud: peer tills never
push to the cloud directly, so an order reaches the cloud by exactly one path
(till → node → cloud)"*, and that received peer orders are *"re-enqueued into
this node's sync_queue so the existing cloud push forwards them."*

**Both statements are false in the current tree.** `syncEngine.ts:1138-1151`
says the opposite explicitly — every till pushes its own orders to the cloud and
"the node is now a replica, reached separately by `pushToNode()`" — and
`nodeIngest.ts:414-418` records the reason (two destinations cannot share one
status column). `INSERT INTO sync_queue` appears in exactly one place,
`syncEngine.ts:1566`, at order creation on the till that made the sale.
**Nothing re-enqueues peer rows for cloud push.**

This is the file a new reader opens to learn the architecture. Header corrected
08-09 to describe the tree as it stands. **The finding stays open until §3 of
`docs/PHASE5-NODE-AUTHORITY.md` is implemented**, at which point the ORIGINAL
header becomes true again and the corrected one must be corrected back. Noted
here so that does not read as a regression.

### A19 · P1 · OPEN · A permanently-offline peer's sales never reach the cloud
Follows from A18. A peer till pushes to two independent destinations: the cloud
(`sync_queue`) and the node (`node_queue`). Under the stated design the peer has
no internet, so:

- the node receives the sales over LAN, so **branch totals and manager reports
  are correct locally** — this half works;
- the peer's `sync_queue` never drains, and the node does not forward it, so
  **the cloud never sees those sales.** The owner's web dashboard, cloud
  reports, eTIMS fiscalisation and cloud-side loyalty are all short by every
  peer sale, indefinitely, with no error anywhere.

**RESOLVED 08-09 — the node forwards.** Owner confirmed the node is the only
link to the cloud, and that cloud sync is for web access and backup rather than
for branch operation. A peer with a `node_url` will push to the node only; the
node enqueues peer rows into its own `sync_queue` preserving the original id and
idempotency key. The two-queue separation stays — `syncEngine.ts:1138-1151` was
right about the mechanism and wrong about the routing. See
`docs/PHASE5-NODE-AUTHORITY.md` §3, including why a node outage delays cloud
backup rather than losing sales, and why idempotency makes a mixed-version
rollout safe.

### A20 · P1 · OPEN · Failover cannot open the shop — the staff roster does not replicate
Follows from the owner's failover requirement (08-09) plus PHASE5 §4a. Promotion
already works well — `tech:promoteToNode` (`ipcHandlers.ts:1746`) is
session-gated, audited, clears `node_url` and starts serving; `collectDistribution`
fans every origin's rows to every peer; orders carry `_items` and `_payments` as
children (`nodeIngest.ts:641-648`), so a promoted till holds COMPLETE orders.

But `REPLICATED_TABLES` is `orders, shifts, float_transactions, expenses,
business_days, events`. PHASE5's `branch_staff` is specified node-only, so a
promoted till would hold every sale in the branch and **no way to authenticate
anyone** — the shop stays shut at exactly the moment failover exists to prevent.

**Decision required from the owner** — replicating the roster means a stolen
peer yields the branch's PIN hashes. Recommendation, tradeoff table and the
"a branch is one trust domain" argument in `PHASE5-NODE-AUTHORITY.md` §10.1.
Includes a runbook item that does not exist today: **rotate PINs when a terminal
goes missing.**

### A21 · P1 · CLOSED 08-09 · `outbox_cursors` is not keyed by node — rows strand on repoint
`localDb.ts:854` — `PRIMARY KEY (table_name)`. A peer records how far it has
offered its own rows as one number per table, with **no record of which node it
offered them to**. `peer_cursors` on the node side is correctly keyed
`(device_id, table_name)`; the peer side is not.

On failover: peer C has offered `orders` to seq 500; the dead node had only
distributed to 430 before dying; peer C is repointed at the promoted till and
**never re-offers 431-500**. Not lost — they are on peer C — but absent from the
new source of truth, the day close, and (under PHASE5 §3) the cloud, with nothing
reporting a gap.

**Fix:** reset the outbox cursors in `tech:setNodeUrl` when the URL actually
changes. Ingest is `INSERT OR IGNORE` / upsert-by-id, so re-offering everything
is absorbed — the same property that makes PHASE5 §3's rollout safe. Two lines,
no schema change. Keying the table `(node_id, table_name)` is cleaner but is a
local-schema change, and D6 already records six undocumented generations of that.
See §10.2.

**CLOSED 08-09.** `resetOutboxCursors()` in `nodeIngest.ts`; called from
`tech:setNodeUrl` **only when the URL actually changes** — re-entering the same
address must not trigger a full re-offer. The repoint audit line now carries
`node_changed`, and the reset is logged to `swiftpos.log`.

Option 2 (keying the table `(node_id, table_name)`) was NOT taken: it is a
local-schema change to the mechanism that decides whether a field till works, and
D6 already records six generations of that going undocumented. Revisit only if a
branch ever runs two nodes at once. The test asserts the current primary key, so
it will fail loudly if that ever changes.

12 tests in `apps/desktop/test/failover-cursors.test.mjs`, mutation-checked by
removing the DELETE (9 passed / 3 failed, exit 1; restored, exit 0). Ran on
`node:sqlite`, and **the suite prints that it did** — it is a stand-in, not the
app driver. Run under Electron on the target for a hardware-equivalent green.

**A25 — the original finding.** Retained verbatim; its closure is the A25 entry later in this file (the server can now verify a claimed role).
Found while attempting PHASE5 §4b. **`device_role` does not exist anywhere in
`apps/server`** — grep returns nothing. So an endpoint that hands out the
branch's PIN hashes could only be gated on `surface === 'desktop'`, which every
till has, and on an owner token, which every till holds.

**The credentials endpoint was therefore NOT built.** Shipping it against that
guard would hand the branch roster to any till, and to anyone who lifted an owner
token off one — the opposite of what PHASE5 §4b exists to do.

This is the concrete form of the D4/D14 prerequisite named in PHASE5 §7. The
server must be able to verify that a caller is the branch's node before any
credential can cross that boundary. **D14 first (register the device), then D4
(enrol it), then §4b.**

### A22 · P2 · OPEN · Promotion has no split-brain check
`promoteToNode` clears `node_url` and starts serving immediately with no check
that the old node is gone. An old node that was merely unplugged, then
reconnected, gives the branch two nodes and peers pointed at either. Nothing
detects it. Low urgency while promotion is a human tech-session action, but a
node that can reach another node on its own branch should say so loudly. §10.5.

### A23 · P2 · OPEN · Distribution lag is the real RPO and is not measured
Promotion cannot recover rows the dead node originated but never distributed —
its own sales live only on its disk. So the recovery point is however far behind
distribution was, and **nothing measures or displays that**. Wanted: a "last
distributed" age on the tech screen. Also a runbook line that does not exist:
**do not wipe or re-image a failed node until its `swiftpos.db` has been read.**
§10.4.

### D14 · P1 · CLOSED 08-10 · The till is not registered — cause found, and it was not the upsert
**I called this a one-line upsert on `sync.ts:71`, then a device-enrolment
design decision. Both were wrong**, and the rule 17 sweep found far more built
than the register credited: `lib/deviceBinding.ts` (181 lines — rebind windows,
relocation history, terminal-code conflict handling, fails-open-until-bound),
`routes/devices.ts` (216 lines — fleet, approve, reject, delete, permission
gated) **and it is mounted**, at `routes/index.ts:94`.

**The cause is `auth.ts:432`:**

```js
const required = setting?.value === 'true' || setting?.value === true;
if (!required) return { result: 'allowed' };
```

Registration sits behind an opt-in business setting Beryl never enabled — and
`checkDeviceRegistration` returns earlier still for owners and elevated roles, so
a desktop till signing in as the owner fell through **both** gates.
`/desktop-login` registered nothing at all. Nothing was broken; registration was
never reached.

Three subsystems then degraded to silent no-ops while looking healthy:
migration 52's branch binding (`checkDeviceBranch` waves an unknown device
through, by design), fleet telemetry (an UPDATE matching no rows is not an
error), and A25.

**MEASURED IN PRODUCTION 2026-08-10, before the fix deployed:**

```
select count(*) from public.user_devices;                    ->  0
select count(*) ... where business_id = '<beryl>';           ->  0
select ... where key = 'require_device_registration';
   Lovers Rock | require_device_registration | false         (one row, all tenants)
```

**Zero registered devices across the ENTIRE fleet — ten businesses, seven of them
non-test.** And exactly one row for the flag anywhere: someone opened that
setting on Lovers Rock once and left it off.

So this was never a Beryl problem. **Device registration has never run for any
tenant, ever.** Everything downstream of it has been dead code in production
since the day it was written:

- `lib/deviceBinding.ts` (181 lines) — branch binding, rebind windows,
  relocation history, terminal-code conflict handling. Never executed.
- `routes/devices.ts` (216 lines) — fleet view, approve, reject, delete. Mounted
  at `routes/index.ts:94`, permission-gated, and always empty.
- Migration 43's telemetry columns — `app_version`, `schema_version`,
  `last_sync_at` never written for any till, so every diagnosis has required
  somebody physically at the machine.
- Migration 52's anti-relocation control — inert everywhere. A till moved
  between branches has been undetectable this whole time.

That is a large amount of correct, careful, well-tested work that has never once
run, gated behind a boolean nobody knew to set. **The lesson is not "turn the
flag on"** — it is that a subsystem with no observable output cannot tell you it
is idle. Nothing anywhere reported an empty fleet as unusual.

**Fix — the two concerns were conflated and are now separated.**
`require_device_registration` means *"cashiers must be approved before signing in
from a new BROWSER"*. It is a real, optional policy and is **untouched**. But a
desktop till is not a browser: it has a stable `device_id`, it is bound to a
branch, it is the unit migration 52 exists to control. So `lib/deviceRegistry.ts`
registers desktop terminals **unconditionally**, from `/desktop-login` and
`/verify-pin`.

New rows land `approved`, not `pending`: a pending row blocks the shop until
somebody opens the dashboard, which is unacceptable at the remote thin-internet
sites this product targets. Defensible because reaching that code already
required a valid owner token or a verified PIN — more than a browser fingerprint
proves. **An existing row's `status` is never touched**, so a rejected terminal
is not silently re-approved by signing in again.

**Registration is not authorisation.** No `branch_id` is set — `checkDeviceBranch`
owns binding, and guessing here could bind a till to the wrong branch
permanently. No `device_role` is set, so **A25 remains open by design**.

### A26 · P1 · CLOSED 08-10 · Fleet telemetry failed silently and blamed the wrong thing
`sync.ts` reported only an `error`. An UPDATE that matches **no rows is not an
error**, so a till with no `user_devices` row discarded its telemetry in silence
— the common case. The one message that could appear asked *"is migration 43
applied?"*, and 43 **is** applied, so the single available clue pointed away from
the cause. That is why diagnosing Beryl needed somebody physically at the machine.

Now `.select('id')` makes the matched count visible and a zero-row match says the
terminal has never registered, explicitly clearing migration 43. The mutation
check is enforced by the compiler: remove the `.select('id')` and there is no
`data` to count, so `tsc` fails.

20 tests in `tests/device-registration.test.mjs`, mutation-checked both ways.

### A27 · P1 · CLOSED 08-10 · The server could not tell what a terminal IS (and PHASE5 excluded office)
Raised by the owner: *"does this involve the view-only node?"* It did, and the
PHASE5 design was wrong.

`deviceConfig.ts:26` — `DeviceRole = 'till' | 'node' | 'office'`. Office is a
branch server that **cannot sell**: no drawer, no shift, no cash, safe
unattended, not meant to consume an activation seat. The file supplies
`isNodeRole()` and `canSell()` precisely so nobody tests the literal, and warns:
*"comparing against the literal 'node' anywhere else is how office machines fall
through cracks."*

**PHASE5 §4b did exactly that** — it gated credential distribution on
`device_role === 'node'`, which would have refused an office machine the branch
roster. Backwards: an office box is the BETTER holder, because it is the machine
that is safe unattended, which is the whole security argument of §10.1.
Corrected in `PHASE5-NODE-AUTHORITY.md` §12; every server-side gate now uses
`isNodeRole()`.

Three things were missing and are now built:
- **`user_devices` had no role column** (confirmed against the live dump).
  Migration **73** adds `device_role` (CHECK till|node|office) and
  `role_reported_at`, plus a `branch_serving_devices` view — the SQL form of
  `isNodeRole()`, with `is_view_only` marking an office machine.
- **The till never reported its role.** Sync sent `X-Schema-Version`,
  `X-Device-Id` and app version, nothing more. Now `X-Device-Role` too.
- **Registration ignored it.** `deviceRegistry.ts` stores and labels it — an
  office machine no longer appears in the fleet view as a till.

**Numbered 73, not 72:** migrations 68 and 72 are absent from this repo and 68 is
known to exist in production (A4). Reusing 72 would collide with whatever is
already applied there.

Existing rows stay NULL — *has not reported* — rather than being defaulted to
`till`. A guess that reads as a fact would make a branch server look like a
counter terminal until somebody noticed.

**A25 is NOT closed by this.** The server can now SEE a claimed role; it still
cannot VERIFY one. A device asserting `office` is exactly as trustworthy as a
device asserting its branch was before migration 52. Enrolment (D4) is what makes
it checkable, and no credential may cross that boundary until it does.

### A28 · P2 · CLOSED 08-10 · A missing migration would have lost the whole registration
Writing `device_role` in the same statement as the rest coupled every terminal
registration — and all fleet telemetry — to migration 73 being applied. If it
were not, the INSERT would fail entirely and no row would be created; the
telemetry UPDATE would fail and take `last_sync_at` and `schema_version` with it.

**Not hypothetical here.** Only **20 of 66** migrations record themselves in
`schema_migrations`, and 68 and 72 are absent from the repo entirely. A migration
being missing is the normal state in this project, not an edge case.

Now: the registry detects `42703` / `PGRST204` and retries without the role
columns, so the terminal registers regardless; and sync writes the role as a
**separate** statement, so telemetry is unaffected either way. Both paths log
which migration is missing, and say plainly what still worked.

**A4 — measurement note, 08-10** (the migration ledger covers less than a third). Belongs to the A4 entry later in this file, which is the authoritative one.
Concrete figure for the "under-reports" claim: **only 20 of 66 migration files
contain an `INSERT INTO public.schema_migrations`**, so 46 are invisible to the
ledger. **Re-measured 08-10: 22 of 68** — the ratio is unchanged, so the finding
stands; the figures are refreshed so a future reader does not conclude the file
was never re-checked. The version format is also split — 17 named (`'52_device_branch_binding'`)
against 1 bare (`'71'`) — so the table cannot be queried reliably by number
either. `60_menu_composition` and `61_adjust_product_stock` are recent examples
that record nothing.

Consequence unchanged and now quantified: **the ledger cannot be trusted to
decide what to run.** Still open.

### A25 · P1 · CLOSED 08-10 · The server can now verify a claimed role
Migration 73 let a terminal SAY what it is. **Migration 74** decides whether to
believe it — the difference between a diagnostic and a security control.

Same shape as migration 52, on purpose: trust on first use per branch, then
closed, with a manager-granted window for legitimate change. A second trust
mechanism would be a second thing to learn and a second thing to get wrong.

**One deliberate difference: this fails CLOSED where 52 fails open.**
`checkDeviceBranch` waves an unbound device through, because refusing would stop
a shop trading over a diagnostic. Here an unconfirmed device is refused
credentials, because the cost of a wrong answer is the branch's PIN hashes
rather than a misattributed sale. Refusing costs a machine offline
authentication until somebody confirms it; granting wrongly cannot be undone.

- `lib/deviceRole.ts` — `confirmServingRole()` (TOFU + conflict recording +
  handover) and `isConfirmedBranchServer()`, the read-only gate PHASE5 §4b must
  call. The gate never confirms as a side effect: a read that quietly grants is
  how a check stops being one.
- The branch is read from the device's **own server-side row**, never from the
  request. A caller-supplied branch would be a second claim propping up the
  first, which is what this exists to stop.
- `POST /api/devices/:id/authorise-handover` — one hour, matching
  `REBIND_WINDOW_MINUTES`. Granted on the OUTGOING device, because that is the
  machine an operator can identify and a replacement may have no row yet.
- Unique index `user_devices_one_server_per_branch` is the guarantee, not the
  intention. Handover clears the incumbent FIRST, so an interruption leaves the
  branch with NO confirmed server rather than two.

**Nothing here affects selling.** A refused machine still trades, still syncs,
still serves its own tills over the LAN with the branch secret. The only thing
withheld is the branch roster.

**Partly closes A22** (split brain): two machines claiming to serve one branch is
now detected and recorded — `role_conflict_at`, `role_conflict_with` — rather
than being silent. The node still does not warn on startup, so A22 stays open.

23 tests in `tests/device-role-confirmation.test.mjs`, mutation-checked.

### A29 · P1 · CLOSED 08-10 · `build-schema-index.mjs --merge-migrations` adds phantom columns
Found because migrations 73/74 tripped `schema-audit`, correctly: the new
columns were not in `scripts/schema-index.json`. The sanctioned unstick path is
`--merge-migrations`, and it **added six columns that do not exist in the live
database**, verified against the owner's 08-09 dump:

```
category_stations.business_id        parking_sessions.billed_amount
fuel_tanks.product_id                parking_sessions.cashier_id
fuel_tanks.tank_name                 parking_sessions.notes
```

Each was created by an early migration and renamed by a later one — `fuel_tanks`
has `fuel_product_id` and `name`, not `product_id` and `tank_name`. The tool
documents *"never removes"* as a safety property, and for removals it is; but it
also cannot know a column was renamed, so it resurrects dead names.

**That WEAKENS the gate.** Code selecting `fuel_tanks.product_id` would now pass
the audit and fail at runtime — the precise failure the index exists to catch,
reintroduced by the tool meant to maintain it.

The six were removed by hand against the live dump; only the eight columns from
73/74 remain. Verified semantically, not by diff: 98 tables before and after,
nothing lost, `total: 0`.

**Fix not yet applied to the tool.** It should either skip columns dropped or
renamed by a later migration, or print them as *unverified additions* for a human
to confirm. Until then, **`--merge-migrations` output must be diffed against the
live schema before it is committed**, and `--from-db` re-run when the database is
reachable. Consider this a standing caveat on that script.

### A30 · P1 · CLOSED 08-10 · Migration 74 failed on the owner's database — SQL nobody had run
```
ERROR: 42P16: cannot change name of view column "is_view_only" to "role_confirmed_at"
```

`CREATE OR REPLACE VIEW` may only **APPEND** columns: existing ones keep their
names, types and positions. Migration 74 inserted four columns before migration
73's trailing `is_view_only`, so position 16 changed name and Postgres refused.

**This reached the owner because "the DDL is unexecuted" was written down as a
caveat instead of being fixed.** Listing a risk is not managing it. Both
migrations now `DROP VIEW IF EXISTS` then `CREATE VIEW` — not `CASCADE`, so a
future dependency fails loudly rather than being quietly deleted.

**A second bug, found only by executing:** re-running 73 after 74 failed with
*"cannot drop columns from view"*, because replace cannot drop columns either.
Every migration here is written to be re-runnable — only 20 of 66 record
themselves (A4), so re-running to be sure is normal practice — and a view that
can be created once breaks that. Neither bug was findable by reading.

**Root fix — migrations now run against a real Postgres.**
`apps/server/test/migration-73-74.test.mjs` executes them under PGlite (Postgres
compiled to WASM: real parser, real planner, real DDL semantics, in-process, no
server to install), and it is **in CI**. 17 tests covering: both apply; both are
recorded; re-running both is idempotent; the CHECK accepts till/node/office and
rejects anything else while allowing NULL; the unique index refuses a second
confirmed server per branch, including an office machine; **clear-then-set is
proved to be the only order the index permits**, which is the handover sequence
`deviceRole.ts` reasons about; the view exposes both derived booleans and
excludes plain tills.

Documented consequence, tested rather than assumed: 73 owns the smaller view
definition, so running it **alone** after 74 reverts the view. Re-running 74
restores it. Run migrations in order.

**The wider lesson is the reusable part.** Any migration can now be executed in
CI before it reaches a database. The five earlier migrations in this batch's
lineage were never run either; they should be brought under the same harness.

### A31 · P1 · CLOSED 08-10 · A new desktop suite was written and never wired in
`failover-cursors.test.mjs` (A21) was added to `apps/desktop/test/` and **not
added to `npm run test:desktop`**. The owner's target run on 2026-08-10 executed
92 tests across five suites under `better-sqlite3 under Electron 35.7.5 — REAL
driver and ABI`, and the sixth was silently absent.

This is A16 repeated **in the same batch that closed A16.** A file in a test
directory is not a test; a test that nothing invokes is decoration (rule 10).

Now `test:failover` and `test:failover:electron` exist, matching how every other
suite is wired, and `test:desktop` runs the Electron variant. Also added to CI's
`desktop-scope` job, where it runs on the `node:sqlite` stand-in — which the
suite declares in its own output rather than implying a real green.

**The general lesson:** the same mistake is available every time a suite is
added. `check-ipc-parity` exists because a feature reached every layer except the
bridge; the equivalent gate here would assert that every `apps/desktop/test/*.test.mjs`
appears in a package script. Not built — recorded as the obvious next hardening.

**A9 (`npm audit`) — RESOLVED 08-10.** Retained as the original record. See the note under the other A9 entry: two unrelated findings were filed under this one ID.
**TRIAGE DONE 08-10 (late). The open half of this item is now closed, and the
answer is that almost none of it reaches a till.**

The measurement said 23 vulnerabilities / 3 critical on desktop. What it did not
say is which of them ship. Split against `apps/desktop/package.json`:

| | Verdict |
|---|---|
| **All 3 CRITICAL** — `concurrently`, `shell-quote`, `tar` | **devDependencies.** `concurrently` and `shell-quote` are the dev-server runner; `tar` arrives via `node-gyp` → `electron-rebuild`. None is in the packaged app. |
| **16 of 18 HIGH** | The `electron-builder` / `node-gyp` / `app-builder-lib` chain, plus `postcss`, `js-yaml`, `nanoid`, `brace-expansion`, `ip-address`. All devDependencies — **build machine only**. |
| **`electron` itself (HIGH)** | The advisory is *AppleScript injection in `app.moveToApplicationsFolder`* — **macOS only**. Every till is `win32`. Not reachable on any deployed machine. |
| **2 MODERATE — `uuid`, `exceljs`** | **The only PRODUCTION dependencies in the list.** `exceljs` is flagged solely via `uuid`. |

**The `uuid` finding does not apply to how we call it.** The advisory is a missing
buffer bounds check in **v3/v5/v6 when `buf` is provided**. Every call site in
this repo is `import { v4 as uuid }` — five of them, all `uuid()` with no
argument. v4, no buffer. (`schemas.ts:5` is a Zod validator that shadows the
name; unrelated.)

**So the shipped surface of 23 vulnerabilities is: none.** That is worth stating
plainly, because "3 critical" on a POS handling money reads as urgent and would
have had someone running `npm audit fix --force` on the electron-builder chain —
a MAJOR bump of the toolchain that builds the installer, the week after a build
went out with two binaries under one version (rule 22).

**Server side, real but lower:** `body-parser` (DoS via a silently-disabled size
limit), `brace-expansion`, `ip-address` (SSRF / trust-boundary bypass). All fixed
by a plain `npm audit fix` — no majors. `ip-address` matters more here than on
the till because the server takes inbound requests; worth doing, but not tonight,
and not in the same change as a mail fix going to production.

**What is NOT claimed:** that these packages are safe in general, only that the
vulnerable code paths are not on the till's shipped surface. A future dependency
could pull `uuid` v5 with a buffer, or move a dev dependency into `dependencies`,
and this triage would be stale. Re-run per workspace when the dependency set
changes rather than trusting this table.

The register carried "23 vulnerabilities, 3 critical — probably build-chain only"
as an unverified guess. Measured on both sides:

- **`apps/server`: 6 vulnerabilities, 0 critical, 3 high.** The guess was wrong
  for the server in both directions, and `nodemailer` is a **direct runtime**
  dependency, not build-chain.
- **`apps/desktop`: 23 vulnerabilities, 2 moderate, 18 high, 3 critical** —
  confirmed on the owner's machine 08-10. The 23/3 figure was the desktop
  workspace all along.

Desktop dependencies are build- and packaging-time (electron-builder and its
tree) rather than reachable from a running till, so the practical exposure is
lower than the number suggests — but that is an argument for triaging them, not
for leaving the number unexamined. Triage still open; the measurement is not.

### A32 · P1 · CLOSED 08-10 · Six migration tests existed, none ran, one had never worked
Found while fixing a Windows path bug in my own harness. **This repository has
tested migrations against PGlite since migration 41** — `scripts/test-migration-47,
-48, -50, -51, -52` and `test-migrations-41-42` — same pattern, same
`fileURLToPath`, same `--no-save` instruction.

**None of them ran in CI**, and the consequences were exactly what a test nothing
invokes always costs:

- **`test-migration-47.mjs` pointed at `/home/claude/out4/migrations/…`** — an
  absolute path from the sandbox it was written in. It has never run anywhere
  else since the day it was committed. **19 assertions, none ever executed.**
  Path fixed; 19/19 pass.
- **Migration 74 shipped a `CREATE OR REPLACE VIEW` Postgres refuses (A30)** and
  reached the owner's database. The practice to catch it existed; nothing made
  it habitual.

`scripts/run-migration-tests.mjs` now **discovers** `test-migration*.mjs` rather
than listing them — a hand-kept list is one more thing to forget, which is the
failure being fixed — runs each in its own process, and reports every failure
rather than stopping at the first. `npm run test:migrations` at the root, in CI.
**7 files, 110 assertions, all green — confirmed on the owner's Windows machine
2026-08-10.**

The runner reads both summary conventions in this directory (`N passed, N failed`
and `test-migrations-41-42`'s `PASS`/`all green`), because a blank summary is
indistinguishable from a file that asserted nothing — and after 47, "looks like
it did nothing" is not a reassuring thing for a runner to show. Exit status, not
the summary, decides pass or fail; verified by running a deliberately failing
file through it (`1 of 8 migration test file(s) failed`, exit 1).

`@electric-sql/pglite` is a root devDependency, so `npm install` provides it and
the `--no-save` step in six file headers stops being load-bearing.

**My own error, recorded because it is the same one:** I wrote a new harness at
`apps/server/test/` without checking whether the practice already existed — a
rule 17 miss in the batch that added rule 17 — and claimed migrations "now" run
against real Postgres when they had since migration 41. Moved to `scripts/` and
renamed to match.

### A33 · P2 · CLOSED 08-10 · `new URL(import.meta.url).pathname` breaks on Windows
My migration harness resolved paths with `new URL(import.meta.url).pathname`,
which yields `/C:/swiftpos/…` on Windows; `path.resolve` then prepends the drive,
producing `C:\C:\swiftpos\…` and 17 failures on the owner's machine. Correct
on Linux, the only place it had run.

Every other script in this repository already used `fileURLToPath`. Mine was the
sole deviation — the convention was right and I did not follow it.

Fixed, plus the harness now **fails immediately with the resolved path** when the
migrations directory is missing. Without that, a path bug presents as every
assertion failing for its own apparent reason — missing columns, empty views —
and the real cause is buried in the noise, which is precisely what the owner saw.

**CONFIRMED ON TARGET 08-10** — all 7 files pass on the owner's Windows machine.
This could not be proved from Linux (`fileURLToPath` is platform-dependent), and
it is the second time in one day that only the target could settle a claim.

### A34 · P1 · CLOSED 08-10 · CI #42 red — desktop suites added without the build they need
```
Run node --no-warnings test/logFile.test.mjs
dist/main not built. Run:  npx tsc -b tsconfig.main.json --force
```

`logFile`, `syncEngine-failures` and `failover-cursors` import from
`apps/desktop/dist/main`. `npm run test:desktop` builds first — which is exactly
why they pass on the target and failed on the runner. **I added the CI steps and
not the build**, and could not have found it locally, because locally the build
had already happened.

The `desktop-scope` job installed only `better-sqlite3` at the repo root, which
is all the `scripts/*.mjs` gates need. Three steps added:

- `npm ci --ignore-scripts` in **shared/printing** — it is a project reference of
  `tsconfig.main.json` and declares `"types": ["node"]`, so without its own
  `node_modules` the build fails on a missing type definition. Non-obvious, and
  it cost a cycle to find the first time.
- `npm ci --ignore-scripts` in **apps/desktop** with
  `ELECTRON_SKIP_BINARY_DOWNLOAD=1` — the Electron binary is ~100MB and nothing
  in this job launches it.
- `npx tsc -b tsconfig.main.json --force`.

**Verified against a genuinely clean checkout**, not the working tree: extracted
`git archive HEAD` to a fresh directory with no `node_modules`, ran the three
steps in order, then all three suites — 12, 29 and 12 passed. That is the closest
reproduction of a runner available here.

The other five jobs — typecheck, build, secret scan, schema drift and **server
suites, including the 7 migration files** — were green on the same run. Only this
one failed.

**The general point:** CI is the first environment in this project that starts
from nothing. Everything local benefits from state built up by hand, and A32
(six migration tests never run) and A31 (a suite never wired in) were both
invisible for the same reason. Expect more of this on the next few runs; each
one is a real gap, not noise.

### A35 · P1 · CLOSED 08-10 · The secret scan never ran on a pull request
CI #44, PR #2 (`dev → main`):

```
RequestError [HttpError]: Resource not accessible by integration
  GET .../repos/oweyahillary/swiftpos/pulls/2/commits   403
  x-accepted-github-permissions: pull_requests=read
```

`gitleaks-action` lists the PR's commits through the API on a `pull_request`
event. The workflow declared **no `permissions` block at all**, so it inherited
the repository default — `contents`, `metadata`, `packages`, all read — and the
action crashed **before scanning anything**.

**Every earlier run was a `push` event, where the API is never touched.** So this
gate had been passing for a reason that did not hold on the one event type that
gates a merge to `main`. It looked like 40-odd green runs of a working secret
scan; on the path that matters it had never been exercised.

`permissions: { contents: read, pull-requests: read }`, scoped to that job —
nothing else here calls the API, and a read-only default is worth keeping
everywhere it still works.

**Second finding, from the same failure.** The job's steps ran gitleaks FIRST and
the `.env` assertion second, so when gitleaks crashed the job stopped and **both
secret gates were skipped by one infrastructure fault.** The `.env` check needs
no action, no API and no network. It now runs first, so it cannot be taken out by
something unrelated failing.

Context for why this matters more than a red tick: A1 was a service-role key
leaked in a packaged zip on 2026-08-08, and the repo leaked an Ed25519 signing
key before that. These two steps are what stand between that and a repeat.

**The general shape, third time today:** a check that passes for the wrong
reason. `test-migration-47` had never run (A32), `failover-cursors` was never
invoked (A31), and now a secret scan that had never scanned a PR. All three
looked like coverage.

### A36 · **P0** · CLOSED 08-10 · `/desktop-login` minted `surface: 'web'` — four features silently dead
The one-word bug behind everything chased today.

`routes/auth.ts` `/desktop-login` set `surface: 'web'` in its token payload. **The
header of that same file has said `surface='desktop'` since the route was
written.** The comment and the code disagreed for months and nothing compared
them.

It propagates: `/verify-pin` issues `surface: req.surface ?? 'web'`, so the
owner token's value flows into every staff token minted from it. On every till
that signed in through that route, four things were false and therefore silent:

1. **`offlineAuth` (`auth.ts:1356`) is gated on `surface === 'desktop'`.** The
   PIN hash was never returned, so `staff_pin_cache` stayed EMPTY. **The entire
   offline sign-in feature — D16, shipped 2026-08-08 with 16 passing pinCache
   tests — has never worked in the field.** Measured on Beryl's till 2026-08-10:
   manager and cashier PINs entered ONLINE, then
   `select count(*) from staff_pin_cache` → **0**.
2. **Desktop terminal registration (D14) never ran.** `user_devices` was empty
   for all ten businesses, which kept migration 52's branch binding and every
   telemetry column inert. This is the *real* reason the fleet was empty — the
   `require_device_registration` flag was a second, independent cause.
3. **The `desktop_licensed` gate never fired** for those tills (`pos.ts:87`,
   `auth.ts:1174`). A till signing in this way traded unlicensed.
4. **`requireWebSurface` was bypassed**, so a till could reach web-portal-only
   routes.

**Why nothing caught it.** `/pos-login` derives surface from the request body and
CAN be `'desktop'` — so the fixtures, and the real `BRANCH_NOT_LICENSED` errors
seen in the field, both looked right. Two login routes, two different answers,
and the tests exercised the correct one.

**Deploy safety, checked before shipping:** the till never calls `/api/reports*`,
so activating `requireWebSurface` changes nothing; and Beryl's Main Branch has
`desktop_licensed = true` since 2026-07-25, so the licence gate will pass. **On
an unlicensed branch this fix stops the catalogue pull with a 403** — check
before deploying anywhere else.

`tests/auth-surface.test.mjs`, 10 tests, mutation-checked. It is a source-text
test on purpose: the bug was one word in a literal, and a unit test asserting
`payload.surface === 'desktop'` against a stub would only prove the stub. It also
asserts the header and the code agree, which is the specific thing that failed.

### A37 · P2 · CLOSED 08-13 · The desktop licence was bypassable by client-supplied `surface`
`/pos-login` read `surface` from the request body and gated the licence on it
(`callerSurface !== 'web' && !allowed.desktop_licensed`). A client that sent
`surface: 'web'` skipped the desktop-licence check, and `pos.ts` then also passed
because it reads the same value from the minted token. A commercial control
decided by client input.

**Fixed by making the exempting surface earned, not asserted.** Web access and the
desktop licence are separate products (`webAccess.ts`: "Offline desktop POS is NOT
affected by web-access state"). `/pos-login` now honours `surface: 'web'` only when
the business actually holds web access — `effectiveSurface = callerSurface === 'web'
&& getWebAccess(businessId).canLogin ? 'web' : 'desktop'` — the same server check
`/login` gates on. The licence gate and the token mint both key off
`effectiveSurface`, so a caller with no web entitlement that claims `web` is
treated as a desktop till and licence-checked, and the token it carries into
`pos.ts` can no longer be dodged. The legitimate web POS (a business that holds web
access) is unchanged.

**Residual, documented not hidden:** a business that holds BOTH web access and
physical tills could still claim `web` on a till. Closing that for dual-subscribers
is a business-policy call (does a web subscriber's physical till need its own
desktop licence?), not a code question — the primary bypass, a desktop-only
business dodging the per-branch licence entirely, is closed.

**Verified on the bench:** server `tsc` clean; `tests/auth-surface.test.mjs`,
11 assertions, **mutation-checked** (revert the gate to `callerSurface` and the
A37 assertion fails). What the bench cannot prove and a live check should: an
actual `/pos-login` from a no-web-access business claiming `web` receiving the 403
`BRANCH_NOT_LICENSED`, and a real web-access business still logging in.

**Also fixed here — a D11 regression this test caught.** D11 rewrote `pos.ts`'s
licence gate (`branch && !branch.desktop_licensed` → `!opBranch?.desktop_licensed`)
but `auth-surface.test.mjs` §3 pinned the old shape and had been silently failing
since; the D11 session ran its own test and the gates but not the full
`tests/*.test.mjs` suite. The assertion is updated to match the D11 shape and now
passes — a reminder that a shape-pinning test must be re-run whenever the shape it
guards is changed.

### A38 · **P1** · CLOSED 08-10 · The till sent `X-Device-Id` twice — every reader got a comma-joined value
Found in Render's logs while chasing A36, and it is the SECOND independent cause
of the empty fleet:

```
[fleet] no user_devices row for device
  24dbc289-ee7f-42b6-8fed-6e089095b719, 24dbc289-ee7f-42b6-8fed-6e
```

`syncEngine.pushAuthHeaders()` declared **both** `'x-device-id'` and
`'X-Device-Id'` in one object literal. HTTP header names are case-insensitive,
so fetch emitted the pair and the server received them joined with `", "`. The
reader then did `.slice(0, 64)` on the JOINED string, chopping the second copy
mid-uuid — which is the trailing fragment in that log line.

**Four places consumed it:**
- fleet telemetry — `WHERE device_id = ?` could never match, so this would have
  stayed broken even after registration started creating rows
- `orders.device_id`
- `shifts.device_id`
- `terminalKeyFromRequest`, which feeds migration 63's one-open-drawer-per-terminal
  unique index

**The rollout risk, and why the server fix matters more than the client one.**
An updated till sending a single value would resolve to a DIFFERENT terminal key
than the shift it opened under the joined value — looking like a new terminal and
being allowed a second open drawer against the same physical till. New
`deviceIdFromRequest()` in `lib/terminalKey.ts` takes the first comma-separated
value, so an old build and a new one resolve identically and the change is
invisible to that index. `orders.ts`, `shifts.ts` and `sync.ts` all route through
it.

Client side: one spelling in both header builders. They previously disagreed —
`'x-device-id'` in `authHeaders`, `'X-Device-Id'` in `pushAuthHeaders` — which is
how a copy-paste put both into one object.

`tests/device-id-header.test.mjs`, 10 tests, mutation-checked both halves
(removing the split → exit 1; restoring the duplicate key → exit 1). It asserts
against **the exact string Render logged**, not a value typed into the test.

**Worth stating plainly:** the empty `user_devices` table had THREE independent
causes — the `require_device_registration` opt-in (D14), `surface: 'web'` (A36),
and this. Fixing any one alone would have produced no visible change, which is
why the first two fixes appeared to do nothing.

### A39 · **P1** · CLOSED 08-10 · The design six files cite was not in the repository
`BRANCH_AUTHORITY_AND_SYNC_DESIGN.md` is cited **by section** in six source files
— `cart.ts:39`, `managerReports.ts:405`, `localDb.ts:920`, `branch-prices.ts:20`,
`pos.ts:17`, `orders.ts:176` — and was **not in the repo or its git history.**
Supplied by the owner from a different folder on 2026-08-10; now in `docs/`.

Worse than a missing file: the citations make it look present. Anyone working
from a clone reads *"See BRANCH_AUTHORITY_AND_SYNC_DESIGN.md §6"* and finds
nothing, so the reasoning behind `branch_prices`, the effective-price COALESCE
and the `updated_by` stamp is invisible.

**And it is the design for most of what this register has been rediscovering all
week.** Its status line reads *"agreed design, not yet implemented"*:

| Register finding | Already specified as |
|---|---|
| A19 — a peer's sales never reach the cloud | §1, §3 — the node is the sole uplink |
| A24 — reference data goes stale on a peer | §1 — "edits flow DOWN: Manager PC → tills" |
| PHASE5 §4 — offline sign-in | §2 — "PIN login must also be local", tills cache a verifier via safeStorage |
| PHASE6 — branch-local settings | §1 — the branch authority owns reference data |
| Two-writer resolution | §5 — newest-wins, collision-only notify, confirm/reject, audit |

`syncEngine.ts:1138-1151` records a deliberate move AWAY from §1 and §3, with a
sound engineering reason and no apparent knowledge that a design said otherwise —
which is what an untracked specification produces.

**Partially implemented already:** §6's per-branch pricing decision (
`branch_prices`, migration 20), and §5's stamping (`branch-prices.ts:97` —
`updated_by='pc'`, the edit's own timestamp so an offline edit keeps its real
time). §2's PIN caching exists as `pinCache.ts` but caches from the **cloud**
rather than from the node, and did not work at all until A36 was fixed today.

**Rule 19 covers the repo root; this is the converse** — a document that should
be in `docs/` and was nowhere.

**GATE BUILT 08-10** — `scripts/check-doc-refs.mjs`, in CI. Every `Something.md`
cited from live code or live docs must resolve to a file in the tree. It found
more than a manual grep did, and **three of the owner's own documents are still
missing**:

| Missing | Cited by |
|---|---|
| `DESKTOP_DESIGN.md` | `migrations/18_web_access_remodel.sql:4`, and **BRANCH_AUTHORITY itself at :3, :28, :157** — it is the companion that defines the `node` role and steps 5-6 of the build sequence |
| `SwiftPOS_eTIMS_Integration_Scope.md` | `etims/provider.ts:4`, citing **§2** |
| `BRANCH-SERVER-PLAN.md` | `docs/PHASE2-3-DESIGN.md:3` |

`DESKTOP_DESIGN.md` matters most: PHASE6 is to be built against BRANCH_AUTHORITY,
which opens by calling itself *"Companion to DESKTOP_DESIGN.md"* and widens the
node role *"from DESKTOP_DESIGN.md"*. **Building PHASE6 without it means building
against half a specification.**

`docs/history/` is deliberately excluded from the citation scan — a past handoff
naming a since-deleted document is an accurate record, not a broken link — but
documents living there still count as PRESENT, so a live doc pointing at an
archived handoff passes.

**UPDATED 08-10 — the gate is red on ONE document, not three.** Re-run measured
158 citations across 496 files. `DESKTOP_DESIGN.md` is now in `docs/` (A40) and
`SwiftPOS_eTIMS_Integration_Scope.md` is in `docs/history/handoffs/`, which the
scan counts as present. **Only `BRANCH-SERVER-PLAN.md` is still missing.**

That matters for sequencing: PHASE6 is recorded elsewhere in this file as blocked
on three documents. It is blocked on one.

### A40 · P1 · CLOSED 08-10 · `DESKTOP_DESIGN.md` is lost — recorded, not reconstructed
Searched the repository, its full history (`--diff-filter=D`) and the owner's
local folders. **Gone.** Eleven citations survive.

`docs/DESKTOP_DESIGN.md` now states plainly that the original is lost and maps
each surviving citation to the code that implements it. **Nothing is invented** —
a plausible reconstruction would be worse than an honest gap, because the next
reader could not tell which parts were real.

What the citations preserve, and where it lives:

| Cited | Now |
|---|---|
| "the two-products model" (`migration 18:4`) | `branches.desktop_licensed` + `businesses.web_access_expires_at`; `lib/webAccess.ts` carries the whole renewal ladder |
| "the `node` role" (BRANCH_AUTHORITY:28) | `deviceConfig.ts:26` — and wider now, `'till' \| 'node' \| 'office'` |
| "steps 5-6 of the build sequence" (BRANCH_AUTHORITY:157) | **Diverged.** `syncEngine.ts:1138-1151` moved away from the sole-uplink model deliberately, with no sign of knowing a design said otherwise. Register A19, still open. |

Genuinely gone: the reasoning behind the two-products split, the full build
sequence, and whatever else it covered. **PHASE6 is unblocked** — the parts it
depends on are implemented and readable.

Still missing and worth finding: `BRANCH-SERVER-PLAN.md`,
`SwiftPOS_eTIMS_Integration_Scope.md`.

**UPDATED 2026-08-12 — `check-doc-refs` is now GREEN.** Neither document was
recovered, so following A40's precedent both are filed as honest tombstones that
reconstruct nothing: `docs/BRANCH-SERVER-PLAN.md` (records that the plan was
never committed and maps to the surviving `PHASE2-3-DESIGN.md` amendment and the
branch/node design docs) and `docs/history/handoffs/SESSION-HANDOFF-2026-08-02.md`
(records that `HANDOFF-2026-08-03.md` superseded it, per A6).
`SwiftPOS_eTIMS_Integration_Scope.md` was already present in
`docs/history/handoffs/`. The gate resolves every live citation; no original
content is claimed.

### A41 · P1 · CLOSED 08-10 · Two gates for the seam that produced everything this week
§L: *"two things that must agree, with nothing comparing them."* Every finding
this week was that shape. Two more comparators, both in CI:

**`check-header-keys.mjs`** — no object literal declares one header under two
spellings (A38). Mutation-checked.

**Its own first version silently missed the bug it was written for.** The
literal-matching regex refused nested braces, so any headers bag containing
`` `Bearer ${token}` `` was skipped — which is every one that matters. It scanned
23 literals, reported OK, and passed a mutation test by not looking. Now
interpolations are blanked (length-preserving, so line numbers stay true) and it
catches A38 at the exact file and line. **A gate that cannot fail is the thing it
was built to prevent.**

**`check-test-registration.mjs`** — every test file is invoked by a package
script, a CI step, or a discovering runner (A31, A32). Mutation-checked by
unwiring `test:failover:electron`.

**Its first version reported 22 false positives** — files a CI shell glob
(`for f in tests/*.test.mjs`) runs perfectly well. Fixed before shipping, because
a gate that cries wolf gets switched off, which is worse than no gate.

**Still no gate for the seam §L names as widest:** an IPC channel whose two sides
disagree about the *payload shape*. `check-ipc-parity` proves a channel exists,
not that its arguments agree. P-09 and P-11 both came through it. Next.

### D8 · P1 · CLOSED 08-10 · Dispatch slips could print on neither system — and the HTML sale path is gone
Thermal ran a full service on 2026-08-10 with **all ticket types produced,
dispatch slips included**, which is the condition `POSPage.tsx:451` set for
itself: *"The old path is NOT deleted. It is the fallback, and it stays until a
real service has gone through the thermal one on this hardware."*

**0.5.27 removes the HTML SALE path only.** The rule 17 sweep found the naive
"delete four modules" would have taken three things with it:

- **Shift and Z-reports.** `escposBridge` exports exactly one print function,
  `printSale`. There is no thermal shift report. `printShiftReport.ts` is
  untouched and `ShiftPanel`/`ManagerPage` still use it.
- **Printer calibration.** `buildCalibrationTicket` is how paper width is
  detected. No thermal equivalent.
- **Test prints and previews.** `PrintersTab` uses `printKOT` and
  `printDispatcher` for sample tickets and on-screen previews.

So `printKOT`, `printDispatcher` and `printReceipt` all remain. What went is the
duplicated live-sale branch in `POSPage` — 76 lines — and the early return that
was D8 itself.

**D8 is closed by reporting, not by routing around it.** `printSale` has always
returned `{ queued, skipped }` and every caller discarded `skipped`, so a station
with no printer bound was skipped in silence. It now reaches the renderer and
the cashier is told *"nothing printed for: Dispatch"*. With no fallback there is
no second system to catch it, so silence was no longer survivable.

**`escpos_enabled` now defaults ON** (`localDb.ts`). It defaulted OFF while HTML
was the fallback — correct then, dangerous now: OFF no longer means "print the
old way", it means print nothing. A guarded one-time backfill in
`maintenance_state` flips tills that hold 0, and **does not override a manager
who later turns it off deliberately** — verified against a real SQLite database,
not reasoned about.

**The `localStorage` exclusion list is retired.** The Printers tab previewed and
test-printed from a per-till localStorage copy while the printer used the
server-synced list — two lists on one screen, silently disagreeing. New
`escpos:kitchenExclusions` IPC exposes what the printer actually applies; the box
is now **read-only and shows the live value**, and says where it is edited. A
control that looks editable and changes nothing is worse than no control.

**Not done, and deliberately:** a thermal shift report. That is new code, not
removal, and deleting the HTML one would have left the manager screen with
nothing. Its own release.

### A42 · P1 · CLOSED 08-10 · The thermal toggle's OFF label reassured while nothing printed
`PrinterSetupScreen.tsx:169` read *"Off. Sales still print the old way; nothing
on this screen affects them yet."* True while the HTML fallback existed. **From
0.5.27 it is false: OFF means nothing prints at all** — no kitchen ticket, no
dispatch slip, no receipt.

Now *"OFF — nothing will print. Turn this on before trading."* in amber. Found
because the owner unticked it on a live till and the screen said everything was
fine.

The 0.5.27 backfill is confirmed working on real hardware: marker row
`escpos_default_on_0527 = applied` at 12:49:43, column set to 1, and it correctly
did **not** override the owner's later deliberate untick — the property verified
against SQLite before shipping.

### A43 · P1 · CLOSED 08-12 · Exclusions were built on a screen that is not rendered
**Closed 08-12.** The read-only kitchen-exclusions box (plus the
`escpos:kitchenExclusions` read) was ported from the unrouted `PrintersTab` into
`PrinterSetupScreen`, which IS routed — `ManagerPage`'s `case 'printers'` renders
it. The root cause (orphaned on a screen nothing mounts) is therefore resolved:
the box now lives where the code path reaches it. The list is cloud-owned and
read-only on the till (synced via `syncEngine.ts:645`, read via the live IPC), so
there is no save path to break. Renderer `tsc` green. **Smoke-test on Windows to
confirm the box renders and shows the synced terms** — the residual is visual
confirmation, not wiring (unlike the original, this screen mounts).
`PrintersTab.tsx` was superseded by `screens/PrinterSetupScreen.tsx`.
`ManagerPage.tsx:1116` says so in a comment: *"PrinterSetupScreen supersedes
PrintersTab… PrintersTab.tsx remains in the tree"* until thermal is proven.

0.5.27's read-only exclusions box, the live-list preview and the
`escpos:kitchenExclusions` wiring all went into `PrintersTab`. **None of it is
reachable.** A rule 17 failure of the exact shape the rule names: the file
existed, and I never checked that it renders.

The IPC channel and the main-process half ARE live and correct — only the
renderer half is orphaned.

**Deliberately not ported across.** `PrinterSetupScreen` is station-oriented —
stations left, the selected station's settings centre — which is the natural home
for **per-station** exclusions (PHASE6 §4, `print_stations.exclude_terms`) rather
than a global card bolted onto a per-station layout. Exclusions stay on the web
dashboard until PHASE6.

**DELETION ATTEMPTED AND REVERTED 08-10. A43 STAYS OPEN — it is not the
one-line removal this entry implied, and the reason is worth more than the
deletion.**

Thermal ran a full service on 2026-08-10, so the condition
`ManagerPage.tsx:1116` set for retention IS met. The file is genuinely
unreachable: no `import PrintersTab` anywhere in `apps/desktop/src`, only
comments. Deleted; desktop main tsc, renderer tsc and `vite build` all passed
(64 modules transformed).

**Then `scripts/test-print-resilience.mjs` went red — 51 assertions, ENOENT.**
Four of them read `PrintersTab.tsx` directly, at lines 63, 70, 81 and 178. Two
things are tangled in there and they need separating before anything is deleted:

1. **§4 protects a real field bug that has nothing to do with this file's
   reachability.** `PrinterPicker` was once declared INSIDE the component, so
   every render made a new component type, React remounted the `<select>`, and
   an open dropdown snapped shut under the status-dot probes — read on site as
   *"stuck on Microsoft Print to PDF"*. The assertions pin it to module scope.
   **`PrinterSetupScreen.tsx:270` has a `<select>` of its own and no equivalent
   assertion.** So deleting `PrintersTab` does not merely drop dead coverage; it
   drops the ONLY guard against that bug, on the screen that is now live.
2. **§5 asserts the owner edits kitchen exclusions "on the Printers tab"** —
   `PB2.includes('Kitchen exclusions')`. That assertion is already describing
   something unreachable, which is this very finding. The gate is protecting a
   fiction and has been since 0.5.27.

**Rule 20 decides it: the assertion complains, so the change moves.** Rule 12
too — "delete 479 dead lines" grew into "rewrite a print-resilience suite
covering a live field bug", which means the diagnosis was wrong, not that the
fix is bigger. Reverted rather than loosened.

**The right sequence, and it is a decision, not a chore:**

1. ~~Port §4's picker assertions to `PrinterSetupScreen.tsx`~~ **DONE 08-10.**
   `test-print-resilience.mjs` §4b, four assertions on the live screen, in the
   general form of the bug rather than a copy: no component declared INSIDE
   `PrinterSetupScreen` (the identity churn that remounts an open `<select>`);
   options keyed by `p.name` not index; a target still settable with no printer
   plugged in; and the free-text input not hidden behind `localPrinters.length`,
   or a machine reporting no printers could set no target at all.
   Mutation-checked twice — nest a component inside the export, and key by index;
   each fires its own assertion. **The screen currently uses inline JSX and so
   cannot have the original bug, but it is one refactor away, and the refactor is
   the obvious thing to do as the file grows.**
2. Resolve §5 — either exclusions move somewhere reachable (PHASE6 §8c makes them
   per-station), or the assertion is dropped as describing a screen that is gone.
3. Only then delete the file.

**Also note what the deletion orphans:** `components/StationsPanel.tsx` (294
lines — define print stations, route categories) is imported ONLY by
`PrintersTab:22`. It is the nearest existing desktop implementation of what
PHASE6 §8c wants at the branch, so it should not be swept up with the parent.

Checked and NOT orphaned — all still have live callers, so D8's retention
reasoning holds: `printReceipt` (8, incl. `POSPage`), `printKOT`
(`usePrinterSettings`), `printDispatcher` (`printKOT`), `buildCalibrationTicket`
and `buildThermalDocument` (`PrinterSettingsModal`, `thermal`, `printReceipt`),
`PaperWidthControl` (`PrinterSettingsModal`).

### A44 · P2 · CLOSED 08-10 · Adding a station — already built, and it anticipated this
Owner asked for a "Barista" station. `dashboard/pages/settings/StationsPage.tsx`
has create, edit, delete and category routing; `routes/stations.ts` has
POST/PATCH/DELETE behind `products.manage`. The page's header comment reads *"A
client wanting a 'Barista' station tomorrow meant a code change"* and the New
station placeholder is literally **"Barista"**.

`kind` is constrained to `kitchen | dispatch | receipt` (migration 44). A Barista
station is a new station NAMED Barista with kind `kitchen` — kind decides
behaviour and ticket layout, the name is what staff call it. It reaches the till
on the next catalogue sync, where a printer is bound to it.

**Nothing to build for the DASHBOARD.** But the desktop cannot create stations,
and that matters: a branch at `locked` cannot open the portal, so it could not
add a station at all — a shop building a coffee counter would have to renew a
*web* subscription to tell its own till about it.

**Folded into PHASE6 §8c** (owner, 08-10): station create/edit becomes
manager-editable at the branch under `products.manage`, no internet required,
**not** behind the tech screen — tech access needs a reveal code and a signed
token from the same portal that is locked, which would route around a closed door
with a key kept behind it.

Backed up and visible to head office, per the owner: node authoritative, cloud
the durable copy, dashboard reads it, *"so the owner can tell what is happening on
the ground."* `print_stations` already syncs DOWNWARD to the till; the missing
half is the write path and the upward sync — the same `/node/settings` channel
per-station exclusions need, so building them apart would mean building that sync
twice.

**A45 — the original finding, as written on 08-10.** Retained verbatim. Its closure is recorded in the A45 entry earlier in this file (cloud side closed 2026-08-11, one role grant away from fixed).
Observed on a live till 2026-08-10: a manager opens Receipt, edits the branch
address and phone, presses Save, and gets **"Your role does not allow this
change."**

Two gates for one action, disagreeing:

- `ManagerPage.tsx:1083` — the tab is listed `...(isManagerRole ? [...] : [])`
- `business.ts:110` — the write needs `requirePermission('settings.manage')`

**§L's seam again, this time in permissions.** The UI promises what the server
refuses, and nothing compares them. The user finds out after typing.

Immediate unblock: grant the role `settings.manage` on the dashboard, or edit as
the owner. **Both are worse than they sound — see A46.**

Proper fix is PHASE6 §7, which already separates branch-operational settings from
business-identity ones. The screenshot makes the case: the header read
`Juja B Branch / 018202083` — a BRANCH address and phone, exactly the
manager-editable, branch-local content §2 argues for. The KRA PIN line is the
part that is business identity and stays owner-only.

Whatever the split, **the tab's gate must read the same key the server enforces.**
A source-text gate asserting that every permission-gated route has a UI gate
naming the same permission would catch this class — the fourth comparator, after
`check-ipc-parity`, `check-header-keys` and `check-doc-refs`.

### A46 · **P1** · PARTLY CLOSED 2026-08-11 — machinery built, 13 of 16 routes split
**Shipped:** `requireAnyPermission()` (`rbac.ts`), migration 75 registering all
twelve keys, and 13 of the 16 `settings.manage` routes re-pointed:

| File | Routes | Now accepts |
|---|---|---|
| `devices.ts` | 5 | `devices.approve` **or** `settings.manage` |
| `tables.ts` | 4 | `tables.manage` **or** `settings.manage` |
| `etims.ts` | 4 | `etims.manage` **or** `settings.manage` |

**Additive, and that is the design, not a compromise.** A role holding
`settings.manage` today keeps exactly what it has, so the split is deployable
without a coordinated permission migration and nobody is locked out mid-service.
The narrow key is what a manager is granted *instead*, going forward. This does
not shrink `settings.manage`; it provides alternatives to it. Shrinking it needs
to know who holds it in production and is a separate decision.

**THREE ROUTES DELIBERATELY NOT SPLIT, each for a different reason:**
1. **`business.ts:110` — `receipt.manage`. This is A45's actual field bug and it
   is NOT a route swap.** `POST /settings` writes any key through one handler,
   including `supervisor_pin` (bcrypt-hashed) and the ENCRYPTED_SETTING_KEYS
   M-Pesa secrets. `receipt.manage` must therefore be a PER-KEY check inside the
   handler, allowing only `receipt_header` / `receipt_footer`. Getting that
   wrong grants write access to a PIN hash or a payment secret. Different
   mechanism, security-sensitive, own batch. The key is already registered so
   that batch needs no migration.
2. **`shifts.ts:369` — `shifts.force_close`.** Its UI is
   `apps/desktop/src/renderer/pages/DayCloseTab.tsx`, so touching it triggers a
   desktop version bump (rule 15) and a green this bench cannot produce (rule 9).
3. **`flags.ts:26`** stays `settings.manage` — feature flags are business-wide
   and are exactly what the retained key is for.

**`products.manage`'s 29 routes are untouched.** `stations.manage` is registered
ready for PHASE6 §8c but nothing enforces it yet.

### A46 (original finding) · One permission gates sixteen routes with wildly different blast radii
Owner, 08-10: *"split these roles into fine small roles that would not affect
operations… rather than having one role once implemented a whole section is
affected."* Correct, and the measurement supports it.

**`settings.manage` gates 16 routes across 6 files:**

| Route | What it grants |
|---|---|
| `business/settings` | Receipt text — **and** loyalty rate, service charge, turnover alerts, every flag in `READABLE_SETTING_KEYS` |
| `devices/:id/approve` · `reject` · `delete` | Approve or **revoke a terminal** |
| `devices/:id/authorise-handover` | Hand the branch-server role to another machine (migration 74) |
| `etims/config` · `branches/:id/register` | **KRA fiscal device registration** |
| `flags/:key` | Feature flags |
| `shifts/:id/force-close` | Close a drawer with no count — the cash-variance path |
| `tables/*` | Create and delete tables |

**To let a manager type a branch phone number you must also grant eTIMS
registration and the power to revoke a till.** That is not a permissions model;
it is one switch.

`products.manage` is worse by volume — **30 routes** (re-counted 08-10; the entry said 29) — and includes station
create/delete, which PHASE6 §8c moves to the branch.

**Proposed split** (names follow the existing `noun.verb` convention):

| New key | Takes over |
|---|---|
| `receipt.manage` | `business/settings` for `receipt_header`, `receipt_footer` |
| `stations.manage` | `print_stations` create/edit/delete, per-station exclusions (PHASE6 §8c) |
| `devices.approve` | approve / reject / delete / authorise-handover |
| `etims.manage` | eTIMS config and registration — owner-only in practice |
| `tables.manage` | `tables/*` |
| `shifts.force_close` | the no-count close, audited |
| `settings.manage` | **retained** for what is left: flags and business-wide settings |

Every key is additive: a role holding `settings.manage` today keeps everything it
has, and the new keys are what a MANAGER role gets granted. `permissions` and
`role_permissions` already exist (migration 00), `permissions_version` already
forces token refresh on change, and migration 59 already backfills defaults — so
the machinery is there. This is seeding rows and re-pointing gates, not new
infrastructure.

**Not started.** It touches 45 route gates and every UI gate that mirrors them,
and it needs the A45 comparator built first or the two will drift again while
being changed. Sequence: comparator → split → re-point UI gates.

### A50 · P1 · **REOPENED AND RE-FIXED 08-10** · Daily summaries never delivered — SMTP died on IPv6

> **THE FIRST FIX DID NOT WORK, and the boot check is how we know.** Production
> answered, within seconds of deploy:
>
> ```
> [mailer] SMTP FALLBACK IS DEAD — smtp.gmail.com:587 —
>          connect ENETUNREACH 2607:f8b0:400e:c20::6c:587
> ```
>
> **`family: 4` is never read by nodemailer.** `smtp-connection/index.js:264`
> builds its DNS options as `{ port, host, allowInternalNetworkInterfaces,
> timeout }` — `family` is not among them. Resolution goes through
> `dns.lookup(host, { all: true })`, filters with `isFamilySupported()` — which
> asks whether the machine **has** an IPv6 interface, not whether it has a
> working **route** — and `formatDNSValue()` then picks **a random address from
> what survives**.
>
> Render's container has an IPv6 interface and no usable route, so IPv6 counted
> as supported and was chosen roughly half the time. **That also explains the
> mixed `ENETUNREACH` and `Connection timeout` lines in one run** — different
> random picks, one failing instantly and one hitting `connectionTimeout`. One
> fault, not two. Because the pick is random rather than ordered,
> `dns.setDefaultResultOrder('ipv4first')` would not have fixed it either.
>
> **The real fix:** resolve A records ourselves (`dns.resolve4`) and connect to
> the literal, with `tls.servername` set to the hostname so certificate
> validation still matches — without that, TLS would be checked against
> `74.125.126.108` and every send would fail verification instead of routing,
> trading one silent failure for another. Re-resolved on a 10-minute TTL because
> Google rotates these; a DNS blip keeps the last good address rather than
> falling back to the hostname, since the hostname is the failure mode.
>
> **WHY THE TEST DID NOT CATCH IT, which is the more important lesson.** It
> asserted that nodemailer **stored** `options.family = 4`. It does store it. It
> never reads it. **Storage is not effect** — and the mutation check was blind
> here, because removing an ineffective option leaves behaviour identical, so
> both versions were equally broken and the gate saw no difference.
>
> **And this sandbox cannot reproduce the bug at all.** It has no non-internal
> IPv6 interface, so `isFamilySupported(6)` returns false and IPv6 is filtered
> out before the random pick. Every local check passed because the failure is
> environmental — rule 9, sharper than usual: not merely a weaker environment, an
> environment in which the defect is **structurally impossible**. The only thing
> that could have caught this before deploy was the boot check, and it did, four
> seconds after the service went live.
>
> Re-fixed with three mutation checks that now bite: revert to the hostname,
> drop `tls.servername`, reintroduce `family`. **Still unproven in production
> until the next deploy prints `SMTP fallback reachable`.**

**A50 — the FIRST close, 08-10.** Superseded by the REOPENED entry above, and then by A54: the IPv4 pin worked and a second, independent cause (a filtered port) survived it. Retained because the reasoning in this text is what A54 falsifies.
Found by reading Beryl's server log, not by anyone reporting it. **Nine
businesses, every scheduled run, both observed days, zero delivered.**

```
[dailySummary] Failed for Beryl: connect ENETUNREACH 2607:f8b0:400e:c02::6c:587
[dailySummary] Failed for MAZURI Petrol Station: Connection timeout
```

`2607:f8b0::/32` is Google over IPv6, port 587 — the SMTP fallback. Render's
container has no usable route there, so nodemailer resolved AAAA first and died
in `connect()`, before TLS, before AUTH, before any recipient was offered.
`Connection timeout` in the same run is the same fault on a different IPv6 route,
hitting `connectionTimeout` instead of failing instantly.

**Two plausible explanations were checked and ruled out against the log:**

- *Unverified Resend domain.* No — `RESEND_API_KEY` was **absent**. The boot line
  *"Not set … will fall back to SMTP"* only prints for variables missing from
  `env.ts`'s optional list, so `resend` was `null` and that branch never ran. The
  free-mail warning at `mailer.ts:44` never fired either. Resend was not in the
  picture on either day.
- *Test businesses with unreal addresses.* No — `ENETUNREACH` is a NETWORK-layer
  failure on connect, so no address was ever sent. A bad recipient produces an
  SMTP 550 after `RCPT TO`. Beryl, a real production client, failed identically,
  and all nine failed the same way on both days.

**Fixed:** `family: 4` on the transport. `family` is honoured by nodemailer at
runtime but is absent from `@types/nodemailer` 8.0.x, so supplying it made
TypeScript fall through to another `createTransport` overload and report the
misleading *"'host' does not exist"*. Widened with a named
`SmtpOptions = SMTPTransport.Options & { family?: 4 | 6 }` rather than casting the
literal to `any`, which would have silenced real mistakes in the same object.

**Also fixed: the silence.** `dailySummary.ts:61` catches per business, logs, and
moves on, so the only trace was a line at 18:00 UTC. `reportMailReadiness()` now
runs at boot — `verify()`, which connects and authenticates without sending — and
names a dead transport at startup beside the other things that are wrong. Not
awaited and it never throws, same rule as `reportSeededAdmins`: a shop must not
fail to trade because nobody verified a mail domain.

It also names the case production was actually in — **`RESEND_API_KEY` unset means
SMTP is the ONLY path**, so an SMTP failure is total, not a degraded fallback.

**This is §L in a form the register has not recorded before.** Not two things
that must agree — a feature and its own failure report, with nothing making the
failure reach anybody. Nine businesses believed they had a daily summary.

**Still outstanding, and NOT code:**
- `Mama Ari Restaurant` has `owner_id = null` and is skipped before any send is
  attempted. A data-integrity problem in the business row, both days, silent.
- Setting `RESEND_API_KEY` is still worth doing. If it is set, `NOTIFY_FROM_EMAIL`
  must be on a domain verified at resend.com/domains, or every send is rejected
  and demoted back to SMTP — the boot warning will say so.

**The test failed its own mutation check before it passed.** Commenting out
`family: 4,` and `void reportMailReadiness();` left both matching their regexes,
so all 14 assertions reported green against a codebase with the fix removed. One
assertion was worse: `/family:\s*4/` was satisfied by the phrase inside an ERROR
MESSAGE at `mailer.ts:152`. Comments and string literals are code to a regex.
**Third occurrence this session** — `check-auth-retry` read `.from('stock')` out
of the comment explaining the B6 fix, and `manage-fetch-refresh` asserted against
an empty default parameter. Rule 23 keeps being right.

### A51 · P2 · CLOSED 08-13 · The device token sawtooths: every other catalogue pull 401s by construction
Beryl's till log is **90 lines and every one of them is this**:

```
07:32:58 [sync] catalogue pull failed: HTTP 401 …
07:32:58 → recovered after: …          (3-5s later)
07:52:58  … and again, exactly 20 minutes later, all day
```

Deterministic, not intermittent:

- `syncAll()` runs every **10 minutes** (`index.ts:226`)
- the access token lives **15 minutes** (`auth.ts:51`)
- **refresh is purely reactive** — nothing decodes `exp`, nothing refreshes ahead

So after a refresh at T the pull at T+10 succeeds and the pull at T+20 **cannot**:
20 > 15. Every other pull 401s, refreshes, and resets the clock. A permanent
sawtooth.

**Which token:** the catalogue pull uses `authHeaders()` → `_accessToken`, the
DEVICE token. `pushAuthHeaders()` prefers `_staffToken`. So this sawtooth refreshes
the device token only and never touches the staff token — which is precisely why
A47 could sit undetected on a busy till: selling triggers pushes, pushes refresh
the STAFF token on 401, and `manageFetch` read the fresh one from the store for
free. On an idle till nothing pushes, the staff token dies alone, and the first
manager action eats the 401.

Three costs, and the third is the one that matters:

1. Every other catalogue pull is 3-5 seconds slower than it needs to be.
2. **~72 refresh-token rotations per day per till.** Each is a chance for two
   refreshes to race, and `validateRefreshToken` treats a reused token as stolen
   and revokes EVERY session for that user. Running that lottery 72 times a day
   for no reason.
3. **The log is no longer usable as a diagnostic.** A revoked till, a rotated
   service key, a genuine expiry — all would look identical to routine noise.
   An error that always fires is an error nobody reads.

**Fixed — `refreshDeviceTokenIfExpiring()` in `syncEngine.ts`.** `syncAll()` now
refreshes the device token when it is within `REFRESH_SKEW_SECONDS` (120s) of
expiry, before the pull, so the 10-minute tick can no longer collide with the
15-minute lifetime. Reads `exp` payload-only via `secondsUntilExpiry()` (no
signature trust — the server still verifies every request); an unreadable `exp`
returns null and falls through to the reactive 401 path, which is untouched and
remains the backstop. Scoped to the DEVICE token only — it never reads
`_staffToken` or calls `refreshStaffToken`, which was load-bearing while A47's
idle test was live.

**Verified on the bench:** `apps/desktop/test/device-token-refresh.test.mjs`,
21 assertions — the sawtooth simulation, device-only scoping, the reactive
backstop still present, and safe `exp` reading (garbage/empty/no-exp all return
null rather than throwing into the sync tick). The register entry had lagged the
code: this was implemented after the entry was written and closed here on 08-13.
**Not yet field-confirmed** — a till running a build from before this landed still
sawtooths, so a rebuilt release must reach the fleet before the log goes quiet.

### A52 · P1 · CLOSED 08-10 · The till stayed signed in on an unattended machine
Requested after A47: *"can we make the app lock after 3-5min of inactivity"*, then
clarified — *"it should only fire when there is no activity in the software, not
when someone is using it; it should work like screen lock"*.

**That clarification chose the design.** `powerMonitor.getSystemIdleTime()`
reports seconds since the last keyboard or mouse input ANYWHERE on the machine —
the signal Windows uses to blank a screen. A cashier mid-sale is touching the
machine, so idle is 0 and the timer cannot fire. **"Never lock mid-transaction"
is true by construction, not by a special case somebody must keep working.**

Renderer activity tracking would have been the obvious build and the wrong one:
it misses a cashier reading a long receipt or counting cash into the drawer, so
it locks a till somebody is standing at. Staff answer lock fatigue with trivial
or shared PINs, which on a 4-6 digit PIN over bcrypt is a net security LOSS.

**Thresholds:** manager 5 min, POS 10 min. The split is exposure, not friction —
the manager screens hold Close Day, Close Branch, Staff and Receipt, and
`settings.manage` also gates till revocation and eTIMS registration (A46). Not 3
minutes anywhere: too short to distinguish "away" from "not typing".

**It is a CURTAIN, not a reset.** `LockCurtain` renders OVER whatever is mounted.
It does not unmount `POSPage`/`ManagerPage`, does not clear the staff session,
does not touch SQLite. The cart, the part-entered payment and the open tab are
all still there behind it. **Losing a sale to the lock is unreachable rather than
merely unlikely** — there is no code path that discards anything, so there is
nothing to get wrong later.

**Unlock is the PIN pad, never the owner login** (A17). It calls the same
`auth.verifyPin` `PinPage` does, so the offline cache (`staff_pin_cache`, 14
days) and the revocation handling come for free instead of being a second
implementation that must agree with the first. **Only the locked staff member can
dismiss it** — another cashier's valid PIN would otherwise continue the first
cashier's shift under their identity, with every order still attributed to the
person who walked away.

**Suppression** holds the lock off while work is in flight and nobody is at the
screen — an M-Pesa STK push awaiting its callback, a print job spooling. A
counter, not a boolean, because those overlap and a boolean lets whichever
finishes first re-arm the lock. Tokens are held in MAIN: handing the release
closure to the renderer would let a reload mid-print strand a suppression and the
till would never lock again.

27 tests. Three mutation checks, each caught by exactly the assertion that owns
it: make the curtain clear the staff session → the cart-loss guard fires; remove
the identity check → the wrong-cashier guard fires; render the curtain INSTEAD of
the screen rather than alongside → the unmount guard fires.

### A53 · P2 · RATCHETED 2026-08-11 (was OPEN) · Twenty-one audit IDs are cited in code with no entry anywhere
This register records being opened on 2026-08-07 with sections
`A1, B1-B5, C1-C6, D1-D3, E1-E4, F, G1-G2, H1-H2, I`. The 08-08 restructure kept
**only A and D**. The code still cites the rest — `// Audit H10` in `render.yaml`,
`// audit C4` in `index.ts`, `audit B6`, `audit H14` and more.

**They are not recoverable.** The first committed version of this file
(`a80c224`) already contained only A-section headings, so those entries never
reached the repository at all. An earlier note in this register suggesting
recovery from `git show 415e044:docs/AUDIT-REGISTER.md` was wrong — that commit
is not in this history. **Reconstructing them would mean inventing findings**,
which is worse than a gap a reader can see.

`docs/AUDIT-ID-INDEX.md` now lists all 20 cited IDs with their call sites and
marks each *in register* or *cited only*, so a citation leads somewhere. It is
generated by reading the tree, not hand-maintained.

**RATCHETED 2026-08-11.** The recorded fix below was "when a cited-only line is
next touched", which is a policy nothing enforces — so the set could quietly
grow. `check-register-consistency.mjs` now counts orphan citations against
`scripts/register-orphan-baseline.json` (21 today): the set may shrink and may
never grow. Fixing some fails the run until the baseline is lowered, same as
typecheck-ratchet. The 21 remain unrecoverable and are NOT to be reconstructed.

**Fix, when a cited-only line is next touched:** resolve the reference into the
comment — say what the finding was, in place — or drop the citation. A reference
a reader cannot follow looks like documentation and is not, which is the same
reasoning that produced `check-doc-refs` for documents (A39).

### A47 · P1 · CLOSED 08-10 · **CONFIRMED IN THE FIELD** · `manageFetch` never refreshed — every manager screen reported the till signed out

> **VERIFIED ON 0.5.28, Beryl's till, 2026-08-10.** Signed in, away 30+ minutes,
> then clicked through the manager screens — **no banner**, confirmed again
> later in the same session. That is the discriminating test: an idle till with
> no sales is the one condition under which nothing refreshes the staff token,
> and it is exactly how this was reported.
>
> The till log corroborates the setup rather than the result — `19:19:45`,
> `19:39:46`, `19:59:46`, `20:19:45` show the machine awake, online and syncing
> throughout. It cannot corroborate the result itself: `manageFetch` failures
> throw to the renderer and never reach `swiftpos.log`, so the absence of errors
> there is not evidence. **The click-through is the evidence.**
>
> Same log incidentally confirms **A51** in the wild — twenty minutes apart to
> the second, on a build that does not yet carry that fix, exactly as the
> simulation in `device-token-refresh.test.mjs` predicts.

**A47 (duplicate wording) — superseded.** Same finding as the A47 entry immediately above; the two headings said the same thing twice.
**Field report, Beryl, 0.5.27, Menu screen: the banner appears after the till has
been signed in and left a while. Selling unaffected.**

Not a refresh-token failure and nothing to do with D13's crash window.

`manageFetch` (`ipcHandlers.ts:1288`) serves **35 manager-screen handlers** —
Menu, Staff, Prices, Combos, Receipt, Printers. It read the staff access token
once and threw on any non-2xx. **It had no 401 branch at all.**

The staff ACCESS token lives 15 minutes (`auth.ts:51`); its REFRESH token lives
30 days and was valid throughout. So the first manager action after fifteen idle
minutes returned 401, `humaniseError` matched `/unauthor/i` (`posApi.ts:401`), and
printed *"This till was signed out. Ask a manager to sign in again."*

The till was never signed out. The sync engine had been refreshing on its own
token the whole time — which is why sales kept working, only manager screens
broke, and the fault read as intermittent rather than as a missing branch.

**`ownerFetch`, forty lines earlier in the same file, has had the branch since it
was written.** §L again: two things that must agree with nothing comparing them —
the same shape as A38's two header spellings, one file apart instead of two.

Fixed with the `ownerFetch` pattern: on 401 refresh, re-read from the store
(refresh persists a new pair to SQLite, so the in-memory copy can lag), retry
ONCE. A second 401 is a real rejection — revoked, `ACCOUNT_INACTIVE`,
`PERMISSIONS_CHANGED` — and reaches the user. `refreshStaffToken` is already
single-flight, which is load-bearing: two concurrent refreshes present the same
rotating token, and `validateRefreshToken` (`auth.ts:210-222`) treats a reused
token as stolen and **revokes every session for that user** — the real "signed
out" this change prevents rather than causes.

15 tests, mutation-checked (remove the branch → 4 red, exit 1, naming it).

**The test failed its own first version (rule 23, third time).** Its
brace-balancer took `ownerFetch`'s `= {}` DEFAULT PARAMETER as the function body,
so every assertion about `ownerFetch` was evaluated against `"{}"` and passed by
not looking. Fixed by walking the parameter list to its matching `)` first.

**GATE BUILT — `scripts/check-auth-retry.mjs`, in CI.** Every function that both
attaches `Authorization: Bearer` and calls `fetch()` must handle 401. It asserts
only that expiry was CONSIDERED; whether the retry is correct is the test's job,
because a source scan claiming more would be pretending to knowledge it lacks.
Mutation-checked: it names the exact file, function and line.

**It found a second instance on its first run** — `refreshTechConfig`
(`techService.ts:85`). Exempted with a checkable reason, not fixed: one call site
(`ipcHandlers.ts:126`), fire-and-forget, passing a token seconds old from
`/desktop-login`. A 401 there is not expiry, and the only cost of failing is that
the tech panel cannot be unlocked offline until the next login. Machinery for a
case that cannot arise is rule 12.

### A48 · P1 · CLOSED 08-10 · The receipt closing block was lost with the HTML sale path
**Field report: `Thank you for your business!` and `TAX RECEIPT UPON REQUEST`
missing above `Powered by SwiftPOS`.**

A regression from 0.5.27's removal of the HTML sale path (D8). The footer stack is
an owner-approved arrangement dated 04 Aug 2026, recorded at
`ReceiptView.tsx:250-256`: the owner's box verbatim, a rule only when that box has
content, then a fixed closing block the box cannot edit.

**The closing block existed only in the HTML receipt.** The thermal renderer had
never carried two of its behaviours:

- the DEFAULT thank-you when the owner's box is blank. `ipcHandlers.ts:792` passes
  `receipt_footer || undefined`, so an empty field printed no thank-you AND no
  rule — the receipt ended on the payment line and then the credit.
- `TAX RECEIPT UPON REQUEST` whenever VAT applies. The string appeared nowhere in
  `shared/printing` — only in the deleted component, and in `wrapAuthored`'s
  docstring, which uses it as its worked example.

`wrapAuthored` was never at fault. P-15 fixed newline handling and it still works;
the lines were not reaching it.

Restored in `render.ts` so it renders once for every receipt path. The tax line is
gated on `vatRate > 0` — a zero-rated business printing it claims something untrue
on a document the customer keeps — and is deliberately NOT taken from
`receipt_footer`: a line with legal meaning that depends on someone remembering to
type it is a line that goes missing, and on this build a manager cannot type it
anyway (**A45**).

11 tests driving the real renderer at 80mm and 58mm. Mutation-checked twice —
remove the block → 7 red; remove ONLY the `vatRate > 0` guard → exactly 1 red.

**Records a gap in D8's sweep.** The rule 17 sweep correctly found what still USED
the HTML modules — shift reports, calibration, previews — and correctly kept them.
It did not ask what those modules EMITTED that nothing else did. Deleting a path
means auditing its output, not only its callers.

**`SAMPLE-OUTPUT.txt` is NOT regenerated by `npm test`.** This file claims it is,
in §I and in the 08-08 status block, and cites it as evidence. It is a captured
run, updated by hand via `npm run sample` — which prints a money check and writes
nothing. Corrected here; the citations elsewhere should be read with that in mind.

### A49 · P1 · CLOSED 08-13 · `stock_adjustments` is a dead table, hidden by a false gate exception
Found 08-10 by a column-level sweep for more A12-shaped bugs.

`stock_adjustments` is a real table — baseline, RLS-enabled, FKs, CHECK
constraints. It is **read in exactly one place**, `reports.ts:286`, which builds
the Adjustments section of the stock-movement report. It is **written nowhere**:
not `apps/server`, not `apps/dashboard`, not `apps/desktop`, not any migration,
not any RPC.

`reports.ts` derives `restocked` and `written_off` from it and unions them with
sold quantities. **Every one of those figures is permanently zero.** The report
shows what sold and states that nothing was ever restocked or written off.

**`check-table-usage` — the gate built for exactly this shape (B6) — was silenced
on it by an exception whose stated reason was false on both counts:**

> *"Written by the till via /api/sync/push, which resolves the table name
> dynamically."*

`/api/sync/push` writes four hardcoded tables — `business_days`, `shifts`,
`float_transactions`, `expenses`. There is no dynamic resolution anywhere in
`sync.ts`. And the till has no such local table: `stock_adjustments` appears in
neither `SYNC_DIRECTION` nor `localDb.ts`. **It had never been true.** The entry
even carried its own caveat — *"Confirm this stays true if the sync route is ever
refactored"* — which invited a re-check of a claim that was wrong at rest.

Adjustments are actually recorded in `stock_movements` (`stockEffects.ts:378`,
`orders.ts:1097`, `fueltanks.ts:194`, `branches.ts:162`).

**This is rule 20 arriving by a quieter route.** Not a loosened assertion — a
plausible-sounding exception nobody re-derived. `table-usage-exceptions.json` is
the least-tested part of the gate system: every reason in it is prose that nothing
checks. The file's header now says so.

Exception corrected 08-10 to state the finding instead of hiding it. **The fix
itself is a product decision and is NOT done:** point the report at
`stock_movements`, or drop the table and the report section.

**Fixed 08-13 — pointed the report at `stock_movements`** (owner's direction:
stock management lives on the web, so the web report should show the real
figures). `GET /api/reports/inventory` now folds `stock_movements` instead of the
dead table, scoped to the business via the `products!inner` embed with
`.eq('products.business_id', …)` — the exact pattern `inventory.ts` and
`branches.ts` already use — and per branch when scoped. `'sale'` is excluded (it
is already counted in the "sold" column, so counting it again would double-count
every sale); `'restock'` → restocked, `'write_off'` → written-off, and
`'correction'` is split by the sign of `quantity_change` (a positive correction
found stock, a negative one lost it). The fold is extracted to
`apps/server/src/lib/stockMovementSummary.ts` (pure, supabase-free) and proven
against the REAL compiled function — `tests/stock-movement-summary.test.mjs`,
6 assertions, **mutation-checked** (drop the correction sign-split and it fails).
Server `tsc` clean. The stale `readOnly` exception for `stock_adjustments` is
removed and `check-table-usage` stays green. **`stock_adjustments` is now read and
written NOWHERE — a fully dead table, a drop candidate for a future tidy migration**
(the same shape as `sync_queue`/migration 80); left in place for now since the
finding — a report showing permanent zeros — is what is fixed. What the bench
cannot prove and a live check should: the report returning real restocked/
written-off numbers against a database with actual `stock_movements` rows.

### A24 · P1 · OPEN · Reference data goes permanently stale on an offline peer

**FIRST PAYLOAD DESIGNED 08-10** — `docs/PHASE6-BRANCH-SETTINGS.md`. Printer
settings rather than the staff roster, deliberately: if downstream distribution
misbehaves, a ticket prints an item it should not (visible, harmless), where the
same failure with credentials means someone signs in who should not. Also
uncovered that `business_settings` has **no `branch_id`**, so a two-branch
business changing exclusions for one branch changes both — and that there are
**two** exclusion mechanisms, cloud-backed and per-till `localStorage`, feeding
the two print paths from different sources.
The unifying finding. `REPLICATED_TABLES` is `orders, shifts, float_transactions,
expenses, business_days, events` — **all sales-side**. Everything a till READS
still comes from the cloud: `syncEngine:476` pulls the catalogue from
`/api/pos/init` and `:581` pulls staff from `/api/staff`, both against
`_serverUrl`. `nodeClient` pulls only `/node/since`.

**The node replicates sales upward and sideways; nothing flows downward through
it.** A17 (auth), A20 (roster for failover) and this are three symptoms of that
one sentence, not three findings.

Consequence at a remote site: a price change reaches the node when *it* has
internet and never reaches the tills; a cashier hired at HQ can never sign in on
a peer; receipt text and kitchen exclusions never update. Two tills at one branch
can quietly sell the same item at different prices — the class `branch_prices`
and `local_price_edits` exist to control.

**Fix:** extend `collectDistribution` downstream to carry `users` and the
catalogue tables. That closes A17, A20 and A24 together and is an extension of an
existing mechanism rather than a new one. See `PHASE5-NODE-AUTHORITY.md` §11.

### CORRECTION 08-09 — the register under-credits what is built
Owner's push-back, checked and upheld. Verified present and sound: bidirectional
branch replication with cursors; orders replicating COMPLETE with `_items` and
`_payments`; promotion and demotion, session-gated, audited and probe-before-save;
`emitEvent` with `EVENT_WHITELIST` as an explicit security boundary; Phase 4
central day close with instructions and acks; the staff sync pipe; `can_authorize`
and `/api/staff/authorizers`; order idempotency end to end.

**PHASE5 §§3-5 over-specified as a result** — in particular it proposed a new
`branch_staff` table when the local `users` table already exists and is already
synced. Superseded by §11.4: add columns to `users`, one flag on `shapeStaff`,
one `/node/verify-pin` route, and extend distribution. Items 6, 7 and 9 there are
a handful of lines each.

### A2 · P1 · CLOSED 08-09 · BUG-17 — mpesa `.single()`
Both sites fixed. `:224` raised PGRST116 on a refunded order (two mpesa legs —
migration 37 keeps both rows) and told the cashier "No M-Pesa payment leg found"
for an order that had one. Now reads all legs, picks the `pending` one, and
distinguishes "already completed" (409) from "nothing to collect" (404).

`:372` was worse and was not in the original finding: the callback destructured
**only `data`**, so any lookup failure produced `payment === undefined`, logged
"unknown checkout", and returned. **A payment M-Pesa had already collected was
dropped, and the log said the checkout did not exist.** Now `maybeSingle` shape
with an explicit error branch that says the payment was NOT recorded and needs
reconciling against the Daraja statement, plus a loud error if two rows ever
share a checkout id.

### A14 · P0 · CLOSED 08-09 · Owner token can carry an `auth.users` id
**This is the Beryl root cause.** `auth.ts` resolved the owner's `public.users`
row with `.eq('email', data.user.email)` — a **case-sensitive** match against a
column holding whatever was typed at signup, while Supabase Auth lowercases. On
a miss both `/login` and `/desktop-login` fall back to `data.user.id`, which is
an **`auth.users`** id, and mint a token carrying it as `userId`.

`orders.cashier_id` is `REFERENCES public.users(id)` (confirmed in the live
dump), and `orders.ts` writes `cashier_id: req.userId`. So the push fails
**23503** — which was neither 23505 nor 23514, so it fell to `throw createErr`
and became "Failed to create order (ref: …)".

It persists for a whole session because **`/refresh` reuses `cleanPayload.userId`
and never re-resolves it**, so one bad login poisons the entire 30-day refresh
chain until a fresh `/desktop-login`. That is the bounded 21:09–22:53 window.

`pos-login` already had the correct pattern from BUG-05 (escaped coarse `ilike`,
exact compare in JS). It was never applied to the two owner paths. Now shared as
`resolveOwnerUserRow()`.

**Login is deliberately NOT refused when the row is missing** — a release is in
flight and an owner who works today must still work tomorrow — but it now logs
an explicit error naming the consequence instead of failing silently.

**Still to confirm on production** (the deduction is from source, not from the
database): see §E.

### A15 · P1 · CLOSED 08-09 · Every order-create failure was one sentence
Anything that was not 23505 or 23514 became "Failed to create order (ref: …)" —
the same message for a bad foreign key, a malformed uuid and a dead database.
Extracted to `lib/orderErrors.ts` and classified: 23503 → 422
`ORDER_FK_VIOLATION`, 22P02/22007/22008 → 422 `ORDER_MALFORMED_VALUE`, 23502 →
422 `ORDER_MISSING_FIELD`. Unknown codes still rethrow, but the log now carries
the SQLSTATE — the one thing missing for three sessions.

Note `22007`: the RPC casts `created_at` with a bare
`NULLIF(...)::timestamptz`, and **only the offline path populates that field.**
Same shape as the `pump_id` bug migration 69 exists to fix.

### A16 · P0 · CLOSED 08-09 · No test in `tests/` had ever run in CI
All 18 offline suites — including `pay-claim-and-loyalty`, `tip-reconciliation`,
`atomic-order` and `stock-effects-parity`, i.e. **the money paths** — were
written one per incident, passed once on the author's machine, and were never
executed again. Nor were any of the 92 desktop tests added on 08-08.

New `server-suites` CI job runs all 18. The two Electron-free desktop suites
(`logFile`, `syncEngine-failures`) added to `desktop-scope`. The three SQLite
suites cannot run on a Linux runner by design (better-sqlite3 is built for
Electron's ABI) and stay a target-machine step; a comment in the workflow says
so, so the next person does not "fix" it.

### A3 · P1 · OPEN · BUG-21 — KDS realtime / RLS
Never re-verified. Still unknown, not known-good.

### A4 · P1 · OPEN · Migration 68 exists only in production
Applied to the live database, never committed to any branch. Confirmed absent
from git history. The repo cannot reproduce production.
**Blocked on:** `select version, applied_at from public.schema_migrations order by version;`

**NARROWED 2026-08-14 (owner supplied a table-only schema export, `swiftdb.sql`).**
Diffed prod's 99 tables and all their columns against baseline + every committed
migration: **every prod table and column is reproduced by the repo.** The lone
prod-only table, `schema_migration_runs`, is **not** a missing migration — the
runner `scripts/migrate.mjs:96` bootstraps it (`CREATE TABLE IF NOT EXISTS` + its
own RLS). So whatever 68/72 did, it was NOT tables or columns. The export is
table-only (no functions/indexes/policies), so the remaining candidates are a
function, index, RLS policy, or data backfill — or a migration **superseded** by a
later committed one (cf. 69 "supersedes 66"). Still OPEN, but the blast radius is
now "invisible objects", not the whole schema. To close: `schema_migrations` rows
WITH `notes` for the gap versions (62/64/65/66/68/72), or a real
`pg_dump --schema-only` (which carries functions/indexes/policies).

### A5 · P1 · CLOSED 08-10 · Documentation understated the system by two phases
Both documents now carry a status header stating what is actually true, rather
than being silently wrong.

`PHASE2-3-DESIGN.md` said *"For approval before code"* a week after the code
shipped — Phase 2a in `5ef0f08` (v47), Phase 2b+2c in `fee91cc` (v49), Phase 4's
central day close in `40f53ac` (v46). It now says to read it as a record of what
was decided and built, names the code as the authority where they disagree, and
lists the drift already known from running it (A19 replica-not-relay, A24 stale
reference data, A17 no node authority) — none of which the design anticipated.

`ROADMAP.md` (dated 2026-07-10) mentions **none** of Phase 2, Phase 4, Close
Branch, `/node/since`, the office role or the ESC/POS migration, so its "now vs
later" calls are not a guide to what is next. It now says so and points at the
register. Kept rather than deleted: §1's product north star — fast food first,
petrol/minimart/parking secondary — is the standing direction and is recorded
nowhere else.

**Not the same as rewriting them.** Restating a month of decisions as a fresh
plan would be inventing intent. A document that announces its own staleness is
honest; one that looks current and is not is the failure this item was about.

`ROADMAP.md` last touched 2026-07-10; no mention of Phase 2, Phase 4, Close
Branch, `/node/since`, events or the office role — all of which pass tests.
`PHASE2-3-DESIGN.md` still reads *"For approval before code."*

### A6 · P2 · CLOSED 08-10 · The 3-Aug handoff was never filed
Recovered from `git show 0f85155:HANDOFF.md` — 383 lines, intact — and filed at
`docs/history/handoffs/HANDOFF-2026-08-03.md`. It supersedes
`SESSION-HANDOFF-2026-08-02.md` and the interim 08-03 file, and its §5 (zip
supersession) is the origin of rule 3.

Recoverable: `git show 0f85155:HANDOFF.md`. Commit `a4aee05` overwrote the path
with a different document. Nothing in `docs/` records the tech DB console or the
wipe gates.

### A7 · P2 · CLOSED 2026-08-11 · `ParkingPOS` / `PetrolPOS` are UNWIRED UPGRADES — and the README said otherwise
**Closed by correcting the document that was actively wrong.** `README.md`'s
business-type table claimed `parking -> ParkingPOS` and `petrol_station ->
PetrolPOS`. Both are imported nowhere. The live path is `CashierScreen.tsx` —
bay grid at `:1141`, pump grid at `:1182` — which is what the table now says,
with a note pointing at this entry before anyone touches either file.

A README that names a dead component is worse than one that says nothing: it is
the first thing a new session reads, and it sends them to the wrong file.

The accuracy note added at the top of README.md also records what it still does
NOT cover: the Electron till, offline mode, the branch-node architecture and
failover, eTIMS, the print server, `apps/admin`, that there are 77 migrations
rather than two, and that each app installs its own dependencies (there is no
root workspace, so the `pnpm install` instruction was wrong as well).
**Re-characterised 2026-08-10 — the previous wording ("unrouted, no ROADMAP
line") invites someone to rebuild what already exists.**

Parking and petrol already ship. `CashierScreen.tsx` (2,739 lines) serves both
inline: `isParking`/`isPetrol` at `:184-185`, the bay grid at `:1141`, the pump
grid at `:1182`.

`ParkingPOS.tsx` (890) and `PetrolPOS.tsx` (889) are FINISHED replacement
components that carry their own wiring instructions in their headers —
*"INTEGRATION IN CashierScreen.tsx — Replace the existing bay-grid block:
`{isParking && view === 'bays' && (<ParkingPOS bays={tables} … />)}`"*. The block
they name is still the live code at `:1141`.

Their sibling `MinimartPOS.tsx` carries the same style of header and **was**
wired in (`CashierScreen.tsx` imports it). Two of three were connected.

**Rule 17's defining pattern exactly** — complete at every layer except one wire,
same as ESC/POS built and left unconnected, same as `adjust_product_stock`. The
decision is whether to wire or to delete; it is not a build.

### A8 · P2 · OPEN · `SplitBillModal` unrouted while `PATCH /:id/split` is live
Confirmed 08-10: the endpoint is at `orders.ts:1932`, scopes edits to the order's
own items via `ownSet`, and works. `SplitBillModal.tsx` (152 lines) has zero
references anywhere in `apps/dashboard/src`.

**Full unreferenced sweep of the dashboard, 08-10** — six files, 2,903 lines:
`ParkingPOS` (890), `PetrolPOS` (889), `OrderHistoryTab` (361),
`BranchSelectScreen` (353), `VariantModal` (258), `SplitBillModal` (152).

**A9 ("empty" renderer directories) — CLOSED 08-10, was never true.** Retained as the original record. NOTE: an earlier A9 heading in this file covers a DIFFERENT subject (`npm audit` findings) — two unrelated findings were filed under one ID, which is precisely why IDs must not be reused.
The finding read *"Empty `apps/desktop/src/renderer/{lib,pages,components}/`"*.
Measured: **12, 12 and 14 files.** Not empty, and no history of being so.

**ID COLLISION, and it is the register's own rule being broken.** `A9` is used
TWICE — this entry and *"A9 · RESOLVED 08-10 — `npm audit`, split by workspace"*
above. The header of this file says *"IDs are stable and never reused."* Reusing
one is how a closed item and an open one become indistinguishable in a changelog.
This copy retains the number because renumbering would break citations; the audit
entry is the one meant by "A9" elsewhere.

### A10 · P3 · CLOSED 08-12 · `PrinterSetupScreen` docstring claims a supersession that has only PARTLY happened
**Closed 08-12.** Docstring corrected to reality: it supersedes only `PrintersTab`
(now unrouted); it does NOT replace `PrinterSettingsModal` or `PaperWidthControl`,
both still live on the POS screen (`POSPage.tsx:21` imports the modal, which
renders the control at `:249`) — re-verified 08-12. Renderer `tsc` green.
**Confirmed still open 08-10, after first being wrongly dismissed.** The docstring
(`PrinterSetupScreen.tsx:4`) claims it *"Replaces PrinterSettingsModal,
PaperWidthControl, PrintersTab and PrintersPage."* Checked one by one:

| Claimed replaced | Reality |
|---|---|
| `PrintersTab` | **True** — unrouted. Deletion attempted 08-10 and reverted; see A43 |
| `PrinterSettingsModal` | **FALSE — still live.** Imported at `POSPage.tsx:21` and rendered at `:1351` behind `showPrinters` |
| `PaperWidthControl` | **FALSE** — still imported by `PrinterSettingsModal.tsx:6`. `PrinterSetupScreen` imports only React and `posApi` |
| `PrintersPage` | dashboard, out of this tree |

So one of four. A docstring that overstates what it replaced is how the next
reader deletes something still on the sell path.

### A11 · P3 · CLOSED 08-12 · `ManagerPage.tsx` comment contradicts itself
Confirmed present 08-10. The comment on the `printers` nav case said `PrintersTab`
*"stays reachable"* AND *"remains … unrouted"* — an unrouted tab is not reachable;
both cannot hold. **Closed 08-12:** rewritten to state plainly that `PrintersTab`
is unrouted and the Printers tab renders `PrinterSetupScreen`. (Line ref drifted
from the original 1061-65 after the A59 edits; the comment is now at the `case
'printers'` render.) Renderer `tsc` green.

### A12 · **P1** · OPEN · `ingredients.current_stock` has had no writer since migration 23
**Raised from P3/INVESTIGATE to P1 on 08-10 — it is no longer a question. It is
B6's sequel, exactly as this entry predicted, and it is live.**

Migration 23 moved ingredient stock to `ingredient_stock_levels`, backfilled once,
and says so in its own header: *"It does NOT drop `ingredients.current_stock` yet
(that's Phase 6…)"*. Phase 6 never came. Since then:

- **Nothing writes `ingredients.current_stock`.** `adjust_ingredient_stock`
  (migration 23) writes `ingredient_stock_levels`. `stock.ts:58` touches
  `ingredients` only for `unit_cost`. `stock.ts:190` creates catalogue rows with
  no stock at all, and says so.
- **`recipes.ts` reads it in three places** — `:28`, `:44`, `:110` — and serves it.
- **`RecipeDrawer.tsx:308-309` renders it**, red when `<= 0`.

So the Recipes drawer shows a snapshot frozen at whenever migration 23 ran, and
every ingredient created since reads **"0 in stock" in red**, while
`IngredientsPage` — which goes through `stock.ts:162` and flattens
`ingredient_stock_levels` — shows the true figure. Two screens, two numbers, one
ingredient, and the wrong one is styled as an alarm.

**Why no gate caught it.** `check-table-usage` compares TABLES. Both tables are
legitimately read and written, so it is satisfied. B6 was a dead table; this is a
dead COLUMN inside a live one. A column-level read/write comparator is the gap.

**Fix needs a decision and is NOT a one-line repoint:** `recipes` is
business-level and `ingredient_stock_levels` is per-branch, so pointing
`recipes.ts` at it requires choosing a branch (the caller's? summed? per-branch
rows returned?). Not started for that reason.

**FIX APPLIED 2026-08-14.** The decision was already made elsewhere: `stock.ts`'s
`GET /ingredients` flattens per-branch stock with `branchScope(req)` — scoped
branch → that branch, owner/no-branch → business-wide sum. `recipes.ts` now
mirrors it exactly (shared `branchScope`, same flatten), so the three reads join
`ingredient_stock_levels` instead of the dead column and the Recipes drawer and
the Ingredients page finally agree. Server `tsc` clean; the dead-column read is
gone. **OPEN pending live verification** (rule 16): on a real DB, an ingredient
with branch stock shows the true figure in the Recipes drawer (not "0 in red"),
and matches `IngredientsPage` for the same branch. **Follow-up, not done:** the
"dead column inside a live table" class still has no gate — a column-level
read/write comparator is the missing check (`check-table-usage` is table-level).

### A13 · P3 · NOTE · Two suites run on `node:sqlite`, not the app's driver
`test-node-ingest`, `test-sync-rejection-routing`. They say so themselves. A
local green is not hardware-equivalent.

**Pattern worth copying (08-08):** `test/heldOrders.test.mjs` selects
`better-sqlite3` when it resolves and falls back to `node:sqlite` only where the
native module cannot be built — then prints which driver ran. On any machine
that can run the app the real driver is used, so the green *is* hardware-
equivalent, and where it is not the output says so instead of implying otherwise.
**Confirmed on the target machine 08-08:** plain `node` cannot load the app's
`better-sqlite3` at all — `ERR_DLOPEN_FAILED`, built for `NODE_MODULE_VERSION`
133 (Electron 35) against the 115 that Node 20 requires. That is not a broken
checkout; `postinstall` runs `electron-builder install-app-deps`, which is
supposed to build for Electron's ABI. And `node:sqlite` needs Node >= 22.5 while
the tills run Node 20, so a suite that hard-imports it cannot run where it
matters either. **The only runtime that tests the real driver is Electron
itself:** `npm run test:held:electron` (see `test/run-under-electron.mjs`).
Verified green there: 21/21 on better-sqlite3 under Electron 35.7.5, Windows.

---

### A68 · P3 · OPEN · Deploy environment is not visually distinguishable (dashboard + admin)

`main` (prod) and `dev` are separate cloud instances, separate Supabase
projects, separate Vercel URLs — and until now identical to the eye. Nothing in
a browser tab told you whether you were about to act on prod or dev, which is the
kind of two-things-that-must-agree gap this register exists to name — here the
two things are "which deploy am I looking at" and "what am I about to change."

Fixed **per deployment, not per branch**. A committed-per-branch favicon would
diverge on every `dev → main` merge (A39's class); instead a single env var
`VITE_APP_ENV` (set on each Vercel project) selects the badge at runtime, so the
two branches stay byte-identical in git. `apps/dashboard/src/lib/appFlavor.ts`
and `apps/admin/src/lib/appFlavor.ts` generate an SVG-data-URI favicon and set
the tab title: prod → blue `#3b82f6` "S" / `SwiftPOS`; dev → amber `#f59e0b`
"SD" / `[DEV] SwiftPOS`. Amber is already the UI's "attention" colour. Absent or
unknown env resolves to **prod**, so a missing variable never disguises dev as
prod. Called once in each app's `main.tsx` before render.

**OPEN, not closed:** the code is verified (dashboard `tsc` green on the bench),
but the badge only appears once `VITE_APP_ENV` is set on the three Vercel
projects (owner action — see MANIFEST-2026-08-14-a.md), and "looks right in the
tab" is a browser check the bench cannot make. Closes when the vars are set and
seen. Palette confirmed against the dashboard's own hex usage, not assumed.

---

### A69 · P2 · OPEN · Enrolment issuance moves to admin (billable), branch-bound; owner self-provisioning retired

D4 shipped issuance on the **owner** side (`POST /api/enrol/code`, owner-scoped).
That is a revenue leak by design: a client who can provision their own tills has
nothing to be charged for. Owner's call — **provisioning is a billable act and
belongs behind the SwiftPOS admin gate.** So issuance moves; the redeem path
(`/api/auth/enrol/redeem`) is untouched.

Built and bench-verified:
- **New admin endpoint** `POST /api/admin/clients/:id/branches/:branchId/enrol-code`
  (`requireAdmin`). **Branch-bound** (branch from the URL, always set — the
  owner's optional-branch ambiguity is gone). **Licence-gated**: refuses with
  `BRANCH_NOT_LICENSED` unless the branch is desktop-licensed, which is also what
  the D11 init gate would enforce anyway — fail early, not at first sync. The
  code's `created_by` is the **owner's** `public.users.id` (resolved via
  `resolveOwnerUserId`, the same business_id+email match `resolveOwnerUserRow`
  uses on desktop-login), because redeem mints an owner-scoped token and
  `orders.cashier_id` REFERENCES `public.users(id)`. The **admin** is recorded in
  the audit log, not as the principal. Refuses (`NO_OWNER`) rather than mint a bad
  token if the owner can't be resolved.
- **Owner endpoint retired** to a 410 `ENROL_ISSUE_MOVED` (not a silent 404 — old
  callers are told where issuance went). No self-provisioning path remains.
- **Shared `lib/enrolCode.ts`** (makeCode/hashCode/expiry), rejection-sampled to
  drop the modulo bias the owner path had; hashes the upper-cased code. So the
  admin path and the retired path cannot drift.
- **Billing** needs nothing new: the branch-licence handler already auto-creates
  an `invoices` row when `invoice_amount` is passed, and the admin UI already
  prompts for the one-off desktop fee. Enrolment codes are provisioning, not a
  separate charge — the branch licence is the billable unit (per the owner's
  confirmed model: desktop = one-off **per branch**, unlimited tills, no trial).
- **Desktop InstallPage** now LOCKS the branch when the code carried one (it
  already pre-selected it), so a branch-bound code fixes placement — the installer
  confirms, can't reassign. Renderer `tsc` clean.
- **Admin UI**: "Enrol till" per licensed branch → shows Business ID + code once,
  copyable, with the 15-min expiry.
- `tests/enrol-endpoints.test.mjs` rewritten for the relocation (25 checks, run;
  the licence-gate guard mutation-checked after its first version was too loose —
  `/BRANCH_NOT_LICENSED/` matched a mutated `..._X`; tightened to a word boundary
  and the actual gate line, rule 23).

**OPEN, not closed (rule 16):** the HTTP flow, the admin token mint, owner
resolution against a real row, and a completed admin→till enrolment have NOT run
— the bench has no server round-trip or Electron. Closes when: an admin issues a
code for a licensed branch, a till redeems it, the branch is locked on the till,
and a second redeem of the same code is refused. The owner 410 and the licence
gate are the two new refusals to confirm live.

**Batch (2026-08-14):** the endpoint takes an optional `count` (1–20) and mints
N single-use codes in one insert, returning `codes: [...]`; the admin UI prompts
"how many tills?" and lists them. Batching is a **convenience, not a reusable
code** — each is its own single-use, branch-bound code, so a leak still enrols
exactly one till and the 1:1 `redeemed_device_id` trail is intact. A reusable
branch code was declined for that reason (owner's call): no seat cap on a
per-branch model means a reusable code's blast radius is unbounded.

---

### A70 · P3 · OPEN · Enrolled-device roster in the admin portal

Provisioning is now visible from the admin side (`GET /api/admin/clients/:id/
devices`, `requireAdmin`): the `user_devices` rows for a business, each with its
label, claimed role (till/node/office), bound branch (names resolved in one
round-trip, no N+1), status, last-seen, and app version. Rendered as an "Enrolled
Devices" card under the client Overview. Read-only — `device_role`/`branch_id`
are self-reported claims confirmed server-side elsewhere (migrations 52/74); this
is a view of the fleet, not the gate. Scoped to the business, capped at 500.

**OPEN (rule 16):** the query and shape are bench-verified (server `tsc`, source
guards), but the card populated from real rows — a till that enrolled, reported
its role, bound its branch, and phoned its version — is a live check. Closes when
an enrolled till shows in the roster with the right branch and role.

**Build fix 2026-08-14:** the roster card was added as a second top-level element
inside `{tab === "overview" && ( … )}` without a fragment — adjacent JSX, which
`vite build` rejects ("Expected ) but found {"). It shipped because the check was a
filtered `grep` of `tsc` output, not the actual build; the real gate is
`npm run build`. Wrapped grid + roster in `<>…</>`; **`vite build` now passes
(647 modules).** Lesson logged: verify UI with the build, not a grep.

---

### A71 · P3 · OPEN · Owner device view showed only person + generic label — enriched with branch, role, last-active, version, enrolled

Settings → Devices (the owner's `user_devices` view, migration 14) led with the
cashier's name and an auto-generated label ("SwiftPOS till"), and nothing else —
no branch, no absolute last-active, no version. The person leads because the
screen was built for cashier-login *approval* (per-user-per-device), not till
management, and the data for a fuller picture was in `user_devices` all along; the
`GET /api/devices` list simply never selected it.

Fixed: the list now selects `branch_id, device_role, terminal_code, created_at`
and resolves branch names in one round-trip (not embedded — `user_devices` has two
FKs to `branches` via migration 52, so PostgREST embedding is ambiguous). The
DevicesTab row gains a detail line: **branch**, role, terminal, **last active as an
absolute date+time** (not just "2h ago"), app version, and enrolled date. Additive
— the person/label/status line is unchanged. Server + dashboard `tsc` clean.

**Not built (owner's call):** *renaming* a device to something meaningful ("Front
Till") — that needs an editable `device_label` + a PATCH, which changes data.
Recorded, not shipped, pending a decision.

**OPEN (rule 16):** verified by `tsc` only; the row populated from a real device
— branch name, a real last-active timestamp, the version — is a live check.

---

### A72 · P3 · OPEN · Devices are owner-nameable; a stale-sync badge flags a till that has gone quiet

Devices carried only an auto-generated label ("SwiftPOS till"). The owner can now
give one a chosen name (`PATCH /api/devices/:id/label`, tenant-guarded, ≤60 chars),
edited inline in Settings → Devices. Safe against the clobber trap: `device_label`
is written by registration **only on the first insert** — the refresh path applies
`patch`, which never touches it — so a chosen name persists across sign-ins. No
migration; the admin roster (A70) reads the same column, so a renamed device shows
its name there for free.

Bundled with it: a **"not synced" badge** on any approved device whose
`last_sync_at` is over a day old — surfacing the failure the fleet code itself
warns about (a till that signed in, then silently stopped syncing, looks healthy
by last-seen while the day's takings quietly go missing in the cloud). Only shows
for devices that have ever synced, so a browser cashier login doesn't trip it.

Server + dashboard `tsc` clean.

**OPEN (rule 16):** `tsc`-verified; the live checks — a rename that sticks after
the till signs in again, a rename refused for another business's device, and the
stale badge appearing on a genuinely quiet till — are on the target. **Not built
(deferred):** naming a device *at enrolment*, and renaming from the admin roster;
both easy follow-ons if wanted.

---

### A73 · P2 · OPEN · Fleet-health page was built, routed, and unreachable — nav drift

`FleetPage` (the "Terminals" screen — which build each till runs and, the number
that matters, when it last synced) is fully built and routed at
`/dashboard/terminals`, but had **no way to reach it**: `DashboardLayout` holds two
Setup definitions — a static one (with the Terminals link) and a dynamically
rebuilt one that "replaces the static Settings group" to inject the business-type
link. The rebuild was copied without the Terminals item, so the rendered nav
dropped it. Two things that must agree, with nothing comparing them — the exact
class this register exists for. A complete safety view (it exists to catch a till
that signed in then silently stopped syncing while the day's takings go missing)
sat invisible.

Fix: the missing item added back to the dynamic group, matching the static one.
Dashboard `tsc` clean. **Latent risk noted, not fixed (rule 12):** the two Setup
definitions still duplicate each other and will drift again — they should be one
source, but deduping the nav is its own change, not this one.

**OPEN (rule 16):** `tsc`-verified; the live check is the "Terminals" link
appearing under Setup and opening the fleet table.

---

## D. OPEN — desktop app audit, 2026-08-08

Every item below was verified against source at `a80c224`, not against docs.

### D1 · P0 · Owner login is a dead end when they own two businesses
`auth.ts:603` — `/desktop-login` returns 409 `MULTIPLE_BUSINESSES` with *"Choose
which one to open."* `ipcHandlers.ts:83` throws `data.error` and drops `code`.
There is no picker anywhere in `apps/desktop`. The owner reads an instruction
the app gives no way to follow.
**Not firing for Beryl** — that owner has exactly one business (verified 08-08).
Closed by the D4 enrolment work, which removes owner login from the till.

### D2 · P0 · CLOSED 08-08 · Open tables lived in localStorage
See §E. Held orders now sit in SQLite, one row per tab. D9 (cross-till recall)
remains open — that needs server state, not local storage.

### D3 · P1 · OPEN · No auto-update — scaffold added, release pipeline outstanding
No `electron-updater`, no `autoUpdater`. Every release is a hand-installed `.exe`
per till; `localDb.ts` says so itself. Root cause of A1 — no release pipeline is
why `pos.zip` gets hand-built from a working folder. Also the tax on every other
fix in this list.

**Scaffold added (08-13), NOT verified.** `apps/desktop/src/main/autoUpdate.ts`
wires electron-updater correctly (dev-guarded, silent, checks on launch + every
6h, installs on next quit so a till is never interrupted), and
`docs/DESKTOP-AUTOUPDATE.md` is the runbook to finish it. It is deliberately not
wired into `index.ts` and cannot be — it will not type-check or build until
`electron-updater` is a dependency and an electron-builder `publish` target
exists, and the bench has neither Electron nor a feed. **Excluded from the main
build (08-13):** `tsconfig.main.json` excludes `src/main/autoUpdate.ts`, because
the `src/main/**/*` glob otherwise pulls it into `tsc -b tsconfig.main.json` and
its unresolved `electron-updater` import fails the desktop build (it did, in CI).
It is an orphan (imported nowhere), so excluding it changes no runtime behaviour;
finishing D3 means adding the dependency, removing this exclude, and wiring it.

**Outstanding, all owner work:** add the dep, wire the one call, choose a publish target, obtain a Windows
signing certificate, cut the first published release, run the end-to-end check,
and put the release in CI (which is what actually closes A1). Stays OPEN — a
scaffold that has never run is not a fix.

### D4 · P1 · OPEN · Owner portal credential used to provision the till — implemented, pending live verification
No device-scoped enrolment. Couples portal and till blast radius, and is the D1
dead end: the owner's credentials belong to a person, and a two-business owner
cannot say which business a till serves.
**Agreed design:** business ID identifies, a single-use enrolment code authorises.
Portal issues it; server burns it, writes the `user_devices` row and returns a
device session. Copy `routes/tech.ts` — that flow is already this shape.

**Implemented across all three layers (08-13):**
- **Schema** — `migrations/81_device_enrolment_codes.sql` (single-use, expiring,
  business-scoped; `code_hash` UNIQUE, raw shown once; RLS on). Proven against
  real Postgres: `scripts/test-migration-81.mjs`, 13 checks, mutation-checked on
  the atomic burn. `schema-index.json` updated.
- **Server** — `POST /api/enrol/code` (owner issues; `routes/enrol.ts`) and
  `POST /api/auth/enrol/redeem` (burn + mint; in `auth.ts`, on the authLimiter
  surface, reusing the local session helpers). Redeem runs the exact atomic
  burn the migration test proved and mints the same owner-scoped desktop token
  `/desktop-login` does — the code replaces the password, not the token identity.
  Server `tsc` clean; `tests/enrol-endpoints.test.mjs` (19 assertions: code
  generation + hashing, and source guards pinning the burn guard, business scope,
  desktop surface, single non-oracle 401, owner-only issue).
- **Desktop** — `auth:enrolDevice` IPC handler (a near-mirror of `auth:login`),
  preload bridge + `posApi.auth.redeemEnrolment`, and the InstallPage now takes a
  **Business ID + enrolment code** instead of an owner email/password. Renderer
  `tsc` clean; IPC parity 139/139; main `tsc` adds no new errors.

**What has NOT run, and must before this closes:** the end-to-end path — a real
`POST /enrol/code` in the portal, the till redeeming it, the token minting, and a
completed install binding a branch. None of that is bench-verifiable (no server
round-trip, no Electron). Stays OPEN until that live test passes. **Closes D1**
when it does — the InstallPage no longer asks for owner credentials, so the
two-business dead end is structurally gone. Runbook: `docs/DEVICE-ENROLMENT-D4.md`.

### D5 · P1 · CLOSED 08-08 · Owner and staff tokens stored plaintext in SQLite
See §E. Wrapped at rest via `main/tokenStore.ts`; plaintext columns retained as
a fallback and never cleared until the wrapped value has been read back in the
same write.

### D6 · P2 · CLOSED 08-10 · Local schema 46-51 undocumented
`docs/LOCAL-SCHEMA-VERSIONS.md`, reconstructed from `localDb.ts` and its history.

**The mechanism is not numbered steps** — there is no `case 46:` ladder. New
tables arrive via `CREATE TABLE IF NOT EXISTS` and columns via `migrateColumns`,
which reads `PRAGMA table_info` and adds what is absent. Both additive and
idempotent, so any older till converges by running the whole file.
`LOCAL_SCHEMA_VERSION` labels the resulting SHAPE; it does not drive replay.

Traced: **43** baseline · **44** `device_id` on expenses/floats, never shipped
alone · **45** replication seq/outbox/cursors (`3763946`) · **46** Phase 4 node
tables (`40f53ac`) · **47** Phase 2a distribution (`5ef0f08`) · **49** events and
maintenance_state (`fee91cc`) · **51** `escpos_enabled`, `kitchen_exclusions`
(`a80c224`).

**48 and 50 NEVER EXISTED.** No commit sets either value; the constant jumped
47 → 49 → 51. Nothing broke, because the number labels a shape — but a reader
hunting "what did 48 do?" finds nothing, and would reasonably conclude a
migration was lost. **The same shape as the server side**, where 31 and 32 are
recorded SKIPPED and 64 never existed (A4, §M). Two independent numbering
schemes, both with gaps that looked like data loss until somebody checked.

Not reconstructed, and said so in the file: what 44 and below did in detail, and
whether every field till has actually reached 51 — nothing in this repo records
the fleet's state. `X-Schema-Version` puts it on every push; ask the machines.

`localDb.ts` explains 43/44/45 in detail, then goes silent through 51. Six
generations with no record, on the mechanism deciding whether a field till works.

### D7 · P2 · OPEN · IPC channels have no per-channel payload validation — shared mechanism now added, rollout pending
`check-ipc-parity` proves a channel is bridged AND handled, not that its two
sides agree on the payload. 136 channels crossed the boundary unchecked; a
renderer sending the wrong shape surfaced as an undefined-dereference deep in a
handler, or a silent wrong write. This is the gap §L already names, and what
P-09 and P-11 were.

**Shared mechanism added (08-13), rollout under way.** `apps/desktop/src/main/ipcValidate.ts` —
a dependency-free validator (the desktop has no zod, and adding one is its own
footprint call): `validatePayload` / `assertPayload` for object payloads,
`expectStringArray` for the bare-value channels, extra fields allowed so a schema
names only what a handler depends on. **Adopted so far:** `escpos:setKitchenExclusions`
(bare array — rejects a malformed payload instead of silently coercing it to an
empty list, which would wipe the list); and the auth / money-adjacent object
payloads `auth:verifyPin`, `order:void` and `auth:enrolDevice` (throwing
`assertPayload` at the top, so a malformed payload is a clean, uniform error
instead of an undefined-dereference mid-handler, and valid payloads pass through
untouched). Tested — `tests/ipc-validate.test.mjs`, 25 assertions (validator
truth table + source guards pinning every adoption, mutation-checked). **Still
open:** the remaining ~132 channels. `order:create` is **deliberately left
unvalidated** — its payload is a deep nested object and the primary sale path must
not get a validation schema written blind; it needs a schema designed against
`createLocalOrder` and a live test before adoption. Kept OPEN: the gap it names is
the unvalidated channels, and a few of 136 is progress, not a close.

**D8 (legacy summary line) — superseded.** The authoritative D8 entry is the CLOSED one earlier in this file (dispatch slips could print on neither system).
`POSPage.tsx:455` early-returns on `canPrint('kitchen')`, but the HTML path it
skips prints kitchen **and** dispatch. `escposBridge.ts:409` filters targets to
bound stations. Kitchen bound + dispatch unbound = the dispatch slip prints on
neither system, silently. Dormant while thermal is off.

### D9 · P3 · OPEN · Held orders are not visible across tills
Tabs (open restaurant tables — food cooking, no bill yet) are **local to one
till** by design: one row per tab in that till's SQLite, out of the sync queue.
`heldOrders.ts` says so and points here — *"Cross-till recall is register D9 and
needs server state."* So a tab opened on the floor terminal cannot be charged at
the counter, which for a multi-till restaurant is a real gap.

**Designed 08-13, deliberately NOT built — `docs/HELD-ORDERS-CROSS-TILL-D9.md`.**
This is the most dangerous data in the app (losing a tab is its worst failure),
and it is not "add `held_orders` to `REPLICATED_TABLES`": that mechanism is
seq-append and origin-scoped, built for write-once records (orders, shifts), and
held orders are **mutated and deleted** — a charged tab must vanish on every other
till at once or a second cashier charges it. Two things block a blind build:

1. **A concurrency decision the owner must make** — when till 2 wants a tab open
   on till 1: hard claim/handoff, soft-view-with-charge-lock, or view-only. A
   workflow choice about how the floor runs, and it decides the whole design.
2. **Multi-till runtime** — the real risk (two tills racing a claim, a till going
   offline mid-charge, a ghost tab) is exactly what the bench cannot exercise.

Recommended shape once the decision is made: **node-authoritative** — the branch
node is the single source of truth for open tabs, recall/charge is one atomic
claim (409 on double-claim, the same conditional-update shape proven for D4's
enrolment burn), so there is no peer-to-peer race to reconcile and delete
propagates for free. The claim is benchable; the multi-till behaviour is not.
**P3, on the worst-failure path, owner-decision-gated — should NOT ride the client
rollout.** Left unbuilt on purpose: a double-charged table is worse than the gap.
### D10 · P3 · `ipcHandlers.ts` at 1,639 lines
### D11 · P1 · CLOSED 08-13 · `/api/pos/init` licensed the till from the wrong branch, and 500'd on zero main branches
`pos.ts` fetched only the `is_main` branch with `.single()` and gated the desktop
licence on **that** branch's `desktop_licensed` — regardless of which branch the
till was bound to. Two bugs in one place:

1. **Wrong branch for the licence.** A till bound to branch B was licensed by
   branch A's `desktop_licensed` flag. A licensed till at B could be locked out
   by A being unlicensed, and an unlicensed B could ride A's licence. The route
   already knew the bound branch — it fetched it a second time, lower down, for
   per-branch pricing — but the licence check never used it.
2. **Fail-closed on zero main branches.** `one_main_branch_per_business` permits
   ZERO main branches; `.single()` errors on zero rows, and that error was in the
   hard-error check, so a business with no main branch got a 500 that killed the
   whole catalogue pull.

**Fix.** The bound branch (the caller's `branch_id`, validated to the business
and carrying `desktop_licensed`) is now resolved in the same parallel fetch as
`boundBranch`; the operating branch is `boundBranch ?? mainBranch`; the licence
gate keys off that, and per-branch pricing reuses the same resolution instead of
a second lookup — so licence and pricing can no longer disagree about which
branch the till is on. The main-branch query is `maybeSingle()`, so zero main
branches is no longer an error; a desktop till with no resolvable licensed branch
now gets a clean 403 `BRANCH_NOT_LICENSED` rather than a 500. `branchId` in the
response stays the MAIN branch — the desktop uses it only as the fallback for an
unbound till (`syncEngine`: `effectiveBranchId = boundBranchId || branchId`), so
that is deliberately unchanged.

**Verified on the bench:** server `tsc` clean; `tests/pos-init-desktop-licence.test.mjs`
— 14 assertions, **mutation-checked** (reverting the gate to the main branch, or
`maybeSingle` back to `single`, fails 3). The test pairs a licence truth table
(bound-licensed-under-unlicensed-main → allowed; the mirror → blocked; web exempt;
zero branches → clean block) with source guards that pin the fix in `pos.ts`, so
the bug cannot silently return. What the bench does NOT prove and a live check
should: an actual two-branch business where one branch is unlicensed, confirming
a till at the licensed branch syncs and a till at the unlicensed one gets the 403.

**Gate note.** The old title — *"fails closed and kills the catalogue pull"* —
contained the word "closed", which `check-register-consistency` reads as a CLOSED
status. D11 was therefore counted as closed while it was open; the header's D-P1
total happened to match only because of that. The title now avoids status words.
A heading whose prose trips the status parser is a latent false-positive worth
knowing about; the parser now reads only the status field — **A67**, fixed in
this same session, not silently worked around.

### D12 · P1 · CLOSED 08-08 · Inbound sync failures were entirely silent
See §E.

### D13 · P0 · PARTLY CLOSED 08-08 · Refresh rotation
Client side done — single-flight guard and stale-token retry, see §E.
**The crash window remains open** and cannot be closed from the client: the
server revokes the consumed token before the response is even sent, so any
interruption between there and the till's `UPDATE session` strands a dead token.
Only a server-side grace period fixes it — a briefly-superseded token returning
the current pair instead of a 401. That is the outstanding part of D13.

### D13 (original finding) · Refresh rotation with a non-atomic persist and no guard
`auth.ts:50-51` — access 15m, refresh 30d, **rotating**; `auth.ts:736` revokes
the consumed token before the desktop persists the new one at
`syncEngine.ts:117`. Killed between those points — crash, power cut, dropped
response — the till holds a revoked token and can never refresh. **The owner must
sign in again.** The window opens every ~15 minutes of trading.
Second path: `refreshAccessToken()` has no single-flight guard and is called from
the sync loop, IPC handlers and the PIN screen; concurrent callers present the
same token and the loser gets a 401.
**Fix:** single-flight mutex; on 401 re-read the token from SQLite once before
giving up; server-side, a short grace window returning the current pair.

**D14 (legacy summary line) — superseded.** The authoritative D14 entry is the CLOSED one earlier in this file; this one-line version predates it and is retained only as the original wording.
`user_devices` has **no row for Beryl at all**. `sync.ts:71` is an `UPDATE`, not
an upsert, so telemetry writes nothing; `checkDeviceBranch` returns `ok:true` for
unknown devices, so migration 52's binding is inert. Consequence: no remote
visibility of `app_version` or `schema_version` — every diagnosis needs someone
physically at the machine.

### D15 · P3 · CLOSED 08-12 · Two different tables named `sync_queue`
**Closed 08-12** by migration `80_drop_dead_sync_queue.sql` —
`DROP TABLE IF EXISTS public.sync_queue CASCADE`. Re-confirmed dead 08-12 (zero
`sync_queue` references in apps/server or apps/dashboard; nothing FK-references
it). Removed from `schema-index.json` in the same change so `verify-db-schema`
does not then report it missing. Migration test `test-migration-80.mjs` (PGlite,
5 assertions: drops when present, records itself, idempotent when absent) passes;
full harness green. The live SQLite queue of the same name on the till is
untouched.
`public.sync_queue` in Postgres (`retry_count`, `table_name`) is **dead** —
no hit for `from('sync_queue')` anywhere in `apps/server` or `apps/dashboard`.
The live one is the till's SQLite table (`attempts`, `last_error`). Same name,
different columns, one of them a decoy. Drop or rename it.

---

### D17 · P3 · OPEN · Desktop build has no dev/prod flavour (icon, appId, userData, update channel)

The desktop build was one identity regardless of which cloud it targets: same
icon, same `com.swiftpos.desktop` appId, same `%APPDATA%\SwiftPOS` data folder.
A dev-testing build and a prod build could not be told apart on the taskbar, and
worse, installing one over the other shared a single local `swiftpos.db` — dev
trading writing into prod's till data.

Two layers of fix, the split that matters here: **build-time identity** and
**runtime truth.**

- **Build-time (what you asked for):** `apps/desktop/electron-builder.config.js`
  (new) replaces the static `build` block in `package.json`. `SWIFTPOS_ENV=dev`
  swaps icon (`resources/icon.dev.ico`, an amber DEV-badged variant of the
  existing mark), `productName` → "SwiftPOS Dev", `appId` →
  `com.swiftpos.desktop.dev`, and the artifact name — all from one source so the
  four cannot disagree. Distinct `productName` gives dev its own
  `%APPDATA%\SwiftPOS Dev` (Electron derives userData from productName — the
  index.ts comment already warns of this), so dev and prod coexist with isolated
  local DBs, which is the point. Default (unset) is prod. **Version stays owned
  by the build tooling — the config sets no version (rule 22).** Resolution
  proven by requiring the config under both env values (prod + dev) and printing
  the result; not asserted. Named cross-platform release scripts
  (`release:patch:dev` etc.) route through `scripts/release-flavour.mjs` — a
  ~20-line wrapper we own rather than a `cross-env` dependency + lockfile change
  (rule 22); its flavour/bump parsing and env mapping are proven by a dry-run.
  Both flavours build at ONE version via `scripts/release-both.mjs` (`release:both`
  bumps once then packs prod + dev; `pack:both` rebuilds both at the current
  version) — running the two `release:*` scripts separately bumped the version
  twice, which is the build-up this removes. `pack:dev`
  (`release-flavour.mjs dev none`) builds the dev flavour at the CURRENT version —
  no bump, no tag — for the routine dev-test loop; only real releases (both
  flavours) move the number and get tagged.

- **Runtime (the honest signal):** a build's real environment is the cloud it is
  *enrolled* against (`getServerUrl()`), not a build flag — so `index.ts` now
  titles the window from the enrolled cloud host (`SwiftPOS — {host}`),
  collapsing to plain `SwiftPOS` only for hosts in `PROD_CLOUD_HOSTS` (owner
  fills this; empty default over-shows and never hides). Held against renderer
  `document.title` via `page-title-updated`.

**OPEN, not closed (rule 9/16):** the config logic is proven on the bench, but no
installer was built here — `electron-builder` cannot run on this Linux bench
against Electron's Windows ABI, and "the `.ico` renders crisply at 16/32px in the
taskbar and Start menu" is a target check only. Closes after a real
`SWIFTPOS_ENV=dev pack:installer` on Windows shows the DEV icon and an isolated
data folder, and a prod build still installs clean. **Interacts with D3:** if the
dev flavour ever self-updates it needs its own feed keyed on the dev appId, or a
dev build could be offered a prod installer — recorded in DESKTOP-AUTOUPDATE.md.

---

### D18 · P2 · OPEN · A tech token pasted into the reveal field is truncated — "not allowing the full string"

Admin Tech Access hands out a **token** (`st2.<payload>.<sig>`, a few hundred
chars) and nothing else — no reveal code. But the desktop tech entry (`PinPage`,
long-press the logo) asks for the 8-char **reveal code** first, in an
`<input maxLength={12}>` that also upper-cases. A tech holding only the token
pastes it there; `maxLength` truncates it to `st2.XXXXXXXX` and the upper-casing
corrupts the base64 — so the full token can never be entered, and even the stub
fails the reveal check as "Incorrect code". The token's own field (a `<textarea>`,
no maxLength) is only reachable *after* the reveal gate, which the tech can't pass
without a code admin never gave them.

Fix: an `onPaste` on the reveal field detects a token (`st2.` prefix) and routes
it straight to the token step with the **full** value, bypassing the truncation
and the doorknock. Safe — the reveal code grants nothing on its own (it only
reveals the prompt), and the token is branch-scoped and cryptographically
verified. Renderer `tsc` clean. Desktop change → version bumps at the next build
(rule 15).

**OPEN (rule 16):** the live check is pasting a real admin-issued token at the
reveal prompt and reaching an unlocked tech session. **Admin complement done
(2026-08-14):** the Tech Access page now also fetches and shows the branch
**reveal code** beside the token (`GET /branches/:branchId/reveal-code`, already
built), labelled "enter this FIRST on the till", so the intended reveal→token flow
works without relying on the paste shortcut — the two ends are now self-consistent.

---

## M. Migration ledger — reconciled against production, 2026-08-08

Source: `select version, applied_at from public.schema_migrations`, cross-checked
against the live schema dump. **`schema_migrations` under-reports** — several
migrations are demonstrably applied but have no row, so the log cannot be used to
decide what to run. That is worse than a known gap and is why 46 sat unapplied.

- **31 and 32** are recorded `SKIPPED`, "number never used". Resolved, not lost.
  **64 never existed.** The earlier concern about four missing numbers is one gap.
- **68 is real and prod-only.** `p_delta` → `p_points` on the loyalty RPC, applied
  2026-08-06 21:13. `CREATE OR REPLACE` cannot rename a parameter, so it needed a
  DROP. **Extract the live definition and commit it** — see §E.
- **66 is applied in production but filed under `archive/superseded`.** It is the
  live `create_order_atomic`, superseded only by 69's hotfix. 69 is a full
  redefinition, so the repo *can* rebuild the function.
- **71 is recorded as version `71`**; the file inserts `71_adjust_fuel_tank_level`.
  Re-running it creates a duplicate row.
- **Applied but unrecorded:** 57 (`onboarding_progress.owner_pin_set` exists),
  60 (`component_slots`, `order_item_units` etc. exist), and almost certainly
  53 and 61 (functions). 55/56/58 are recorded under legacy names.
- **Genuinely unapplied until 08-08: 46.** See §E.

---

## E. CLOSED 2026-08-08

| ID | What it was | Closed by |
|---|---|---|
| 46 | `payments_method_check` admitted only cash/mpesa/card/credit while `PaymentModal.tsx:49-57` offers Glovo on every till, unconditionally. The migration file predicted the symptom verbatim: *"the order fails to sync and sits in the queue with a constraint violation nobody can read from the till."* | Applied to production 08-08. Verified: `glovo` present in the constraint. **Was not the Beryl fault** — those payloads are cash. |
| D12 | Inbound sync failures were silent. `syncEngine.ts:328` was a bare `if (!res.ok) return false` — status and body discarded — on the **one** call that matters, while tables/pumps/stations all log properly. Compounding it, the desktop had **no durable logging at all**: every `console.warn` goes to a console that does not exist on a packaged build. | New `main/logFile.ts` (rolling, bounded, never throws). Catalogue pull and both token refreshes now record status + body. `getSyncStatus()` gains `pullError`, `pullErrorSince` and `logPath`, alongside the existing `failedReason`. |
| D2 | Held orders — restaurant tabs, with pre-assigned bill number and per-line kotSent flags — were one JSON blob in renderer `localStorage`, read through a catch that returned an empty list. A truncated write reported **zero open tables**, silently, with the KOTs already on the pass. | New `held_orders` table (one row per tab, so a bad row costs one table not all of them). Five IPC channels; the renderer API keeps its shape but is now async — 9 call sites and 5 functions in `POSPage.tsx`. **No `LOCAL_SCHEMA_VERSION` bump**: `CREATE TABLE IF NOT EXISTS` runs ungated on every open. A corrupt cart now returns the tab with an empty cart and a `corrupt` flag so it can be rebuilt from the KOT, rather than disappearing. One-time idempotent import of the legacy blob, and the old key is cleared only after the main process confirms it. Not cleared by `clearCatalogue()`. |
| D13 (client half) | Refresh tokens rotate and `auth.ts:736` revokes the consumed one, but `refreshAccessToken()` had no single-flight guard across three call sites (`ownerFetch`/PIN pad, the sync loop, the order push) and `refreshStaffToken()` none across four. Two concurrent refreshes present the same token; the loser gets a 401 for a token that was valid when it read it, and the owner is signed out. Offline that is unrecoverable — there is no way to sign back in. | Single-flight promise on both paths, so overlapping callers await one request. Plus a one-shot retry when a 401 arrives and the persisted token differs from the one sent — a stale in-memory copy is bookkeeping, not a revoked session. A genuinely revoked token is **not** retried. 10 new tests; mutation-checked by removing the guard and confirming they fail. |
| D16 (offline sign-in) | Everything on a till worked offline except the DOOR: `auth:verifyPin` called the server and threw, and the local `users` table carried no hash to check against, so a line fault stopped the floor starting a shift. | New `staff_pin_cache` table + `main/pinCache.ts`. Cached **only** for staff who signed in on this terminal while online, **only** bcrypt hashes (legacy upgrades on next online sign-in), **never** `override_pin_hash` — elevated actions stay online. Wrapped with safeStorage/DPAPI; nothing cached at all if the platform cannot wrap it. Expires after 14 days without server contact; cleared on logout. Offline verification scans all cached entries and refuses on two matches, same as the server. `bcryptjs` (pure JS) not `bcrypt` — a native module would hit the same ABI wall as better-sqlite3. Server returns the hash from `/api/auth/verify-pin` for `surface === 'desktop'` only. **The fallback fires on transport failure only, never on a 401/409** — otherwise a sacked cashier signs in by unplugging the cable. 16 tests. |
| D5 | `session.token` / `refresh_token` and the staff equivalents were plaintext in `swiftpos.db`. The refresh token is the durable one — 30 days, self-renewing — so anyone with a copy of the file held working owner-scoped access long after taking it. | New `main/tokenStore.ts`: values wrapped with safeStorage (DPAPI) into `*_enc` columns, 8 read sites and 3 write sites routed through it, `migratePlaintextTokens()` at startup so an upgraded till stops holding a clear credential within seconds. **The plaintext is cleared only after the wrapped value round-trips in the same write** — the naive version of this change is itself a lockout, and offline the owner cannot sign in again to replace what it destroyed. No safeStorage means plaintext, not a broken session. 14 tests, mutation-checked by removing the round-trip verification. Honest limit, same as PHASE2-3-DESIGN §2d: defeats a copied `.db`, a stolen backup and a pulled disk; not code running as the app user. |
| A1 (packaging) | `pos.zip` hand-built from the working folder, so `.env` rode along. Written as prose in five handoffs and committed as a script zero times — which is why it recurred. | `npm run package` → `git archive --format=zip HEAD -o pos.zip`, plus `npm run package:check` which fails if `.env` or `node_modules` appear. |

### Still open from the Beryl investigation

Eight orders failed on 2026-08-07 between 21:09 and 22:53 UTC, all `attempts=5`,
all `Failed to create order (ref: …)`. Ruled out by evidence, not by reasoning:

- **Not Glovo** — both sampled payloads are `"method":"cash"`.
- **Not the shift FK** — shift `79c4881f-…` exists, open, terminal `T1`.
- **Not the payment reconciliation guard** — 600 = 600 and 6040 = 6040 exactly;
  that path is 23514 and returns a readable 400 anyway.
- **Not an order-number collision** — 23505, handled as a 409 at `orders.ts:669`.

**CORRECTED 08-09 — "something threw after the RPC committed" is ruled out.**
`syncEngine.ts:1161` sends `X-Idempotency-Key: row.order_id`, identical on every
retry, and `orders.ts:360-372` checks that key **before anything else** and
returns `200 duplicate` when a matching order exists. So had attempt #1
committed — even if something then threw post-commit — attempt #2 would have
short-circuited and the row would have cleared at `attempts=2`. All eight
reached 5. **No attempt ever committed. The money is not banked and the till was
telling the truth.**

That leaves `throw createErr` on a code that is neither 23505 nor 23514.
**A14 is the candidate: 23503 on `orders_cashier_id_fkey`,** because the desktop
owner token can carry an `auth.users` id. It fits every ruled-out item, and it
fits the bounded window, because `/refresh` never re-resolves `userId`.

Settle it with either:

```sql
-- Expect ZERO rows. Any row means the deduction above is wrong.
select id, order_number, created_at, idempotency_key from public.orders
where idempotency_key in ( <the 8 local order ids from sync_queue> );

-- The smoking gun for A14: a cashier_id equal to businesses.owner_id
-- (an auth.users id) rather than a public.users id.
select b.name, b.owner_id as auth_id, u.id as users_id, u.email
from businesses b left join users u on u.business_id = b.id
where b.name ilike '%beryl%';
select distinct cashier_id from orders where business_id = '<beryl>';
```

The server log for `error 341849fb` remains the direct answer and now would
print the SQLSTATE (A15).

---

## B. CLOSED this session — audit findings

| ID | What it was | Closed by |
|---|---|---|
| A1 (rotation) | Live secrets in the archive | Rotated. **Packaging still open — see A1 above.** |
| B1 | `/pay` had no idempotency and no concurrency guard | Claim-before-write: `.eq('status','open').select()`. Loser returns the winner's payload; amount mismatch writes a `payment_exceptions` row. |
| B2 | Loyalty diverged 10× between counter and dine-in | `/pay` now uses `awardLoyaltyPoints` + earn rate + tier. Writes the ledger row, `total_spent` and `loyalty_points_used`. |
| B3 | ESC/POS built but `queueTickets()` never called | Wired into the sale path behind a per-terminal switch. |
| B4 | Two printer config stores | Stations from `print_stations`; printer bound per terminal. |
| B5 | `pump_id` end-to-end on desktop only | Added to `PaymentModal.buildOrderPayload`. `check-client-parity` proves it. |
| B6 | Low-stock alerts read `stock`, which nothing writes | Both jobs read `stock_levels`. `check-table-usage` proves it. |
| C1 | `fetchAllIds` paged without ORDER BY | `.order(idColumn)` + a `seen` set. |
| C2 | pageSize 1000 could silently truncate | 500, below every plausible row cap. |
| C3 | Racy read-then-write stock in 3 places | `adjust_product_stock` (existed, never called) + new `adjust_fuel_tank_level`. |
| C4 | Unescaped `ilike` pattern + `limit(20)` | `%`/`_`/`\` escaped, cap raised to 200. |
| C5 | BUG-18 owner lockout | **Three** sites, not two. Extracted to `lib/ownerBusiness.ts`; 409 + picker. |
| C7 | Numeric comparisons uncoerced | Fuel reorder, low-stock, discount floor. |
| C8 | `qty_pieces` fractional into an INTEGER column | Rounded in JS. |
| C9 | `dailySummary` `.lt()` — three bugs in one line | Removed; error destructured. |
| D1 | CI job named "Schema drift" did not run the drift gate | Added, plus both new gates. |
| D2 | `assert:built` warned instead of failing | Fails, and compares against newest `src/` mtime. |
| D3 | `build:all` did not clear `dist` | Cross-platform `clean` first. |
| BUG-16 | DB blip logged a cashier out | `try` narrowed to `jwt.verify`; 503 not 401. |
| BUG-19 | Till report overstated by every refunded bill | Nets off `refunded_amount`. |
| BUG-20 | Fuel deducted twice | Tank authoritative; `stock_levels` mirrors. |
| BUG-22 | `device_hint` stored a fleet-identical User-Agent | `device_id` first. Also fixes revocation. |
| — | `release:patch` built before bumping | Reordered. |
| — | `api.ts` stripped every error field but `code`/`status` | Preserved, so 409 payloads are usable. |

---

## P. CLOSED this session — printing

| ID | What it was |
|---|---|
| P-01 | Kitchen ticket empty: bridge used literal station ids that never matched real UUIDs. Now routes by **kind**. |
| P-02 | Combos opaque: components not sent. Now sent, routed by their own `category_id`. |
| P-03 | Plain products lost their variant entirely — `if (attrs.length && units.length)` dropped it when there were no components. |
| P-04 | Category never arrived: renderer sent `categories`, desktop products carry `category_id`. |
| P-05 | All three tickets fired at payment. Split: production on **send**, receipt on **pay**. |
| P-06 | Double printing when thermal was on — both systems fired. Old path now returns early. |
| P-07 | No receipt station possible on the till; receipt was never queued. "Till receipt" always offered. |
| P-08 | `Print receipt` said "sent" and printed nothing. Real reprint, marked **Duplicate Print**. |
| P-09 | Preview dead: handler expected a full `PrintContext`, screen sent `{stationId, paperWidthMm}`. |
| P-10 | Kitchen preview showed "0 items to cook" — sample routing ids didn't match the previewed station. |
| P-11 | Test print crashed on `station.kind` — same shape mismatch as P-09, missed once. |
| P-12 | **`-args` does not bind with `-Command`.** Root cause of three separate "printer" failures. Values now travel in the environment. |
| P-13 | Error classifier guessed from message text — `GetPrintQueue` was in the "not found" regex, so any fault in that call reported a wrong printer name. Now classifies on Win32 codes only, and says **"this is a fault in SwiftPOS"** when it is. |
| P-14 | USB needed manual sharing. Now Win32 `OpenPrinter`/`WritePrinter` RAW via P/Invoke — printer picked by name, no sharing, no native module. |
| P-15 | Receipt footer collapsed to one line — `wrap()` treats `\n` as a space. `wrapAuthored()` keeps author line breaks. |
| P-16 | **Every HTML print was truncated.** The measuring window had no width, so Electron defaulted it to 800px while printing at 302px. Shift report lost its entire cash reconciliation. |
| P-17 | Z-report was the last HTML document, via **two** routes (`printReceipt` and `window.open().print()`). Now ESC/POS through one helper. |
| P-18 | Drinks-only orders printed a kitchen slip reading **"0 items to cook"**. `hasPrintableContent()` — nothing routed, nothing printed. Receipts exempt. |
| P-19 | Both report screens set a failure message nothing displayed. Now shown. |

**New capability:** owner-stated kitchen exclusions (`business_settings.kitchen_exclusions`),
edited in Dashboard → Restaurant, cached on each till, applied to every source of
units. Your design — explicit beats inferred.

---

## I. Verified correct — do not re-audit

- **Item 10 numeric sweep:** additive coercion is clean. This codebase coerces at
  the API boundary, which is the right place. BUG-12 was in a *job* — no boundary.
  **Comparisons were not clean** — see C7.
- **The refund model is right.** `orders.status` stays `completed` on refund
  (migration 37), so the negative leg stays in shift-close scope. The bug was on
  the till only.
- **Constraints the code depends on all exist** — `stock_levels` and `users`
  composite uniques, and the `/orders` idempotency index. The schema dump does not
  render composite uniques; always cross-check `00_baseline.sql` before concluding
  one is missing.
- **`adjust_product_stock` already existed** (migration 61) and the sale path
  never called it. Same shape as `chunkIn`. Worth checking for more of these.
- **Ticket layouts match `SAMPLE-OUTPUT.txt` byte-for-byte**, both widths, and the
  sample is regenerated on every `npm test` in the printing package.

---

## L. The pattern

The 08-07 handoff ends: *"Every serious bug in this codebase came through the same
seam: two things that must agree, with nothing comparing them."*

This session was that, repeatedly — and now with gates on the two widest seams:

- `check-table-usage` — a table written under one name, read under another (B6)
- `check-client-parity` — a field the server reads that one client sends (B5)
- `check-ipc-parity` — caught P-17's handler landing in the wrong file **before** it shipped

The seam that kept biting and has **no** gate: **an IPC channel whose two sides
disagree about the payload shape** (P-09, P-11). `check-ipc-parity` proves a
channel exists, not that its arguments agree. That is the next gate worth building.

---

## Changelog

| Date | Change |
|---|---|
| 2026-08-17 | **A124 closed (purge Stage 1: detector + pre-purge export — non-destructive)** — deletes nothing. Server: suspended_at in GET /clients; new GET /clients/:id/export (read-only JSON of normal user data, hashes stripped, financials excluded, audited). UI: isPurgeDue (180-day grace), purge-due badge on clients list, suspension banner + Export button on client detail. Depends on A122/migration 88. Verified: server tsc clean, admin build clean, 0 new type errors, gates green. Stage 2 awaits sign-offs. Delivery: MANIFEST-2026-08-17-o.md. |
| 2026-08-17 | **A123 opened (suspend-grace-period data purge plan — doc-only)** — filed docs/SUSPEND-PURGE-PLAN.md. Model: 6-month grace purges normal user data; financial/tax retained on accountant's schedule. Drafts RETAIN vs PURGE table classification; flags cascade-from-businesses FKs, order_items.product_id SET NULL, PII-in-retained-records (anonymise-vs-leave = accountant/DPO call). Staged: A122 clock done; Stage 1 detector+export; Stage 2 admin-confirmed purge after sign-off. Open Qs: retention number, PII anonymisation, RETAIN-list confirmation. |
| 2026-08-17 | **A122 closed (suspend timestamp — grace-period purge foundation, D2)** — D2: suspend is the client end-state; long-suspended clients purged after a grace window. Non-destructive groundwork: migration 88 adds `public.businesses.suspended_at`; suspend sets it, activate clears it. NO purge logic. Verified: server tsc clean, schema-drift green (88 public.-qualified), gates green. Needs prod-migrate. Delivery: MANIFEST-2026-08-17-m.md. |
| 2026-08-17 | **A121 closed (admin portal: close/reopen branch — G2)** — new admin `PATCH /clients/:id/branches/:branchId` sets status active|inactive; main branch cannot be closed (guard + button hidden); audited. Per-branch Close/Reopen button. Branch status is a soft flag (hides from selector); hard tills-stop/billing gate stays the licence, so Close confirm prompts to also Revoke. Verified green. Delivery: MANIFEST-2026-08-17-l.md. |
| 2026-08-17 | **A120 closed (admin portal: create branch — G1, admin-only per D1)** — owners must never create branches (billed separately); creation is a SwiftPOS-agent op. New admin `POST /clients/:id/branches` (requireAdmin, name<=100 + optional address/phone, is_main:false/status:active, audited) + "+ Add branch" form. Dashboard 403 unchanged. New branch shows "Not licensed"; billing via existing licence flow. Verified: server tsc clean, admin build clean, gates green. Delivery: MANIFEST-2026-08-17-k.md. |
| 2026-08-17 | **A119 closed (admin portal: edit business details + change owner email)** - implements G5/G6. G5: `PATCH /clients/:id` accepts `type` + client-header Edit panel (name/type/currency). G6: admin `POST /clients/:id/change-owner-email` (updates owner auth email auto-confirmed + contact email, audited; no reassignment) + Change Email button. Built on A118 (cumulative files). Verified: server tsc clean, admin vite build clean, +3 pre-existing-class S.input CSSProperties errors only (one real askPrompt-unknown looseness fixed), gates green. NOT bench-testable - click-test edit + email change. Delivery: MANIFEST-2026-08-17-j.md. |
| 2026-08-17 | **A118 closed (admin portal: revoke till + rotate reveal code + fix health chart)** - implements G4/G3/G8 from ADMIN-PORTAL-PLAN.md. G4: admin `DELETE /clients/:id/devices/:deviceId` (stolen-till kill switch, mirrors owner revoke + admin audit) + Revoke button per device row. G3: Rotate button wiring the existing `reveal-code/regenerate` endpoint (A114 kill switch, previously no UI). G8: Fleet Health card charts the three health bands (green/amber/red) not business type; dropped unused type breakdown. Verified: server tsc clean, admin vite build clean, 0 new type errors, gates green. NOT bench-testable (admin has no tests) - needs click-test. Delivery: MANIFEST-2026-08-17-i.md. |
| 2026-08-17 | **A117 opened (admin-portal plan - capability completion + glass refresh; doc-only, not scheduled)** - filed `docs/ADMIN-PORTAL-PLAN.md` from the admin-portal audit. Nine confirmed gaps (G1 add branch impossible; G2 close branch; G3 rotate reveal code - A114 kill switch unreachable; G4 revoke stolen till - read-only in admin, security; G5 edit business details; G6 change owner email/reassign; G7 offboard; G8 Fleet-Health chart plots type not health; G9 two uncross-checked fleet counts) mapped to 3 phases. Glass direction locked via `docs/admin-portal-glass-mockup.html`. Decisions: D1 branch-create model (a admin-only / b self-serve / c both), D2 client offboard vs suspend. |
| 2026-08-17 | **A116 opened (digital-signage module — design proposal for TVs/display screens; not scheduled, doc-only)** — filed `docs/SIGNAGE-DESIGN.md`: architecture for menu-boards/promos/media on standalone displays (Android-TV/smart-TV kiosk web player), managed from a new dashboard **Displays** section behind an RBAC `signage.manage` key. Principles: reuse the platform (Supabase Postgres + JWT/RBAC + Render — no second auth or DB); signage screens are unattended and kept SEPARATE from `user_devices` (staff tills), with their own pairing; a `menu_board` stores which categories/layout to show and resolves LIVE products + branch-specific prices + active promotions at play time (never copies prices); offline-tolerant via service-worker cache-first media. New tables all `business_id`-scoped, location ones also `branch_id` (`signage_screens`, `signage_screen_groups`, `signage_content`, `signage_media`, `signage_playlists`+items, `signage_schedules`+entries); new routes under `/api/signage/*` (admin = JWT+RBAC; player = per-screen HMAC token). Phased: P0 menu-board MVP → P1 media CMS (Supabase Storage + ffmpeg transcode on Render) → P2 Supabase Realtime + branch-node offline. Adapts the existing standalone **Content-Manager-Pro** signage codebase (pairing, offline cache, transcode, now-pluggable storage). Source-pointer decision (owner Q): cite the Content-Manager-Pro **repo**, not a personal account/email — add the GitHub URL once the repo is pushed (private; URL TBD). Adds **NO §A/§D open finding** — Open/Counts rows unchanged (roadmap/design item, like the A74–A111 changelog-only entries). No code, no migration, no manifest. NOTE: originally filed as A115, which a concurrent session took for the health-monitoring closure — re-filed under A116 to avoid an ID collision. `check-register-consistency` + `check-doc-refs` re-run green after re-file. |
| 2026-08-17 | **A115 closed (health monitoring documented + direct Supabase keep-alive)** — owner set up an UptimeRobot monitor on `/health`, but a sister app's Supabase still PAUSED at ~day 15 despite it. Root cause: `/health` keeps Supabase warm only through the Render→Supabase chain, and free Render (cold ~50s wake / monthly-hour cap) can drop the ping before it reaches Postgres, so Supabase accrues idle days and pauses anyway. The `/health` endpoint itself is well-built (bounded DB round-trip that reaches Supabase, cached schema check, 200-on-drift / 503-on-DB-down, strict check isolated in `/health/schema`; `render.yaml healthCheckPath: /health` correct) — no code fix needed. Added: (1) `.github/workflows/supabase-keepalive.yml` — a scheduled job (every 3 days + manual dispatch) that touches Supabase **directly**, independent of Render, closing the fragile-chain gap for dormant deployments (live stores stay warm via till sync); needs repo secrets `SUPABASE_URL`/`SUPABASE_ANON_KEY`. (2) RUNBOOK §6 documenting both UptimeRobot monitors (keep-warm on `/health` at 5-min/≥60s-timeout; drift alarm on `/health/schema` at 15–30-min, **excluded from uptime %**), the Supabase-chain caveat, and the honest fix (Render paid / Supabase Pro remove spin-down/pause). Verified: workflow YAML lints; doc-refs green. GitHub cron drift is immaterial for a 3-day touch inside a 7-day pause window. Delivery: MANIFEST-2026-08-17-h.md. |
| 2026-08-17 | **A114 closed (tech-access reveal code: stable-per-branch, auto-provisioned, self-healing on sync)** — resolves the "Incorrect code" lockout and the offline-till access design. Root cause: the branch reveal code (`branches.tech_reveal_code`) was minted lazily and only CACHED on the till at owner-login/enrol — but the till UI has no owner-login path, and the staff-PIN path (`auth:verifyPin`, A101 chain) never refreshed it, so a cashier-only till held a NULL/stale code and the technician reveal stage could never pass. Design agreed with owner: ONE stable reveal code per branch (doorknock, never rotated) + the per-tech, per-access, offline-verifiable `st2.` Ed25519 token (unchanged — it already verifies against the cached public key with zero connectivity, which is how a never-online till is serviced). Rejected a shared-symmetric-secret scheme: it would re-introduce token forgeability from a stolen till, the exact risk the asymmetric design removes. Changes: (1) server `GET /api/tech/branch-config` now auto-mints + persists a reveal code when missing (lazy provisioning; stable thereafter, never rotates here); (2) desktop `syncEngine.syncAll` calls `refreshTechConfig(_accessToken)` after each catalogue pull, so any online sync self-heals the cached reveal code + public key without an owner login (device token is restored at startup, so cashier-only tills have it); (3) **migration `87_backfill_branch_reveal_code.sql`** front-fills a stable code for every EXISTING branch that had NULL, using the same alphabet/length as `generateRevealCode()` (verified) and schema-qualified per A62. Token path untouched. Verified: server + desktop-main `tsc` clean; migration codes match the validator; schema-drift/sql-binds/table-usage/register/supabase-catch gates green. NOT bench-verifiable (rule 9): the on-till refresh + reveal-stage pass need a real online sync; the migration needs the prod-migrate step + a real-data check. Delivery: MANIFEST-2026-08-17-g.md. |
| 2026-08-17 | **A113 closed (tech-access hardening — retire legacy v1 HMAC tokens + hardcoded default secret)** — audit of the tech-access subsystem found two real issues (design otherwise sound: Ed25519 asymmetric, offline-verifiable, clock-rollback-guarded, 48h/4h bounds, audit-logged, prod refuses to boot without signing keys). **F1:** `tech.ts verifyTechToken` still ACCEPTED legacy v1 HMAC tokens though nothing minted them (v2 `st2.` Ed25519 is the only live mint via `signTechToken`) — pure forgery surface gated on a shared secret, exactly what v2 removed. **F2:** `admin.ts` held a hardcoded default `TECH_HMAC_SECRET` (`'…change-at-install'`) used only by a DEAD `generateTechToken`. Fix (all deletions, no behaviour change to the live v2 path): removed the v1 verify branch (`verifyTechToken` is now `st2.`-only), deleted `admin.ts`'s dead minter + default secret, and swept `TECH_HMAC_SECRET` out of `env.ts` (no longer required at boot), the `envGuard.ts` comment, and `render.yaml` (dead prod var; `TECH_SIGNING_PRIVATE/PUBLIC_KEY` remain). Verified: mode-switch tokens are unaffected (random codes looked up by sha256 hash, never HMAC); server `tsc` clean; no functional `TECH_HMAC_SECRET` refs remain; gates green; no test fed a v1 token. Remaining (owner): confirm `TECH_SIGNING_*` set in prod and the desktop's cached public key matches; low-sev residue noted (offline revocation lags to 48h expiry — rotate the branch reveal code when a tech's access ends). Delivery: MANIFEST-2026-08-17-f.md. |
| 2026-08-17 | **A112 closed (register header reconciled to the tree, doc-only)** — the header's Tree line had lagged since ~08-14 (`0215475` / desktop v0.5.27 / schema 51) and the header never explained where A74–A111 went. Corrected the Tree line to current reality (post-A111; desktop **v0.5.34**; `LOCAL_SCHEMA_VERSION` **52**; web/cloud runtime **Node 24**; desktop **Electron 43**) and added a **Reconciliation** row: A74–A111 live in the Changelog and were near-all closures, so the §A/§D-derived Open/Counts rows are unchanged and still accurate; the open **P0** is A17, now carried by its hardware-pending fix A99–A101; authoritative open list is `HANDOFF-2026-08-17.md` §7. No finding opened/closed by this edit; `check-register-consistency` + `check-doc-refs` green. |
| 2026-08-17 | **A111 opened (standardise on Node 24 LTS across web/cloud + CI; config-only)** — follows A108. The owner moved local to Node 24 (LTS, multi-year support) and, since Electron 43 (A108) already bundles a Node-24-era runtime, the whole stack now aligns on 24. Flipped every `engines.node` 22→24 (root `>=24`; dashboard/admin/server `24`; print-server `>=24`) and every CI `node-version` 22→24 across `ci.yml` (incl. the node:sqlite lane — still ≥22.5, comment updated) and `db-migrate-prod.yml`. Desktop unchanged (no `engines`; Electron owns its bundled Node). **Config-only — no code, no deps, no lockfiles shipped**: the engines line in each lockfile re-syncs on the next `npm install` under Node 24. Verified on the bench (Node 22): all five `package.json` parse, both workflow YAMLs lint, dashboard `vite build` clean, repo gates green; `npm install` now emits the EXPECTED `EBADENGINE required:{node:24} current:v22` — which confirms the new pin is live (silent on Node 24). NOT verified on a real Node-24 runtime here (nodejs.org isn't on the bench allowlist and apt only offers 22) — real proof is the owner's local + the CI run on 24; 22→24 is a modern low-risk step and the code already built+tested clean on 22 (A108). Owner action: confirm each Vercel project's Node.js Version UI offers 24; Render reads `engines`. Delivery: MANIFEST-2026-08-17-d.md. |
| 2026-08-17 | **A110 closed (recharts v2 deprecation resolved repo-wide; NO new charting library)** — the Vercel `npm warn deprecated recharts@2.x` line (a deprecation, not a vulnerability — audit was already 0). Root cause on inspection: recharts is barely used. **Dashboard used it ZERO times** — every chart (`MiniBarChart`, `HourlySparkline` in `OverviewPage.tsx`) is hand-rolled SVG; recharts survived only as a dead `package.json` dep, a stale `App.tsx` comment, and an orphaned `manualChunks` branch. Removed all three → `npm install` drops **37 packages** (recharts + d3), `vite build` clean, 0 vulns, warning gone. **Admin was the only real user** — a single `BarChart` in `AdminPortal.tsx` (client-type breakdown) plus dead `LineChart`/`Line` imports. Checked the official 3.0 migration guide against that exact usage: none of the breaking changes apply (no `Customized`, no custom-`content` Tooltip — it uses `contentStyle`, default axis IDs so the new `CartesianGrid` x/yAxisId rule is a no-op, single Y axis, no Scatter/Area/Pie/Reference). Bumped `recharts ^2.12.7 → ^3.10.1`, dropped the dead imports; `vite build` clean (603→590 KB), 0 vulns, and tsc shows **zero** new/chart-related errors. **Decided against adding a new charting library** — one 7-bar chart doesn't justify swapping one big dependency for another; v3 is the current supported major and the minimal fix. NOTE (pre-existing, untouched): admin has ~59 `tsc --noEmit` errors (inline-style `boxSizing` etc.) that predate this and are unrelated — admin builds via esbuild (`vite build`) with no tsc gate, so they don't block deploy; recorded, not fixed here. Residual: admin's one chart should be eyeballed in a browser (no e2e covers AdminPortal). Delivery: MANIFEST-2026-08-17-c.md. |
| 2026-08-17 | **A109 closed (green CI — offline suite `kitchen-exclusions-local` fixture drift, test-only)** — the "Server suites → Run offline suites" job went red on A108 with `table device_config has no column named continuous_operation` at `tests/kitchen-exclusions-local.test.mjs:121`. NOT a product bug and NOT caused by A108's deps: the test extracts the REAL `device_config` INSERT column list from `deviceConfig.ts` (which has included `continuous_operation` since **A104**) but drives it against a hand-rolled `CREATE TABLE` fixture that A104 never updated. The drift was **latent** because the test uses `node:sqlite` (`DatabaseSync`, Node ≥ 22.5) and self-skips on Node 20 — so on the old Node-20 offline lane it never executed its INSERT. A108's Node 20→22 bump activated the test, which immediately caught the stale fixture. Fix: add `continuous_operation INTEGER` to the fixture `CREATE TABLE`, matching `localDb.ts:941`. Verified on Node 22: 17/17 pass; mutation-checked (removing the column reproduces the exact CI error). Full sweep: only this one test hand-rolls a `device_config` schema; the other newly-active node:sqlite root test (`register-status-parse`) passes 12/12; all other jobs (Build, Secret scan, Desktop row scope, Type-check, Schema drift) were already green. Delivery: MANIFEST-2026-08-17-b.md. |
| 2026-08-17 | **A108 opened (Node 20 → 22 runtime + full npm vulnerability sweep to zero; desktop Electron 35 → 43) [web/cloud SHIPPABLE, desktop BLOCKED on two-till build]** — Vercel dropped Node 20, so every web/cloud surface moves to Node 22 and all five apps go to **0 npm vulnerabilities** in one batch. **Web/cloud (verified on the bench, ships on merge):** dashboard 4→0 (react-router 7.18.2), admin 2→0 (postcss/nanoid) — both `engines.node` 22, both `vite build` clean; server 6→0 (`nodemailer` 8→9, `overrides.exceljs.uuid ^11.1.1` — exceljs KEPT at 4.4.0, npm's "fix" was a bogus 3.4.0 downgrade; uuid flaw is v3/v5/v6-with-buf, unreachable via exceljs's v4 use), `tsc` clean + runtime smoke (exceljs writeBuffer, nodemailer 9 createTransport/sendMail); print-server 0→0 (**added a missing package-lock.json**); root + CI (`ci.yml`, `db-migrate-prod.yml`) node-version 20→22. **Desktop (24→0, NOT hardware-verified — rule 9):** electron 35.7.5→43.4.0, electron-builder 25→26.15.7, electron-rebuild@3 shim → @electron/rebuild@4.2.0, better-sqlite3 11→13 (mandatory for the newer runtime; N-API 10, ABI-stable, ships a win32-x64 prebuild — compiles+loads+runs WAL/FK/prepare/transaction on the bench). The 8-major Electron jump produced exactly ONE source break: `PrinterInfo.isDefault` removed in E43 (default-ness now in the platform `options` bag) — read defensively in `printService.ts`, display-only, printing unaffected. Renderer/main/shared `tsc` clean (only the pre-existing benign TS2688 node-types line); 8/9 desktop suites green; `test:pin` 8/8 is the pre-existing plain-node baseline (needs Electron `safeStorage`, only `test:pin:electron` injects it) — proven identical on the un-patched tree, NOT a regression. **Desktop BLOCKED per rule 9/§8: build `pack:dev` on Windows (VS Build Tools) and trade a full shift — app launch, swiftpos.db WAL open, sign-in, thermal print, printer "(default)" label — before any prod till build.** Server nodemailer 9 also needs a real Render SMTP send (bench proves construction only; RESEND_API_KEY still unset, A54). Delivery: MANIFEST-2026-08-17-a.md. |
| 2026-08-13 | **A54 — live log confirms SMTP dead (both ports blocked); test tool added** — `swiftpos-server.onrender.com` boot log shows 587 AND 465 time out (host filters SMTP), IPv4 pin intact. Resend (HTTPS) is the path: set `RESEND_API_KEY` + a verified `NOTIFY_FROM_EMAIL`. Added `sendEmailChecked()` (returns provider/error) and owner-only `POST /api/notifications/test-email` (self-only) to prove delivery on demand. `tests/mailer-transport.test.mjs` §7 (8 assertions). A54 stays OPEN, now blocked on Resend config. |
| 2026-08-13 | **D3 scaffold excluded from the main build** — the committed `autoUpdate.ts` scaffold broke `tsc -b tsconfig.main.json` in CI (unresolved `electron-updater`, an unheld dep). Added it to `tsconfig.main.json` exclude — it is an orphan (imported nowhere), so no runtime change; D3 stays held. Removing the exclude + adding the dep is part of finishing D3. |
| 2026-08-13 | **A66 CI regressions fixed** — the commit went red on two lanes. (1) `REQUIRED_DESKTOP_SCHEMA` was still 51 while A66 bumped `LOCAL_SCHEMA_VERSION` to 52; the two must move together (test-branch-close, test-events enforce it) — bumped to 52 (a till on 51 is merely shown behind, HARD_MIN unchanged). (2) `kitchen-exclusions-local.test.mjs` hard-imported `node:sqlite`, crashing the Node-20 server-suites lane which globs all of tests/; now skips gracefully when the module is absent, like the better-sqlite3 suites. Both verified against the app driver. |
| 2026-08-15 | **A107 closed (green CI — gitleaks false positives on the dev→main PR)** — the "Secret scan" job failed the dev→main PR: gitleaks (default config, no `.gitleaks.toml`) flagged `key = 'escpos_default_on_0527'` in localDb.ts as a `generic-api-key` on entropy alone. It is a `maintenance_state` FLAG KEY, not a credential, and can't be renamed without orphaning rows already written under it. Added a `.gitleaks.toml` that **keeps the full default ruleset** (`[extend] useDefault=true` — real secrets still fail CI) and allowlists only confirmed false positives by their exact match: the flag key; the Crockford base32 alphabet `23456789…XYZ` (enrolment codes, var name `SECRET_ALPHABET` tripped it); a SQL UPSERT column list (`refresh_token, logged_in_at=…`); and an `alg:"none"` TEST-FIXTURE JWT in `security.mjs` (fed in to prove it's rejected). Verified with gitleaks 8.24.3 (the CI version): full-history scan goes from 5 findings to **no leaks found**. Config-only; the `.env`-tracked check already passed. |
| 2026-08-15 | **A106 closed (green CI — test-print-resilience harness)** — the "Desktop row scope" CI job failed on `test-print-resilience.mjs` with `ReferenceError: escapeRegex is not defined`. Not a product bug: `kitchenPrepLines` word-boundaries each owner exclusion term via `escapeRegex` (added in A84), but the test's `new Function` harness — untouched since before A84 — only injected `KITCHEN_NOTE_EXCLUDE`, so the eval'd copy referenced a name not in scope. The test had been red since A84. Fix: extract `escapeRegex` from `ticketLines.ts` alongside `kitchenPrepLines` and inject it into the harness, so the eval'd function has the same dependency the module does. `test-print-resilience.mjs` now 55/55; all nine Desktop-row-scope test files green. Test-only change. |
| 2026-08-15 | **A105 closed (manager-nav consolidation — Shift+Report, Orders+Item Mix) [#6/#7]** — two pairs of sibling tabs folded into one nav item each, selected with a segmented control ("like the print option"). **#6:** the "Shift Report" tab is now a **Shift report** view inside the **Shift** tab (`ShiftAndReportTab` → Current shift | Shift report), so a manager sees the open shift and switches to view/print its Z-report without a second tab. **#7:** **Item Mix** (restaurant-only) is now a view inside **Orders** (`OrdersAndMixTab` → Orders | Item Mix; no selector shown for non-restaurant, which has no Item Mix). Low-risk: the existing `ShiftTab`/`ZReportTab`/`OrdersTab`/`TopItemsTab` are unchanged and simply wrapped; the `zreport`/`items` switch cases are kept as fallbacks though the nav no longer lists them. Renderer `tsc` clean; gates green. Remaining from the change doc: none — this closes the batch. |
| 2026-08-15 | **A104 closed (24-hour operation — grace window + Settings tab) [#3/#4]** — a business that never closes overnight was hard-locked the instant the trading day rolled over (only a manager could clear it), which also blocked cashiers from ever reaching the open-float modal (the reported "cashier doesn't get the opening float" — root cause was the stale-day gate suppressing `needsShift && !needsManager`, NOT a role bug in the modal, which is role-independent). Added a per-business **24-hour operation** setting: `checkDayGate` keeps the hard lock (cash must be confirmed to close a day) but, when continuous mode is on, grants a **2-hour grace window** after midnight during which the till keeps trading behind an amber reminder — so a cashier gets the open-float modal and service continues while a manager closes the prior day; after the window the red hard lock returns. Wired like receipt text: `continuous_operation` in `business_settings` → `/api/pos/init` → cached to `device_config` (new column via migrateColumns) → read by `checkDayGate`. New desktop **Settings** tab (renamed from Payments) with the 24-hour toggle and the payment-methods manager moved into it (owner asked to gather custom settings there). `tests/day-gate-grace.test.mjs` (6 assertions, mutation-checked). Server + desktop `tsc` clean; gates green. Note: the dedicated manager/supervisor role the owner mentioned for day-close is a later addition; today's close stays on the existing manager gate. |
| 2026-08-15 | **A102 closed (custom receipt header missing on the physical receipt)** — the owner's editable header (address/tagline lines under the business name) rendered in the on-screen `ReceiptView` but never on the thermal print: `renderReceipt` printed name/branch/PIN/telephone and skipped `receipt_header` entirely. Added `header?` to `BusinessConfig`, rendered it centred (one line per line, blanks dropped) right under the branch name to match the screen, and passed `cfg.receipt_header` into the print ctx from `queueThermal`. Footer already worked (`thankYouMessage`). Verified by rendering a sample ticket — all four header lines now print; a ticket with no header is unchanged. shared/printing + desktop `tsc` clean. |
| 2026-08-15 | **A103 closed (till Payments tab "Something went wrong")** — the desktop Payments manager (A97) hard-failed to a useless generic error when `manage:listPaymentMethods` couldn't reach the server (offline manager token / transport), because the list came only from `manageFetch`. Made the panel resilient: on a list failure it now falls back to the methods CACHED on this till (`pos:paymentMethods`, A96) shown read-only with a clear amber note ("Can't reach the server to manage… showing what's active on this till — reconnect to add, rename, or remove"), and hides the add/edit/delete controls while offline. Management still needs a connection; the manager always sees the live tenders. Desktop `tsc` clean. |
| 2026-08-15 | **PHASE5 GATE — A101 hardware sign-off REQUIRED before A19** (process entry, no code change) — the offline-auth chain (A99→A101) is code-complete on origin, but per PHASE5 §8 it must **trade a full service on the dev flavour across two tills** before A19 (the node→cloud relay, which moves money paths) is built or shipped. **A19 is BLOCKED** until the five A101 hardware checks pass on real hardware: (1) peer signs in via the node when both online (`node sign-in:` in the log); (2) cloud down + node up → peer still signs in; (3) wrong PIN → refused immediately, never falls through; (4) node+cloud both down → cached cashier signs in, and a node-configured till does NOT time-expire (30+ days); (5) a cashier deactivated on the dashboard is refused at the peer via the node after the node re-syncs. Checklist delivered: `swiftpos-a101-test-checklist.html`. Owner to report pass/fail before A19 begins. |
| 2026-08-15 | **A101 (PHASE5 slice 2) — peer authority chain + no time-bomb expiry [A17, closes P0]** — the behaviour change. A peer's `auth:verifyPin` is now **node → cloud → last resort**: it asks its branch node over the LAN first (`verifyPinAtNodeClient` → `POST /node/verify-pin`), then the cloud as before, then a local authority. The **08-08 rule holds across all three**: fall back only on a transport failure, never on a rejection — a `401` from the node is as final as one from the cloud, so a sacked cashier can't sign in by unplugging a cable. The node itself falls back to its OWN roster (`verifyPinAtNode`, never expires) rather than a cache. **Expiry is no longer a time bomb (owner's call):** a till with a node configured NEVER time-expires its offline cache — revocation for such a till is the node roster (wholesale-replaced each pull), not a clock — so a remote branch that relies on its node is never locked out. Only a STANDALONE till with no node keeps the 14-day bound. Accepted tradeoff, documented: a stolen node-configured peer, kept off the LAN, can sign in a previously-cached cashier indefinitely; physical security and §5's typed-Windows-password rule cover the node. `tests/peer-auth-chain.test.mjs` (7 assertions, mutation-checked on the rejection-is-final rule). Desktop main `tsc` clean; gates green. **Per PHASE5 §8 this must trade a full service on the dev flavour across two tills before it reaches a prod till.** |
| 2026-08-15 | **A100 (PHASE5 slice 1b) — node roster cache + /node/verify-pin [A17]** — second additive step. Node-only local `branch_staff` table (safeStorage-wrapped bcrypt PIN + override hashes, permissions, status) populated from `GET /api/pos/branch-staff` on every catalogue pull (node role only, best-effort AFTER the catalogue is stored so it can't fail the pull). New `branchStaff.ts` mirrors `pinCache`: bcrypt only, scan every candidate, **refuse on two matches**, but with **no TTL** — a node is the branch's authority and its roster is valid until replaced (§4e), replaced wholesale each pull so a deactivated staff member disappears. New `POST /node/verify-pin` on the node (guarded by the same X-Node-Secret + branch scope as every /node/* route): returns the identity + permissions on a match, 401 on a bad/ambiguous PIN (final — the peer must not fall back on a 'no'), 503 only when the node can't read its roster. **No JWT minted.** Still fully additive — the node can now answer, but no peer asks yet (slice 2). `tests/node-verify-pin.test.mjs` (5 assertions, mutation-checked). Desktop main `tsc` clean; gates green. |
| 2026-08-15 | **A99 (PHASE5 slice 1a) — node branch-staff endpoint [A17]** — first, fully ADDITIVE step of the branch-node auth work (PHASE5 §4b): `GET /api/pos/branch-staff` hands a branch NODE its active staff roster with bcrypt PIN + override hashes and effective permissions, so the node can later authenticate cashiers offline (closing the day-15 lockout). This is the one route that gives a machine the branch's PIN hashes, so the guard is four conditions: desktop surface, the caller's own business, a device registered as node/office (server-side `isNodeRole` via `user_devices.device_role` — the D4/D14 prerequisites, already in place), and that device's own branch. Effective permissions resolve exactly like `/verify-pin` and the JWT (role grants then per-user overrides); bcrypt-only (a legacy hash upgrades on the next online sign-in). Nothing on any till changes behaviour yet — the node roster table + `/node/verify-pin` (slice 1b) and the peer auth chain (slice 2, the behaviour change, hardware-tested before it ships per PHASE5 §8) follow. `tests/branch-staff-roster.test.mjs` (7 assertions, mutation-checked). Server `tsc` clean; gates green. |
| 2026-08-15 | **A98 closed (kitchen exclusions — chip editor + explicit Save)** — the desktop exclusions editor was a free-text box that saved silently on blur, so it was unclear whether a change had persisted. Replaced with a chip editor: each term is a removable chip (✕), a term is added with Enter or the Add button (a pasted comma/line-separated list is split and de-duped case-insensitively), and an explicit **Save** button persists the list — with "Unsaved"/"Saved" status. Same data and semantics (per-terminal override wins over the business default, survives sync; "Reset to cloud default" unchanged); built-in drinks rule still shown read-only. Renderer `tsc` clean; gates green. |
| 2026-08-15 | **A97 closed (custom payment methods — web POS + till management)** — completes #4. **Web POS:** `usePOSData` now surfaces `paymentMethods` from `/api/pos/init` (+ `POSInitResponse` type), CashierScreen passes them to the web `PaymentModal`, which renders them as tender buttons after Cash/M-Pesa/Card/On-Account (`method` widened to string); a custom method settles immediately like a card (non-cash, no STK), stored as its `code`. **Till management:** methods can now be added from the desktop too, not only the dashboard — new manage IPC (`manage:listPaymentMethods`/create/update/delete → `/api/payment-methods`) + a **Payments** tab in the till's manager (gated `settings.manage`||`products.manage`); after each write the local `payment_methods` cache is rewritten so a new tender appears at the POS at once. Server + dashboard + desktop `tsc` clean; gates green. A96/A97 close the feature end to end: define (dashboard or till) → offline-cached → tender on both POS clients → reports by name → non-cash in reconciliation. |
| 2026-08-15 | **A96 (Phase 2) closed (custom payment methods — POS wiring)** — the methods defined in A95 now work as tenders at the point of sale, offline. `/api/pos/init` returns active `paymentMethods` (per business); the till caches them in a local-only `payment_methods` table (replaced wholesale on each pull, like stations) so they are available with no network. `PaymentModal` renders them as extra tender buttons after Cash/M-Pesa/Card (`DraftLeg.method`/`PaymentLeg.method` widened to string); a custom leg carries its `code` as `method`, flows through `createLocalOrder` → payments → sync → server (stored as-is) → `/sales` (already groups by method), and reports under its name. Reconciliation is unaffected — expected cash filters on `method==='cash'` only, so every custom method is non-cash by construction (owner decision). Receipts and the shift report humanise an unknown code (`coop_card` → "Coop Card"). Wired through IPC (`pos:paymentMethods`, preload, posApi). Server + desktop + shared `tsc` clean; gates green. **Web POS wiring is the remaining slice** (desktop — the offline priority — is done here). |
| 2026-08-15 | **A95 (Phase 1) closed (custom payment methods — define)** — a business could not accept a tender beyond the built-in Cash / M-Pesa / Card (owner asked for "Coop Card" etc.). Phase 1 lets them DEFINE custom methods: migration 86 adds `payment_methods` (per business — id, business_id FK, name, code UNIQUE per business, is_active, sort_order); server CRUD at `/api/payment-methods` (list/create/patch/delete, business-scoped, `settings.manage`||`products.manage`, code generated once from the name and immutable so historical orders keep mapping); dashboard **Payment methods** page (add / rename / activate / delete) + nav. Scope per business, all methods non-cash for reconciliation (owner decisions). The server already stores `leg.method` as a free string and `/sales` groups by it, so defined methods report by name once used. `scripts/test-migration-86.mjs` (7 checks, PGlite, UNIQUE-per-business proven). Server + dashboard `tsc` clean; gates green. **Phase 2 (A96, next): wire the methods into the desktop till + web POS payment modals.** |
| 2026-08-15 | **A94 closed (reprint any receipt from Order History)** — the only reprint was the post-payment modal's button (`escpos:reprintReceipt`), which reprints the *last* order cached in memory — no way to reprint an earlier one after moving on. Added per-row **Reprint** on the Order History panel. Faithful by construction: `createLocalOrder` now stores the exact order payload in a local-only `receipt_payloads` table (pruned to 200), and `escpos:reprintReceiptForOrder(orderId)` replays it through the SAME `queueThermal` path as the original — byte-identical, marked "Duplicate Print". Wired through IPC (preload, posApi). Orders created on another terminal or before this shipped have no stored payload and report so honestly rather than printing something wrong. Renderer + main `tsc` clean; gates green. Advice items from the same review — exclusion "add term" chips (#1) and custom payment methods (#4) — recorded for later, not built here. |
| 2026-08-15 | **A93 closed (M-Pesa reported as "unaccounted" on the cloud) [#3]** — the desktop shift showed M-Pesa correctly but the dashboard payment-method breakdown booked it as "unaccounted". Cause: `/api/orders` wrote EVERY M-Pesa leg `status='pending'` (for the STK-push flow, where the Daraja callback later flips it to `completed`), but the desktop till is a **manual tender** — the cashier confirms on their phone, there is no STK and no callback — so its M-Pesa legs sat `pending` forever, and `/sales` counts only `completed`, surfacing the amount as the unaccounted remainder. Cash was `completed`, so only M-Pesa broke. Fix: the till now sends `status:'completed'` on its (always-confirmed) legs; the server honours an explicit `completed` for M-Pesa and keeps `pending` as the default only when none is sent (the STK path is untouched). Migration 85 backfills the historical stuck rows, guarded so it can never complete an in-flight STK payment (`mpesa_checkout_id IS NULL` AND older than 1h). `scripts/test-migration-85.mjs` (6 checks, PGlite). Server + desktop `tsc` clean; gates + 17 migration tests green. |
| 2026-08-15 | **A92 closed (one-click default stations seed)** — a fresh restaurant with no stations showed the "N categories print nowhere" warning and required creating stations + ticking every category by hand. Added `POST /api/stations/seed-defaults` (guarded: refuses if any station already exists) that atomically creates **Kitchen** (kitchen), **Packing** (dispatch) and **Till** (receipt), then routes every category so none prints nowhere — cooked categories (`is_kitchen`) to Kitchen, ALL categories to Packing (the packer bags the whole order); Till carries no category routing. Wired through IPC (`manage:seedDefaultStations`, preload, posApi) and surfaced as a **"Create default stations"** button on the empty Stations tab (gated on `canEdit`); refreshes the local station cache so routing works on the terminal at once. Server + desktop `tsc` clean; gates green. |
| 2026-08-15 | **A91 closed (restaurant shows 1 station instead of 3 defaults)** — a restaurant with no stations configured on the server showed only "Till receipt" on the Printers tab, not the expected Kitchen + Dispatch + Till. `FALLBACK_STATIONS` (Kitchen/Dispatch/Till) existed for exactly this day-one case, but the loader always pushed a synthetic receipt when the real list was empty, making it length-1 and so never reaching the fallback. Predates A89 (A89 fixed the source, not this empty-case). Fix: when `/api/stations` returns none, seed the defaults by venue type — restaurant gets all three (matching `shared/printing`'s kitchen/dispatch/receipt presets, the incumbent's three-station layout, and the escpos `is_kitchen`→kitchen/dispatch routing fallback which recognises these built-in ids); retail gets the receipt alone. Configured stations are used as-is, still adding a receipt fallback if the business defined none. Renderer `tsc` clean; gates green. Live check: a fresh restaurant enrolment now shows Kitchen/Dispatch/Till on the Printers tab for binding. |
| 2026-08-15 | **A90 closed (Receipt folded into a "Printing" nav item)** — the Receipt (header/footer text) screen moved from its own left-nav item into the tabbed print screen as a fourth tab, and the nav item was renamed **Printing**. Per-tab permission gating so no one loses access: Stations/Printers/Exclusions require `stations.manage`; the Receipt tab requires `receipt.manage` || `settings.manage`; the nav item shows if the user holds EITHER, and `PrintersScreen` renders only the tabs each permission allows (a manager with only `receipt.manage` keeps Receipt and gains no station control). Removed the standalone `receipt` nav item + its dead switch case + unused import. Renderer `tsc` clean; gates green. |
| 2026-08-15 | **A89 closed (Printers tab showed only 1 station)** — after the tabbed Printers screen (A83), the **Printers** tab listed just the synthetic "Till receipt" where a venue had Kitchen + Dispatch configured. Cause: `ManagerPage`'s station loader read `pos.init().stationRouting.stations` — a field the server **never emits** (zero references in `apps/server`) — so the list was always empty and the receipt-fallback added the one synthetic station. The real source is `GET /api/stations` (the `print_stations` table), which the **Stations** tab (`StationsPanel`) already used — so the two tabs disagreed. Fixed: the loader now calls `posApi.manage.listStations()` (active stations, same source as the Stations tab), keeping the "always have a receipt station" fallback. Both tabs now show the same real stations. Renderer `tsc` clean; gates green. Live check: open Printers on a till with Kitchen/Dispatch configured and confirm all three appear for printer binding. |
| 2026-08-15 | **A88 closed (D13 P0 remainder — refresh-token grace window)** — the last open part of D13. `/refresh` revoked the consumed token before the till persisted the new one; a lost response (crash, power cut, dropped packet) left the till holding a revoked token, and the reuse check then revoked EVERY session "for security" — so a dropped packet logged the owner out of the till, every ~15 min of trading. Fixed with chain-based reuse detection (time-independent, survives a power cut): migration 84 adds `refresh_tokens.replaced_by`; rotation links a consumed token to its replacement; on presenting a revoked token, `refreshGraceDecision` (pure, `lib/refreshGrace.ts`) returns **reissue** when the successor is still the live head (client never received the response — mint a fresh pair, revoke the orphan successor, no session nuke) and **replay** only when the chain advanced or there is no successor (logout) — preserving the security behaviour for real replays. `tests/refresh-grace.test.mjs` (5 assertions, imports real dist, mutation-checked) + `scripts/test-migration-84.mjs` (6 checks, PGlite, additive + idempotent). Server `tsc` clean; schema-index updated; all gates + 16 migration tests green. **D13 now fully closed.** Live verification wanted: pull the till's network mid-refresh and confirm it recovers on reconnect instead of demanding re-login. |
| 2026-08-15 | **A87 closed (A59 remainder — shifts.force_close wired)** — the last deferred A59 thread. `shifts.force_close` was a registered key (migration 75) that nothing used: the force-close route enforced the broad `settings.manage`, no role was granted the dedicated key, and the till's force-close trigger was ungated in the UI (visible to cashiers who then hit a 403). Now, all ADDITIVE: the route is `requireAnyPermission('shifts.force_close', 'settings.manage')`; migration 83 grants `shifts.force_close` to the manager role set (same normalised name match as 75/76/78, idempotent, `tests/`… `test-migration-83.mjs`, 6 checks, PGlite, mutation-checked); `POSPage` derives `canForceClose = has('shifts.force_close') || has('settings.manage')` from the staff session and `ShiftPanel` gates its "Can't count the drawer?" trigger on it — so the UI now matches server enforcement and `check-permission-parity` sees the gate (ungated stays 2, no new divergence). No one loses force-close. Server + desktop `tsc` clean; schema-drift + all gates green. A59 is now fully closed. |
| 2026-08-15 | **A86 closed (sync push — atomic mark-synced) [S3]** — `pushPendingOrders` flipped `sync_queue.status` and `orders.sync_status` to 'synced' in two separate statements in each success branch (201 and 409). A crash between them could leave the two disagreeing — queue synced while the order still read pending, or vice versa. Wrapped both in a single `db.transaction` (`markSynced`), prepared once and reused per row, so they move together or not at all. Behaviour otherwise unchanged. Desktop main `tsc` clean; gates green. (Noted-minor from the sync audit; the window was microseconds on synchronous better-sqlite3 writes, now closed.) |
| 2026-08-15 | **A85 closed (sync push — floats no longer silently dropped) [SS1]** — the server `/push` floats section filtered incoming floats to those whose parent shift is present for the business and **silently skipped the rest** — but the till marks every float NOT in `rejected` as synced, so a float whose shift was rejected earlier in the same push (its only cause) was marked synced and lost: a vanished cash-drawer movement. The exact "silent skip → marked synced → lost" mode the shifts/days path was built to prevent, which floats never got. Fix: floats now upsert **per-row** (like shifts), and a float with an unowned/absent shift is pushed into `rejected` with `table: 'float_transactions'`, `code: 'missing_shift'` — the till already buckets that table and parks it, so the float stays put instead of vanishing. Per-row also removes the batch-upsert failure that could 4xx the whole payload (SS2 for floats). `tests/sync-float-routing.test.mjs` (8 assertions, mutation-checked). Server `tsc` clean; gates green. Expenses SS2 (batch upsert, liveness only, no loss) and the cross-tenant-409-aborts-batch edge (SS3) left as noted. |
| 2026-08-15 | **A82 closed (cost-price editor)** — the server fully supported `products.cost_price` (create, update, CSV import) but the dashboard had no way to enter it, so `cost_price` stayed null and starved the Menu Matrix (A78), gross-margin, food-cost and the COGS export. Added a **Cost** field on the product form (live margin %), a **Cost** column in the product table (flags "no cost"), a **Set costs** bulk editor, and a server `PATCH /api/products/bulk-cost/by-ids` endpoint mirroring `bulk-tax/by-ids` (business-scoped, ≤1000 rows, clears on blank, rejects negatives). Server + dashboard `tsc` clean; all gates green. UI paths not component-unit-tested (no dashboard harness). |
| 2026-08-15 | **A84 closed (kitchen exclusions — word-boundary + visibility) [print Phase 2]** — two refinements after confirming the itemized-description exclusion already works (client shows the meal name; kitchen drops sauces/drinks from the split description via the built-in rule + owner terms; dispatcher shows everything). (1) Owner-added exclusion terms now match on **word boundaries** like the built-in rule, not raw substrings — the old `includes()` over-matched, so "water" clipped "watermelon" and "ice" clipped "rice"/"spice". `kitchenPrepLines` builds a `\bterm\b` regex per term (escaped for regex-safety); a few short regexes per ticket, off the bytes-to-printer path — speed-neutral. (2) The Exclusions tab now shows the **built-in list read-only** (sauces, dips, soft drinks, sodas, drinks, juices, water, coke, fanta, sprite, krest, stoney, minute maid) so the owner can see what's already filtered and not re-add it. Also fixed the stale `noteLines` comment that claimed "prose cannot be filtered" (it can, and does). `tests/kitchen-prep-wordboundary.test.mjs` (11 assertions, mutation-checked). Renderer `tsc` clean; gates green. Dispatcher exclusions were considered and **dropped** — dispatcher shows everything for packing, and takeaway packaging is already deducted server-side via the existing `product_packaging` feature. |
| 2026-08-15 | **A83 closed (print UI — tabbed Printers, Stations restored)** — StationsPanel (create/route Kitchen/Grill/Dispatch) was orphaned when PrinterSetupScreen superseded the unrouted PrintersTab; only binding + exclusions were ported. New PrintersScreen shell puts Stations, Printers and Exclusions under one nav item; ManagerPage routes printers to it; exclusions extracted to ExclusionsPanel. Confirmed upstream regression, not a local edit. |
| 2026-08-15 | **A80 closed (sync audit — stock delta-merge)** — `pullCatalogue` overwrote `stock_levels.quantity` with the server baseline (`quantity=excluded.quantity`) under a comment calling it "reference point for delta merges" and a header promising "delta deduction, never absolute overwrite" — but **no delta merge existed**. Since `syncAll` pulls before it pushes, every reconnect reset the accumulated offline-sale deductions to the server's pre-push baseline; the till showed stale-high stock until the next pull, and indefinitely while a push kept failing. Not data loss (orders survive as pending; stock isn't a hard sell-gate) but it misled staff and locally defeated the A74 low/negative signal exactly when offline. Fix: after the baseline upsert, re-apply `Σ(order_items.quantity)` for tracked products of orders still `sync_status='pending'`, grouped by product+branch (the merge always claimed). `'pending'` includes failed-to-push orders — the push-failure branch never flips `orders.sync_status`. `tests/sync-stock-merge.test.mjs` (11 assertions, mutation-checked). Desktop main `tsc` clean. NOT bench-run on a live offline→reconnect device — wants one field pass. Minor S3 (the two sync-state UPDATEs in `pushPendingOrders` aren't wrapped in one transaction — a microsecond window on synchronous better-sqlite3 writes) noted and accepted, not changed. |
| 2026-08-15 | **A81 closed (sync audit — offline clamp)** — `createLocalOrder` deducted stock with `Math.max(0, currentQty − qty)`, flooring at 0, while the server's `adjust_product_stock` lets `quantity` go negative (A74 "sold beyond stock"). Offline, an oversell stuck at 0 locally and disagreed with the server until the next pull, and the till could never show the A74 state offline. Removed the floor so the local deduction matches the server; the A80 merge likewise doesn't floor. Covered by the same test's negative-survival assertions (mutation-checked). |
| 2026-08-15 | **A79 closed** — the web POS room-charge (guest-split) button posted via a direct `/api/orders` create with a client-minted `generateOrderNumber()` and only a `roomCharging` *state* guard, so a fast double-tap posted two room charges (two distinct numbers, so the unique constraint didn't dedupe). Added a synchronous `roomChargeRef` returned-on before any await + reset in finally (`CashierScreen`). Same shape as A76's desktop guard. Dashboard `tsc` clean. UI path — not component-unit-tested (no renderer harness). |
| 2026-08-15 | **A78 closed** — the Menu Matrix report was a `ComingSoonTab` stub while the README advertised it as working (the one undocumented gap the first audit found). Built for real: `MatrixTab` reuses `/api/reports/products-v2` (already returns qty + `gross_margin_pct` + `total_cost`) and classifies Kasavana-Smith — popularity by the 70% rule (`qty ≥ 0.70 × totalQty/N`), profitability by unit contribution margin vs the average — into Stars / Puzzles / Plowhorses / Dogs, each with the standard action. Items with no `cost_price` are set aside (they'd distort the average) with a prompt to set cost in Inventory. No new server code. Dashboard `tsc` clean. Component (like its sibling tabs) — no unit test; thresholds documented inline. |
| 2026-08-15 | **A77 closed** — the onboarding owner PIN was removed. Traced first: it is a POS-terminal login only (ring sales / unlock), NOT the dashboard login (that's Supabase email+password), and it never actually worked — onboarding hashed it with `btoa()` while the server's `verifyPin` only accepts bcrypt (`$2…`) or legacy sha256-hex, so it could never match (and would throw in `timingSafeEqual`). Removed the whole PIN step (fields, pad, `validatePin`, the `btoa` `hashPin`, `ownerPinHash` from the POST). Server already stored `pin_hash: ownerPinHash ?? null` with an `owner_pin_set` flag and the column is nullable, so no server change. An owner who genuinely operates a till sets a PIN later in Settings → `/api/auth/set-pin` (proper bcrypt). Dashboard `tsc` clean. |
| 2026-08-15 | **A76 closed (bundle: PIN lockout · double-charge · round2)** — three interaction defects the static gates can't see. (1) **PIN lockout**: `LockCurtain` and `POSLoginScreen` auto-submitted at 4 digits, truncating and rejecting every 5–6 digit PIN — a hard lockout for 6-digit managers (`POSLoginScreen` also cleared the field on the failed attempt). Both now cap at 6 and require explicit submit, matching PinPage. (2) **Double-charge**: desktop `handleCharge` guarded on `setPlacing` (state, next-render), leaving a one-frame double-tap window; added synchronous `placingRef` + try/finally, and stopped the bill-reservation catch swallowing. (3) **round2**: desktop `payment.ts` aligned to the server `Number.EPSILON` form. (Register row backfilled — the code shipped in df47203 but this line missed that commit.) Not component-unit-tested (no renderer harness); onboarding owner-PIN excluded then, done in A77. |
| 2026-08-15 | **A74 closed** — negative product stock (a legitimate state: a transfer arrives physically and is sold before it is received in the system) raised no branch-visible warning. `checkLowStock` DID fire on negatives (a negative is below any threshold) but wrote the row owner-scoped and business-wide: `branch_id` was left NULL though the column exists, and the copy did not distinguish "sold beyond stock" from merely "low". A branch manager therefore saw nothing — the dashboard never read `notifications` at all. Now: pure `lib/stockAlerts.ts` (`classifyStockLevel` splits `negative_stock` vs `low_stock`, C7 string-coercion in one tested place); the checker sets `branch_id`, emits the right type with distinct copy/subject, and dedupes per product+branch+type via a `[product|branch]` marker (mirrors the ingredient path); `GET /api/notifications` gained `branch_id` in its select plus `?branch=` and `?type=` filters; ManagerDashboard Overview fetches unread `negative_stock,low_stock` for its own branch and shows a red (sold-beyond) / amber (low) card **on load, no realtime** (owner's call). `tests/negative-stock-alerts.test.mjs` (19 assertions, mutation-checked). Server `tsc` clean. NOT bench-run against live Postgres/RLS end-to-end — the notification insert/read path wants one field pass. |
| 2026-08-15 | **A75 closed** — a stock alert never cleared itself: nothing on the receive path resolved it, so after booking the arriving transfer the red banner lingered until dismissed by hand. Added `resolveStockNotifications` (jobs/lowStockChecker.ts) + pure `shouldResolveStockAlert` (lib/stockAlerts.ts): on `applyProductStockIn` (transfer receive AND cancel-return-to-source) it marks matching unread rows read once on-hand recovers — `negative_stock` clears at ≥ 0, `low_stock` only at/above threshold, so a partial receipt clears the negative and correctly leaves the low. Non-blocking (`void …`), never fails the receipt. Covered by the same suite's resolve assertions (mutation-checked). Restock via other paths is not yet a clear-point — only the two transfer paths call `applyProductStockIn` today. |
| 2026-08-13 | **A49 closed** — the stock report read `stock_adjustments` (a dead table), so restocked/written-off were permanently zero. Repointed `GET /reports/inventory` to fold `stock_movements` (sale excluded to avoid double-counting; correction split by sign). Extracted `lib/stockMovementSummary.ts` (pure); `tests/stock-movement-summary.test.mjs` (6 assertions, mutation-checked). Stale table-usage exception removed; `stock_adjustments` now fully dead (drop candidate). Also: the A59 stations.manage leftover was already enforced additively (migration 79) — only force-close remains, deferred as it touches a desktop file. |
| 2026-08-13 | **A63 closed** — the onboarding seeder matched role names un-normalised (`nm==='branch_manager'`), so a "Branch Manager" typed with a space would be seeded with ZERO permissions (A61 one layer up). Extracted `roleTier()` to `lib/roleTier.ts` (pure, supabase-free), normalising `lower(replace(name,' ','_'))` like the migrations. `tests/role-tier.test.mjs` (12 assertions, mutation-checked). |
| 2026-08-13 | **A64 closed** — owner chose the strict manager policy (receive + see, no adjust/manage/financial; management lives on web). Seeder MANAGER_DENY is authoritative; migration 82 revokes the three keys migration 59 over-granted from manager-type roles only, owner/admin and other grants untouched. `scripts/test-migration-82.mjs` (10 checks, mutation-checked). Run the blast-radius SELECT before applying to prod. |
| 2026-08-13 | **A37 closed** — the desktop licence was bypassable by a client sending `surface: 'web'` on /pos-login. Now the exempting surface is server-derived: honoured only when the business holds web access (`getWebAccess().canLogin`), else forced to desktop and licence-checked. `tests/auth-surface.test.mjs` (11 assertions, mutation-checked). Also fixed a D11 regression this test caught — §3 pinned the pre-D11 `pos.ts` gate shape and had been silently failing. Residual: dual web+desktop subscribers (business-policy call). |
| 2026-08-13 | **A59 closed** — the till/cloud permission-vocabulary mismatch. The renderer already gates on keys (`has()`), the gates were re-pointed, and `check-permission-parity` now sees the till; the one benchable gap — proving migration 78 grants `receipt.manage` to manager/supervisor/branch_manager — is closed by `scripts/test-migration-78.mjs` (7 checks, PGlite, mutation-checked). Closed on the A66/A43 basis: model proven, only the Windows render smoke-test remains. Two cloud-side inconsistencies (unenforced `stations.manage`, force-close key) recorded for a later pass. |
| 2026-08-13 | **D9 designed, not built** — cross-till held orders. Turned the bare title into a real entry + `docs/HELD-ORDERS-CROSS-TILL-D9.md`. It is the app's worst-failure data path (open tabs), needs an owner concurrency decision (claim/handoff vs charge-lock vs view-only) and a multi-till rig to verify, so it is deliberately unbuilt and should not ride the rollout. Recommended shape: node-authoritative with an atomic claim. |
| 2026-08-13 | **A51 closed (register was stale)** — the device-token sawtooth fix (`refreshDeviceTokenIfExpiring` in `syncEngine.ts`, refresh within 120s of expiry, device-scoped, reactive 401 backstop intact) was already implemented and passing `device-token-refresh.test.mjs` (21 assertions); the entry still read "not done". Corrected to CLOSED. NOT yet field-confirmed — a build predating the fix still sawtooths, so the fix must ship. |
| 2026-08-13 | **D4 implemented end-to-end (stays OPEN; closes D1 on live test)** — issue (`routes/enrol.ts`) + redeem (`auth.ts`, atomic burn, mints the owner-scoped desktop token) endpoints; desktop `auth:enrolDevice` + `posApi.auth.redeemEnrolment` + InstallPage now takes Business ID + enrolment code instead of owner email/password. Server/renderer `tsc` clean, IPC parity 139/139, `tests/enrol-endpoints.test.mjs` (19 assertions). The end-to-end HTTP/token/install path is unrun on the bench — `docs/DEVICE-ENROLMENT-D4.md` has the live-test checklist. |
| 2026-08-13 | **D7 rollout (stays OPEN)** — shared IPC validator now adopted on `auth:verifyPin`, `order:void` and `auth:enrolDevice` (throwing `assertPayload`, valid payloads unchanged), in addition to `escpos:setKitchenExclusions`. `tests/ipc-validate.test.mjs` up to 25 assertions (mutation-checked). `order:create` left unvalidated on purpose — the sale path needs a schema written against `createLocalOrder` and a live test, not a blind guard. ~132 channels remain. |
| 2026-08-13 | **A67 closed** — `check-register-consistency` read OPEN/CLOSED from the whole heading, so D11's "fails closed" title counted as CLOSED. Now matches a status label at the start of a leading field, via a pure `scripts/lib/register-status.mjs`; `tests/register-status-parse.test.mjs` (12 assertions). |
| 2026-08-13 | **D7 advanced (stays OPEN)** — added a shared, dependency-free IPC payload validator (`apps/desktop/src/main/ipcValidate.ts`: `validatePayload`/`assertPayload`/`expectStringArray`) — the desktop had none and no zod. Reference adoption on `escpos:setKitchenExclusions` (malformed → clean reject, not a silent coerce-to-empty). `tests/ipc-validate.test.mjs` (21 assertions). ~135 channels still to adopt; rollout is per-channel. |
| 2026-08-13 | **D3 advanced (stays OPEN)** — added an auto-update scaffold (`apps/desktop/src/main/autoUpdate.ts`, electron-updater, dev-guarded, installs on quit) + `docs/DESKTOP-AUTOUPDATE.md` runbook. Not bench-verifiable (no Electron/feed): needs the dep, wiring, a publish target, code-signing and a CI release — which is what actually closes A1. |
| 2026-08-13 | **D4 advanced (stays OPEN; closes D1 when finished)** — `migrations/81_device_enrolment_codes.sql`: single-use, business-scoped, expiring enrolment codes so a till provisions without an owner login. Proven against real Postgres — `scripts/test-migration-81.mjs` (13 checks, mutation-checked on the atomic burn); `schema-index.json` updated. Endpoints + desktop InstallPage are a reviewed proposal in `docs/DEVICE-ENROLMENT-D4.md`, held back because the token path can't be bench-verified. |
| 2026-08-13 | **D11 closed** — `/api/pos/init` gated the desktop licence on the `is_main` branch, so a till bound to branch B was licensed by branch A's flag; and `.single()` on the main branch 500'd the whole pull when a business had zero main branches (which the schema permits). Now resolves `boundBranch ?? mainBranch` in the parallel fetch, gates on that, reuses it for pricing, and uses `maybeSingle` so zero main branches is a clean 403 not a 500. `tests/pos-init-desktop-licence.test.mjs` (14 assertions, mutation-checked). Noticed in passing: the old title "fails closed" made `check-register-consistency` read D11 as CLOSED while it was open — title reworded; parser fixed under A67. |
| 2026-08-13 | **A66 opened and closed** — kitchen exclusions never persisted on the till: `saveDeviceConfig` omitted `kitchen_exclusions` from its INSERT/VALUES/SET, so the synced cloud list vanished and the printer applied nothing (invisible to `check-sql-binds` — the statement was balanced, it just never named the column). Fixed, and a per-terminal `kitchen_exclusions_override` added (`LOCAL_SCHEMA_VERSION` 52) so a till can own its list and keep it through every sync — "local is final". Proven by running the real INSERT under `node:sqlite` (`tests/kitchen-exclusions-local.test.mjs`, 17 assertions, mutation-checked). Windows render check outstanding (A43's limit). Two findings recorded: cloud lists are business-wide by design; a `deploy_mode:'local'` till is still not provisionable. |
| 2026-08-11 (f) | **A62 opened and closed** — migration 76 failed in the field with 42P01 on `role_permissions`. One unqualified table name in an otherwise fully-qualified file, shipped by this session. All of 75/76/77 qualified and re-verified under `search_path = ''`; `check-schema-drift` gained check D, ratcheted at 22, mutation-checked against the real bug. |
| 2026-08-11 (e) | **A55 closed** — `total_spent` was the last racy read-modify-write on the customer row, in three places, while loyalty_points and visit_count on the SAME row had been atomic since migration 53. Migration 77 adds `increment_customer_spend` and `adjust_customer_visits`; the void path now makes three RPC calls instead of one racy statement. Proven by RUNNING the race under PGlite: the old shape banks 100+250 and records 250. |
| 2026-08-11 (e) | **A60 closed** — `check-register-consistency`. Ten IDs had two headings (A4 A9 A25 A45 A46 A47 A50 A57 A58 D8 D14), several contradictory; the header claimed 0 P0 while A17 sat OPEN at P0. **Three duplicates were created by this session**, hours after it criticised the same failure. All merged; header re-derived from the body. |
| 2026-08-11 (e) | **A61 closed** — a bug THIS SESSION shipped in migration 75: grants matched `branch_manager` but not `Branch Manager`, so a business that typed the name with a space got nothing, silently. Migrations 24 and 49 carry the same blind spot since 2026-07. Fixed at source; migration 76 backfills only the rows the bug skipped. |
| 2026-08-11 (e) | **A7 closed** — README claimed `parking -> ParkingPOS` / `petrol_station -> PetrolPOS`; both are imported nowhere. Corrected to the live `CashierScreen` path, plus an accuracy note recording what the README still does not cover. |
| 2026-08-11 (e) | **A53 ratcheted** — 21 orphan audit-ID citations may shrink, never grow. The recorded fix was a policy nothing enforced. |
| 2026-08-11 (e) | **`check-schema-drift` gained a self-clearing pending declaration.** Migration 77 is written but not run, which the gate correctly called drift — leaving CI red on a correct commit. `schema-index.json` was NOT refreshed to hide it (that would claim production has functions it does not — the A49 shape). Instead `scripts/schema-pending.json` declares the window and FAILS once the functions appear live, so it cannot become a silencer. |
| 2026-08-11 | **A45 closed cloud-side.** `POST /business/settings` takes `receipt.manage` or `settings.manage` and narrows per key: without full settings access, only `receipt_header` / `receipt_footer` are writable. Allow-list, not deny-list; runs before the bcrypt and encrypted-credential branches. 21 assertions against the real compiled middleware. **Remaining step is yours: grant `receipt.manage` to Manager in the Roles screen.** No desktop change needed. |
| 2026-08-11 | **A59 opened (P1)** — the till has NO permission-key plumbing; every gate there is a role test, while the cloud enforces 17 keys. Not two gates disagreeing, two vocabularies. `check-permission-parity` scans the renderer and finds zero keys, so every till gate is invisible to the comparator meant to catch this. A45 was one symptom of it; 14 tabs share the shape. |
| 2026-08-11 | **Known limit of check-permission-parity, recorded not hidden:** it reads MIGRATIONS, not the live database. A key granted through the Roles UI — which is how `receipt.manage` will be granted — does not move its `ungated` count. The ratchet catches drift introduced in the repo; it cannot see grants made in production. |
| 2026-08-11 | **A46 partly closed** — `requireAnyPermission` built; 13 of 16 `settings.manage` routes split onto `devices.approve` / `tables.manage` / `etims.manage`, additively, so no existing role loses access. Three routes deliberately left: `receipt.manage` is a PER-KEY check inside a handler that also writes PIN hashes and M-Pesa secrets (A45's real fix, own batch); `shifts.force_close` needs a desktop file (rules 9, 15); `flags` correctly keeps the retained key. |
| 2026-08-11 | **A57 closed** — migration 75 registers all twelve keys. Idempotent, proven under PGlite (11 assertions), including that a row pre-existing with production's label keeps it. **Correction: the `-b` manifest said this needed the production query first. It did not — ON CONFLICT DO NOTHING makes it safe either way, and migrations 24 and 49 had already set that pattern.** |
| 2026-08-11 | **A58 fix shipped, confirmation wanted** — `orders.view_all` and `inventory.view` registered and granted to manager-level roles, restoring Orders, Turnover and Inventory. Isolated in its own migration block with a revert line, because Turnover shows branch revenue and that is the owner's call. |
| 2026-08-11 | **check-permission-parity revised.** `ungated` now ratchets only on keys GRANTED to some role — a key nobody can hold is owner-only and no screen can gate on it (FleetPage is read-only; devices' four write routes have no UI at all). Raw figure still printed. **Scrutinise this: it was changed while adding keys it then exempted.** Also gained a self-check after mutation showed the scanner could go blind to `requireAnyPermission` and still exit 0 — twice, because the first self-check compared the pattern against itself. |
| 2026-08-11 | **A56 built and CLOSED** — `check-permission-parity`, the comparator A45 asks for and A46 is blocked on. Compares THREE surfaces (cloud `requirePermission`, migration seeds, UI gates), not the two A45 names. Ratcheted on `typecheck-ratchet`'s semantics because the ground is not green (6/6/2) and a day-one-red gate gets switched off. Three defects in my own gate caught first: it walked never-run archive migrations, it assumed zero phantom keys, and its first mutation used an alias the scanner rightly ignores. |
| 2026-08-11 | **A57 opened (P1)** — 6 enforced keys have no `permissions` seed in any migration; `requirePermission` fails closed and `role_permissions` has an FK, so ~62 routes are owner-only on ANY database built from this repo. Not necessarily broken in production — one SQL query settles it, and it is in the entry. Fix deferred INTO A46 so the keys are seeded once, not twice. |
| 2026-08-11 | **A58 opened (P1)** — Orders, Turnover and Inventory nav items gate on `orders.view_all` / `inventory.view`, which the cloud never enforces and no migration defines. `hasPermission` can only ever return false for a non-owner, so three manager tabs are invisible with no error. A45 inverted. |
| 2026-08-11 | **A54 opened.** Mail still undelivered in production. A50's pin WORKED (74.125.195.108 is IPv4); the timeout survived it, falsifying "not two problems; one" in `mailer.ts` and the test header. Second cause is a filtered port, not DNS — `render.yaml` says `plan: starter`, the running instance is dashboard-managed and unverified. Shipped: failure classification by cause, alternate-port probe (diagnostic only), corrected comment. Blocked on the owner for the instance type and a Gmail App Password. **Delivery-level reporting NOT built (rule 12) — recorded as the remaining gap.** |
| 2026-08-11 | **A1 STRUCK** — owner confirms `SUPABASE_SERVICE_ROLE_KEY` was rotated long ago. The packaging half was already closed with two CI gates behind it; the rotation half was the only thing outstanding. Entry retained below per the never-reuse-IDs rule. |
| 2026-08-11 | Header count corrected: **0 P0 → 1 P0**. §A listed A17 as `P0 · OPEN` while the header claimed none. Same failure the preamble names — a header disagreeing with its own body — on the count that decides sequencing. |
| 2026-08-10 | **A5 closed** — `PHASE2-3-DESIGN.md` said "For approval before code" a week after Phase 2a/2b/2c and Phase 4 shipped; `ROADMAP.md` (2026-07-10) mentions none of it. Both now carry status headers naming the code as authority. Not rewritten: restating a month of decisions as a fresh plan would be inventing intent. |
| 2026-08-10 | **D6 closed** — `docs/LOCAL-SCHEMA-VERSIONS.md`. Local schema is additive and idempotent, not a numbered ladder; the version labels a shape. **48 and 50 never existed** — the constant jumped 47→49→51, the same shape as the server's SKIPPED 31/32 and never-existed 64. |
| 2026-08-10 | **A9 triage closed** — 3 critical and 16 of 18 high are devDependencies (electron-builder / node-gyp chain); the Electron CVE is macOS-only and every till is win32; the only prod vulns are `uuid`/`exceljs`, and the advisory covers v3/v5/v6 with a buffer while every call here is `v4` with none. **Shipped surface: none.** Server has real but lower items fixed by a plain `npm audit fix`. |
| 2026-08-10 | **A43 step 1 done** — the picker protection now exists on `PrinterSetupScreen`, the screen that is actually rendered, in the general form of the bug. Step 2 (§5 exclusions) still blocks the deletion. |
| 2026-08-10 | **A52**: idle lock built. OS idle via powerMonitor, so it cannot fire mid-sale by construction. Manager 5 min, POS 10. A curtain over mounted state — never clears the cart or the session; unlock is the PIN pad (A17) and only for the locked staff member. 27 tests, 3 mutation checks. |
| 2026-08-10 | **A53**: 20 audit IDs cited in code with no entry anywhere. The B/C/E/F/G/H sections went in the 08-08 restructure and were never in the first commit, so they are unrecoverable — a previous note suggesting recovery from `415e044` was wrong, that commit is not in this history. `docs/AUDIT-ID-INDEX.md` indexes all 20 with call sites. |
| 2026-08-10 | **A6 closed** — the 3-Aug handoff recovered from `0f85155:HANDOFF.md` (383 lines) and filed at `docs/history/handoffs/HANDOFF-2026-08-03.md`. |
| 2026-08-10 | **A51 fixed** — proactive device-token refresh, scoped so it cannot touch the staff token and mask A47's field test. An assertion fails if anyone later widens it. 21 tests, 4 mutation checks. |
| 2026-08-10 | **A50**: daily summaries never delivered — nine businesses, every run, both observed days. SMTP fallback died as ENETUNREACH on Google's IPv6. Not an unverified Resend domain (`RESEND_API_KEY` was absent) and not unreal test addresses (ENETUNREACH is pre-`RCPT TO`; Beryl failed identically). Fixed with `family: 4` plus a boot `verify()` so a dead mail path announces itself. |
| 2026-08-10 | **A51**: the device token sawtooths — 10-minute pull against a 15-minute token means every other catalogue pull 401s by construction. ~72 refresh rotations/day and a till log that can no longer show a real auth failure. Held out of 0.5.28 so it cannot mask A47's idle test. |
| 2026-08-10 | **A47**: `manageFetch` served 35 manager handlers with no 401 branch while `ownerFetch` in the same file always had one. Staff access token 15m, refresh 30d — so idling produced "This till was signed out" on a signed-in till. Field report. Gate `check-auth-retry` built and in CI; it found `refreshTechConfig` on its first run. |
| 2026-08-10 | **A48**: the receipt closing block (thank-you, TAX RECEIPT) lived only in the HTML receipt and went with it in 0.5.27. Restored in `render.ts`, tax line gated on VAT. Also: `SAMPLE-OUTPUT.txt` is NOT regenerated by `npm test`, contrary to §I. |
| 2026-08-10 | **A49**: `stock_adjustments` is read by the stock report and written nowhere, so restocked/written-off are permanently zero. `check-table-usage` was silenced on it by an exception that had never been true. Exceptions file now warns that its reasons are unchecked prose. |
| 2026-08-10 | **A43 stays OPEN** — deletion attempted, `test-print-resilience` went red (ENOENT, 4 reads). Its §4 pins a real field bug (PrinterPicker remount = dropdown snaps shut) and `PrinterSetupScreen.tsx:270` has an unguarded `<select>` of its own, so deleting drops the ONLY guard on the screen that is now live. §5 asserts exclusions are edited on a tab nobody can open. Reverted per rules 12 and 20; sequence recorded. |
| 2026-08-10 | Register reconciled against the tree. A9 closed (dirs were never empty; ID collision with the npm-audit A9 recorded). A10 REOPENED — only 1 of its 4 claimed supersessions happened; `PrinterSettingsModal` is still live in `POSPage`. A12 raised P3 → **P1**, it is live. A7 re-characterised: parking/petrol ship inside `CashierScreen`; the two files are unwired upgrades carrying their own integration instructions. A1 split — packaging closed, key rotation still unconfirmed. A39 down to one missing document. A4 (22/68) and A46 (30 routes) refreshed. |
| 2026-08-07 | Opened. A1, B1-B5, C1-C6, D1-D3, E1-E4, F, G1-G2, H1-H2, I. |
| 2026-08-07 | Live schema dump reviewed. Added B6, C7-C9, §0 dump caveat. BUG-19 upgraded and sized. |
| 2026-08-08 | G1-G7 shipped. 31 items closed. Printing migrated to ESC/POS end to end (P-01…P-19). Two new gates. Register restructured: open items first, closed items retained as evidence. |
| 2026-08-08 | Desktop audit (D1-D15) and Beryl sync investigation. Migration ledger reconciled against production (§M). Migration 46 applied. D12 and A1 packaging closed. Header counts and commit corrected. |
| 2026-08-10 | A45: the Receipt tab is shown on `isManagerRole` while the server demands `settings.manage` — a UI gate and a server gate disagreeing. A46: that one permission covers 16 routes from receipt text to eTIMS registration and till revocation; owner asked for a fine-grained split, proposed with seven keys. |
| 2026-08-10 | A42: the thermal toggle's OFF label reassured while nothing would print — corrected. A43: 0.5.27's exclusions box went onto PrintersTab, which is superseded and unrendered; deferred to PHASE6 as per-station. A44: station creation already exists on the dashboard. |
| 2026-08-10 | 0.5.26 built and installed. 0.5.27: HTML SALE path removed after thermal proved itself; D8 closed by reporting skipped stations rather than routing around them; escpos_enabled defaults ON with a guarded backfill; localStorage exclusion list retired. Shift reports and calibration deliberately kept. |
| 2026-08-10 | A40: DESKTOP_DESIGN.md confirmed lost; stub records what the citations preserve and where it lives, nothing reconstructed. A41: check-header-keys and check-test-registration added to CI — both caught defects in their own first versions. |
| 2026-08-10 | **A39**: BRANCH_AUTHORITY_AND_SYNC_DESIGN.md — cited by section in six source files, absent from the repo. Now in docs/. It already specifies A19, A24, PHASE5 §4 and PHASE6; status line reads "agreed design, not yet implemented". |
| 2026-08-10 | Rule 21 (node vs cloud vocabulary). PHASE6 designed: branch-local settings owned by the node, cloud-backed, manager-editable offline — the first payload for A24's downstream channel. |
| 2026-08-10 | **A38**: the till sent X-Device-Id twice; every server reader got a comma-joined, truncated value. Third independent cause of the empty fleet, alongside D14's opt-in flag and A36's surface. Normalised server-side so old and new builds resolve the same terminal key. |
| 2026-08-10 | **A36 (P0)**: `/desktop-login` minted `surface: 'web'` while its own header said `'desktop'`. Four features silently dead on every till — offline sign-in (D16) never worked in the field, device registration never ran, the licence gate never fired, requireWebSurface bypassed. One word. A37 opened. |
| 2026-08-10 | D14 measured in production: **0 registered devices across all 10 businesses**, and one `require_device_registration` row anywhere (Lovers Rock, false). Registration has never run for any tenant; deviceBinding.ts, devices.ts, migration 43 telemetry and migration 52 binding have all been dead code in production. |
| 2026-08-10 | CI #44 (PR dev→main): secret scan 403 — no permissions block, so gitleaks could not read PR commits and scanned nothing. Passing on push for 40+ runs, never exercised on the event that gates main. Fixed; .env check moved first so one fault cannot skip both gates. |
| 2026-08-10 | CI #42: desktop-scope red — the three desktop suites import dist/main and the job never built it. Build + the two installs added, verified from a clean checkout. Other five jobs green, including all 7 migration files. |
| 2026-08-10 | A32: six migration tests existed and none ran; test-migration-47 had never worked (hardcoded sandbox path, 19 dead assertions). Runner added, all 7 in CI. A33: Windows path bug in my harness. |
| 2026-08-10 | Target run: 92 desktop tests green under real Electron ABI. A31 found — failover-cursors was never wired into test:desktop, A16 repeated in the batch that closed A16. A9 measured: 23/3-critical is desktop, server is 6/0. |
| 2026-08-10 | Migration 74 failed on the owner's database (42P16). Fixed, plus a second idempotency bug only execution found. Migrations now run against real Postgres (PGlite) in CI — 17 tests. A30 closed. |
| 2026-08-10 | D4: migration 74 makes a claimed role verifiable — TOFU per branch, recorded conflicts, one-hour handover window, unique index. A25 closed; A22 partly closed. A29 found: --merge-migrations resurrects renamed columns and weakens the audit. |
| 2026-08-10 | Office role (view-only node) brought into scope. PHASE5 §4b corrected from `=== 'node'` to `isNodeRole()`. Migration 73 adds device_role; till reports it; registry stores and labels it. A27, A28 closed. A4 measured: 20/66. A25 still open — a role can now be seen, not verified. |
| 2026-08-10 | Rule 17 sweep on D14. Cause found at `auth.ts:432` — an opt-in flag, not a missing upsert; far more was built than credited. D14 and A26 closed; approval and registration separated. A25 still open by design. |
| 2026-08-09 | Owner's correction upheld: most of the architecture is built. A24 opened as the unifying finding — the node has no downstream distribution. PHASE5 §11 rewrites the delta; `branch_staff` dropped in favour of columns on the existing `users` table. |
| 2026-08-09 | Failover clarified: data replicates to all tills, a peer can be promoted. Promotion machinery confirmed present and sound. A20-A23 opened against the gaps; PHASE5 gains §10. |
| 2026-08-09 | Owner's design clarification: node is branch source of truth, sole cloud uplink, may stay offline forever and may authorise. A17/A19 resolved to a design; `PHASE5-NODE-AUTHORITY.md` written for approval. Reverses D16's override-PIN decision (§5) and makes D4/D14 prerequisites (§7). |
| 2026-08-09 | Batch 1 (server). A14 Beryl root cause found and fixed, A15 error classification, A16 CI gap, A2 closed. Beryl post-commit hypothesis ruled out by idempotency deduction. 17 new tests, mutation-checked. |
| 2026-08-08 (eve) | D2, D12, D13 (client half), D16 offline sign-in, A1 packaging closed. Migration 46 applied. 78 desktop tests added, green on Windows/Node 20 with SQLite suites on the real Electron ABI. Working rules moved into the handoff §0. |
