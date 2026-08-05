# Apply — Phase 1 repair, 2 August 2026

Five files. Nothing here touches the deployed server. Unzip over the repo root;
there is no ordering to get wrong, no other zip supersedes it.

```bash
cd /c/swiftpos/pos
unzip -o ~/Downloads/swiftpos-phase1-repair.zip -d .
```

---

## What was wrong

Your repo had the ownership scoping applied but **not the bind arguments**. The
`COALESCE(device_id,'') = COALESCE(?,'')` predicates were in; the values that
fill the `?` were not. Eleven statements, all of them `tsc`-clean:

```
syncEngine.ts    pushLocalRecords  ×4   the entire cash push
syncEngine.ts    confirmCloudDelivery
syncEngine.ts    reconcileClosedShifts
ipcHandlers.ts   POS header pending counts ×3
ipcHandlers.ts   open-shift lookups ×2
```

`better-sqlite3` throws `Too few parameter values were provided` on each, at
runtime, on the first sync pass. A till built from the repo as it stood would
have failed to push a single shift, float, expense or trading day.

`swiftpos-phase1-ownership.zip` was correct. Something applied an earlier drop of
that work over it, or applied it partially — the four other patched files
(`managerReports`, `dayService`, `dailySalesReport`, `localDb`) were already
byte-identical, so only these two needed replacing.

Separately: `check-sql-binds.mjs`, the guard that catches exactly this, was not
in `scripts/` at all, and neither guard was in `ci.yml`.

---

## What is in the zip

| File | Change |
|---|---|
| `apps/desktop/src/main/syncEngine.ts` | bind fixes (6) + rejection routing |
| `apps/desktop/src/main/ipcHandlers.ts` | bind fixes (5) |
| `scripts/check-sql-binds.mjs` | **new to the repo** — was only ever in the zip |
| `scripts/test-sync-rejection-routing.mjs` | new — 18 assertions against real SQLite |
| `.github/workflows/ci.yml` | new `desktop-scope` job, three steps |

### The rejection routing (M33, client half)

The server already emits `rejected[].table` — `apps/server/src/routes/sync.ts`
names `business_days` and `shifts`. The client ignored it and applied every
rejection to `shifts`:

```sql
UPDATE shifts SET sync_status='conflict', notes=… WHERE id=<a business_day id>
```

Zero rows, no error, nothing logged — and the commit loop below then marked that
business_day `synced`. **A refused trading day was recorded as delivered and
never retried.** So the server half of M33 was live and the client half was not,
which is worse than neither: the server was reporting a table nobody read.

Now:

- Rejections route on `table`, with a code-map fallback for an older server.
- An **unknown** code or table is *not* defaulted to `shifts`. Defaulting is what
  caused this. It parks the row pending, reports it, and asks for an update.
- The reason is written to `notes` only on `shifts` and `business_days`.
  `float_transactions` and `expenses` have no `notes` column locally — writing
  there throws and would abort the transaction, killing the whole cash push on
  the first rejection of any kind. Those two get status only. (Assertion 3.)
- Every mark-synced loop now excludes **its own table's** rejections. Previously
  only `shifts` was filtered.

The first version of this fix still lost unroutable rejections — they went onto
the `unrouted` list and into none of the exclusion sets, so the commit loop marked
them synced anyway. Section 5 of the test caught it. That is the reason the test
exists rather than a code review.

---

## Verify

```bash
node scripts/check-own-rows.mjs                            # OK, 59 queries / 15 files
node scripts/check-sql-binds.mjs                           # OK, 157 checked
node --no-warnings scripts/test-sync-rejection-routing.mjs # 18 passed, 0 failed
cd apps/desktop && npx tsc -p tsconfig.main.json --noEmit && npx tsc -p tsconfig.json --noEmit
```

All five were run here and all five are clean.

**Note on the test harness:** it uses `node:sqlite`, not `better-sqlite3`. The
native binding could not be built in this environment. Both are SQLite and the
SQL under test is identical, but if you want the belt-and-braces version, run it
once on your machine against `better-sqlite3` — the driver's `.changes` and
`no such column` behaviour is what assertions 1 and 3 turn on. The CI job pins
Node 22 because `node:sqlite` needs it.

---

## NOT in this zip — still open, needs your call

**1. `REQUIRED_DESKTOP_SCHEMA` is 43; `LOCAL_SCHEMA_VERSION` is 44.**
The handoff says these must move in the same release. I have not touched it
because the three live tills are on 43, and bumping the server's requirement
makes all three report "this till is running an older build" until they are
rebuilt. That is reported, not blocked, so it is cosmetic — but it is noise
aimed at cashiers during the first real trading day. Bump it when you build.

**2. `apps/desktop/package.json` is already `0.4.5`** — the version you say is on
three tills. This source is not that binary: different schema version, and the
binds were broken. Bump to 0.4.6 before any build, or you will have two different
installers with one version string and no way to tell them apart from the POS top
bar.

**3. `PHASE1-STATUS.md` is stale.** It describes the abandoned `origin_device_id`
design and contradicts `PHASE1-OWNERSHIP.md`. The code is clean — zero
occurrences of `origin_device_id` repo-wide — so this is documentation only, but
it is the first Phase 1 doc someone will open. Delete it or move it to
`handoffs/`.

**4. C0.** `apps/server/.env`, `apps/dashboard/.env` and `e2e/.env` were inside
`pos.zip`. They are correctly gitignored and CI asserts none are tracked, so this
is packaging, not the repo. Package with `git archive --format=zip HEAD -o pos.zip`.
Rotate `SUPABASE_SERVICE_ROLE_KEY` regardless of whether the values are test
ones: it bypasses RLS by definition, which is what migrations 29 and 47 are for.

**5. `migrations/archive/` exists but holds four files**, all promotions and
hourly-rate. The seventeen unnumbered files `LEGACY-MIGRATIONS.md` describes are
still in `migrations/`. Half-done is the worst state for that directory —
`archive/` now implies the sorting happened.
