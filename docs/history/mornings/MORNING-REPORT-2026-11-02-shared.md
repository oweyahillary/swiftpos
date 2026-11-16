# Morning report — 2 November 2026: shared components, batch G

Night work was on branch `shared-components` (worktree `C:\swiftpos\pos-shared`). Nothing is committed. `dev` is
untouched apart from this report. The full write-up is section **8g** of the shared-components plan document. That
document is on the branch only.

## 1. Where the refactor stands

| Step | State |
|---|---|
| 1. The package mechanism | Done |
| 2. Shared logic into `packages/core` (batches A–E) | Done: 48 modules, no copies left |
| 3. POS screen pieces into `packages/ui` | In progress: MethodDot and Pager (batch F), **category panel (batch G, tonight)** |

**Step 3, still to do:**
- **Waiting for the dev merge:** the money field and tender keypad, and the cart lines. Dev's A619 rewrote both payment
  screens and the cart.
- **Need your decision first,** because the two POS differ:
  - Forecourt and pumps: different designs.
  - Fuel keypad: the web has no keypad.
  - Product tile: different badges and wording.
  - NoteModal: different example text.
  - WeightModal and KitchenVoidModal: they behave differently.

**After step 3:** take in dev's changes, a final review, merge into `dev`, then the platform move (VPS and our own sign-in).

## 2. Batch G (tonight)

**Moved:** the category panel and its parts (menu bar, category chips, the panel toggle, the "Later" button) into one
file in `@zaptill/ui`. Each POS keeps its own look in a thin wrapper.

**Proof:**
- Rendered markup, old against new: 25,948 renders per POS, **0 differences**.
- Stylesheets: byte-identical.
- Seeded changes (a swapped file, a class, a size) were caught, so the comparison works.

**One rule broken: the desktop POS main chunk grew by 611 bytes** (457,654 → 458,265; still under the 450 kB budget at
446.9 kB).
- The category panel is part of the sale screen, so its look sits in the main chunk.
- **Your call: accept it, or undo the move.** The undo steps are in section 8g.
- I'd accept it: 0.13%, with nothing visible changed.

**Left, with reasons:** forecourt, fuel keypad and product tile (see above).

## 3. Checks on the branch

**Full CI:** 265 steps, 10 failures, none caused by batch G:
- the usual noise: no `python3`, the migrations `npm install`, the libuv exit crash after "N passed", and the time-zone
  case in desktop money reports;
- **branch server hardening** failed once, then passed on its own (45 of 45).

**Per-file loop:** 315 OK, plus 3 that passed and then hit the exit crash.

**Migration tests:** 96 of 97 pass; the other is the usual 41–42 "all green" case.

**Other checks:**
- `check-shared-sync`: "48 modules … no copies".
- Doc refs: OK.
- Typechecks: clean.

**One gap:** `check-shared-sync.mjs` is not a step in `ci.yml` on the branch, so it only runs when started by hand. It
should be added before the branch is merged.

## 4. Your steps

**1. Commit batches F and G on the branch** (one commit):

```bash
cd /c/swiftpos/pos-shared
git add -A apps packages scripts tests docs
git status --short
git commit -m "Shared components batches F and G and a clean-code pass: MethodDot, Pager and the category panel (menu bar, chips, panel toggle, Later) moved to @zaptill/ui, each POS keeping its look in a thin wrapper (renders identical, stylesheets byte-identical; the desktop main chunk +611 bytes for the panel); WeightModal, NoteModal, KitchenVoidModal, forecourt, fuel keypad and product tile left (they differ); packages/core tidied without behaviour change (385,742 old-vs-new cases identical); check-shared-sync covers the look wrappers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin shared-components
```

Before you commit, check that `git status --short` lists the new files as added: `packages/ui/src/Pager.tsx`,
`packages/ui/src/CategoryPanel.tsx` and `apps/desktop/src/renderer/lib/useNarrowWindow.ts`.

**2. Merge `dev` into the branch.** It brings in A611–A620, and the merge makes a commit, so it's yours:

```bash
cd /c/swiftpos/pos-shared
git merge origin/dev
```

Expect conflicts in the files A619 changed: both payment screens, `CashierScreen.tsx`, `POSPage.tsx`, and
`check-shared-sync.mjs`, because A619 added `platformPrices` as a shared copy and the branch moves copies into
`packages/core`. Tell me and I'll resolve them with you.

**3. This report on `dev`:**

```bash
cd /c/swiftpos/pos
git add docs/MORNING-REPORT-2026-11-02-shared.md
git commit -m "Morning report 2026-11-02: shared components batch G" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin dev
```

**4. Decide:**
- accept the +611 bytes, or undo the move;
- one wording for NoteModal;
- whether the forecourt, fuel keypad and product tile should look the same on both POS, and which design wins.
