# WORKING METHOD — how a SwiftPOS session runs

Written 2026-09-23 at the owner's request, after a session of 13 deliveries in which every push landed, every CI run
was green and no time went on troubleshooting the hand-over itself. **Future sessions follow this exactly.** It sits on
top of the rules — `HANDOFF-2026-08-08-evening.md` §0, rules 1–24 — and the owner rulings in `HANDOFF-2026-09-22.md`;
it does not replace or reword them. Where this file and a rule disagree, the rule wins and this file gets fixed.

Standing rulings, restated because they changed an original rule:
- **Every delivery is a zip** mirroring the repo root, with a manifest — **docs-only included**. Rule 18 ("zip only when
  code changed") is retired (owner, 2026-09-22).
- **Rule 21 covers UI strings**: "node" or "cloud", never "server" on its own — in code, docs, tests and anything a user reads.
- **SwiftPOS is general-purpose.** Logos, menus or names of any business used as test references never appear in shipped
  code, UI strings, sample data, proposals or new docs. Use "Your Business" and generic items (A322). Dated history stays
  as written.

---

## 1. Roles

- **Owner (Eugene):** runs the commands on the Windows box (Git Bash, `C:\swiftpos\pos`), deploys cloud/dashboard, builds
  and tags desktop releases, tests on the till (**mamangina**), decides scope. Zips are saved in `C:\swiftpos\other files`.
- **Lead developer (Claude):** reads the source, builds and proves every change on a Linux bench, packages deliveries,
  gives the exact commands, and after every push independently confirms the tip and CI before saying "landed" (the
  owner's standing instruction, item 4 of the prompt in §10). Never pushes. Never assumes a push worked.

## 2. The loop

```
owner asks ──► sweep + diagnose (read source) ──► if ambiguous or growing: ASK (rule 3/12)
          ──► build + test + mutation-check ──► gates ──► register + manifest ──► zip
          ──► rehearse on a FRESH CLONE of the tip (apply · checksums · gates · rollback) ──► hand over
owner applies (3 blocks) ──► pushes ──► lead dev pulls, checks checksums + gates + CI ──► "landed" (or not, with why)
```

"Landed" means all of: the tip commit contains **exactly** the delivered files · every file's md5 matches what was
delivered · the gates exit 0 on a fresh clone · CI for **that** commit completed successfully · (when a CI step was added)
the step appears in the run's job. Anything less is reported as not landed, with the evidence.

## 3. Starting a session

1. `git clone -b dev https://github.com/oweyahillary/swiftpos.git` (or fetch + `reset --hard origin/dev`).
2. Read, in order: the newest `docs/HANDOFF-*.md`, the previous one, `HANDOFF-2026-08-08-evening.md` §0 (rules 1–24), this file.
3. Confirm the tip matches the last handoff's final commit, run the three gates, and read CI (§6).
4. Report the state in one short block, then do the rule-17 sweep for the first task **before writing code**.

## 4. Building a delivery (lead dev, on the bench)

1. **Sync first, always.** `git fetch && git reset --hard origin/dev && git clean -fd -e node_modules`. Building on a stale
   tree cost a failed gate on 2026-09-23 (-w): the register edit carried a Tree row newer than that tree's `package.json`.
2. **Sweep (rule 17).** Find every copy, caller, sibling and existing test of what is being changed — including tests with
   the same name in another folder (`tests/` vs `apps/desktop/test/`).
3. **Reproduce the bug on the tip before fixing it.** Drive the real code: the compiled engine with shims, the shipped
   bundle with `Buffer` deleted, the real component in headless Chromium (Playwright; browsers at `/opt/pw-browsers`),
   the real built middleware. Quote the exact failure.
4. **Fix, then test the fix by execution**, and write a committed test that runs the real thing where CI can; a source
   pin only where CI cannot (and say so).
5. **Mutation-check (rules 10, 23, 24):** break the fix one way at a time; each break must turn a named check red.
   Rebuild between engine mutations (stale `dist/` gives misleading results). If a mutation survives, the test is blind —
   fix the test, say so in the manifest.
6. **Gates:** the three register/doc gates, `check-test-registration` (new test files must be wired into a package script,
   CI step or discovering runner), `run-all` (run it in the background if it may exceed the tool's time limit), the
   type-check ratchet, dashboard build, desktop tsc, and whatever suite the change touches. Node 24 when behaviour may
   differ (the owner runs 24; the bench is 22 — a Node 24 binary can be downloaded for the check).
7. **Register:** entries, statuses, evidence, Counts, the Open line (re-derived by the gate), Last updated, changelog row.
8. **Manifest** `docs/MANIFEST-YYYY-MM-DD-<letter>.md`: base commit, why, files table (the manifest counts itself),
   verification as commands + what they printed, what is owed on target, a rollback line that works **both** before and
   after commit (`git rm -q --ignore-unmatch … && rm -f …`).
9. **Zip** only the changed/new files, paths from the repo root (`zip -X -q` from a file list).
10. **Rehearse on a fresh clone of the tip:** unzip · `md5sum -c` · gates · (for a bump: the version step) · commit · run
    the rollback · confirm `git diff <base>` is empty. Only then hand it over.

## 5. Handing over — the three blocks (never change this shape)

Every delivery message gives the owner exactly these, each **pasted on its own**:

**Block 1 — apply.** Resets to the tip and extracts INTO the repo (the owner's zips live in `C:\swiftpos\other files`;
extracting anywhere else was the 2026-09-23 `-l` failure: only the new file landed).
```bash
cd /c/swiftpos/pos && git fetch && git reset --hard origin/dev && git log -1 --format=%h && \
unzip -o "/c/swiftpos/other files/swiftpos-delivery-YYYY-MM-DD-<x>.zip" -d .
```
Say which commit it must print.

**Block 2 — prove it applied.** A heredoc of the md5 of every file; every line must say `OK`.
```bash
md5sum -c <<'EOF'
<md5>  <path>
EOF
```

**Block 3 — verify, commit, push — CHAINED with `&&`** so any failing check stops the commit. (Unchained, a failed check
scrolled past and the commit went through anyway — 2026-09-23 `-n`.)
```bash
<build/test commands> && \
node scripts/check-register-consistency.mjs && node scripts/check-doc-refs.mjs && node scripts/check-root-clean.mjs && \
git add -u && git add <each NEW file, by path> && \
git commit -m "<what> (delivery -<x>)" && \
git push origin dev
```
`git add -u` + new files **by path** — never `git add -A` (untracked local files, e.g. a tester's HTML, must not ride along).
State what each test must print ("expect 18 passed"), and "if the chain stops, send me the output".

Then, in plain language: what changed, what was proven, what the owner verifies next and on what (deploy / build / till).

## 6. Confirming "landed" (lead dev, after every push)

```bash
cd /tmp && rm -rf tip && git clone -q -b dev https://github.com/oweyahillary/swiftpos.git tip && cd tip
git log --oneline -2 && git show --stat --format= HEAD | tail -1      # the commit holds exactly the delivered files
md5sum -c --quiet /tmp/<x>.md5 && echo "all files match"            # the md5 list saved when zipping
for s in check-register-consistency check-doc-refs check-root-clean; do node scripts/$s.mjs >/dev/null 2>&1; echo "$s exit=$?"; done
```
**CI:** the GitHub REST API rate-limits this bench, so read the Actions page and poll until the run for the new number
completes:
```bash
for i in $(seq 1 20); do S=$(curl -s "https://github.com/oweyahillary/swiftpos/actions?query=branch%3Adev" \
  | grep -oE 'aria-label="[^"]*Run <N> of CI' | head -1); case "$S" in *running*|*queued*|"") sleep 15;; *) break;; esac; done; echo "$S"
```
Look for `completed successfully`. When a delivery adds a CI step, open the run's job pages and confirm the step's name is
there. Release runs appear as `Run <n> of Release desktop`. Tags: `git ls-remote --tags origin | grep vX.Y.Z`.
If the tip does not match: say so plainly, show which files differ, give a recovery (usually: re-extract with `-o`, check,
`git add -u`, commit) — or re-issue as the next letter if the delivery itself needs a fix.

## 7. Desktop release (bump + tag)

Three files change together or CI goes red: `apps/desktop/package.json`, `apps/desktop/package-lock.json` (both by the
owner's `npm version X.Y.Z --no-git-tag-version`) and the register Tree row `desktop **vX.Y.Z**` (in the delivery).
The version field itself is never in a zip (rule 22). Sequence:
1. Delivery with the Tree row → owner applies → runs `npm version` → **one commit** → push.
2. Lead dev confirms CI green on that commit.
3. Owner tags **on that commit**, with a guard:
```bash
cd /c/swiftpos/pos && git pull && \
node -e "const v=require('./apps/desktop/package.json').version; if(v!=='X.Y.Z'){console.error('package.json is '+v+' — stop');process.exit(1)} console.log('package.json X.Y.Z ✓')" && \
git tag vX.Y.Z && git push origin vX.Y.Z
```
4. `Release desktop` builds on the tag; the installer's version comes from `package.json`, not the tag name. Never move a
   pushed tag — cut the next version instead. Record the release result in the Tree row once the till runs it.

## 8. Target verification

- An item closes only on target evidence (rule 16): the owner's results, pasted as returned, recorded in that day's
  verify log in `docs/` (named like `VERIFY-LOG-2026-09-23.md`) and on each register entry.
- Checklists: markdown in `docs/`, plus an interactive HTML copy in `docs/checklists/` (house style of
  `VERIFY-CHECKLIST-v0.6.0.html`: Pass/Fail/Skip, a note required on Fail, "Record:" prompts, progress kept in the browser,
  output in the `A1: PASS — note … Summary … Failed:` format).
- Before a retest, re-check every expectation against current behaviour — an outdated expectation marks correct behaviour
  as a FAIL (2026-09-23: `#777777` was wrongly listed as "must be rejected").
- Ask the tester to record what separates causes (did "Saved." appear? which form was used? how many seconds?).

## 9. Pitfalls met on 2026-09-23, and the fix now standard

| What happened | Standard now |
|---|---|
| Zip extracted outside the repo; only the new file was committed | Block 1 extracts with `-d .` from the repo root; Block 2 proves every file |
| A failed check didn't stop the commit | Block 3 is one `&&` chain |
| `spawnSync npx ENOENT` on Windows | On win32 call `npx.cmd`, through a shell |
| `"npx.cmd"` quoted → cmd.exe resolved `%~dp0` to the repo → `npx-cli.js` not found | Command NAME unquoted, arguments quoted, one string (`execSync`) — no DEP0190 on Node 24 either |
| A Linux stand-in for `npx.cmd` could not show cmd.exe behaviour | Say so (rule 9); the owner's Windows run is the real test |
| A test spawned `node_modules/.bin/tailwindcss` → `ENOENT` on Windows (it is a `.cmd`) — 2026-09-24-f | Never spawn a `.bin` file: run the package's JS entry with `process.execPath` (`require.resolve('<pkg>/lib/cli.js')`), or use its Node API |
| CI red on a stale pin: a desktop test pinned a line the slice changed; `run-all` does not run `apps/desktop/test` — 2026-09-24 (#394) | Before hand-over run EVERY test CI runs: `run-all` **and** every `apps/desktop/test/*.test.mjs` (after `npx tsc -b tsconfig.main.json`). Sweep for tests that pin ANY line you edit, not only the pattern you are changing |
| A dashboard control verified in LIGHT mode only was near-invisible in DARK mode, the dashboard's default — 2026-09-24 (A327) | The dashboard is dark-first (light mode = overrides in `index.css`): write dark-first classes, and check every new dashboard UI in BOTH modes in the browser |
| Node crashed on exit on Windows after a test PASSED — `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (libuv), 2026-09-24-j | New tests end with `process.exitCode = fail ? 1 : 0;`, not `process.exit()`. Follow-up: 56 older tests still call `process.exit` — convert when touched |
| A colour sweep matched Tailwind CLASSES only; the main web POS colours with inline hex/rgba and was counted as zero — the owner saw green Charge beside themed Confirm (2026-09-25, A328) | A sweep must match every form the code uses (classes, hex, `rgb(a)`, named colours) AND list every file scanned with its count; a key screen with 0 hits is a red flag, not a pass |
| Tests passed in Node because Node has `Buffer`; the browser does not | Run the shipped bundle with `Buffer` deleted |
| A regex test proved "wired", never "accepts the real payload" | Run the real middleware on each caller's real payload |
| Refusal tests "passed" for the wrong reason | Every refusal starts from a payload that passes |
| A harness default answered the refresh endpoint with 200 → engine silently de-configured | Unrouted refresh = 401 |
| A new test shared a name with an old one in another folder | Sweep both test folders; rename to be distinct |
| Built on a stale tree — twice (-w, and this handoff) | Sync first (§4.1), every time, even for docs |
| Tagged before the lead dev confirmed CI | Tag after confirmation (§7) — it worked this time; the guard keeps it safe |

## 10. Session-start prompt (owner pastes this to begin)

> You are my lead developer on SwiftPOS. Repo: https://github.com/oweyahillary/swiftpos.git (branch dev).
>
> Before touching code:
> 1. Clone the repo and read, in order: the newest docs/HANDOFF-*.md, the one before it, docs/WORKING-METHOD.md, and the
>    working rules in docs/HANDOFF-2026-08-08-evening.md §0 (rules 1–24).
> 2. Follow docs/WORKING-METHOD.md exactly — the delivery loop, the three command blocks, how you confirm "landed", the
>    release sequence. Standing rulings: every delivery is a zip mirroring the repo root with a MANIFEST, docs-only
>    included; rule 21 (node/cloud, never "server") covers UI strings; never name any reference business — SwiftPOS is
>    general-purpose.
> 3. If a rule is ambiguous, ask me rather than guess. If a fix starts growing, stop and ask.
> 4. After every push I make, pull origin/dev yourself, check the files and gates, and read CI on that commit before
>    saying it landed.
>
> Today: start with the "Next session" list in the newest handoff. Confirm the tip and CI first, then do the rule-17 sweep
> for the first item and report what you found before writing code.
