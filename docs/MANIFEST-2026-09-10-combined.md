# MANIFEST 2026-09-10-combined — D1 + A204 + A146 CLOSED, A18 re-graded

**Base:** `origin/dev` @ `fa05e8f`. **Dashboard (2 files) + 2 tests + register.** No migration, no
server change. Supersedes the earlier unpushed D1/A204/A18 delivery (that one was never committed;
`origin/dev` is still `fa05e8f`). Folded into one because all four share `AUDIT-REGISTER.md`.

## D1 — CLOSED (last open P0), no code
The "owner with two businesses hits a login dead-end" bug was already resolved by the A158
enrolment work; the heading was never flipped. Server `/api/auth/desktop-login` is RETIRED → 410
Gone (`auth.ts:709`); the `409 MULTIPLE_BUSINESSES` lives only on the web `/login`. The desktop
activates via a one-time enrolment code (`/enrol/redeem`) — no owner credentials, no business
picker. Renderer sweep: only 6-digit PIN fields; "back to owner" → ENROLMENT flow, not a login.
No code path can produce the dead-end. **Zero open P0s remain.**

## A204 — CLOSED (code)
Stock Transfers **Cancel** used a native `window.confirm` and then called `advance()` with no
`reason`, which the server rejects (`400 reason_required`) — so Cancel popped a dialog AND failed.
Replaced with an in-app modal that captures a required reason and threads it through
`advance(t,'cancelled',false,reason)` into the PATCH body (mirrors the A203 same-user modal). The
modal's Cancel button is disabled until a reason is typed.

## A146 — CLOSED (code)
The webhooks UI existed but was **duplicated and diverged**: `BusinessPage` imported the full
standalone `settings/WebhooksTab.tsx` (test-send ping + per-hook delivery log), while
`SettingsPage` carried its OWN inline `WebhooksTab` that was a stale subset (no test-send, no
delivery log). Consolidated: deleted SettingsPage's inline component + local `Webhook` type,
imported the shared one — both pages now show the full A146 observability. Component is prop-free;
both render `<WebhooksTab />` identically.
NOTE (pre-existing, NOT fixed — out of scope): `ReportSchedulerTab` destructures `useConfirm()`
outputs it never uses or renders; dead declaration, left alone.

## A18 — re-graded P1 OPEN → P3 NOTE (no code)
Nothing to fix: the `nodeServer.ts` header was already corrected (08-09). It is a tracking marker
to revert the header when PHASE5-NODE-AUTHORITY §3 lands. Kept as a NOTE (like A13) so it stops
inflating the P1 count as a live defect while the reminder survives. Revert the heading if you'd
rather it stay an open P1.

## Files
| File | Change | ID |
|---|---|---|
| `apps/dashboard/src/pages/stock/StockTransfersPage.tsx` | cancel-reason modal replaces window.confirm | A204 |
| `apps/dashboard/src/pages/SettingsPage.tsx` | delete inline WebhooksTab + local type; import shared component; drop now-unused imports | A146 |
| `tests/transfer-receive-hang.test.mjs` | +A204 guard (mutation-checked) | A204 |
| `tests/webhook-test-logs.test.mjs` | +A146 consolidation guard (mutation-checked) | A146 |
| `docs/AUDIT-REGISTER.md` | D1/A204/A146 CLOSED; A18 → P3 NOTE; counts A-P1 19→18, A-P2 22→21, D-P0 1→0; changelog | — |
| `docs/MANIFEST-2026-09-10-combined.md` | this record | — |

## What ran (rule 7)
```
dashboard tsc --noEmit                 0 errors
tests/transfer-receive-hang.test.mjs   5/5 ; A204 guard mutation-checked both ways
tests/webhook-test-logs.test.mjs       2/2 ; A146 guard mutation-checked
offline suites  tests/*.test.mjs       96/96
gates  register-consistency / doc-refs / root-clean / test-registration   OK
```

## NOT verified here (rule 16)
- A204 cancel modal on screen + a real cancel round-trip.
- A146 webhooks UI on screen on BOTH pages (Settings + Business) after consolidation.
- D1: optional belt-and-suspenders — on a till, "back to owner" lands on enrolment, not a login.

## Apply
```
git pull origin dev
# extract this zip over the repo root, then:
cd apps/dashboard && npx tsc --noEmit && cd ..
node tests/transfer-receive-hang.test.mjs && node tests/webhook-test-logs.test.mjs
node scripts/check-register-consistency.mjs && node scripts/check-doc-refs.mjs
git add apps/dashboard/src/pages/stock/StockTransfersPage.tsx apps/dashboard/src/pages/SettingsPage.tsx tests/transfer-receive-hang.test.mjs tests/webhook-test-logs.test.mjs docs/AUDIT-REGISTER.md docs/MANIFEST-2026-09-10-combined.md
git commit -m "D1/A204/A146 CLOSED; A18 → P3 NOTE (last P0 cleared)"
git push origin dev
```
Rollback: revert this commit.
