# SwiftPOS — schema parity + shifts/days + printing, 2026-07-30

Unzip over the repo root. `scripts/test-migration-41.mjs` was renamed to
`test-migrations-41-42.mjs` — delete the old file if you have it.

---

## What happens when Supabase moves and the desktop doesn't

Both sync directions name their columns explicitly, which gives clean semantics:

| Change on Supabase | Effect on the till |
|---|---|
| New nullable column on a PULLED table | **Silent.** Never read. The feature just does not exist on the terminal. |
| New nullable column on a PUSHED table | Silent, harmless. |
| New **NOT NULL, no default** on a pushed table | **Push rejected on every pass — the till stops syncing entirely.** |
| Narrowed CHECK, or a new FK | Same. |
| Renamed or dropped column the till still sends | Same. |

So additive changes fail quietly and constraint changes fail totally — and you
find out at 06:00.

## The parity check

`scripts/schema-parity.mjs`, wired into the existing **Schema drift** CI job.

Derives the Postgres shape from `migrations/*.sql` and the local shape from
`localDb.ts` (`CREATE TABLE` plus `migrateColumns`), then compares them.
Deliberately NOT built on `scripts/schema-index.json` — that index is
hand-maintained and is the artefact that went stale for eleven days.

**Severity depends on sync direction**, read from `SYNC_DIRECTION` in
syncEngine.ts. Without that the output was 36 "critical" findings, almost all
noise, and a check nobody trusts is worse than none:

- **PULL tables** — the till holds a deliberate subset and never writes back.
  Nothing here can break sync. Reported as info, hidden unless `--verbose`.
- **PUSH tables** — the till originates the rows. A NOT NULL column with no
  default it cannot fill, or a local-only column it might send, fails the build.
- **Warnings** never fail: a Postgres column the till does not populate is an
  unimplemented feature, not a fault.

Current state: **0 critical, 33 warnings.** Run it:

```bash
node scripts/schema-parity.mjs            # summary
node scripts/schema-parity.mjs --verbose  # include pull-table subsetting
node scripts/schema-parity.mjs --json     # machine-readable
```

### Two guards worth knowing about

**The parse floor.** A regex parser's own failure mode is matching nothing and
reporting perfect parity forever. The script asserts a minimum table count and
exits **2** — distinct from pass and fail — if it is not met. CI then asserts the
guard itself fires, because an untested guard is indistinguishable from none.

**A parser bug it caught in itself.** The first version stripped only whole-line
comments, so a trailing `-- 'float_in' | 'float_out'` stayed glued to the next
chunk and swallowed `float_transactions.amount` — then demanded a column that was
already there. Comment stripping is now quote-aware so `DEFAULT 'a--b'` survives.

### The exceptions file

`scripts/schema-parity-exceptions.json`. Every entry carries a REASON, because a
file of bare column names becomes a place to silence the check. Three categories:
local bookkeeping the till never sends (`sync_status`, `synced_at`), server-derived
columns the till must NOT send (`payments.business_id` is forced from the token —
accepting a client value would let one tenant write into another), and local-only
tables.

## A real bug the check found immediately

`business_days` was missing from `SYNC_DIRECTION`. I had created it locally with
`sync_status='pending'` but never wired the push, so **every day close would have
stayed on the till** and the cloud would show every trading day open forever. Now
pushed, with a matching arm in `/api/sync/push`.

Also surfaced, pre-existing and worth a look: `orders.pump_id` (the fuel-report
gap your own audit script mentions), `orders.table_number`, `orders.covers`,
`orders.source`, `shifts.denomination_breakdown` — all in Postgres, none on the
till.

---

## Migrations — order matters

**Run now on Supabase: 41.** Purely additive. Nothing in it can reject a write.

**Run 42 only after deploying this build.** It adds the one-open-shift-per-cashier
index. `/api/sync/push` used to batch-upsert shifts, so one rejected row failed
the whole call and the sync engine retried forever. Now per-row, with a 23505
returned as a `rejected` entry inside a **200** — the rows were understood and
refused on their merits, and a 4xx would make the client retry everything.

Rejected shifts are marked `sync_status='conflict'`, excluded from later pushes,
and surfaced at the top of **Manager → Close Day**.

Test suite: 26 assertions via PGlite, including one asserting **41 alone does NOT
enforce the rule** — otherwise I would only have proved I moved text between files.

```bash
npm i --no-save @electric-sql/pglite
node scripts/test-migrations-41-42.mjs
```

## Build

```bash
cd /c/swiftpos/pos/apps/desktop
npm version 0.2.1 --no-git-tag-version
npx tsc -p tsconfig.json && npx tsc -p tsconfig.main.json && npx vite build \
  && rm -rf release && npm run pack:portable && npm run pack:installer
```

Redeploy the server too — `routes/sync.ts` and `routes/shifts.ts` both changed,
and 42 depends on the sync change.

## Verified here

Renderer, main (`strict: true`) and server all type-check clean; `vite build`
succeeds; 26 migration assertions green; parity 0 critical; parse-floor guard
confirmed firing.

## Still outstanding

- **Reports** — date filters and CSV download. Your original second ask, not started.
- Dashboard force-close UI (endpoint exists, nothing calls it).
- `terminals` table for the online POS.
- `clearDeviceConfig()` ungated — a factory reset now bypasses the day gate.
