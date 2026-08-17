# MANIFEST — 2026-08-10-d

**Supersedes `-b` and `-c`. Cumulative — apply this one only** (rule 3).
**Base commit:** `84400d6` (`dev`)

**Two independent deploy surfaces. They do not interact.**

| Surface | Files | Action |
|---|---|---|
| **SERVER** — new in `-d` | `apps/server/src/lib/mailer.ts`, `apps/server/src/index.ts` | Deploy to Render **now**. Does not touch the till. |
| **DESKTOP** — unchanged since `-c` | `apps/desktop/**`, `shared/printing/**` | **Already running as 0.5.28.** Nothing here changes it. |

**Desktop version: 0.5.27 in the tree — UNCHANGED by this zip.** No
`package.json` `version` field is touched anywhere (rule 22). Your 0.5.28 build
and its idle test are undisturbed.

**`apps/server/package.json` is not modified at all.**

---

## 1. The mail fix — A50

### What the log actually said

```
[dailySummary] Failed for Beryl: connect ENETUNREACH 2607:f8b0:400e:c02::6c:587
[dailySummary] Failed for MAZURI Petrol Station: Connection timeout
… nine businesses, every run, both observed days, zero delivered
```

`2607:f8b0::/32` is Google over IPv6, port 587 — your SMTP fallback, correctly
selected. Render's container has no usable route there, so nodemailer resolved
AAAA first and died in `connect()`: before TLS, before AUTH, before any recipient
was offered. The `Connection timeout` lines are the same fault on a different
IPv6 route, hitting `connectionTimeout` rather than failing instantly.

### Your two hypotheses, both checked and both ruled out

**"Resend domain not verified."** No — `RESEND_API_KEY` was **absent**. The boot
line *"Not set … will fall back to SMTP"* only prints for variables missing from
`env.ts`'s optional list (`env.ts:96`, `!process.env[k]`). So
`const resend = … ? new Resend(…) : null` was `null` and that branch never ran.
An unverified domain would have logged *"Resend error, falling back to SMTP: the
gmail.com domain is not verified"* — you built that warning and it never fired,
as did the free-mail check at `mailer.ts:44`. **Resend was not in the picture on
either day.**

**"Some are test businesses with unreal emails."** No — `ENETUNREACH` is a
NETWORK-layer failure on connect, so no address was ever sent. A bad recipient
gives an SMTP 550 after `RCPT TO`. **Beryl, your real client, failed identically**,
as did Mr Snacks, Lovers Rock and MAZURI. All nine failed the same way on both
days; a mix of real and fake recipients would have given a mix of outcomes.

**Your fallback logic was right. The socket never opened.**

### What changed

**`family: 4` on the transport.** `family` is honoured by nodemailer at runtime —
forwarded to `net.connect` — but is **absent from `@types/nodemailer` 8.0.x**, so
supplying it made TypeScript fall through to a different `createTransport`
overload and report the misleading *"'host' does not exist"*. Widened with a named
type rather than casting to `any`:

```ts
type SmtpOptions = SMTPTransport.Options & { family?: 4 | 6 };
```

Casting the literal to `any` would have silenced real mistakes in the same object.

**`reportMailReadiness()` at boot** — and this half matters as much as the fix.
`dailySummary.ts:61` catches per business, logs, and moves on, so the only trace
was a line at 18:00 UTC in a log nobody reads. It now runs `verify()` (connects
and authenticates, sends nothing) at startup and names a dead transport beside
the other things that are wrong. Never awaited, never throws — same rule as
`reportSeededAdmins`: a shop must not fail to trade over an unverified mail
domain.

It also names the case production was actually in: **`RESEND_API_KEY` unset means
SMTP is the ONLY path**, so an SMTP failure is total, not a degraded fallback.

### What you will see at next boot

```
[mailer] RESEND_API_KEY not set — SMTP is the ONLY path, so a failure here means
         no email is delivered at all.
[mailer] SMTP fallback reachable: smtp.gmail.com:587 (IPv4).
```

If the second line instead reads `SMTP FALLBACK IS DEAD`, the message carries the
reason and tells you whether `family: 4` failed to take effect.

### Still outstanding, and NOT code

- **`Mama Ari Restaurant` has `owner_id = null`** and is skipped before any send
  is attempted. A data problem in the business row — both days, silent. The
  transport fix does nothing for it.
- **Setting `RESEND_API_KEY` is still worth doing.** If you do, `NOTIFY_FROM_EMAIL`
  must be on a domain verified at resend.com/domains — a `@gmail.com` value fails
  every send and demotes you straight back to SMTP. Your own boot warning will
  say so.

---

## 2. A51 — the sawtooth, found and deliberately NOT fixed

Beryl's till log is 90 lines and every one is `401 → recovered`, exactly 20
minutes apart. Deterministic, not intermittent:

- `syncAll()` runs every **10 minutes** (`index.ts:226`)
- the access token lives **15 minutes** (`auth.ts:51`)
- **refresh is purely reactive** — nothing decodes `exp`

After a refresh at T, the pull at T+10 succeeds and the pull at T+20 **cannot**:
20 > 15. Every other pull 401s by construction.

