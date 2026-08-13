# Local (SQLite) schema versions

**Reconstructed 2026-08-10 by reading `localDb.ts` and its git history. Register
D6.** `LOCAL_SCHEMA_VERSION` is currently **52**.

## Why this file exists

`LOCAL_SCHEMA_VERSION` decides whether a till works. `REQUIRED_DESKTOP_SCHEMA`
on the server compares against it, tills are updated by installing an `.exe` by
hand so one is always behind, and the version travels on every push as
`X-Schema-Version` so the server can say "that build is too old" instead of the
mismatch surfacing as an opaque column error mid-service.

Six generations — 46 through 51 — had no record anywhere. That is the mechanism
that gates trading, undocumented.

## How local migration actually works

**Not numbered steps.** There is no `case 46:` ladder. Two mechanisms:

- `CREATE TABLE IF NOT EXISTS …` for new tables
- `migrateColumns(db, table, [[name, def], …])`, which reads
  `PRAGMA table_info` and `ALTER TABLE … ADD COLUMN` for anything absent

Both are **additive and idempotent**, so a till at any older version reaches the
current shape by running the whole file. `LOCAL_SCHEMA_VERSION` is therefore a
*label* for the resulting shape, not an instruction to replay steps — which is
why it can be bumped without a corresponding block of code, and why two numbers
below were skipped without anything breaking.

`getLocalSchemaVersion()` reads `schema_version.id=1` and returns **0** when the
table predates the mechanism.

## The versions

| Version | Commit | What it added |
|---|---|---|
| **43** | `fbb2527` | Baseline for this record. Earlier history not reconstructed. |
| **44** | — | `device_id` on expenses and float movements; every collection query scoped on it. Never shipped alone: no till was built from 44. |
| **45** | `3763946` | Branch replication — `seq`, outbox, cursors. Backfills attribution for rows written between 44 and 45. `REQUIRED_DESKTOP_SCHEMA` had to reach 45 in the same release: a node on 44 ingests peer rows with no `seq`, and every one is invisible to the cursor that decides what still needs replicating. |
| **46** | `40f53ac` | Phase 4 central day close — `node_instructions`, `node_peer_state`. |
| **47** | `5ef0f08` | Phase 2a, branch distribution (replicated star). Gated behind 0.4.8 feedback. |
| **48** | — | **NEVER EXISTED.** No commit ever sets this value. |
| **49** | `fee91cc` | Phase 2b+2c — `events`, `maintenance_state`. Mutation events; bounded replicas and nightly snapshots. |
| **50** | — | **NEVER EXISTED.** No commit ever sets this value. |
| **51** | `a80c224` | ESC/POS printing — `escpos_enabled INTEGER`, `kitchen_exclusions TEXT` on the settings table. |
| **52** | — | Local kitchen-exclusion override — `kitchen_exclusions_override TEXT` on `device_config`. NULL follows the synced cloud baseline (`kitchen_exclusions`); non-NULL is this terminal's own list, which wins and survives every catalogue pull. Shipped with the fix that made `saveDeviceConfig` actually persist `kitchen_exclusions` (it had been omitted from the INSERT/UPSERT, so the synced baseline never reached the DB). The current value. |

## The gaps are real, and they are the same shape as the server's

**48 and 50 were never committed.** The constant jumped 47 → 49 → 51. Nothing is
missing and nothing broke, because the numbering labels a shape rather than
replaying steps — but a reader hunting "what did 48 do?" will find nothing, and
without this note would reasonably conclude a migration had been lost.

That mirrors the server side exactly: migrations 31 and 32 are recorded SKIPPED
and 64 never existed (register A4, §M). **Two independent numbering schemes, both
with unexplained gaps, and in both cases the gap looked like data loss until
somebody checked.** Worth knowing before the next person spends an afternoon on
it.

## What is NOT reconstructed

- **What 44 and below did, in detail.** 43 is the earliest value I traced; older
  generations would need reading the whole file's history.
- **Whether every field till has actually reached 51.** `getLocalSchemaVersion()`
  answers that per machine, and `X-Schema-Version` puts it on every push — but
  nothing in this repo records the fleet's state. Ask the machines.

## When you bump it

1. Add the table or columns additively (`IF NOT EXISTS` / `migrateColumns`) so an
   older till converges by running the file.
2. Bump `LOCAL_SCHEMA_VERSION`.
3. Decide whether `REQUIRED_DESKTOP_SCHEMA` must move in the same release. It
   must whenever a node would otherwise ingest rows it cannot replicate — that is
   the 44/45 lesson.
4. **Add a row to the table above.** Six generations went unrecorded because
   nothing made this step necessary.
