# MANIFEST 2026-09-28-s — A352 email: Resend primary, SendGrid and SMTP as backups (cloud only)

**Base:** origin/dev `0199606` (desktop v0.6.17). The owner fast-forwards `dev` onto this delivery. **No version bump.**
**Deploy: the cloud only.** No migration, no dashboard, admin or desktop change.

Owner, 2026-09-28: "on emails i want to use sendgrid for emails" → **"what i need is resend is the primary, if it fails sendgrid
kicks in or smtp the two works as backup"**.

## Why
- **No email has ever been delivered** by the cloud: no daily summaries, low-stock alerts or test emails (register A50/A54).
- **The cause:** Resend was never set up, and Render blocks the SMTP fallback.
- **The fix:** SendGrid, added here as a backup, is reached over normal HTTPS (port 443), which Render doesn't block.

## What changed
1. **The order is Resend → SendGrid → SMTP.** Each is tried only when the one before it isn't set up or refuses the message.
   - Resend is the primary, and when it delivers nothing else is contacted.
   - If Resend refuses (e.g. domain not verified) or is down, SendGrid sends it.
   - If SendGrid also refuses, SMTP is tried if it's configured. It's blocked on Render, so in practice Resend and SendGrid are the
     two that work.
2. **Several recipients work on SendGrid.** The daily summary sends to several addresses at once. Each now goes to SendGrid as its
   own recipient; SendGrid refuses the joined "a, b" form that Resend accepts.
3. **When every provider refuses, it's a failure.**
   - The nightly jobs log it with each provider's reason, e.g.
     "Resend: domain not verified; SendGrid: HTTP 403 — sender not verified".
   - Before, a Resend refusal with nothing behind it was logged as "no provider configured".
   - "Send test email" shows the usual short message on screen and logs the full reasons on the cloud.
4. **The boot log says what's set up:**
   - "Resend configured (primary)" and "SendGrid configured (backup)".
   - A warning when there's no backup, or no primary.
   - A warning when the sender is a Gmail/Yahoo-type address, because those land in spam or get rejected (DMARC).
5. **Each API key only ever goes in its own request header.** Never in the message body, never in the logs (tested).

## Files
| Area | Files |
|---|---|
| Cloud | `apps/server/src/lib/mailer.ts` (order Resend → SendGrid → SMTP, `sendViaSendGrid`, `parseFrom`, `splitRecipients`), `lib/env.ts` (advisories), `.env.example` |
| Tests | NEW `tests/mailer-sendgrid.test.mjs` (13; picked up by CI's `tests/*.test.mjs` loop) |
| Docs | `docs/AUDIT-REGISTER.md` (A352; A54 note), this file |

## Verification (bench: Linux, Node 22)
```
tests/mailer-sendgrid.test.mjs → 13/13: the COMPILED mailer against fake api.resend.com and api.sendgrid.com.
  Covers:
  - Resend delivers → SendGrid never called;
  - Resend refuses → SendGrid delivers (order checked);
  - both refuse → a failure naming both, and a throw for the nightly jobs;
  - SendGrid alone;
  - the exact SendGrid request;
  - split recipients;
  - the key only in "Authorization: Bearer";
  - no network;
  - unset → nothing sent;
  - the boot lines.
  4 mutations bite.
tests/mailer-transport.test.mjs 34/34 unchanged.
Every tests/*.test.mjs, every static gate, the schema audit and the server build pass.
```
Not verified here (rule 16): real Resend and SendGrid accounts delivering to a real inbox.

## Setup (owner)
Use the **same sending address in both**, on your own domain (e.g. `noreply@swiftpos.co.ke`), not Gmail.
1. **Resend (primary)**
   - Domains → **Add Domain**, and add the DNS records it shows at your domain host.
   - API Keys → create one with **Sending access**.
2. **SendGrid (backup)**
   - Settings → Sender Authentication → **Authenticate Your Domain** (the same domain; more DNS records).
   - Settings → API Keys → Create → **Restricted Access, Mail Send only**.
3. **Render → the API service → Environment:**
   - `RESEND_API_KEY`
   - `SENDGRID_API_KEY`
   - `NOTIFY_FROM_EMAIL` = `SwiftPOS <noreply@yourdomain>`
   - Save.
4. **Deploy the cloud from `dev`.** The log should say:
   - "[mailer] Resend configured (primary)."
   - "[mailer] SendGrid configured (backup), sending as …"
5. **Dashboard, as the owner → Send test email.** It should say sent, provider resend.
6. **To prove the backup:** temporarily change `RESEND_API_KEY` on Render to a wrong value, redeploy, and press Send test email
   again. It should say sent, provider sendgrid. Put the right key back.
7. **Next evening:** the daily summary arrives, which closes A54.

## Rollback
```bash
git revert <this delivery's commits>   # or remove SENDGRID_API_KEY on Render: the mailer is then Resend → SMTP, as before
```
