# Working rules — the standing rules, in one place

The complete standing rules for this project, **lifted here on 2026‑11‑15** so they live in a first‑class doc instead of
inside a dated handoff. [WORKING-METHOD.md](WORKING-METHOD.md) is the "how a session runs" companion that sits on top of
these (roles, the build→prove→manifest→commit loop, what "landed" means). Where the method and a rule disagree, the rule
wins and the method gets fixed.

> The original verbatim §0 (with its full war‑stories and examples) is preserved in the archived handoff
> `HANDOFF-2026-08-08-evening.md` inside `C:\swiftpos\other files\zaptill-handoffs-archive-2026-11-15.zip`. **Rule numbers
> are stable and never reused** — they're cited by ID across `AUDIT-REGISTER.md`.

> **Delivery is a commit now (owner, 2026‑09‑26):** deliveries are **no longer zips** — every delivery is a **commit on the
> session branch with a manifest**, which the owner fast‑forwards onto `dev`. This supersedes the *zip mechanics* in rules
> 1–4, 18 and 22; their **intent still holds**, now expressed as a commit. (Owner, 2026‑09‑22: rule 1 governs **every**
> delivery, docs‑only included — the rule‑18 "no archive" exception is retired; rule 21 covers **UI strings** too.)

## The rules

### Delivery
1. **Only the changed files ship** (as a commit, never the whole tree).
2. **Every delivery carries a manifest and a rollback line** — the file list, one line per file on what changed and why,
   and how to undo it; reviewable without applying it.
3. **Deliveries are cumulative on the session branch**; the branch tip supersedes everything before it. *(Was: lettered
   cumulative zips.)*
4. **State the base commit.** If a whole‑file change has moved in the tree, say so and ship a patch, not an overwrite.

### Evidence
5. **Research before coding** — read the current source, not the docs, not memory. The docs here have been wrong about the
   tree more than once.
6. **Full review, not symptom fixes** — find the *class* of problem and sweep for the rest; fixing the line that shouted is
   how the next four arrive one at a time.
7. **Never say "fixed" — say what was run and what it printed**, plus an explicit list of what could NOT be verified.
   "Should work" is banned.
8. **Build and test in a sandbox before every handover**, not just type‑check. A type‑checker green is not a run green.
9. **State the environment a green came from.** Target is **Windows, Node 20, better‑sqlite3 under Electron** (see
   *Environment* below). A Linux green is a weaker claim and must say so.
10. **A test that passes with the bug present is decoration.** Mutation‑check: remove the fix, confirm the test fails,
    restore it.
11. **Errors travel verbatim** — full text, status code, and the server `ref`. Paraphrased errors send both sides down the
    wrong hole.

### Judgement
12. **If a fix starts growing, stop and ask.** Two files becoming five means the diagnosis was wrong, not that the fix is
    bigger.
13. **Additive during a deploy window** — no deletions, renames or migrations when a release is in flight; every change
    revertable by restoring one file.
14. **Nothing ships without a register ID.** Findings get a number and an `AUDIT-REGISTER.md` entry, in the same delivery
    as the code.
15. **Bump the desktop version on any desktop change, and TAG AFTER THE BUILD** — the version is decided *by* the build
    (`release:patch` runs `npm version patch`). Batch related fixes into one bump; read the artefact filename, then tag.
16. **Some verification is only possible on the target.** Every handover ends with an explicit list of what the other side
    must check; nothing is closed on bench evidence alone.

### Working with this codebase
17. **Assume it's already built, halfway.** Sweep for the existing implementation and read it *before* designing —
    proposing something that already exists is worse than proposing nothing (it gets built twice and the copies drift).
    Say what exists, then what's genuinely missing, then the delta; if a design duplicates existing machinery, say so and
    withdraw it.
18. **Docs‑only deliveries still ship as a commit** (owner 2026‑09‑22 retired the old "no archive for prose" exception).
19. **Nothing but `README.md` in the repo root.** Documents live in `docs/`.
20. **Be sure before you proceed, then build it clean and don't break it.** A green from *every* existing gate is part of
    "not broken"; **never loosen a gate to accommodate your change** — the change moves, not the assertion; if the right
    guard doesn't exist yet, **don't ship the thing that needs it** (record it as a finding); additive beats clever.
21. **Say "node" or "cloud" — never "server" on its own.** Applies to code comments, commit messages, the register,
    handoffs, **UI strings**, and anything said to the owner. `getServerUrl()` returns the **cloud** url.

    | Term | Means | Don't write |
    |---|---|---|
    | **node** | the branch machine that serves its tills | "local server", "branch server", "the server" |
    | **cloud** | the hosted API | "the server", "remote", "backend" |
    | **till** / **peer** | a selling terminal that is not the node | "client" |
    | **office** | a node that cannot sell | — |
22. **A delivery carries the change, never the version.** Never include a file whose only change is a version bump, or
    which the recipient's tooling owns (`package.json` version fields, lockfiles, `CHANGELOG`). Check the artefact filename
    against the intended version before tagging.
23. **Mutation‑check the GATE, not only the fix.** A gate that cannot fail is the very thing it was built to prevent; a
    gate that cries wolf gets switched off — worse than no gate.
24. **A mutation check proves an assertion *notices* a change; it cannot prove it measures the RIGHT thing.** After it
    passes, still ask whether the assertion is pointed at the behaviour that matters.

### Environment (target)
The tills run **Windows, Node 20, Electron 43.4.0** (was 35.x). `node:sqlite` needs Node ≥ 22.5 — the tills are on 20.
`better-sqlite3` is rebuilt by `postinstall` against **Electron's** ABI (`NODE_MODULE_VERSION` 133, not Node 20's 115), so
**plain `node` can never load it** — that is not a broken checkout. **Anything touching SQLite runs under Electron‑as‑Node**
(`test/run-under-electron.mjs`; `npm run test:desktop`).

---

## Domain conventions (where the detail lives)
- **Per‑business‑type wording** → [BUSINESS-TYPE-WORDING.md](BUSINESS-TYPE-WORDING.md) (driven by `shared/businessTerms.ts`).
- **General‑purpose (A322):** no real business's logo, menu or name in shipped code, UI, sample data, proposals or new
  docs — use "Your Business" and generic items. (Dated history stays as written.)
- **Marketing** → restaurant/hotel POS only, true/tested claims only, no pricing on artwork → [POSTER-DESIGN-RULES.md](POSTER-DESIGN-RULES.md) + [POSTER-DESIGN-SYSTEM.md](POSTER-DESIGN-SYSTEM.md).
- **Manuals** → every manual/guide ships as `.md` **and** `.docx` **and** a self‑contained `.html` ([Manuals/](Manuals/)).
- **No emoji in the product UI; Lucide React is the icon system** (marketing artwork uses inline SVG, not emoji).
- **Releases** are **batched** and tagged by the owner when the batch is ready; no tag per feature. Android launch =
  v2.0.0; shared‑components batch = v1.1.0. Nothing deploys without the owner.

## Ops guardrails (hard lines)
- **Never commit or push for the owner** — provide paste‑ready `git` commands (Git Bash paths); commit messages end with
  the session's attribution line.
- **Rewrite, don't patch** — fix the root cause cleanly; no band‑aids on old code.
- **Never touch production Supabase** — the owner runs any prod DB work; Claude guides and reads outputs (see
  [SUPABASE-PROD-MOVE-2026-11-15.md](SUPABASE-PROD-MOVE-2026-11-15.md)).
- **Artefacts stay in the repo** (never only in temp, never a cloud artifact host).
- **Run every CI step locally before a commit** (not just the `check-*` ones).
