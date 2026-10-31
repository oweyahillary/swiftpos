# Moving a Supabase project to its own organisation (dev first, prod by 15 Nov)

**Why (owner, 2026-10-31):** both projects share one Free organisation, and with it one 1 GB a month of log ingestion.
The organisation went over in the cycle 22 Sep – 22 Oct, and Supabase restricts it from **20 Nov 2026** if it stays
over. In separate organisations, each project gets its own quota. Dev moves first as the rehearsal; prod follows by **15 Nov**.

**Prod's own budget:** under about **33 MB of logs a day**, which is 1 GB over 30 days. On 27–30 Oct both projects
together ran at about 42 MB a day.

---

## Before you start (both projects)
- [ ] Check the project's own daily logs: Organization › Usage, with only that project selected.
- [ ] A quiet time. For prod, after closing time: the POS keep selling offline if anything blips.
- [ ] Have these open: Render (the service for this project), Vercel (the dashboard and admin projects for this
      environment), GitHub › Settings › Secrets.

## Route A — Supabase's own transfer (try this first)

The project moves as it is: **same URL, same keys, same data**. Nothing in the apps changes and nobody is signed out.

1. Supabase › your account › **New organisation**, Free plan. Name it e.g. `ZapTill Dev` (later `ZapTill Prod`).
2. Open the project (**swiftpos development**) › **Project Settings › General** › **Transfer project**, choose the new
   organisation.
3. Wait for it to finish (minutes). The project page now shows the new organisation.
4. Check (section C).

**If Supabase refuses** (for example because the old organisation is over its quota or in a grace period): note its exact
message, then choose:
- **Pro for a month or two** on the old organisation (about USD 25 a month): no migration. Then try the transfer again
  once it is back under quota.
- **Route B** below.

## Route B — a new project, copied (only if A is refused)

The new project has a **new URL and new keys**, so every place below changes.

### B1. Make the new project
1. New organisation (Free) › **New project**, region **eu-central-1** (as today).
2. Note its URL, anon key, service role key and JWT secret (Project Settings › API). Keep them in your password manager,
   never in chat or a file in the repo.

