# HANDOFF — 2026-08-10 (evening)

Working rules: `HANDOFF-2026-08-08-evening.md` §0, rules 1-23, plus
`HANDOFF-2026-08-10.md` for rules 21-23. **Two are new tonight**, both earned by
failures in §5:

- **24 — a test must assert EFFECT, not storage.** `family: 4` was asserted as
  "nodemailer stored it". It does store it. It never reads it. The fix shipped,
  production said `SMTP FALLBACK IS DEAD`, and the mutation check had been blind
  the whole time — removing an option that does nothing changes nothing.
- **25 — name the environments where a defect is IMPOSSIBLE, not merely
  unlikely.** This sandbox has no IPv6 interface, so the mail bug could not
  occur here at any point. Every local check passed for a structural reason, not
  a lucky one. Rule 9 covers "weaker environment"; this is stronger than that and
  deserves saying out loud.

The register (`AUDIT-REGISTER.md`) wins where this disagrees with it.

---

## 1. Goal

Open with: a full read of the repository, then two field faults reported on
0.5.27 — the recurring **"This till was signed out"** banner, and a receipt
**missing its closing lines**.

Neither was what it looked like. The session became: **fix what the field
reported, then close everything that could be closed without a decision** —
and, repeatedly, **discover that the checks meant to catch these things could
not see them**.

---

## 2. Current state

**Green.** 13 gates pass; `check-doc-refs` is red on one pre-existing document
(`BRANCH-SERVER-PLAN.md`, cited in eight places, never committed). All builds
clean. 110 migration assertions, 23 server suites, 10 desktop-scope, 6 desktop,
11 printing, 136 IPC channels bridged and handled, ratchet 0/0.

**In production:**

- **0.5.28** on Beryl's till, carrying A47 and A48.
- **A47 CONFIRMED IN THE FIELD** — signed in, away 30+ minutes, clicked through
  the manager screens, **no banner**, reproduced again later. That is the
  discriminating test: an idle till with no sales is the only condition under
  which nothing refreshes the staff token.
- **A48 confirmed** — receipt footer prints correctly.
- **A50 NOT fixed in production.** The first mail fix deployed and failed within
  ten seconds. Re-fixed tonight; **unproven until the next deploy**.

### Do these before anyone trades

1. **Deploy the server** and read the boot log. Success is one line:
   `[mailer] SMTP fallback reachable: smtp.gmail.com:587 via 74.125.126.108 (IPv4 pinned).`
   If it still says `DEAD`, the message now names the pinned address, which
   separates "pin not applied" from "IPv4 also blocked".
2. **Tick the thermal checkbox** on any till that has not traded on 0.5.27+.
   With it off, nothing prints at all — no kitchen ticket, no receipt (D8).
3. **`SUPABASE_SERVICE_ROLE_KEY` is still unconfirmed** after the 08-08 zip
   exposure. Nothing in this repo records a rotation. **Treat it as live.**

---

## 3. Active files

**Server (deploy tonight):**
- `apps/server/src/lib/mailer.ts` — IPv4 pin, `tls.servername`, boot readiness
- `apps/server/src/index.ts` — `void reportMailReadiness()` at boot

**Desktop (built into 0.5.28, or waiting for 0.5.29):**
- `apps/desktop/src/main/ipcHandlers.ts` — `manageFetch` 401 branch (**in 0.5.28**)
- `apps/desktop/src/main/syncEngine.ts` — `refreshStaffToken` exported (**0.5.28**);
  `refreshDeviceTokenIfExpiring` (**0.5.29**)
- `apps/desktop/src/main/idleMonitor.ts` — NEW, thresholds live here (**0.5.29**)
- `apps/desktop/src/renderer/components/LockCurtain.tsx` — NEW (**0.5.29**)
- `apps/desktop/src/main/preload.ts`, `renderer/App.tsx`, `renderer/lib/posApi.ts`
  — idle bridge and wiring (**0.5.29**)
