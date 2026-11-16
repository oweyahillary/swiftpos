# Supabase prod → new account move — the real run (2026-11-15)

What we **actually did** the night we moved the production database to its own **new Supabase account**, with the one
gotcha that nearly shipped a wide-open database and how we caught + fixed it. This is the proven, repeatable version —
more authoritative than the theoretical §E in [`SUPABASE-ORG-MOVE.md`](./SUPABASE-ORG-MOVE.md) and the
[`DB-MOVE-PLAYBOOK.md`](./DB-MOVE-PLAYBOOK.md), because every command here ran against real prod and was verified.

> **Method:** a full **copy** (Route B), not Supabase's "Transfer project" — Transfer only moves a project between orgs you
> already belong to, so it can't push into a **separate account**. A new account = copy.
>
> **Golden rules that saved us:** (1) **verify structure, not just row counts, before re-pointing.** (2) **Never trust the
> first restore into a Supabase project's pre-existing `public` schema** — `DROP SCHEMA public CASCADE` and re-restore
> clean. (3) The operator runs it; **never paste connection strings or keys into chat** — only command *outputs*.

---

## 0. Pre-stage (done hours ahead, while the shop was open — nothing destructive)

- **Quota headroom** so the old org wasn't restricted mid-move: A611 deployed to prod Render, `BRANCH_DRAWERS_MEMO_S=300`
  on prod Render. (The KRUNCH & CO day-close noise was moot — that client was terminated, services off.)
- **New account → new project**, region **eu-central-1** (match the old). Saved its **URL + legacy `anon` + legacy
  `service_role` + JWT secret** to the password manager. The legacy `eyJ…` keys live under **Settings → API Keys → Legacy
  API keys** (a new project shows the new *Publishable/Secret* keys up top — not those). JWT must be **Legacy HS256
  (shared secret)** — the server verifies owner sign-ins with it; **do not rotate** to the new signing keys.
- **Tools on the operator's PC:** PostgreSQL **18** client (`psql`/`pg_dump` 18.4 — newer than the server, fine) and the
  `supabase` CLI (had 2.95.4; **did not update it right before the move**). *(We ended up using raw `pg_dump`, not
  `supabase db dump` — see note in §3.)*
- **Storage:** confirmed **no buckets** — `select name from storage.buckets;` → 0 rows, `select count(*) from
  storage.objects;` → 0. (Product images are on **Cloudinary**, logos are in-DB.) So the copy is **DB-only**, nothing to
  copy separately.
- **Postgres versions:** old **17.6**, new **17.11** → same major (17), restore-safe. (`select version();` on each.)
- **Both connect:** `read -rs OLD_PROD`, `read -rs NEW_PROD` (Session pooler strings, port 5432, password URL-encoded),
  then `psql "$OLD_PROD" -c "select 1"` / same for NEW → both returned `1`.
- **Fresh backup from today:** ran the GitHub `backup` workflow → `Backup ok … 3.4 MB`. (Dumps public+auth+storage; our
  rollback net.)

```bash
PG="/c/Program Files/PostgreSQL/18/bin"
read -rs OLD_PROD && export OLD_PROD
read -rs NEW_PROD && export NEW_PROD
mkdir -p ~/zaptill-prod-move && cd ~/zaptill-prod-move    # outside the repo — these files hold sign-in data
```

## 1. Freeze writes (maintenance)

The app has **no maintenance flag**, so we **suspended the prod API service on Render** (Service → Suspend). That stops
all writes to the old DB; desktop POS sell offline and buffer, and drain after resume. Done just after midnight, nothing
selling.

## 2. Dump (after suspend, so the snapshot is final)

```bash
"$PG/pg_dump" "$OLD_PROD" --schema=public --no-owner -Fc -f prod-public.dump          # ~4.3 MB
"$PG/pg_dump" "$OLD_PROD" --data-only --table=auth.users --table=auth.identities -f prod-auth.sql   # ~6 KB, 6 accounts
```
Only `auth.users` + `auth.identities` (data-only) are needed — that carries the owners' **passwords**. Sessions/refresh
tokens don't survive the new project's JWT secret anyway (everyone re-signs-in once).

