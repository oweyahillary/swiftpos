# Working rules — the one place to find them all

A map of every standing rule this project runs by. It **does not restate the rules** (that risks drift — and the rule
always wins over any summary); it gathers the **sources** and the **conventions** so you don't have to hunt. When a rule
changes, change it at its source, not here.

## The hierarchy (lowest wins when they disagree)
1. **Base rules 1–24** — `HANDOFF-2026-08-08-evening.md` §0. The original operating rules.
2. **Owner rulings** — `HANDOFF-2026-09-22.md` (and later dated handoffs). These override specific base rules.
3. **The session method** — [WORKING-METHOD.md](WORKING-METHOD.md). Sits *on top* of 1–2; "where this file and a rule
   disagree, the rule wins and this file gets fixed."

Read [WORKING-METHOD.md](WORKING-METHOD.md) first — it's the current, owner‑blessed consolidation of how a session runs
(roles, the build→prove→manifest→commit loop, what "landed" means, the gates).

## Standing rulings (restated in WORKING-METHOD because they changed an original rule)
- **Every delivery is a commit on the session branch** (`claude/…`) with a manifest; the **owner** fast‑forwards it onto
  `dev`. Claude pushes **only** to the session branch — never `dev`, never a tag — and never assumes a push worked
  (independently confirms the tip + CI before saying "landed").
- **Rule 21 — wording:** "node" or "cloud", never "server" on its own, in code, docs, tests and any user‑visible string.
- **General‑purpose (A322):** no real business's logo, menu or name in shipped code, UI, sample data, proposals or new
  docs — use "Your Business" and generic items. (Dated history stays as written.)

## Domain conventions (where the detail lives)
- **Per‑business‑type wording** → [BUSINESS-TYPE-WORDING.md](BUSINESS-TYPE-WORDING.md) (driven by `shared/businessTerms.ts`).
- **Marketing** → restaurant/hotel POS only, true/tested claims only, no pricing on artwork → [POSTER-DESIGN-RULES.md](POSTER-DESIGN-RULES.md), [POSTER-DESIGN-SYSTEM.md](POSTER-DESIGN-SYSTEM.md).
- **Manuals** → every manual/guide ships as `.md` **and** `.docx` **and** a self‑contained `.html` ([Manuals/](Manuals/)).
- **No emoji in the product UI; Lucide React is the icon system** (a general dev rule — marketing artwork uses inline SVG, not emoji).
- **Releases** → desktop releases are **batched** and tagged by the owner when the batch is ready; no tag per feature.
  Android launch = v2.0.0; shared‑components batch = v1.1.0. Nothing deploys without the owner.

## Ops guardrails (hard lines)
- **Never commit or push for the owner**; provide paste‑ready `git` commands (Git Bash paths). Commit messages end with
  the session's attribution line.
- **Rewrite, don't patch** — fix the root cause cleanly; no band‑aids on old code.
- **Never touch production Supabase** — the owner runs any prod DB work; Claude guides and reads outputs. (See the
  2026‑11‑15 move: [SUPABASE-PROD-MOVE-2026-11-15.md](SUPABASE-PROD-MOVE-2026-11-15.md).)
- **Artefacts stay in the repo** (never only in temp, never published to a cloud artifact host).
- **Run every CI step locally before a commit** (not just the check‑* ones).

> Several of these are also held as assistant memory so they persist across sessions. This file is the human‑readable
> gathering; `WORKING-METHOD.md` + the dated handoffs remain canonical.
