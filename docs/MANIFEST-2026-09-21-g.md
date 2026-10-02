# MANIFEST 2026-09-21-g — branding sync-down: /pos/init serves branding + till pulls it (A304)

**Supersedes 2026-09-21-f** (Rule 3). Code + register ship together (Rule 14).

**Base commit:** `240ec66` (`dev` tip — the A303 cloud store). If `dev` moved, apply the register
edits by hand rather than extracting the full register.
**Scope:** server `/pos/init` + desktop pull. No migration, no version bump (Rules 15, 22).
**Working rules:** unchanged — `HANDOFF-2026-08-08-evening.md §0`.
**Register ID:** A304. **Depends on migration 104 (A303) being live on prod to work end-to-end.**

## Why

A303 built the cloud store; A301 built the local read path. This connects them: the cloud serves
branding on `/pos/init`, and the till writes it to the local `branding` mirror (remote-wins). That
is the actual A295 sync-down (SCOPE §4, §10 step 2).

## What changed and why

| File | New? | Change | ID |
|---|---|---|---|
| `apps/server/src/routes/pos.ts` | edit | `/init` fetches `business_branding` and returns `branding {accentHex, logoPng} | null`; `business_branding` added to the `/catalogue-version` `latest()` list (A291 signal → propagates on the normal pull). | A304 |
| `apps/desktop/src/main/localDb.ts` | edit | `applyPulledBranding(b)` — upsert the single local branding row keyed by the owner session's business_id, remote-wins; no-op with no session. | A304 |
| `apps/desktop/src/main/syncEngine.ts` | edit | `pullCatalogue` cloud path sets `branding` from the init JSON; `applyReferenceConfig` calls `applyPulledBranding` **only when `c.branding` is set**. | A304 |
| `apps/desktop/src/main/referenceBundle.ts` | edit | Optional `branding?` on `AcquiredReference['config']` (cloud sets it; node path leaves it undefined → skip). | A304 |
| `tests/branding-sync-pull.test.mjs` | **new** | 12 checks: source wiring both ends + remote-wins upsert semantics (node:sqlite). Auto-registered by the CI `tests/*.test.mjs` glob. | A304 |
| `docs/AUDIT-REGISTER.md` | edit | A304 entry + Open `18 P3`→`19 P3` + Counts `…A303 A304` + a `2026-09-21 (sync)` changelog line. | A304 |

**Remote-wins semantics (design decision, noted):** the pull writes the cloud branding **only
when the cloud returned a row**. A `null` (no cloud row) or the node path leaves the local
(tech-set, A302) value untouched — no wipe. Strict remote-wins (clear-on-cloud-null) is deferred
until the web branding portal (SCOPE §6) exists to author branding; until then A302's tech feed is
the editor. Node-relay of branding to peers is a follow-up (cloud path only here).

## Verification (Rule 7 — what was run)

Bench, Linux/Node 22 (weak green, Rule 9):
- **`node tests/branding-sync-pull.test.mjs` → 12/12** — the 8 source-wiring guards (both ends)
  and 4 remote-wins upsert assertions (no-session no-op; keyed by session business; overwrite +
  clear; one row) via the node:sqlite stand-in (not the app's driver, A13).
- **Server `tsc` → 0 errors**; **desktop main `tsc` → 0 errors** on the changed files.
- Full static + `check-schema-drift` / `check-rls-coverage` / `check-api-routes` /
  register-consistency / doc-refs / test-registration all green.

**Could NOT verify here (target/CI, Rule 16):** the end-to-end pull against a real server with
migration 104 live; the lock screen updating from a cloud edit; A291 propagation timing.

## Rollback (Rule 2)

```bash
git checkout 240ec66 -- apps/server/src/routes/pos.ts apps/desktop/src/main/syncEngine.ts \
  apps/desktop/src/main/localDb.ts apps/desktop/src/main/referenceBundle.ts docs/AUDIT-REGISTER.md
rm -f tests/branding-sync-pull.test.mjs
```

## Commit (direct to dev, explicit paths — never `git add -A`)

```bash
git checkout dev && git pull                    # confirm 240ec66; else re-apply the register edits
git add apps/server/src/routes/pos.ts apps/desktop/src/main/syncEngine.ts \
        apps/desktop/src/main/localDb.ts apps/desktop/src/main/referenceBundle.ts \
        tests/branding-sync-pull.test.mjs docs/AUDIT-REGISTER.md docs/MANIFEST-2026-09-21-g.md
git status --short                              # expect exactly these seven
node scripts/check-register-consistency.mjs && node scripts/check-doc-refs.mjs && node tests/branding-sync-pull.test.mjs
git commit -m "feat: A304 branding sync-down — /pos/init serves branding + till pulls to local mirror (remote-wins)"
git push
```

Then: CI green on `dev`; **migration 104 must be live on prod** for the sync to carry real data.
End-to-end proof (owner, on a till): edit branding via `PUT /api/business/branding`, wait one pull,
confirm the lock screen adopts it.
