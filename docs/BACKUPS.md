# Backups and the down check

ZapTill backs up every client's data once a week, at midnight going into Sunday (00:00 Nairobi), encrypted, into a storage bucket that belongs to you — not to GitHub, and not only to Supabase. This guide covers what is backed up, where it goes, how to set it up once, how to restore a backup, how to test a restore every month, and the outside check that tells you when the server is down. (A589, 2026-10-25.)

> Owner, 2026-10-25: "how can I be doing backups to protect my client data each night at 12am".

## What is backed up, when, and where

| | |
|---|---|
| **What** | The whole cloud database: every client's products, sales, payments, stock, staff, settings (the `public` schema), the owners' sign-in accounts (`auth`) and the file list of Supabase Storage (`storage`). |
| **When** | Weekly: Sunday 00:00 Nairobi (Saturday 21:00 UTC), once you switch the schedule on — GitHub › Settings › Secrets and variables › Actions › **Variables** › `BACKUP_SCHEDULE_ENABLED` = `true`. Until then it runs only by hand: GitHub › Actions › Nightly backup › Run workflow. **Why weekly (A591, 2026-10-26):** every full backup reads the whole database out of Supabase, which counts as egress — the Free plan allows 5 GB a month in all, so a nightly full copy would use it up. Before switching the schedule on, check the database size (Supabase SQL: `select pg_size_pretty(pg_database_size(current_database()));`) — four of those a month must fit the egress budget. On Supabase Pro its own daily backups cover the days between. |
| **How** | `pg_dump` in PostgreSQL's own compressed format, checked with `pg_restore --list`, then **encrypted** (AES-256, with your passphrase) before it leaves the GitHub machine. The encrypted copy is decrypted once more and compared, so the file that is stored is known to restore. |
| **Where** | Your Cloudflare R2 bucket: `daily/2026-10-26/zaptill-2026-10-26T0003EAT.dump.gpg` (plus a small `.json` with its checksum), and on the 1st of each month also under `monthly/2026-11/`. The last result is in `status/latest.json`, the history in `status/history.jsonl`. |
| **How long** | The newest **30 daily** and **12 monthly** copies. Older ones are deleted after each good backup — never after a failed one. |
| **Never** | A GitHub artifact. The repository is public; an artifact can be downloaded by anyone who can see the run. |

**Not in the database backup:**

- Product photos are stored on Cloudinary (the dashboard uploads them there), not in Supabase. Cloudinary keeps them; the database keeps their links.
- The receipt and branding logos are inside the database (as images in the settings), so they are in the backup.
- The onboarding logo is a file in the Supabase Storage bucket `business-assets` — the only Storage bucket ZapTill uses. Its file *list* is in the backup; the files themselves only if you turn the bucket backup on (set the variable `BACKUP_STORAGE_BUCKETS` to `business-assets` and add the secrets `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`). It is small and owners can upload their logo again, so it is optional.

**What Supabase keeps on its own.** On the Free plan Supabase keeps no backups you can download or restore. On the Pro plan it keeps daily backups for 7 days, and Point-in-Time Recovery is a paid add-on — but those copies live in the same Supabase account as the database. This nightly backup is yours, in a separate account, and does not depend on the Supabase plan.

**Cost.** Cloudflare R2 includes 10 GB of storage free each month and charges nothing to download. 30 daily + 12 monthly copies of today's database fit well inside that. GitHub Actions minutes are free for a public repository.

## Setting it up (once)

Do these in order. Each secret goes in GitHub: the repository › Settings › Secrets and variables › Actions (or, better for the database ones, Settings › Environments › **backup** › Environment secrets — the workflow runs in an environment called `backup`).

### 1. The Cloudflare R2 bucket

1. Cloudflare dashboard › R2 Object Storage › **Create bucket**. Name it, for example, `zaptill-backups`. Location: Automatic. Leave public access **off**.
2. R2 › **Manage API tokens** › Create API token. Permissions: **Object Read & Write**, applied to the `zaptill-backups` bucket only. TTL: forever.
3. Copy the **Access Key ID**, the **Secret Access Key** and your **Account ID** (shown on the R2 overview page). The secret key is shown once.
4. In GitHub add: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (= `zaptill-backups`).

### 2. A read-only database role for the backup

