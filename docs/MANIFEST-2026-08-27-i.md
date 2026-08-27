# MANIFEST 2026-08-27-i — A177: a hung sync fetch deadlocks all syncing

**Base:** `d5bd396`. **Cumulative — includes A175 + A176 (the two revived test
suites from -h) plus A177**, so one patch brings a d5bd396 checkout fully current.
**Artifact:** `swiftpos-2026-08-27-i.patch`. **Desktop change → bump the version +
tag after the build (rule 15); the bump is not in this patch (rule 22).**

## The bug (P0)

Field: a 0.5.37 till showing **ONLINE, 6 PENDING, 0 FAILED** for 30+ minutes,
"Force sync" doing nothing. Not connectivity alone, and not our earlier changes:

- No sync `fetch()` had a timeout, and `_isSyncing` (a module global) is set true
  before the fetch and cleared only in `finally`.
- A connection that opens but never responds — black-holed socket, proxy dropping
  the stream, IPv6 half-open, cold-start stall — hangs the `await` forever, so the
  `finally` never runs and `_isSyncing` stays true permanently.
- Every later `syncAll`/`syncPush` (60s flush, post-sale flush, reconnect, Force
  sync) then returns "Sync already in progress." The queue never drains; orders
  sit `pending` / 0 attempts / 0 failed — invisible, and "Retry failed" can't help
  because nothing reaches `failed` — until the app restarts.

## How it was proven (not guessed)

A sandbox driving the REAL compiled `dist/main/syncEngine.js` with a populated
`sync_queue` (`/tmp/sync-sandbox2.mjs`):

- **fast-fail fetch** → orders climb attempts and hit `failed` at 5 (correct; would show 6 FAILED).
- **hanging fetch** → second `syncPush()` returns `["Sync already in progress"]`, queue stays pending/0 — the exact field signature.
- The Render server itself: `POST /api/orders` answers **401 in 0.2–0.6s, no cold-start** from the sandbox — healthy. The till turns one hung connection into a permanent outage; the cloud is fine.

## The fix (`apps/desktop/src/main/syncEngine.ts`)

1. `syncFetch(url, opts)` — an `AbortController` with `SYNC_FETCH_TIMEOUT_MS` (20s, env-overridable). All 15 sync fetches go through it. A timed-out fetch REJECTS, which the existing per-call catch already handles, so the sync completes and `finally` clears `_isSyncing`.
2. `_syncStartedAt` stale-guard (`SYNC_STALE_MS` = 3 min): a sync "in progress" longer than that no longer blocks a new pass — defence-in-depth against any non-fetch hang.
3. `pushPendingOrders` breaks the batch on the first network timeout (don't burn one full timeout per queued order; they retry next pass).
4. Push failures now write to the durable log (`logLine('sync', …)`) — they were DB-only, which is why the field log showed pulls failing but never the order push.

## Files

| File | ID | Change |
|------|----|--------|
| `apps/desktop/src/main/syncEngine.ts` | A177 | `syncFetch` timeout wrapper on all 15 fetches; stale-guard; break-on-timeout; log push failures. |
| `apps/desktop/test/sync-timeout.test.mjs` | A177 | NEW. Drives the real engine with a signal-respecting hanging fetch; asserts the pass resolves, the order is attempted, and a following sync is never wedged (5/5). |
| `apps/desktop/package.json` | A177 | `test:synctimeout` script + inserted into the `test:desktop` chain. (Scripts only — version untouched.) |
| `apps/desktop/test/pinCache.test.mjs` | A175 | deviceConfig shim + A17 no-expiry test (was 8/8 → 17/0). |
| `apps/desktop/test/syncEngine-failures.test.mjs` | A176 | `fetchReferenceFromNode` shim (was 18/11 → 29/0). |
| `docs/AUDIT-REGISTER.md` | — | A177 (open P0) + A175/A176 (closed); counts + changelog; next free ID → A178. |
| `docs/MANIFEST-2026-08-27-{h,i}.md` | — | Manifests. |

## Verification (rule 7) and what is NOT (rule 16)

- Sandbox (real compiled engine, real better-sqlite3): fix makes a hung fetch time out, the order gets an attempt and escalates to `failed`, and a following sync is never blocked.
- `sync-timeout.test.mjs` 5/5. Regressions: `test:sync` 29/0, `test:pin` 17/0, `test:peerrelay` 28/0. `tsc` clean.
- NOT verified here: that the actual field till drains its 6 once on 0.5.37+A177 and able to reach the cloud. That keeps A177 OPEN P0 until a real-till run confirms it.

## Apply

```
git apply --check swiftpos-2026-08-27-i.patch && git apply swiftpos-2026-08-27-i.patch
cd apps/desktop && npx tsc -b tsconfig.main.json --force && npm run test:synctimeout && npm run test:sync && npm run test:pin
```
Then bump the desktop version, build, install, and confirm the queue drains. If you have an uncommitted 0.5.37 version bump in the tree, commit or stash it first so `git apply` runs clean (this patch touches package.json scripts only, not the version).

## Related, not fixed here

`pushLocalRecords`' SELECTs run outside its try/catch, so a schema error there can
also abort `pushPendingOrders`. Worth decoupling the three pushes so no one can
starve the others. Noted in the A177 register entry.

## Rollback

```
git apply -R swiftpos-2026-08-27-i.patch
```
