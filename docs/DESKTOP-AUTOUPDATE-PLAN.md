# Desktop auto-update — minimal-safe plan (register D3; unblocks A1)

`DESKTOP-AUTOUPDATE.md` is the mechanical how-to (add the dep, wire the call, cut
a release, prove the loop). This is the layer it doesn't cover: the **decisions**
that gate go-live, and a **rollout that can't brick the fleet** — because the one
thing auto-update fixes is also the one thing you can't fix remotely if it breaks.

## Why this is worth doing before almost anything else

Every desktop release today is a hand-installed `.exe` per till. That's a site
visit for every fix, and it's the reason the fleet drifts (the whole point of the
`FleetPage` you just wired in). It also taxes everything else on the board: every
Phase-5 target test, every D-series fix, is a physical visit until this ships.
Auto-update changes the economics of all remaining desktop work.

## What already exists

- `autoUpdate.ts` — written and correct: dev-guarded (`app.isPackaged`),
  `autoDownload`, **`autoInstallOnAppQuit`** (never mid-service), no prerelease,
  checks on launch + every 6h. **Not wired into `index.ts`, not built, not proven.**
- `DESKTOP-AUTOUPDATE.md` — the finishing steps.
- D17 already gives per-flavour `appId`/feed separation, so a dev build can't be
  offered a prod installer (§8 of that doc).

The code is the easy 10%. The 90% is three decisions and a careful rollout.

---

## The three decisions that gate go-live

### 1. Code signing — the real blocker (given "no cert yet")

Be precise about what unsigned costs, because it's not all-or-nothing:

- **electron-updater already verifies integrity.** `latest.yml` carries a sha512
  of the installer; a tampered or truncated download is rejected. Over an HTTPS
  feed, you are safe against a *corrupted* update.
- **What's missing without a cert is *authenticity*** — Windows can't tell who
  published it. That means **SmartScreen / UAC / AV friction on install.**
- **The killer for auto-update specifically:** `autoInstallOnAppQuit` runs the
  installer with **no human present**. Unsigned, that install can stall on
  SmartScreen or be quarantined by AV — and a till that can't self-install is
  exactly the failure you were trying to remove. You already ship unsigned
  *manually* (a human clicks through at each site); hands-off removes the human,
  so the cert stops being optional the moment it's automatic.

**Recommendation:** buy an **OV code-signing certificate** before enabling
auto-update on real tills (EV if you want to skip SmartScreen's reputation
warm-up; OV is cheaper and fine for a controlled fleet). It's ~days of identity
validation and low cost — and it is the actual gate. **You can build, wire, and
prove the entire loop unsigned on a test machine now** (§6 of the how-to), so all
the engineering lands in parallel and only the go-live waits on the cert.

### 2. Install scope — `perMachine` and silent update don't mix

Your NSIS config is **`perMachine: true`** (installs to `Program Files`). A silent
`autoInstallOnAppQuit` into `Program Files` needs **elevation (UAC)** — which,
unattended, prompts nobody and fails. For hands-off updates you almost certainly
need **`perMachine: false`** (per-user install into `%LOCALAPPDATA%`, no
elevation). Trade-off: per-user installs per Windows login — fine for a
single-login till, a consideration for a shared machine. This is a real config
change, not a footnote; decide it before the first auto-update-capable build,
because switching install scope later is itself a hand-reinstall.

### 3. Feed host

- **Generic HTTPS bucket you control** (Cloudflare R2 / S3 / any static HTTPS) —
  recommended. Keeps the installer private, serves `latest.yml` + `.exe` +
  `.blockmap`, and pairs cleanly with the D17 per-flavour URLs
  (`/till/` prod, `/till-dev/` or none for dev).
- **GitHub Releases** — simplest, but public unless the repo is private, and a
  private repo needs a token baked into the client. For a commercial product,
  prefer the bucket.

---

## Minimal-safe rollout design (beyond the scaffold)

The scaffold updates every till that polls the feed, as soon as a version is
published. For a fleet where a bad build can't be recalled remotely, that's too
blunt. Two cheap additions make it safe:

