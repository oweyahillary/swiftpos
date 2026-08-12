# MANIFEST — 2026-08-11-a

**Base:** `0215475` (`dev`) · First zip of this session, supersedes nothing (rule 3).
**No `version` field touched anywhere** (rule 22). **No desktop file touched**, so
no version bump is due (rule 15).
**No migration** — nothing to run in Supabase.

One item. **A54 — mail is still undelivered, and A50's recorded diagnosis was wrong.**

| File | Change |
|---|---|
| `apps/server/src/lib/mailer.ts` | Corrected the falsified "not two problems; one" comment. Added `classifySmtpFailure()`. Boot check now names the cause and probes the alternate port. `secure` follows the effective port. |
| `tests/mailer-transport.test.mjs` | Header corrected (it carried the same false claim). §5 and §6 added — 10 assertions, all mutation-checked. |
| `docs/AUDIT-REGISTER.md` | A54 entry. A1 marked closed per owner. Header P0 count corrected 0 → 1. Tree commit corrected. Changelog. |

---

## Rollback

```
git checkout 0215475 -- apps/server/src/lib/mailer.ts tests/mailer-transport.test.mjs docs/AUDIT-REGISTER.md
rm docs/MANIFEST-2026-08-11-a.md
```

Three files, all restorable individually. No schema, no data, no deletions.

---

## What was run, and what it printed (rule 7)

Environment: **Linux, Node 22.22.2.** The target is Windows/Node 20 — but nothing
in this batch touches the desktop, SQLite or Electron, so the platform gap does
not weaken these greens (rule 9). No desktop test was run and none was needed.

```
BEFORE (baseline, unmodified tree)
  server tsc                    OK (exit 0)
  mailer-transport.test.mjs     16 passed, 0 failed

AFTER
  server tsc                    OK (exit 0)
  npm run build                 OK — dist/lib/mailer.js emitted
  mailer-transport.test.mjs     26 passed, 0 failed

  check-ipc-parity        OK    check-own-rows          OK
  check-header-keys       OK    check-sql-binds         OK
  check-test-registration OK    check-row-attribution   OK
  check-table-usage       OK    check-rls-coverage      OK
  check-supabase-catch    OK    check-shared-sync       OK
  check-auth-retry        OK    check-client-parity     OK
  check-schema-drift      OK
  check-doc-refs          RED — PRE-EXISTING, unrelated (BRANCH-SERVER-PLAN.md,
                          SESSION-HANDOFF-2026-08-02.md). Red before this batch,
                          red after it. Not touched, not masked.
```

**The classifier was executed, not just asserted on.** Compiled `dist` loaded and
called with the real error shapes:

| Input | Output |
|---|---|
| `ESOCKET` / `Connection timeout` — **the actual production error** | SYN dropped, port 587 filtered; check the live instance type in the Render dashboard first; no code change reaches it |
| `ENETUNREACH … 2607:f8b0::…:587` — the original A50 error | The IPv4 pin is not being applied; a pinned A record cannot resolve to a v6 address |
| `ENETUNREACH … 74.125.195.108:587` | No route at all — check egress rules (correctly does *not* blame the pin) |
| `EAUTH 535-5.7.8` | Connect succeeded, auth rejected — Gmail needs a 16-char App Password |
| `ECONNREFUSED` | Reachable but not speaking SMTP there — check host/port |

## Mutation checks (rules 10 and 23)

Each defect reintroduced, the suite run, the file restored. **Every mutation was
verified as actually applied before its result was believed** — two of them were
not, first time round, and the results were discarded.

| # | Defect reintroduced | Result |
|---|---|---|
| M1 | Remove the `classifySmtpFailure` call from the boot check | RED — *"the boot check routes its hint through it"* |
| M2 | Collapse the timeout branch back into ENETUNREACH | RED — *"a connect TIMEOUT is a distinct branch"* |
| M3 | `secure: SMTP_PORT === 465` instead of the effective port | RED — *"secure follows the EFFECTIVE port"* |
| M4 | Make the send path pass a port override | RED — *"the SEND path never passes an override"* |
| M5 | Drop the App Password guidance | RED — *"an auth rejection is a CREDENTIAL fault"* |

**Two rule-23 failures of my own, both caught and fixed:**

1. **The assertion for M1 was defective.** `/classifySmtpFailure\(err/` also
   matched the function's own **declaration**, so it passed with the call site
   removed — `check-header-keys`'s defect exactly: it passed by not looking.
   Now matched on the interpolation `${classifySmtpFailure(`.
2. **M1 and M4's first mutations never applied** (a `perl` regex that did not
   match, and an unverified `sed`). Both printed a green that meant nothing.
   Re-run with the edit diffed and confirmed present first.

**A third correction, from the gate rather than the mutation check:** the
assertion *"the timeout branch sends the reader to the INSTANCE PLAN"* went red
on first run, because `CHECK THE LIVE INSTANCE TYPE` was split across a
template-literal line break and never appeared contiguously in source. Rule 20 —
the assertion complained, so **the code moved**, not the regex.

---

## What only you can verify (rule 16)

**None of this delivers an email.** It makes the next failure say what to do.
Three things are outside the code and block delivery:

1. **The live instance type, in the Render dashboard.** `render.yaml:8` says
   `plan: starter`; the service deploys from `dev` with no `branch` in the
   blueprint, so it is dashboard-managed and the file is not evidence. If it is
   **Free**, that is the entire cause — Render blocks 25/465/587 there. This is
   the first thing to check and it takes thirty seconds.
2. **`SMTP_PASS` must be a Gmail App Password** (16 chars), not the account
   password, once 2FA is on. This is the most likely *next* failure after a port
   opens, and the classifier now names it.
3. **`SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` are `sync: false`** — nothing in the
   repo can confirm they are set at all.

After deploying, the boot line tells you which world you are in:

```
[mailer] SMTP fallback reachable: smtp.gmail.com:587 via <ip> (IPv4 pinned).
    -> mail will flow.

[mailer] SMTP IS DEAD AND IS THE ONLY PATH — … — Connection timeout
         Connect timed out against a valid address … port 587 is filtered …
         CHECK THE LIVE INSTANCE TYPE IN THE RENDER DASHBOARD FIRST
[mailer] …but port 465 DOES answer on the same host. Set SMTP_PORT=465 …
    -> one-line fix, no deploy needed.

[mailer] …and port 465 fails too: …
    -> the host filters SMTP outright. Upgrade the instance, or use Resend.
```

---

## Deliberately NOT done (rule 12)

**Delivery-level reporting.** `reportMailReadiness` proves a socket opens at
boot. It does not prove a message landed, and `dailySummary.ts:61` still catches
per business, logs, and moves on. Nine businesses went undelivered across three
distinct root causes without the product saying so.

That is the real hole, and it is a third concern in a batch that already had two
— rule 12 says stop and ask rather than let it grow. It also needs a decision
(a `mail_deliveries` table? a per-run summary line? an owner-visible banner?),
which is yours. Recorded at the end of A54.

**The send path was not touched.** Provider order is unchanged: Resend when
`RESEND_API_KEY` is present, SMTP otherwise — which is already what you asked
for, so changing it would have been change for its own sake.
