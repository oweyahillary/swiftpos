# DB move playbook — the proven Supabase org-move procedure

A distilled, reusable version of what actually worked on **dev (31 Oct 2026)**, plus the **prod deltas**. The full,
authoritative runbook (both routes, all checks) is [`docs/SUPABASE-ORG-MOVE.md`](./SUPABASE-ORG-MOVE.md) — this is the
quick-reference.

> **Try Route A (Transfer) first.** Same URL, same keys, nothing in the apps changes, nobody is signed out. The copy
> below (Route B) is the **fallback**, used only when Supabase refuses the transfer (old org over quota / in a grace
> period).

---

## What dev did — Route B copy (proven, 2026-10-31)

Done in **Git Bash on the owner's PC**, with **PostgreSQL 18** tools (v15 cannot dump a newer server), in a work dir
**outside the repo** (the dumps hold sign-in data).

```bash
PG="/c/Program Files/PostgreSQL/18/bin"
read -rs OLD_DEV && export OLD_DEV   # OLD dev Session-pooler string (Project Settings › Database, port 5432), password URL-encoded
read -rs NEW_DEV && export NEW_DEV   # NEW dev Session-pooler string
mkdir -p ~/zaptill-dev-move && cd ~/zaptill-dev-move
```

1. **Dump** the old DB — app schema+data (with grants), and the sign-ins (data only):
   ```bash
   "$PG/pg_dump" "$OLD_DEV" --schema=public --no-owner -Fc -f dev-public.dump
   "$PG/pg_dump" "$OLD_DEV" --data-only --table=auth.users --table=auth.identities -f dev-auth.sql
   ```
2. **Restore** into the new project — **sign-ins first** (the app tables point at them):
   ```bash
   "$PG/psql" "$NEW_DEV" -v ON_ERROR_STOP=1 -c "SET session_replication_role = replica" -f dev-auth.sql
   "$PG/pg_restore" --no-owner --exit-on-error -d "$NEW_DEV" dev-public.dump
   ```
   Expect **one** ignored error: `schema "public" already exists`.
3. **Verify IDENTICAL** with the read-only row-counts script on both, then `diff`:
   ```bash
   "$PG/psql" "$OLD_DEV" -At -F' ' -f /c/swiftpos/pos/scripts/db-move/row-counts.sql > old.txt
   "$PG/psql" "$NEW_DEV" -At -F' ' -f /c/swiftpos/pos/scripts/db-move/row-counts.sql > new.txt
   diff old.txt new.txt && echo "IDENTICAL"
   ```
   A difference only in `refresh_tokens` is fine (the old DB stayed live). `schema_migrations` must match.
4. **Re-revoke grants.** The new project auto-exposes `anon`/`authenticated` to **every** restored table — dev had **245**
   our migrations had revoked. List the extras, revoke exactly those, re-diff grants + structure (the `$G`/`$Q`/
   `revoke-extra.sql` block in [`SUPABASE-ORG-MOVE.md`](./SUPABASE-ORG-MOVE.md) §B2.5).
5. **JWT Keys = Legacy HS256** (shared secret) — the server verifies owner sign-ins with it. **Do not rotate.**
6. **Re-point** Render + Vercel at the new project; then `rm -rf ~/zaptill-dev-move` (it holds sign-in data).

**Dev result:** 146 table counts identical (one `refresh_tokens`), structure identical, 245 grants revoked, Render +
Vercel re-pointed, `/health` → `db up, schema ok`, owner signed in with correct numbers.

**Lessons (bite marks):**
- A pasted connection string once **lost its last letter** → check it copied whole.
- Use **PostgreSQL 18** tools.
- In Vercel, `VITE_SUPABASE_*` are **Config**, not Secret, and go only to that project's own environments.

---

## Prod deltas (what's different from dev)

- **Fuller `auth` copy.** Dev copied only `auth.users` + `auth.identities` (data-only). Prod must keep **all** owners'
  passwords/sessions → use **`supabase db dump`** (roles + schema + data), not the dev raw `pg_dump`. See
  [`SUPABASE-ORG-MOVE.md`](./SUPABASE-ORG-MOVE.md) **§E**.
- **Check Storage first.** Dev had **no buckets** (logos live in the DB). If prod has any bucket with files, those objects
  copy **separately** — stop and handle them before the restore.
- **Maintenance window + fresh backup** from that day; nothing writes to prod during the copy.
- **Owners/managers re-sign-in once** afterwards (new JWT secret) — Route B only.
- **Desktop POS need nothing** — they talk to the API on Render, never to Supabase.

---

## Prerequisites (so Route A isn't refused / the new org stays under quota)

Old org is restricted from **20 Nov 2026** if still over its 1 GB/month log quota. Before prod moves (§D): **A611 deployed**,
**`BRANCH_DRAWERS_MEMO_S=300`** on prod Render, **KRUNCH & CO's two old day-closes cancelled**. Target: prod under **~33 MB
logs/day**.

**The owner runs the move; never run or query prod from here.**