- `shared/printing/src/render.ts`, `types.ts` — receipt closing block (**0.5.28**)

**Gates and tests:**
- `scripts/check-auth-retry.mjs` — NEW gate, in CI
- `scripts/table-usage-exceptions.json` — A49 corrected; header now warns its
  reasons are unchecked prose
- `tests/mailer-transport.test.mjs`, `apps/desktop/test/{manage-fetch-refresh,
  device-token-refresh,idle-lock}.test.mjs`, `shared/printing/test/receipt-footer.test.ts`
- `scripts/test-print-resilience.mjs` — §4b added (A43 step 1)

**Docs:**
- `docs/AUDIT-REGISTER.md` — reconciled against the tree
- `docs/RUNBOOK.md` — §0 field incidents; staleness warning
- `docs/LOCAL-SCHEMA-VERSIONS.md`, `docs/AUDIT-ID-INDEX.md` — NEW
- `docs/history/handoffs/HANDOFF-2026-08-03.md` — recovered

---

## 4. Changes made

### A47 — the banner was a missing branch, not a token problem

`manageFetch` (`ipcHandlers.ts:1288`) serves **35 manager-screen handlers** and
**had no 401 branch at all**. The staff access token lives 15 minutes; its
refresh token lives 30 days and was valid throughout. So the first manager action
after fifteen idle minutes returned 401 and `humaniseError` printed *"This till
was signed out."*

**`ownerFetch`, forty lines earlier in the same file, has always had that
branch.** §L: two builders that must agree, nothing comparing them.

Why it read as intermittent: on a **busy** till, pushes use the staff token, hit
401 first, refresh, and persist — so `manageFetch` got a fresh token for free.
Only an idle till exposes it. **Continuous use is the exact condition under which
the broken build also worked**, which is why the first field test did not
discriminate.

Gate built: `check-auth-retry.mjs`. Found `refreshTechConfig` on its first run —
exempted with a `VERIFY BY:` grep rather than fixed, since it is called once with
a token seconds old.

### A48 — the receipt regression came from a deletion

The closing block (default thank-you, `TAX RECEIPT UPON REQUEST`) lived **only**
in `ReceiptView.tsx`, and 0.5.27 removed the HTML sale path (D8). The thermal
renderer had never carried either behaviour. `wrapAuthored` was never at fault —
the lines were not reaching it.

Restored in `render.ts`, tax line gated on `vatRate > 0`. **Records a gap in D8's
sweep**: it correctly found what still *used* the HTML modules and kept them; it
did not ask what those modules *emitted that nothing else did*.

### A50 — mail, wrong twice, and the boot check is why we know

See §5. Net: `family: 4` is never read by nodemailer; the fix is an IPv4 literal
with `tls.servername`.

### A51 — the sawtooth

`syncAll` every 10 minutes against a 15-minute token, refresh purely reactive, so
**every second catalogue pull 401'd by construction**. That is the whole of
Beryl's 90-line log. ~72 refresh rotations/day, each a chance for a replay that
revokes every session — and a log in which a real auth failure was
indistinguishable from noise.

**Scoped to the DEVICE token deliberately.** A generic proactive refresh would
have refreshed the staff token and masked A47's field test. An assertion fails if
anyone widens it.

### A52 — the idle lock

OS idle via `powerMonitor.getSystemIdleTime()`, per the owner's requirement that
it *"work like screen lock"*. A cashier mid-sale has idle 0, so the timer cannot
fire — **"never lock mid-transaction" is true by construction**, not by a special
case. Manager 5 min, POS 10 min, both named constants.

**A curtain, not a reset**: renders over mounted state, never clears the cart or
the session. Unlock is the PIN pad, never the owner login (A17), and only the
locked staff member can dismiss it.

### Also closed

