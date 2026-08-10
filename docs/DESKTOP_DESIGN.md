# DESKTOP_DESIGN.md — LOST. What it covered, and where that lives now

**Status: the original is lost.** Searched the repository, its full git history
(`--diff-filter=D`), and the owner's local folders on 2026-08-10. Not found.

This file exists so the eleven citations across the tree resolve to *something*,
and so nobody spends another afternoon hunting for it. Register **A39**.

> **This is not a reconstruction.** Nothing here is invented. Every line below is
> either a direct quotation from a surviving citation, or a pointer to code that
> demonstrably implements what was cited. Where the reasoning is gone, this file
> says so rather than guessing — a plausible-sounding reconstruction would be
> worse than an honest gap, because the next reader could not tell which parts
> were real.

---

## Why it mattered

`BRANCH_AUTHORITY_AND_SYNC_DESIGN.md` — the design PHASE6 is built against —
opens by calling itself *"Companion to `DESKTOP_DESIGN.md`"* and twice defers to
it for definitions. Losing the companion is why A39 was raised as P1 rather than
a tidy-up.

**The good news:** the parts PHASE6 depends on were implemented and are readable
in code. What is lost is the *reasoning*, not the design.

---

## What each citation referred to, and where it lives now

### 1. The two-products model
> `migrations/18_web_access_remodel.sql:4` —
> *"Aligns the schema with the two-products model (see DESKTOP_DESIGN.md)"*

**Now in code, unambiguously.** Two separately-sold things:

| Product | Column | Gate |
|---|---|---|
| Desktop licence, per branch | `branches.desktop_licensed` | `pos.ts:87`, `auth.ts:1174` |
| Web access, per business, 10k/yr | `businesses.web_access_expires_at` | `lib/webAccess.ts` |

`lib/webAccess.ts` carries the renewal ladder in full — `active → grace (21d) →
reports_only (7d) → locked` — and states the rule the whole model rests on:
*"Offline desktop POS is NOT affected by any of this — desktop tills keep selling
regardless of web-access state."*

Migration 18 **is** the implementation. Read it and `webAccess.ts` together and
the model is complete.

### 2. The node role
> `BRANCH_AUTHORITY_AND_SYNC_DESIGN.md:28` — *"The Manager PC is the `node` role
> from `DESKTOP_DESIGN.md`, widened from 'receives orders' to 'also owns the
> branch catalogue/staff and hosts the management UI.'"*

**Now `deviceConfig.ts:26`**, and wider still than that sentence describes:

```ts
export type DeviceRole = 'till' | 'node' | 'office';
```

`office` — a node that cannot sell — post-dates the lost document. See
`isNodeRole()` and `canSell()` in the same file, and `PHASE5-NODE-AUTHORITY.md`
§12 for why every gate must ask `isNodeRole()` and never `=== 'node'`.

### 3. Build sequence steps 5–6
> `BRANCH_AUTHORITY_AND_SYNC_DESIGN.md:157` — *"Cloud order uplink + lapse queue
> (web-access clients): gate on web access; queue-and-flush on renewal. (Ties
> into steps 5-6 of `DESKTOP_DESIGN.md`.)"*

**Partly built, and it diverged.** BRANCH_AUTHORITY §3 says *"the PC is the sole
uplink"* and *"tills are never involved in cloud sync"*. The tree does the
opposite: every till pushes its own orders to the cloud, and the node is a
replica reached separately.

`syncEngine.ts:1138-1151` records that change deliberately, with a sound
engineering reason — one status column cannot hold two destinations' opinions —
**and no sign of knowing a design said otherwise.** That is the cost of an
untracked specification, and it is register **A19**, still open.

What steps 5–6 actually said is **lost**. The lapse queue described in
BRANCH_AUTHORITY §4 is not implemented.

---

## What is genuinely gone

- The **reasoning** behind the two-products split — why per-branch desktop and
  per-business web, rather than another cut.
- The full **build sequence**, of which only steps 5–6 are quoted anywhere.
- Whatever else it covered. Eleven citations survive; the document may have been
  much larger, and there is no way to know.

**Do not fill these in from memory later.** If the original resurfaces, replace
this file wholesale. If a decision needs making that this file cannot answer,
make it fresh, write it down, and commit it — which is the entire lesson.

---

## The lesson, kept short

A design that lives outside the repository is a design that will be lost, and its
citations make it look present right up until someone tries to follow one.

`scripts/check-doc-refs.mjs` (in CI) now fails the build if a comment cites a
`.md` that is not in the tree. It would have caught this the day the citation was
written.

**Two other documents are still missing and should be added if they exist:**

| Missing | Cited by |
|---|---|
| `SwiftPOS_eTIMS_Integration_Scope.md` | `apps/server/src/lib/etims/provider.ts:4`, citing §2 |
| `BRANCH-SERVER-PLAN.md` | `docs/PHASE2-3-DESIGN.md:3` |
