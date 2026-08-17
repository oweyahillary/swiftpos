# BRANCH-SERVER-PLAN.md — recorded as a tombstone, not reconstructed

> **This document was cited but never committed.** It is filed here as an honest
> landing point so `check-doc-refs` resolves and no reader follows a citation
> into nothing. Registers **A39** and **A40** track its history. Nothing of the
> original plan is reconstructed below — a plausible reconstruction would be
> worse than an honest gap, because the next reader could not tell which parts
> were real. That is the same reasoning A40 gives for the `DESKTOP_DESIGN.md`
> tombstone.

## What it was

`BRANCH-SERVER-PLAN.md` was the original Phase 2 / Phase 3 plan for the
branch-server (branch-node) architecture. Its surviving citation origin is
`docs/PHASE2-3-DESIGN.md:3`, which opens by describing itself as *"One amendment
to BRANCH-SERVER-PLAN.md"* — so `PHASE2-3-DESIGN.md` is an amendment **to** this
plan, not the plan itself. The base plan was never filed in the repository or in
its git history (register A39).

## Where the surviving design actually lives

The parts that were captured, and are authoritative, are these live documents:

- **`docs/PHASE2-3-DESIGN.md`** — the amendment: replicated star (not true mesh),
  three resolved decisions, and the Phase 2 mitigations. Read it with its own
  2026-08-10 status banner: it records what was built, not a proposal.
- **`docs/BRANCH_AUTHORITY_AND_SYNC_DESIGN.md`** — branch authority, sync, and the
  `node` role.
- **`docs/PHASE5-NODE-AUTHORITY.md`** — node authority and failover.
- **`docs/PHASE6-BRANCH-SETTINGS.md`** — branch-local settings.

## What is genuinely gone

The original plan's own framing — the pre-amendment design and whatever rationale
it carried before `PHASE2-3-DESIGN.md` amended it. Where shipped behaviour and
the surviving docs disagree, the **code is the authority**; registers A17, A19 and
A24 record the known divergences (the node is a replica not a relay, reference
data does not flow to an offline peer, and the node cannot authorise anybody).