### B2. Fill it
- **Dev, as a full copy (owner's choice, 2026-10-31: new Supabase account, organisation "zaptill dev").** In Git Bash, on
  this PC. Use PostgreSQL **18**'s tools: version 15 cannot dump a newer server.
  1. **Connection strings.** For each project, open **Project Settings › Database › Connection string › Session
     pooler** (port 5432), with the password in it. A `@`, `:` or `/` in the password must be URL-encoded. Set them in the
     terminal only, never in a file in the repo or in chat:
     ```bash
     PG="/c/Program Files/PostgreSQL/18/bin"
     read -rs OLD_DEV && export OLD_DEV   # paste the OLD dev string, Enter (nothing shows)
     read -rs NEW_DEV && export NEW_DEV   # paste the NEW dev string, Enter
     mkdir -p ~/zaptill-dev-move && cd ~/zaptill-dev-move   # outside the repo
     ```
  2. **Back up the old dev database:**
     - the app's schema and data, with the grants;
     - the sign-ins (data only).
     ```bash
     "$PG/pg_dump" "$OLD_DEV" --schema=public --no-owner -Fc -f dev-public.dump
     "$PG/pg_dump" "$OLD_DEV" --data-only --table=auth.users --table=auth.identities -f dev-auth.sql
     ```
  3. **Restore into the new project.** The sign-ins go first, because the app's tables point at them.
     ```bash
     "$PG/psql" "$NEW_DEV" -v ON_ERROR_STOP=1 -c "SET session_replication_role = replica" -f dev-auth.sql
     "$PG/pg_restore" --no-owner --exit-on-error -d "$NEW_DEV" dev-public.dump
     ```
     Storage: dev keeps logos in the database (no buckets to copy). Check **Storage** in the old project; if it has
     files, tell me before step 5.
  4. **Check the data.** Run the read-only `scripts/db-move/row-counts.sql` on both databases and compare the outputs.
     Every line must match, and the last migration (`schema_migrations`) must be the same.
     ```bash
     "$PG/psql" "$OLD_DEV" -At -F' ' -f /c/swiftpos/pos/scripts/db-move/row-counts.sql > old.txt
     "$PG/psql" "$NEW_DEV" -At -F' ' -f /c/swiftpos/pos/scripts/db-move/row-counts.sql > new.txt
     diff old.txt new.txt && echo "IDENTICAL"
     ```
     Expected: the restore reports **one** ignored error, `schema "public" already exists` (the new project ships with an
     empty `public`). A row-count difference only in `refresh_tokens` is fine: the old database stayed live and renewed a
     sign-in after the dump.
  5. **Check the structure, then the grants.** The new project's "Automatically expose new tables" gives `anon` and
     `authenticated` access to every restored table, including the ones our migrations had revoked. Dev had 245 of them.
     List them and revoke exactly those:
     ```bash
     Q="select 'tables', count(*) from pg_tables where schemaname='public' union all select 'functions', count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' union all select 'triggers', count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal union all select 'policies', count(*) from pg_policies where schemaname='public' union all select 'rls_tables', count(*) from pg_tables where schemaname='public' and rowsecurity union all select 'indexes', count(*) from pg_indexes where schemaname='public' union all select 'constraints', count(*) from information_schema.table_constraints where table_schema='public' union all select 'grants', count(*) from information_schema.role_table_grants where table_schema='public'"
     G="select table_name||' '||grantee||' '||privilege_type from information_schema.role_table_grants where table_schema='public' order by 1"
     "$PG/psql" "$OLD_DEV" -At -c "$G" > old-grants.txt
     "$PG/psql" "$NEW_DEV" -At -c "$G" > new-grants.txt
     comm -13 old-grants.txt new-grants.txt > extra-grants.txt      # expected: only anon / authenticated
     comm -23 old-grants.txt new-grants.txt > missing-grants.txt    # expected: empty
     awk '{printf "REVOKE %s ON TABLE public.\"%s\" FROM %s;\n", $3, $1, $2}' extra-grants.txt > revoke-extra.sql
     "$PG/psql" "$NEW_DEV" -v ON_ERROR_STOP=1 --single-transaction -q -f revoke-extra.sql && echo REVOKED
     "$PG/psql" "$NEW_DEV" -At -c "$G" > new-grants.txt && diff old-grants.txt new-grants.txt && echo "GRANTS IDENTICAL"
     "$PG/psql" "$OLD_DEV" -At -F' ' -c "$Q" > old-struct.txt
     "$PG/psql" "$NEW_DEV" -At -F' ' -c "$Q" > new-struct.txt
     diff old-struct.txt new-struct.txt && echo "STRUCTURE IDENTICAL"
     ```
  6. When it says `IDENTICAL` throughout, point dev at it (B3). Before that, check the new project's **JWT Keys**: the
     current key must be **Legacy HS256 (shared secret)**, because our server verifies owner sign-ins with it. Do not
     rotate to the new signing keys. Then delete the folder `~/zaptill-dev-move`, because the dumps hold sign-in data.

  **Dev result (2026-10-31): done.**
  - 146 table counts identical (apart from one `refresh_tokens` row) and the structure identical.
  - 245 extra `anon` / `authenticated` grants revoked.
  - Render and Vercel pointed at the new project; `/health` showed `db up, schema ok`.
  - The owner signed in on dev and the numbers were correct.
  - **Lessons for prod:**
    - copy the connection strings carefully (a pasted command lost its last letter);
    - use PostgreSQL 18's tools;
    - in Vercel, the `VITE_SUPABASE_*` values are **Config**, not Secret, and go only to that project's own environments.
- **Dev, fresh instead (if the copy gives trouble):** the schema from our migrations, in order, with your migration
  runner pointed at the new database, then `scripts/dev-seed/attendance-demo.sql` and your usual test business.
- **Prod:** a full copy is needed: the `public`, `auth` and `storage` schemas, so owners keep their passwords.
  1. Use the Supabase CLI's dump (`supabase db dump` for the roles, the schema and the data).
  2. Restore with `psql`, with the server in maintenance so nothing is written during the copy.
  3. The exact commands go in a prod section of this file **after the dev rehearsal**, with what we learned.

### B3. Point everything at it
| Where | Settings |
|---|---|
| Render (that environment's API service) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (and `SUPABASE_SECRET_KEY` where set), `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET` |
| Vercel (that environment's dashboard project, and the admin portal's if it has them) | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, then **Redeploy** (Vite bakes them in at build) |
| GitHub › Secrets (prod only today) | `SUPABASE_URL`, `SUPABASE_ANON_KEY` (keep-alive), `SUPABASE_SERVICE_ROLE_KEY` and `BACKUP_DATABASE_URL` (nightly backup, environment `backup`), `DATABASE_URL` (prod migrations, environment `production`) |
| Your migration runner | the new database's connection string |

The desktop POS need **nothing**: they talk only to the API on Render, never to Supabase.

### B4. What people notice (Route B only)
- Owners and managers sign in to the dashboard again once, because the new project has a new JWT secret.
- The POS keep working throughout. Anything they could not send during the switch goes when the API answers again.

## C. Check after the move (both routes)
- [ ] The dashboard signs in. Overview loads with today's sales.
- [ ] A POS on this environment syncs: a test sale reaches the dashboard.
- [ ] Admin portal › System: the Supabase card shows calls and egress again.
- [ ] GitHub › Actions: the next keep-alive, uptime check (and, for prod, the nightly backup) are green.
- [ ] Over the next days: Organization › Usage of the new org — logs per day under ~33 MB.
- [ ] Route B only, after a few calm days: pause, then delete, the old project.

## D. Prod by 15 Nov — what has to be true first
1. The dev move is done and checked (section C).
2. Prod's logs are under ~33 MB a day:
   - A611 deployed;
   - `BRANCH_DRAWERS_MEMO_S=300` on prod Render;
   - KRUNCH & CO's two old day closes cancelled before their licence is restored.
3. If prod needs Route B: the copy commands written into this file from the dev rehearsal, a maintenance window agreed,
   and a fresh nightly backup from that day.