1. **A server-side version gate (the kill switch).** Before `checkForUpdates`,
   the till asks the cloud for a `target_desktop_version` (a single row/setting).
   It only self-updates *toward that target*. Publishing a build to the feed then
   does nothing until you move the pointer — so you **stage**: point one canary
   branch at the new version, watch it trade a full service, then move the fleet
   pointer. And if a release regresses, you move the pointer **back** and the
   fleet stops offering it (electron-updater won't downgrade, but new tills stop
   pulling the bad one). This is the difference between "published" and "rolled
   out", and it's a few lines each side.
2. **Node conservatism.** The node is the branch's authority; if it auto-updates
   into a bug, the whole branch is down. Hold the node one step behind, or gate
   node updates behind an explicit ack, so a bad build can't take out the
   authority and the tills at once.

The scaffold already gets the rest right: **install on quit, never mid-service**;
**offline-first** (a till that can't reach the feed keeps selling and updates next
time it's online); **rollback by publishing a higher fixed version.**

---

## Work breakdown

**Group A — wire + prove unsigned (no cert needed, do now):**
1. `npm i electron-updater`; wire the one `initAutoUpdate()` call in `index.ts`
   (how-to §2). Type-check.
2. Set `perMachine: false` in `electron-builder.config.js`; understand the
   per-user data-path implication with D17's existing `%APPDATA%` split.
3. Configure the generic HTTPS `publish` target, per flavour (D17 §8): prod feed,
   **no dev feed** (dev stays hand-updated).
4. Stand up the feed bucket. Cut v(n) and v(n+1), `--publish always`, and prove
   the loop on a test machine (how-to §6). All unsigned, all on the bench-side of
   real tills.

**Group B — the safe-rollout additions:**
5. Server: a `target_desktop_version` setting + a tiny endpoint the till reads.
6. Client: gate `checkForUpdates` on that target; node holds a step behind.

**Group C — go-live (gated on the cert):**
7. Obtain the OV cert; set `CSC_LINK`/`CSC_KEY_PASSWORD`; re-cut a **signed**
   release.
8. **One-time hand-install** of the first signed, auto-update-capable build across
   the fleet (the bootstrap: a build can't auto-update itself into existence).
9. Canary one branch via the version pointer → full service → move the fleet
   pointer.

**Group D — CI (closes A1):**
10. A GitHub Action: checkout, `npm ci` in `apps/desktop`, signed
    `electron-builder --win --publish always` with secrets. Releases stop being
    hand-built from a working folder.

---

## Sequencing and the paradox to respect

**Nothing turns on for real tills until the loop is proven signed on a test
machine, because auto-update is the fix-delivery mechanism itself** — the one bug
class you cannot patch remotely is a broken updater. So: prove unsigned (A) →
add the gate (B) → signed test-machine proof (C7) → bootstrap hand-install (C8) →
canary one branch (C9) → fleet. The version pointer means the last step is moving
one value, not walking to every machine.

## Test plan — target only (bench can't run any of it)

- Installed v(n) polls, downloads, installs **on quit**, relaunches as v(n+1).
- An **offline** till doesn't update, keeps selling, updates on next online quit.
- The **version pointer** held below a published build: the till does **not**
  update until the pointer moves (the staging/kill-switch check).
- A **signed** installer runs the on-quit install with **no UAC prompt** under
  `perMachine: false` (the constraint that decides whether hands-off works at all).
- A **regressed release**: move the pointer back; new tills stop offering it.
- **Node** stays a step behind the tills (conservatism check).
- A **dev-flavour** build never sees the prod `latest.yml` (D17 §8).

## What this closes / unblocks

- **D3** — auto-update, end to end, safe to roll out.
- **A1** — the release pipeline (Group D).
- **Everything desktop** — schema bumps (`REQUIRED_DESKTOP_SCHEMA`) and every
  future D-fix and Phase-5 rollout stop being per-till site visits. This is the
  multiplier called out in `PHASE5-READPATH-PLAN.md`.

## Risks

- **The updater breaking is unrecoverable remotely** — hence prove-signed-first
  and canary-by-pointer, never a blind fleet push.
- **Branch schema skew** during a rollout: tills at one branch updating at
  different quits can transiently straddle a `REQUIRED_DESKTOP_SCHEMA` bump. The
  version pointer + node-behind mitigates; still, pair schema-bumping releases
  with a tolerant window.
- **`perMachine` decision is load-bearing** — get it wrong and hands-off simply
  doesn't work (silent UAC), or you strand existing per-machine installs and
  re-walk the fleet once.
- **Cost/time of the cert** is the only hard external dependency; everything else
  is buildable now.