**A5** (docs two phases stale — both now state it) · **A6** (3-Aug handoff
recovered from `0f85155`) · **A9 triage** (shipped surface: none — all criticals
are devDependencies, the Electron CVE is macOS-only, `uuid` is v4-with-no-buffer)
· **A43 step 1** (picker protection ported to the live screen) · **D6** (local
schema documented; **48 and 50 never existed**).

### Opened

**A49** — `stock_adjustments` read by the stock report, written nowhere, hidden
by an exception reason that was false and had never been true.
**A53** — 20 audit IDs cited in code with no entry anywhere; unrecoverable.

---

## 5. Failed attempts — read this before re-deriving anything

### The mail fix was wrong, shipped, and failed in production

`family: 4` on the transport. Deployed. Ten seconds later:
`SMTP FALLBACK IS DEAD — connect ENETUNREACH 2607:f8b0:400e:c20::6c:587`.

**nodemailer never reads `family` during resolution.** `smtp-connection:264`
builds DNS options as `{port, host, allowInternalNetworkInterfaces, timeout}`. It
resolves with `dns.lookup(all:true)`, filters by `isFamilySupported()` — does the
machine **have** an IPv6 interface, not does it have a **route** — and
`formatDNSValue:83` picks **a random survivor**.

Three consequences worth keeping:
- The mixed `ENETUNREACH` / `Connection timeout` lines were **one fault**, not
  two — different random picks.
- `dns.setDefaultResultOrder('ipv4first')` would **not** have helped, because the
  pick is random rather than ordered.
- **The sandbox has no IPv6 interface**, so the defect was structurally
  impossible locally. Every check passed for a reason that had nothing to do with
  the fix being right.

### Two hypotheses about the mail failure, both wrong, both ruled out by the log

- *"Resend domain not verified."* `RESEND_API_KEY` was **absent** — the boot line
  only prints for missing variables, so `resend` was `null` and that branch never
  ran.
- *"Test businesses have unreal addresses."* `ENETUNREACH` precedes `RCPT TO`, so
  no address was ever sent. Beryl, a real client, failed identically.

### Deleting `PrintersTab.tsx` was wrong, and the gate caught it

The register pre-approved the deletion. `test-print-resilience` went red: its §4
pins a real field bug (`PrinterPicker` remount → dropdown snaps shut), and
`PrinterSetupScreen.tsx:270` has an unguarded `<select>` of its own. **Deleting
would have dropped the only guard on the live screen.** Reverted per rules 12 and
20. Step 1 of the sequence is now done.

### A10 was dismissed as a false positive. It is real.

I reported it closed. It is not: only **one of four** claimed supersessions
happened. `PrinterSettingsModal` is still imported at `POSPage.tsx:21` and
rendered at `:1351`. Reopened.

### Advice given that was wrong

- **"Recover the lost register items from `git show 415e044:…`"** — that commit
  is not in this history. The first committed register (`a80c224`) already had
  only A-section entries. They are unrecoverable; see A53.
- **`=== BUILD OK ===` printed off `tail`'s exit code**, not `tsc`'s. The build
  had failed. Exit codes are now read directly.

### Five tests passed their own first run against the defect they existed to catch

1. `check-auth-retry` read `.from('stock')` out of **the comment explaining the
   B6 fix**.
2. `manage-fetch-refresh` asserted against `ownerFetch`'s **empty default
   parameter** — its brace-balancer returned `"{}"` as the whole body.
3. `mailer-transport` passed **all 14** against a codebase with the fix removed:
   comment-blind, and one assertion satisfied by the phrase inside an **error
   message**.
4. `device-token-refresh` blanked string literals so aggressively it hid
   `'base64url'` from its own assertion — over-correcting lesson 3.
5. Same file: the `syncAll` slice ran to end-of-file, so **the helper's own
   definition** satisfied "syncAll calls it".

Every one was caught by the mutation check, never by the green run.

### And the limit of mutation checking, learned tonight

