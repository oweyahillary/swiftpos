# MANIFEST 2026-09-28-s — A352 email through SendGrid (cloud only)

**Base:** origin/dev `0199606` (desktop v0.6.17). The owner fast-forwards `dev` onto this commit. **No version bump.**
**Deploy: the cloud only.** No migration, no dashboard, admin or desktop change.

Owner, 2026-09-28: "on emails i want to use sendgrid for emails".

## Why
- **No email has ever been delivered** by the cloud: no daily summaries, low-stock alerts or test emails (register A50/A54).
- **The cause:** Render blocks outgoing SMTP, the Gmail fallback, and Resend was never set up.
- **The fix:** SendGrid is reached over normal HTTPS (port 443), which Render doesn't block.

## What changed
1. **SendGrid is tried first** when `SENDGRID_API_KEY` is set. Resend, then SMTP, are still tried after it if configured.
2. **Several recipients work.** The daily summary sends to several addresses at once, and each now goes to SendGrid as its own
   recipient. SendGrid would have refused the joined "a, b" form that the others accepted.
3. **A refused email counts as failed.**
   - The nightly jobs log it per business with SendGrid's own reason, e.g. "does not match a verified Sender Identity".
   - "Send test email" shows the usual short message on screen and logs the full reason on the cloud.
4. **The boot log says so:**
   - "SendGrid configured (primary), sending as …" when it's set up.
   - A warning if the sender is a Gmail/Yahoo-type address, because those land in spam or get rejected (DMARC).
5. **The API key only ever goes in the request header.** It's never in the message body and never in the logs (tested).

## Files
| Area | Files |
|---|---|
| Cloud | `apps/server/src/lib/mailer.ts` (SendGrid path, `parseFrom`, `splitRecipients`, `sendViaSendGrid`), `lib/env.ts` (advisory), `.env.example` |
| Tests | NEW `tests/mailer-sendgrid.test.mjs` (11; picked up by CI's `tests/*.test.mjs` loop) |
| Docs | `docs/AUDIT-REGISTER.md` (A352; A54 note), this file |

## Verification (bench: Linux, Node 22)
```
tests/mailer-sendgrid.test.mjs → 11/11: the COMPILED mailer against a fake api.sendgrid.com.
  Covers:
  - the exact request;
  - split and de-duplicated recipients;
  - "Name <addr>" parsing;
  - the key only in "Authorization: Bearer", never in the body or logs;
  - a refusal reported in SendGrid's words;
  - a refusal throws for the jobs;
  - no network;
  - Resend fallback;
  - unset → nothing sent;
  - free-mail warning.
  4 mutations bite.
tests/mailer-transport.test.mjs 34/34 unchanged.
Every tests/*.test.mjs, every static gate, the schema audit and the server build pass.
```
Not verified here (rule 16): a real SendGrid account delivering to a real inbox.

## Setup (owner)
1. **SendGrid → Settings → Sender Authentication.**
   - Best: **Authenticate Your Domain**. Add the DNS records it gives you at your domain host, e.g. for `swiftpos.co.ke`.
   - Quick start: **Verify a Single Sender**, e.g. `noreply@yourdomain`, and click the link in the email it sends. Use your own
     domain, not Gmail.
2. **SendGrid → Settings → API Keys → Create API Key.**
   - Choose **Restricted Access** and set **Mail Send: Full Access**. Nothing else.
   - Copy the key. It's shown once.
3. **Render → the API service → Environment:**
   - `SENDGRID_API_KEY` = the key.
   - `NOTIFY_FROM_EMAIL` = `SwiftPOS <the verified address>`.
   - Save.
4. **Deploy the cloud from `dev`.** The log should say "[mailer] SendGrid configured (primary), sending as …".
5. **Dashboard, as the owner → Send test email.**
   - It should say sent (provider sendgrid), and the email arrives.
   - If it fails, the Render log has SendGrid's exact reason.
6. **Next evening:** the daily summary arrives, which closes A54.

## Rollback
```bash
git revert <this commit>   # or just remove SENDGRID_API_KEY on Render: the mailer falls back to Resend / SMTP as before
```
