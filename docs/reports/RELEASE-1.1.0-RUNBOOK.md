# Desktop v1.1.0 release runbook (prepared 2026-11-08)

**Status: PREPARED FOR YOUR REVIEW. Nothing merged, deployed, or tagged.** Every git/deploy/DB step below is yours to run — I don't commit, push, deploy, or touch the prod DB. CI is green on the work (`ci.yml` run 42457131099, `android.yml` 42457131023).

---

## What this release actually is

This is **not** a 1.0.x patch. The desktop fixes you want are built on top of the shared-components refactor, so they can't be peeled off it. Releasing them **is** the v1.1.0 batch. Promoting `dev → main` ships, in one move:

- **Shared components** — one design for both POS, shared code living once in `packages/core` + `packages/ui` (claimed byte-identical output, installer verified in CI). This is the v1.1.0 structural change.
- **8n category layout** — categories in a side panel or across the top, per branch.
- **Transfer "MOVED" kitchen ticket** + web pump keypad.
- **M-Pesa statement report** (online licence).
- **Owner can join a running shift** fix.
- **migration-158 credit-ageing** fix.
- **Neutral POS table cards** (the shared CashierScreen change — visible on the desktop POS too).

Riding along on `main` (unavoidable with a `dev → main` merge, but **not** released as a product):
- **Android Till** source (stage 0/1/2 + premium Batch 1). **No APK is built from a desktop tag** — Android stays on its own dev track. Its source on `main` is still **pinned to dev-api**, so *do not cut an Android release off `main`* until that pin is flipped. Not relevant to this desktop release.

---

## Blast radius — the irreversible points

1. **Pushing the version bump to `dev`** → only runs `ci.yml` on dev. Does **not** deploy prod (Render deploys from `main`). Safe.
2. **Merging `dev → main`** → **PRODUCTION CLOUD DEPLOY** of the server **and** the web POS (Render, from `main`). This is the point of no easy return. The web POS goes to the shared-components build for every online user.
3. **Migrations 189 & 190 on the prod DB** → your job, via your usual migration runner. Both are **additive + idempotent** (189 adds two nullable columns; 190 registers one permission and grants it once). Safe to run **before** the merge while prod still runs 1.0.24. Run them first so there's no window where new code is live without its schema. Migration 190 bumps `permissions_version`, so cashier tokens renew once (benign).
4. **Tagging `v1.1.0` on `main`** → builds the desktop installer → rollout. Canary on one till before the fleet.

---

## Step 1 — version bump on `dev` (run now)

The version lives in exactly 3 files that must move together (guarded by `release-version.test.mjs` for the first two and `check-register-consistency.mjs` for the third):

```bash
cd /c/swiftpos/pos
git checkout dev
git pull origin dev

# 1 + 2: the two version files move together
sed -i 's#"version": "1.0.24"#"version": "1.1.0"#' apps/desktop/package.json
sed -i "s#export const RELEASE = '1.0.24';#export const RELEASE = '1.1.0';#" packages/core/src/release.ts

# 3: the AUDIT-REGISTER Tree line must name the shipped version (check-register-consistency rule 3)
perl -0pi -e 's/desktop \*\*v1\.0\.24\*\*/desktop **v1.1.0** (shared components: one design for both POS, shared code in packages core and ui; 8n category layout per branch; Transfer MOVED kitchen ticket and web pump keypad; M-Pesa statement report; owner joins a running shift; migration-158 credit-ageing fix; neutral POS table cards) — before it **v1.0.24**/' docs/AUDIT-REGISTER.md

# verify (fast, no build): the register agrees with package.json
node scripts/check-register-consistency.mjs

# review, then stage only the 3 version files
git diff
git add apps/desktop/package.json packages/core/src/release.ts docs/AUDIT-REGISTER.md
```

Then commit (the feature work is already on dev — this commit is the version bump only):

```bash
git commit -m "Desktop 1.1.0: shared components (one design for both POS), 8n category layout per branch, Transfer MOVED ticket + web pump keypad, M-Pesa statement report, owner joins a running shift, migration-158 fix" -m "Version bump only: apps/desktop/package.json and packages/core/src/release.ts move together (release-version.test.mjs); the AUDIT-REGISTER Tree line follows (check-register-consistency.mjs). The features are already on dev." -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"

git push origin dev
```

`ci.yml` runs on the dev push. **Wait for it to go green before Step 2.**

---

## Step 2 — open the release PR `dev → main` (after dev is green)

```bash
gh pr create --base main --head dev --title "Release v1.1.0 — shared components, 8n category layout, Transfer MOVED ticket, M-Pesa statement" --body "<see PR body below>"
```

**PR body:**

> Release **v1.1.0** (desktop + production web/server).
>
> **Ships:** shared-components refactor (one design for both POS, shared code in `packages/core` + `packages/ui`); 8n category layout per branch; Transfer "MOVED" kitchen ticket + web pump keypad; M-Pesa statement report (online licence); owner-joins-a-running-shift fix; migration-158 credit-ageing fix; neutral POS table cards.
>
> **DB:** run migrations **189** (android approved versions — additive) and **190** (pos_layout permission — additive, grants once) on prod **before merge**.
>
> **Deploy:** merging deploys the prod cloud (server + web POS) from `main`.
>
> **Android:** source rides along, **no APK built** from this; Android app stays on its dev track (still dev-api pinned).
>
> 🤖 Generated with [Claude Code](https://claude.com/claude-code)

**Do not merge yet.** Wait for CI green, then do Step 3 → Step 4.

---

## Step 3 — migrations on prod (before the merge)

Run on the prod DB via your usual runner (I don't touch prod):
- `migrations/189_android_approved_versions.sql`
- `migrations/190_pos_layout_permission.sql`

Both are additive and safe on the current prod code (1.0.24). 190 will renew cashier tokens once.

---

## Step 4 — merge + deploy + tag

1. **Merge the PR** (`dev → main`). → Render deploys the prod server + web POS. Watch the Render deploy go healthy and the web POS load.
2. **Tag the desktop release:**
   ```bash
   git checkout main && git pull origin main
   git tag v1.1.0
   git push origin v1.1.0
   ```
   (This triggers the desktop installer build.)
3. **Canary:** install v1.1.0 on **one** till first. Confirm it opens, sells, prints, and the shared-components screens look right. Only then roll to the rest.

---

## Rollback notes

- **Before merge:** nothing to roll back — just don't merge.
- **After merge (cloud):** redeploy the previous `main` commit on Render if the web POS misbehaves. The migrations are additive, so they don't need reverting for 1.0.24 code to run; reverse SQL is in each migration's header comment if you ever want them gone.
- **Desktop:** a bad installer is handled by your normal update-approval hold (don't approve 1.1.0 for the fleet until the canary passes).