**It could not catch the `family: 4` mistake.** Removing an option that does
nothing leaves behaviour identical, so mutated and unmutated were equally broken.
Mutation testing proves an assertion *notices a change*; it cannot prove the
assertion measures the right thing. That is rule 24.

---

## 6. Next steps

### Immediate

1. **Deploy the server** — read the two `[mailer]` boot lines. Real proof is
   18:00 UTC.
2. **Build 0.5.29** with A51 + A52. **Read the artefact filename before tagging**
   (rule 15).
3. **Test the lock**: Manager, walk away 5 minutes, curtain appears, PIN back in,
   tab still there. Then POS **with items in the cart**, 10 minutes, PIN back in
   — **cart intact**. That second one is the property everything was designed
   around.
4. **Test the sawtooth**: leave the till an hour; `swiftpos.log` should stop
   filling with `401 → recovered`.

### Then, in order

5. **A43 step 2** — resolve §5's exclusions assertion, then delete
   `PrintersTab.tsx`. Note it orphans `StationsPanel.tsx` (294 lines), which
   PHASE6 §8c may want.
6. **A49** — repoint the stock report at `stock_movements`, or drop the table and
   the report section.
7. **A12** — Recipes drawer reads a column with no writer. Needs a decision:
   recipes are business-level, `ingredient_stock_levels` is per-branch.
8. **D13** — the last P0. Needs a `replaced_by` column (migration) and a window
   length. **60 seconds suggested**: long enough for a dropped response, short
   enough that a stolen token is unlikely to land inside it.

### Proposed, not started

- **A46** — split `settings.manage` (16 routes) and `products.manage` (30).
  Correctly sequenced behind the A45 comparator, or 46 gates drift while being
  changed.
- **Column-level read/write comparator** — A12 and A49 are both this shape;
  `check-table-usage` compares tables, not columns.
- **Exception-file verifier** — every reason in
  `table-usage-exceptions.json` is prose nothing checks. That is what hid A49.
- **IPC payload-shape comparator** — 126 channels, still the widest ungated seam.
- **`BRANCH-SERVER-PLAN.md`** — the single document blocking `check-doc-refs` and
  PHASE6. Writing it means making architecture decisions.

### Skipped deliberately

- **A11** — the claim is *"`ManagerPage.tsx:1061-65` comment contradicts
  itself"*. I read it and could not find one. Rewriting a comment on a guess
  would replace a finding I do not understand with prose that looks resolved.
  **You wrote it; you will know in ten seconds.**
- **`npm audit fix`** — server has real items (`body-parser`, `ip-address`), all
  fixed without majors. Not in the same change as a mail fix going to production.
- **Raising `PIN_CACHE_TTL_DAYS`** — widens the stolen-till window without giving
  the node the authority the design says it has.
- **Deleting `StationsPanel.tsx`** — a PHASE6 decision, not a tidy-up.

---

## 7. The pattern, restated

Every fault this session was **two things that must agree, with nothing
comparing them** — and every one had a check that could have caught it and did
not:

- A47: two fetch builders in **one file**, disagreeing about token expiry.
- A48: a deleted path's **output**, versus the sweep that only checked its
  callers.
- A49: a report and its writer, with the gate **silenced by an untrue exception**.
- A50: an option that is **stored but never read**, and a mutation check that
  could not tell.
- A51: a **10-minute** timer and a **15-minute** token.
- A12: a migration's deferred cleanup and the readers it left behind.

**The new one tonight is sharper.** It is no longer only "nothing compares them"
— five times, the thing doing the comparing **could not see what it was
checking**: comments, string literals, default parameters, a slice that ran past
its function. A check that reports green by not looking is worse than no check,
because it also stops you looking.

The boot check for mail is the counter-example worth remembering. It was added as
an afterthought to the real fix, and it is the only thing in this session that
caught a wrong fix **in production, in ten seconds**, on a defect that could not
occur anywhere it was tested.