**Which token matters here.** The catalogue pull uses `authHeaders()` →
`_accessToken`, the DEVICE token. `pushAuthHeaders()` prefers `_staffToken`. So
this sawtooth keeps the device token alive and never touches the staff token —
**which is exactly why A47 could hide on a busy till.** Selling triggers pushes,
pushes refresh the staff token on 401, and `manageFetch` read the fresh one from
the store for free. On an idle till nothing pushes, the staff token dies alone,
and the first manager action eats the 401. That is Beryl's report precisely.

Three costs; the third is the one I would act on:

1. Every other catalogue pull is 3-5s slower than needed.
2. **~72 refresh rotations per day per till** — each a chance for two refreshes to
   race, and `validateRefreshToken` answers a reused token by revoking **every**
   session for that user.
3. **The till log is no longer usable as a diagnostic.** A revoked till, a rotated
   service key or a real expiry would look identical to routine noise.

**Held out of this zip on purpose.** It lives in `syncEngine.ts`, the file A47
touched, and A47's idle test is running right now. Worse: a *generic* proactive
refresh would refresh the staff token too, masking the A47 test exactly as the
auto-lock would. **The fix must be scoped to the device token**, and that is a
deliberate 15-minute job, not a quick one. Queued for 0.5.29 with the auto-lock.

---

## 3. What was run

Environment: **Linux, Node 22** — weaker than production (rule 9).

```
14 gates                       13 PASS, check-doc-refs FAIL (pre-existing, 1 doc)
server tsc                     exit 0
typecheck ratchet              server 0 · dashboard 0, baseline held
migration tests (PGlite)       7 files, 110 assertions
server offline suites          23 / 23   (was 22 — mailer-transport is new)
desktop-scope suites           10 / 10
desktop suites                 4 / 4
shared/printing                11 / 11
check-test-registration        30 files, all invoked
```

### Mutation checks — and this one caught me out

| Mutation | Result |
|---|---|
| Comment out `family: 4,` | 1 red |
| Comment out `void reportMailReadiness();` | 2 red |
| `family: 4` → `family: 6` (wrong direction) | 1 red |

**The test passed all 14 assertions against a codebase with the fix removed,
before I fixed the test.** Two faults in it:

1. **It was comment-blind.** Commenting out `family: 4,` and
   `void reportMailReadiness();` left both matching their regexes.
2. **Worse: one assertion was satisfied by an error message.** `/family:\s*4/`
   matched the phrase inside `reportMailReadiness`'s own failure text at
   `mailer.ts:152`. An assertion a log string can satisfy is worse than none —
   it was retargeted to pin the `SmtpOptions` type widening instead, which is its
   own real fact.

**Third occurrence this session.** `check-auth-retry` read `.from('stock')` out of
the comment explaining the B6 fix; `manage-fetch-refresh` asserted against
`ownerFetch`'s empty default parameter. Comments and string literals are code to
a regex. Rule 23 keeps being right, and each time it was the mutation check that
caught it rather than the green run.

I also caught myself printing `=== BUILD OK ===` off a `tail` exit code rather
than `tsc`'s. The build had failed. Exit codes are now read directly.

---

## 4. Rollback

Server only — deploy and revert independently of the till:

```bash
git checkout 84400d6 -- apps/server/src/lib/mailer.ts apps/server/src/index.ts
rm tests/mailer-transport.test.mjs
```

Everything:

```bash
git checkout 84400d6 -- apps apps/server shared scripts docs .github/workflows/ci.yml
rm apps/desktop/test/manage-fetch-refresh.test.mjs \
   shared/printing/test/receipt-footer.test.ts \
   scripts/check-auth-retry.mjs \
   tests/mailer-transport.test.mjs
```

**Reverting the mail fix cannot affect the till.** Nothing in `apps/server`
touched by this zip is on the sell path.

---

## 5. Carried from `-c` (unchanged)

A47 `manageFetch` 401 refresh · A48 receipt closing block · `check-auth-retry`
gate · A49 false table-usage exception corrected · register reconciled against
the tree (A1 split, A7 re-characterised, A9 closed, A10 reopened, A12 → P1, A39
down to one document) · RUNBOOK field-incident section · **A43 deletion attempted
and reverted** — `test-print-resilience` proved it drops the only guard on a live
field bug.

---

## 6. Order of operations

1. **Deploy the server now.** Independent of everything else.
2. **Read the boot log** for the two `[mailer]` lines above. That is the
   verification — the next real proof is 18:00 UTC.
3. **Let the 0.5.28 idle test finish.** Sign in, sell nothing, 15+ minutes, then
   Refresh on Menu.
4. **Then 0.5.29**: A51 device-token scope + the auto-lock, once A47 is confirmed.

## 7. Still needs a decision from you

1. **Auto-lock** — PIN pad not owner sign-in (A17 through a new door); and
   block-mid-sale vs hold-the-cart. 5 min on manager screens, POS left alone.
2. **A43** — approve the three-step sequence before anything is deleted.
3. **A49 `stock_adjustments`** — repoint the report at `stock_movements`, or drop
   the table and the section.
4. **A12** — which branch's stock should the Recipes drawer show?
5. **A1 rotation** — was `SUPABASE_SERVICE_ROLE_KEY` rotated after 08-08? Nothing
   in the repo records it. **Treat as live until confirmed.**
6. **`Mama Ari` `owner_id`** — a data fix only you can make.