## 3. Restore — ⚠️ THE GOTCHA

**First attempt, straight into the new project's existing `public`:**
```bash
"$PG/psql" "$NEW_PROD" -v ON_ERROR_STOP=1 -c "SET session_replication_role = replica" -f prod-auth.sql   # COPY 6 / COPY 6 ✓
"$PG/pg_restore" --no-owner -d "$NEW_PROD" prod-public.dump
# → pg_restore: error: schema "public" already exists  (looked like the one benign error…)
```
Row counts came back **IDENTICAL** — so it *looked* done. **But the structure check exposed a disaster:**

| | should be | got |
|---|---|---|
| triggers | 93 | **0** |
| RLS policies | 119 | **0** |
| RLS-enabled tables | 147 | **0** |
| indexes | 457 | 113 |
| constraints | 1842 | 1454 |

The restore into Supabase's **pre-existing** `public` had its **post-data phase killed** — data landed, but **no RLS, no
triggers, half the indexes/constraints**. RLS at 0 = every table wide open. **This is why you verify structure before
re-pointing.**

**The fix — wipe `public` and re-restore clean:**
```bash
"$PG/psql" "$NEW_PROD" -c "DROP SCHEMA public CASCADE;"                 # dropped ~205 objects (the partial restore)
"$PG/pg_restore" --no-owner -d "$NEW_PROD" prod-public.dump 2>restore.log
echo "exit=$?  lines=$(wc -l < restore.log)"                           # exit=1, only 22 lines
grep -i "error:" restore.log | sed -E 's/^pg_restore: error: //' | sort | uniq -c | sort -rn
# → 3  could not execute query: ERROR:  permission denied to change default privileges
```
The only 3 errors are **benign** — the dump trying `ALTER DEFAULT PRIVILEGES` on Supabase-managed roles, which `postgres`
can't; they touch no table/index/constraint/trigger/policy. **Do NOT re-run the auth insert** (auth wasn't dropped).

*(We used raw `pg_dump`/`pg_restore`, the dev-proven path, not `supabase db dump` — it has known-good expected outputs on
this DB. The `supabase db dump` text in §E is untested here; prefer this.)*

## 4. Verify — the gate (all must pass before re-pointing)

```bash
# structure: triggers / policies / RLS / indexes / constraints
Q="select 'tables', count(*) from pg_tables where schemaname='public' union all select 'functions', count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' union all select 'triggers', count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal union all select 'policies', count(*) from pg_policies where schemaname='public' union all select 'rls_tables', count(*) from pg_tables where schemaname='public' and rowsecurity union all select 'indexes', count(*) from pg_indexes where schemaname='public' union all select 'constraints', count(*) from information_schema.table_constraints where table_schema='public'"
"$PG/psql" "$OLD_PROD" -At -F' ' -c "$Q" > old-struct.txt
"$PG/psql" "$NEW_PROD" -At -F' ' -c "$Q" > new-struct.txt
diff old-struct.txt new-struct.txt && echo "STRUCTURE IDENTICAL"      # ✓

# data
"$PG/psql" "$OLD_PROD" -At -F' ' -f /c/swiftpos/pos/scripts/db-move/row-counts.sql > old.txt
"$PG/psql" "$NEW_PROD" -At -F' ' -f /c/swiftpos/pos/scripts/db-move/row-counts.sql > new.txt
diff old.txt new.txt                                                  # only `refresh_tokens` differs by 2 — fine

# grants
G="select table_name||' '||grantee||' '||privilege_type from information_schema.role_table_grants where table_schema='public'"
"$PG/psql" "$OLD_PROD" -At -c "$G" | sort > old-grants.txt
"$PG/psql" "$NEW_PROD" -At -c "$G" | sort > new-grants.txt
diff old-grants.txt new-grants.txt && echo "GRANTS IDENTICAL"         # ✓  extra=0, missing=0
```