The backup should not use the database owner's password (the one `db-migrate-prod.yml` uses). It gets its own role that can **read everything and change nothing**. In Supabase › SQL Editor, run (with a long random password of your own):

```
CREATE ROLE zaptill_backup WITH LOGIN PASSWORD 'a-long-random-password' BYPASSRLS;
GRANT pg_read_all_data TO zaptill_backup;
ALTER ROLE zaptill_backup SET default_transaction_read_only = on;
```

- `pg_read_all_data` lets it read every table; it has no right to insert, change or delete anything (checked: even with read-only switched off, a delete is refused with "permission denied").
- `BYPASSRLS` is needed because the tables have row-level security: without it the dump would be refused ("query would be affected by row-level security policy").
- If Supabase refuses `BYPASSRLS` for a new role, use the `postgres` role's connection string for `BACKUP_DATABASE_URL` instead, in the `backup` environment only.

### 3. The connection string

Supabase › **Connect** › Session pooler (port **5432** — not the transaction pooler on 6543, which `pg_dump` cannot use). Change the user to the backup role. It looks like:

`postgresql://zaptill_backup.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require`

Add it in GitHub as `BACKUP_DATABASE_URL`.

### 4. The passphrase

Make a long passphrase (at least 20 characters — 6 random words is good). Add it in GitHub as `BACKUP_PASSPHRASE`, **and keep a copy in your password manager**. GitHub never shows a secret again: without your own copy, no backup can ever be opened.

### 5. The alert and the admin portal line

These are the same values the server already uses on Render, so the admin is told when a backup fails and the admin portal shows the last one:

- `OPS_INGEST_TOKEN` — the same value as on Render. With it the admin portal › System shows "Last nightly backup: 26 Oct 00:03, 48.2 MB, OK".
- `ADMIN_ALERT_EMAIL`, `RESEND_API_KEY` (or `SENDGRID_API_KEY`), optionally `ALERT_FROM_EMAIL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — used when the server cannot pass the alert on (it is down).

### 6. The PostgreSQL version

Supabase › Project Settings › Infrastructure shows the Postgres version (15 or 17). The backup installs the version-17 client, which reads both. Only if Supabase moves you to a newer version, add the variable `BACKUP_PG_MAJOR` with that number — the backup says so in its error if it is needed.

### 7. Run it once

GitHub › Actions › **Nightly backup** › Run workflow. When it is green: the R2 bucket has `daily/<today>/…dump.gpg`, and the admin portal › System shows the backup. Then restore it once (section 4) so you know it works.

## When something goes wrong

- **A backup fails:** the admin is emailed at once ("🔴 Backup failed · Mon 26 Oct" — the step that failed in plain words, the last good backup, and buttons to the GitHub run and this guide; Telegram too), it shows red on the admin portal › System and on the bell, and the GitHub run is red. The older backups are untouched — the clean-up only runs after a good backup.
- **No backup for 8 days** (it failed, or did not run at all — weekly, A591): the server's watchdog emails "Backup: no good backup for …". GitHub switches a schedule off after 60 days without a commit to the repository; the Actions tab then says so — enable the workflow again there.
- **The passphrase is lost:** the existing backups cannot be opened by anyone, including you. Set a new `BACKUP_PASSPHRASE`; the next backups use it.

Which alerts are emailed at once is set on the admin portal › Alerts › Email settings (a super admin). The backup is "at once" by default.

## Restoring a backup

The restore script is `scripts/restore-backup.sh`. It downloads the backup from R2, checks it against its checksum, decrypts it, shows what it holds, asks you to type RESTORE, and restores it. It **refuses a target that looks like production** unless you add `--i-know`.

You need, on the machine you restore from: Git Bash or a Linux/macOS shell, the PostgreSQL client tools (`pg_restore`, `psql` — version 17 or newer), `gpg`, `jq`, and for a download from R2 the `aws` command line. Set the R2 values and the passphrase in the shell first (the passphrase is asked for if you leave it out):

```
export R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_BUCKET=zaptill-backups
export PRODUCTION_DB_MATCH=<your production project ref>
bash scripts/restore-backup.sh --latest --list-only
bash scripts/restore-backup.sh --latest --target "postgresql://postgres:…@localhost:5432/restore_test" --prepare-plain
bash scripts/restore-backup.sh --object daily/2026-10-26/zaptill-2026-10-26T0003EAT.dump.gpg --target "…"
```

- `--list-only` decrypts and lists the tables; it restores nothing.
- `--prepare-plain` is for a plain PostgreSQL (your laptop, Docker): it first creates what every Supabase database has (the `anon`, `authenticated` and `service_role` roles, the `extensions` and `auth` schemas) and restores the `public` schema — all the client data.
- `--schema public` restores one schema only; `--keep-going` reports errors and carries on (useful into a Supabase project, where Supabase's own objects already exist).
- `PRODUCTION_DB_MATCH` tells the script which database is production (your project ref), so a scratch Supabase project is allowed. Without it, every Supabase address is treated as production.

**Restoring over production** (a real disaster) replaces the live data with the backup's: every sale made after the backup is lost from the cloud (the points of sale still hold their own sales and send them again as they sync). Stop and think first; if you go ahead, the script needs `--i-know` and asks you to type the database's host name.

## Testing a restore every month

A backup you have never restored is a hope, not a backup. On the first Monday of each month:

1. Start a throwaway PostgreSQL 17. With Docker: `docker run --name zaptill-restore-test -e POSTGRES_PASSWORD=test -p 55432:5432 -d postgres:17` — or create a free scratch project in Supabase.
2. Restore the newest backup into it: `bash scripts/restore-backup.sh --latest --target "postgresql://postgres:test@localhost:55432/postgres" --prepare-plain`.
3. Check: the script prints the number of businesses; it should match the admin portal's client count. Open a table or two (`psql … -c "select count(*) from orders"`).
4. Throw it away: `docker rm -f zaptill-restore-test` (only the container you started).
5. Write the date and the result in your notes.

> Tested on 2026-10-25 (A589): the full schema (every migration to 174) with sample data, backed up with the read-only role, encrypted, put in a local folder in place of R2, decrypted and restored into an empty PostgreSQL — the same row count in all 135 tables, the same 116 security policies. A wrong passphrase was refused; a Supabase address was refused as production.

## The down check

A server that is down cannot send its own alert. GitHub checks production from the outside every 10 minutes (`.github/workflows/uptime-check.yml`):

- it asks `https://api.zaptill.co.ke/health` (must answer 200) and `https://app.zaptill.co.ke` (the web dashboard);
- only **two failed checks in a row, a minute apart**, count as down — a slow start or one lost request is not an outage;
- when it goes down: one email and Telegram ("🔴 Production down — Mon 26 Oct 13:07 EAT", what is not answering, a button to the run), and a GitHub issue "Production down" is opened. While the issue is open you are not told again;
- when it is back: the issue is closed, one email and Telegram ("production is back — down about 25 min"), and the outage is recorded on the admin portal › System.

