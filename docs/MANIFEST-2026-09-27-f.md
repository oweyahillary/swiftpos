# MANIFEST 2026-09-27-f — A338: one drawer never blocks another's sync

**Base commit:** `b344c80` (origin/dev = desktop v0.6.11; CI #412 green; Release desktop #27 green). One commit on
`claude/modest-cray-f21ll5`; the owner fast-forwards `dev`. **Deploy, in this order:** prod-migrate **107** → cloud (Render) → desktop
**v0.6.12** on the tills. The dashboard is unchanged. Local schema is unchanged (55).

Owner, 2026-09-27 (till on 0.6.10): "the till is not syncing to cloud … i have tried force sync from tech screen but no change and its
because of the cloud till which is running … one should never block the other from syncing".

## Why it happened
The cloud allowed only ONE open drawer per terminal (a unique index, migration 63). The web POS can stand in for a till (it takes the
till's identity). If the web had a drawer open as T1 while T1 had its own, the cloud refused T1's drawer, then everything on it:
- its float movements and expenses were refused;
- every sale was refused ("references a record the server does not have") and gave up after 5 tries;
- its close waited for those sales forever.

Nothing ever retried any of it, which is why Force sync did nothing.

## What changed
1. **Migration 107** turns that unique index into an ordinary one, so a drawer that already exists on a till always lands. Opening a
   second drawer *by hand* is still refused by the app itself: the web POS joins the open drawer, and `POST /api/shifts/open` answers 409.
2. **Cloud:** a sale whose drawer is not on the cloud yet gets **424 "drawer has not reached the cloud yet"**, never a failure.
3. **Till:**
   - such a sale stays pending (it is never marked failed) and goes as soon as its drawer lands;
   - each sync first re-queues what a clash parked: the drawer (with the rejection line removed from its notes), its floats and
     expenses, and its failed sales. Sales are re-queued once only.

## Files (9)
| File | Change |
|---|---|
| `migrations/107_open_shifts_never_block_sync.sql` | NEW — unique index → plain index. |
| `apps/server/src/routes/orders.ts` | 424 `shift_not_synced` before the write. |
| `apps/desktop/src/main/syncEngine.ts` | NEW `requeueAfterDrawerClash` stage; 424 keeps a sale pending. |
| `scripts/test-migration-107.mjs` | NEW — PGlite, 7 checks. |
| `apps/desktop/test/drawer-clash-sync.test.mjs` | NEW — real sync engine, 15 checks. |
| `tests/drawer-clash.test.mjs` | NEW — route pins, 4 checks. |
| `.github/workflows/ci.yml` | Step "Desktop drawer clash never blocks sync". |
| `docs/AUDIT-REGISTER.md` | A338; header; Tree row v0.6.12, migrations → 107 (prod-migrate owed); changelog. |
| `docs/MANIFEST-2026-09-27-f.md` | This file (NEW). |

## Verification (bench: Linux, Node 22)
```
scripts/test-migration-107.mjs → 7 passed (PGlite: BEFORE 107 the till's drawer is refused 23505 and its sale fails the FK — the
  owner's failure; AFTER 107 both land). Mutation: index UNIQUE again → 3 checks red.
apps/desktop test/drawer-clash-sync.test.mjs → 15 passed (real compiled syncEngine + SQLite vs a stand-in cloud: before — drawer,
  float, expense parked, both sales 'failed'; after — everything arrives in 2 passes, the web's drawer untouched; a sale refused
  for another reason left alone; a sale waiting for its drawer pending through 8 passes; requeue once only). 4 mutations bite.
  The first version re-queued a sale forever (last_error is overwritten on failure) — caught by this test, fixed.
tests/drawer-clash.test.mjs → 4 passed; mutation (guard removed) bites
npm run test:migrations → all 30 · schema-audit · schema-drift · api-schema-drift (+ self-test) · rls · schema-parity · push-domain
tests/*.test.mjs → all pass · every desktop test → pass · scripts/test-* → pass · printing → pass · ratchet server/dashboard/admin OK
own-rows · sql-binds · row-attribution · ipc · header-keys · reference-names · colour gates · doc-refs · root-clean · api-routes ·
  permission-parity · notnull-writes · register-consistency (with the 0.6.12 bump) → OK
```
Not verified here (rule 16): the live cloud and the till.

## Rollout (tomorrow) — in this order
1. **Prod-migrate 107:** GitHub → Actions → **DB migrate (production)** → *Run workflow* → branch **dev** → approve. The "Plan" step
   should list only `107_open_shifts_never_block_sync`, and "Verify schema" should pass.
2. **Deploy the cloud** (Render) from `dev`.
3. **Install 0.6.12** on every till. A till on 0.6.10 or 0.6.11 never re-queues a drawer it already parked.

## Owed on target
- **H1.** The till that is stuck: install 0.6.12 and leave it online for a minute (or Tech → Force sync). The Tech screen's pending
  count falls to 0, and the dashboard shows that till's drawer and its sales. **Record:** the Tech Sync card before and after.
- **H2.** Web POS opens a drawer as T1 while T1 has its own open. Ring a sale on each. Both drawers show on the dashboard, both sales
  are there, and nothing stays pending on the till.
- **H3.** Close T1's drawer on the till. It closes on the cloud too, and the web's drawer is unaffected.
- **H4.** Try opening a second drawer on T1 from the web POS by hand. It is still refused (it joins the open one instead).

## Rollback
```bash
git revert <this commit>
# DB: only if no terminal has two open drawers at the time —
#   DROP INDEX IF EXISTS shifts_open_by_terminal;
#   CREATE UNIQUE INDEX shifts_one_open_per_terminal ON shifts (business_id, shift_terminal_key(device_id, terminal_code, branch_id)) WHERE status = 'open';
```
