# Moving ZapTill to our own server — overview for the owner

2026-10-26 · plan only, nothing has been changed yet · the details are in `docs/VPS-MIGRATION-PLAN.md` and `docs/OWN-AUTH-PLAN.md`

You asked to leave Supabase's limits behind, host everything on one server costing KES 2,500 a month or less, and build ZapTill's own sign-in at the same time. This is the plan in plain words.

## What changes

- **One rented server** runs the cloud API, the database, the web dashboard (with the web POS) and the admin portal. Recommended: **Hetzner CX33** in Germany — 4 processors, 8 GB memory, 80 GB fast disk, 20 TB of traffic — about **KES 1,620 a month** with Hetzner's daily server backups (about KES 1,880 if 16% VAT is added). If it is sold out that day: Hetzner CAX21 (about KES 1,980), or Contabo Cloud VPS 6 (about KES 1,125).
- **No more traffic limits between the API and the database.** Today most of the "egress" Supabase counts is our own server asking its own database for data across the internet. On one server that conversation is local and free.
- **ZapTill's own sign-in.** Owners' and partners' email and password move out of Supabase into ZapTill's own database. ZapTill already makes its own sign-in tokens, second-step codes and reset codes; only the password store and about 35 places in the code that call Supabase change.
- **Backups every night** (not weekly), encrypted with your passphrase, into your Cloudflare R2 bucket — free, because the copy no longer leaves Supabase. Plus Hetzner's daily server backups.
- **Supabase, Render and Vercel** are kept untouched for 30 days after the move, then cancelled.

## What stays the same

- **Every address:** `api.zaptill.co.ke`, `app.zaptill.co.ke`, `admin.zaptill.co.ke` and every client's own address. The website stays on Cloudflare Pages.
- **Everyone's password.** Passwords are carried over as they are stored today (scrambled, never readable), so nobody has to reset. Most people will not even be signed out.
- **The tills.** No update is needed. They keep selling offline during the short switch-over and send their sales afterwards.
- **M-Pesa.** The callback address does not change, so nothing is re-registered with Safaricom.
- **Product photos** stay on Cloudinary; the shared-components work carries on, and is tested on the new server first.

## Costs

| | Per month |
|---|---|
| Today (Render + Vercel + Supabase Free) | about KES 900–1,800 — but Supabase restricts us from 20 November, and Render suspended production once in October |
| Staying where we are with paid plans (Supabase Pro, Render bandwidth, Vercel Pro for a commercial product) | about KES 6,700–12,100 |
| **On our own server** (Hetzner CX33 + backups; Cloudflare and R2 free) | **about KES 1,620–1,880** |

The price of the saving is looking after the server: automatic security updates, alerts by email and Telegram when something is wrong, and **15 minutes every Monday** with a short checklist (the backup is fresh, the disk is not full, no alerts left unanswered). A technician you trust can do it.

## Timeline

Supabase threatens to restrict the free project from **20 November**, 25 days from today, so the plan moves production on the night of **Sunday 15 → Monday 16 November, at 02:00**.

| When | What |
|---|---|
| This week (26 Oct – 1 Nov) | You order the server and make the Cloudflare key. We secure the server and set it up. |
| 2 – 8 Nov | The dev environment runs on the new server (with the shared-components branch); ZapTill's own sign-in is built and tested there; the test till T1 points at it. |
| 9 – 15 Nov | A week of using dev on the new server; a full rehearsal with a copy of production; go or no-go on Friday 13 Nov; the switch on Sunday night (about 30 minutes in which tills sell offline and the web POS waits). |
| 16 – 22 Nov | Three days of close watching; the old setup stays ready to switch back. |
| December | Render, Vercel and Supabase cancelled after 30 quiet days. |

**If something is late:** we can move on the same night with a small copy of Supabase's sign-in service on our server (no code change), and switch to ZapTill's own sign-in a week later. If the whole move slips, one month of Supabase Pro (USD 25) buys time without rushing.

## What you need to buy or do

1. **Order the server:** a Hetzner Cloud account (hetzner.com/cloud; Hetzner may ask for ID), project "ZapTill", server **CX33**, Ubuntu 24.04, location Nuremberg or Falkenstein, **Backups switched on**, IPv4 and IPv6 on. Add the SSH public keys we give you (no password login). Send us the server's IP address.
2. **Cloudflare API token** for the certificates: Cloudflare › My Profile › API Tokens › Create token › "Edit zone DNS", zone `zaptill.co.ke` only. It goes into the server's private settings file, never into email or chat.
3. **DNS records** (we prepare them; you or we switch them on the night): `dev-api`, `app.dev`, `admin.dev`, `*.dev` now; `api`, `app`, `admin` and `*` on the night. All "DNS only" (grey cloud).
4. **Run three short commands in Supabase** when we ask (we never connect to it ourselves): the database size, the password format check, and the exports for the rehearsal and the night itself.
5. **Keep in your password manager:** the server's settings file, the backup passphrase, the Hetzner and Cloudflare logins.
6. **Tell clients who trade at night** about the 30-minute window on 15/16 November.

## Decisions we need from you

1. **Server:** Hetzner CX33 (recommended), Hetzner CAX21, or Contabo VPS 6.
2. **Switch-over night:** Sunday 15 → Monday 16 November (recommended); and whether the "small copy of Supabase sign-in" fallback is acceptable that night if ZapTill's own sign-in is not ready.
3. **Dashboards** on the new server (recommended, one place to look after) or on Cloudflare Pages (free, stays up if the server is down).
4. **Password rule for new passwords:** at least 10 characters (recommended) or 12. Existing passwords keep working.
5. **Backups:** nightly at midnight (recommended); and whether to add near-continuous backup (at most 5 minutes of data lost instead of up to a day) in December.
6. **Who looks after the server** each week, and who else may log in to it.
7. **Supabase Pro for one month** as the safety net if the move slips past 20 November.