**Grants bonus from the DROP:** after `DROP SCHEMA public CASCADE`, the auto-exposed `anon`/`authenticated` default
privileges were gone too (that's what the 3 benign errors were failing to re-create), so the re-restored tables were
**never auto-exposed** → `extra=0`, **no revoke needed**. (On the *first*, un-dropped restore there had been **301** extra
grants to revoke — another reason the clean DROP is the right path.)

If you ever DO see extras: build and apply the revoke —
```bash
comm -13 old-grants.txt new-grants.txt > extra-grants.txt
awk '{printf "REVOKE %s ON TABLE public.\"%s\" FROM %s;\n", $3, $1, $2}' extra-grants.txt > revoke-extra.sql
"$PG/psql" "$NEW_PROD" -v ON_ERROR_STOP=1 --single-transaction -q -f revoke-extra.sql && echo REVOKED
```

## 5. JWT

New project → **Settings → JWT Keys**: confirmed the active key is **Legacy JWT Secret (HS256)**. Did **not** rotate.

## 6. Re-point (while suspended), then resume

| Where | What |
|---|---|
| **Render** (prod API) | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` (+ `SUPABASE_SECRET_KEY` if present). Also any direct DB string. |
| **Vercel** (dashboard + admin) | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` → **Redeploy** each (Vite bakes them at build). |
| **GitHub → Secrets** | `BACKUP_DATABASE_URL` (env `backup`), `DATABASE_URL` (env `production`). **Note: `SUPABASE_SERVICE_ROLE_KEY` is *not* a GitHub secret here** — the backup/migration use the DB connection strings. |
| **Desktop POS** | nothing — they only talk to the API. |

**Tip:** grep each env for the **old project ref** (`<ref>` in `https://<ref>.supabase.co`) — anything holding it must
change. Then **Resume the Render service** → it redeploys on the new env and comes up on the new DB.

## 7. §C — confirm live

- Render logs booted clean: `Server started … env:production`, `[permissionCatalogue] catalogue verified (118 keys…)`
  (= the server read+wrote the new DB).
- **Dashboard signs in** (passwords + HS256 verify) and **Overview shows today's sales**.
- **A test sale on a POS appears on the dashboard** (write path + sync).
- **Admin → System** Supabase card tracks the **new** project ("since 5 min ago").

## 8. Rollback & cleanup

- **OLD project: pause, do NOT delete** for several days — the instant rollback is just re-pointing env back at it.
- Keep `~/zaptill-prod-move` (the dumps hold sign-in data — delete once a full day runs clean, then `rm -rf` it).
- GitHub `keep-alive` / nightly `backup` self-confirm on their next runs against the new DB.

## 9. Watch after cutover

- The admin "Supabase pulled" card **right at cutover reads wildly high** (we saw 442% over) — it extrapolates a 6-minute
  sample dominated by the admin page's own polling (`fleet/health`, `fleet/stats`, `ops/events`), the reconnection drain,
  and your report pulls. **Not steady-state.** Close the admin page, idle 30–60 min (or read it next morning) for the real
  rate.
- If steady-state is still over the ~15k calls / ~33 MB-logs-a-day target, that's an **egress-trim follow-up** (admin
  fleet-monitor cadence + `auth/refresh` + report polling) — a separate task from the move.

## 10. One-screen summary

1. Pre-stage: new account+project (eu-central-1), legacy keys + HS256 JWT saved, tools, no buckets, versions match, both
   connect, fresh backup.
2. **Suspend Render.**
3. `pg_dump --schema=public -Fc` + `pg_dump --data-only auth.users auth.identities`.
4. **`DROP SCHEMA public CASCADE` on NEW**, then `pg_restore` (3 benign default-privilege errors). Restore auth data-only
   with `session_replication_role=replica`.
5. **Verify STRUCTURE + DATA + GRANTS identical** — this is the gate.
6. Keep **Legacy HS256** JWT.
7. Re-point Render + Vercel (redeploy) + GitHub secrets.
8. **Resume Render**, run §C.
9. OLD project paused-not-deleted; dumps kept.