It uses the same secrets as the backup's alert (`ADMIN_ALERT_EMAIL`, `RESEND_API_KEY` or `SENDGRID_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `OPS_INGEST_TOKEN`) and, optionally, the variables `PROD_URL` and `APP_URL`.

Inside the server the watchdog still emails at once when the server is overloaded (slow answers, a busy server, a slow database), when the database cannot be reached, on a burst of server errors and on many failed sign-ins.

## The secrets, all in one list

| Secret or variable | Used by | What it is |
|---|---|---|
| `BACKUP_DATABASE_URL` | backup | the read-only role's session-pooler connection string |
| `BACKUP_PASSPHRASE` | backup, restore | the encryption passphrase — keep your own copy |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | backup, restore | the Cloudflare R2 bucket and its token |
| `OPS_INGEST_TOKEN` | backup, down check | the same value as on Render — results on the admin portal |
| `ADMIN_ALERT_EMAIL` | backup, down check | who is emailed |
| `RESEND_API_KEY` or `SENDGRID_API_KEY` | backup, down check | the mail provider (the server's own) |
| `ALERT_FROM_EMAIL` (optional) | backup, down check | the sender, default `ZapTill <noreply@zaptill.co.ke>` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (optional) | backup, down check | Telegram |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (optional) | backup | only for the Storage bucket backup |
| variable `BACKUP_STORAGE_BUCKETS` (optional) | backup | `business-assets` to back up the onboarding logos |
| variable `BACKUP_PG_MAJOR` (optional) | backup | only if Supabase runs a PostgreSQL newer than 17 |
| variables `PROD_URL`, `APP_URL` (optional) | down check | default `https://api.zaptill.co.ke`, `https://app.zaptill.co.ke` |
