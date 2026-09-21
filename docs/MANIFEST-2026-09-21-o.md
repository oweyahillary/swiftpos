# MANIFEST 2026-09-21-o — A19 re-graded FIX BUILT (node→cloud peer-sale relay) + pilot handoff

**Supersedes 2026-09-21-n** (Rule 3). Register-only — records a source/git/test finding, no code.

**Base commit:** `c7bbc52` (`dev` tip). **Scope:** `docs/AUDIT-REGISTER.md` only.
**Register ID:** A19 (status change, not a new finding).

## Why

Asked to "finish A19" (offline peer's sales reach the cloud) so the pilot can do a final test.
Tracing it showed the build is essentially **already done** — and that the 2026-09-18 "OPEN /
unbuilt" note was **mistaken**:

- The node→cloud relay was wired in commit **`3dc17b2` (2026-08-25)** — *before* the 09-18 note.
- The 09-18 note saw peer rows stamped `PEER_SYNC_STATUS` and concluded "no forward," but the
  forward is a **separate** row: `enqueuePeerRelay` writes the peer's original cloud payload into
  the **node's own `sync_queue`**, which the node's normal push relays with the peer's idempotency
  key. The peer attaches that payload (`_relayPayload`, from the A94 `receipt_payloads` snapshot —
  full items+variants+modifiers) in `fillNodeOutbox`; `buildPeerRelay` refuses anything lossy.
- **Bench: `apps/desktop/test/peer-relay.test.mjs` 28/28**, incl. "built payload accepted by the
  node relay," "modifier price survives build→forward (the under-total this prevents)," and
  "idempotency_key stays the order id end to end."

So A19's node relay is built and bench-proven; the register heading was stale. Same pattern as
A276/A277/A278 this week (built, mislabeled).

## What changed

`docs/AUDIT-REGISTER.md`: A19 `OPEN` → `FIX BUILT` with an evidenced note (the above, plus the
change-point-1 decision below). P1 count unchanged (FIX BUILT still counts as open).

## Lead decision recorded (money path)

**Change point 1** (a peer with a `node_url` stops *also* enqueuing to its own cloud `sync_queue`)
is **deliberately NOT built.** The direct push is a harmless belt-and-suspenders — idempotency
dedupes, and for a permanently-offline peer it's dead weight only. Ripping it out to save that dead
weight would remove a safety net on a **money path**; not worth it. The one real (minor) side
effect — a permanently-offline peer's `sync_queue` grows unbounded — is best addressed by a *prune*
(delete rows the node has relayed), not by re-routing the money path. Filed as a follow-up, not
done now.

## Verification (Rule 7)

- `peer-relay.test.mjs` **28/28** (pure `peerRelay.ts` compiled + run on the bench).
- `check-register-consistency` OK.

**This is what CLOSES A19 — target-only, and it's the pilot's job** (Rule 16): a live node + a
genuinely-offline peer + cloud. See the A19 pilot final-test checklist (delivered separately, not a repo doc).

## Rollback (Rule 2)

```bash
git checkout c7bbc52 -- docs/AUDIT-REGISTER.md
```

## Commit (direct to dev, explicit path — never `git add -A`)

```bash
git checkout dev && git pull
git add docs/AUDIT-REGISTER.md docs/MANIFEST-2026-09-21-o.md
node scripts/check-register-consistency.mjs
git commit -m "docs: A19 re-graded FIX BUILT — node→cloud peer-sale relay built (A162 wiring, 2026-08-25) + bench 28/28; pilot test to close"
git push
```
