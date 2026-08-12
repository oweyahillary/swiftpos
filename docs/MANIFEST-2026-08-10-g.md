# MANIFEST — 2026-08-10-g

**Supersedes `-b` … `-f`. Cumulative — apply this one only** (rule 3).
**Base:** `84400d6` · no `version` field touched.

**This exists because the mail fix in `-d`/`-f` did not work.** Everything else
is carried unchanged.

---

## 1. A50 — reopened, re-diagnosed, re-fixed

### Your boot check caught it in four seconds

```
20:13:40  [mailer] RESEND_API_KEY not set — SMTP is the ONLY path…
20:13:50  [mailer] SMTP FALLBACK IS DEAD — smtp.gmail.com:587 —
                   connect ENETUNREACH 2607:f8b0:400e:c20::6c:587
```

Note that despite the log, **SMTP is not okay on Render** — the fallback is dead
and nothing has been delivered. The boot check is doing exactly the job it was
added for: turning a nightly silent failure into one line at startup.

### Why `family: 4` was never going to work

**nodemailer does not read it during resolution.** `smtp-connection/index.js:264`
builds its DNS options as `{ port, host, allowInternalNetworkInterfaces,
timeout }` — `family` is not among them. It then:

1. resolves via `dns.lookup(host, { all: true })`
2. filters with `isFamilySupported()` — which asks whether the machine **has** an
   IPv6 interface, **not** whether it has a working **route**
3. `formatDNSValue():83` picks **a random address from the survivors**

Render's container has an IPv6 interface and no usable route, so IPv6 counted as
supported and got picked about half the time.

**That also resolves something from the earlier analysis:** the mixed
`ENETUNREACH` and `Connection timeout` lines in one run were never two problems.
Same fault, different random picks — one failing instantly, one hitting
`connectionTimeout`.

And because the pick is **random rather than ordered**,
`dns.setDefaultResultOrder('ipv4first')` would not have fixed it either. The only
reliable lever is to hand nodemailer an address it cannot get wrong.

### The actual fix

Resolve A records ourselves and connect to the literal:

```ts
const [addr] = await dns.resolve4(SMTP_HOST);
host: ipv4 ?? SMTP_HOST,
tls:  { servername: SMTP_HOST },   // certificate still checked by NAME
```

`tls.servername` is load-bearing: without it TLS validates against
`74.125.126.108` and every send fails verification instead of routing — trading
one silent failure for another. Re-resolved on a 10-minute TTL because Google
rotates these, and a DNS blip keeps the last good address rather than falling
back to the hostname, since the hostname is the failure mode.

### Why the test didn't catch it — the part worth keeping

**It asserted nodemailer *stored* `options.family = 4`. It does store it. It
never reads it.** Storage is not effect.

**The mutation check was blind here.** Removing an option that does nothing
leaves behaviour identical, so mutated and unmutated were equally broken and the
gate saw no difference. Mutation testing proves an assertion *notices a change*;
it cannot prove the assertion is measuring the right thing.

**And this sandbox cannot reproduce the bug at all.** It has no non-internal IPv6
interface, so `isFamilySupported(6)` is false and IPv6 is filtered before the
random pick. Every local check passed because the defect is **structurally
impossible here**. That is rule 9 sharper than usual — not a weaker environment,
an environment where the failure cannot exist. The only thing that could have
caught it pre-deploy was the boot check, and it did.

Three mutation checks that now bite: revert to hostname · drop `tls.servername` ·
reintroduce `family`.

**Still unproven in production.** Deploy and read the boot log. Success is:

```
[mailer] SMTP fallback reachable: smtp.gmail.com:587 via 74.125.126.108 (IPv4 pinned).
```

---

## 2. A47 — your 30-minute test

The log is consistent with the fix working, and the sawtooth confirms the till
was genuinely reachable throughout: `19:19, 19:39, 19:59, 20:19` — the device
token cycling on schedule, so the machine was awake, online and syncing.

**One thing I cannot tell from the log**, and it matters: `manageFetch` failures
throw to the renderer and never reach `swiftpos.log`. So the absence of errors is
not evidence.

**The test passes only if, after returning, you actually used a manager screen —
pressed Refresh on Menu, or opened Staff/Prices — and no banner appeared.** If
you only observed the app still running, that shows it did not crash, which was
never in doubt. Worth thirty seconds tomorrow if you are not sure.

## 3. A51 confirmed in the wild, incidentally

`19:19:45 · 19:39:46 · 19:59:46 · 20:19:45` — twenty minutes apart to the
second, exactly as predicted, on a build that does not yet contain the fix. The
arithmetic in the test matches the field precisely.

---

## 4. What was run

Linux, Node 22 — **and for A50 specifically, an environment where the bug cannot
occur.** Stated plainly rather than buried.

```
gates                    PASS (check-doc-refs red: 1 doc, pre-existing)
server tsc               exit 0
typecheck ratchet        server 0 · dashboard 0
server suites            23 / 23  (mailer-transport now 16)
check-test-registration  32 files, all invoked
```

## 5. Deploy

Server only — nothing here touches the till, so your 0.5.28 testing is
undisturbed.

```bash
git add apps/server/src/lib/mailer.ts tests/mailer-transport.test.mjs docs/AUDIT-REGISTER.md
git commit -m "mail: pin SMTP to an IPv4 literal — family: 4 was never read (A50)

The first fix shipped family: 4 and production answered SMTP FALLBACK IS DEAD
with an IPv6 address. nodemailer does not read family during resolution: it
resolves with dns.lookup(all:true), filters by whether an IPv6 INTERFACE exists
rather than a working route, and picks a random survivor. Render has the
interface and no route.

Resolve A records ourselves and connect to the literal, with tls.servername so
the certificate is still validated against the hostname. 10-minute TTL; a DNS
blip keeps the last good address rather than falling back to the name.

The previous test asserted nodemailer STORED family: 4 — it does; it never reads
it. Storage is not effect, and the mutation check was blind because removing an
ineffective option changes nothing. This sandbox has no IPv6 interface so the
defect is structurally impossible here."

git push origin dev
```

Then read the boot log. If it still says DEAD, the message now reports which
address it pinned, which distinguishes "pin not applied" from "IPv4 also
blocked".

## 6. Still needs you

**A43 step 2** · **A49** · **A12** · **A11** · **D13 window length** ·
**A1 key rotation** · **`Mama Ari` `owner_id`** · and **`RESEND_API_KEY`**, which
would route around SMTP entirely — but only with `NOTIFY_FROM_EMAIL` on a
verified domain.
