# MANIFEST 2026-08-17-i — A118 admin portal: revoke till + rotate reveal code + fix health chart

**Base:** fresh clone of `dev` (d4a6073). Register ID **A118**. Implements the
three **unblocked** items from `docs/ADMIN-PORTAL-PLAN.md` (G4, G3, G8) — the ones
that needed no owner decision. G1/G2/G5/G6/G7/G9 remain per the plan.

## Files (2 code)

| File | Change |
|---|---|
| `apps/server/src/routes/admin.ts` | **G4** — new `DELETE /clients/:id/devices/:deviceId`: admin revokes a device (stolen/compromised till), mirroring the owner revoke + admin audit. |
| `apps/admin/src/AdminPortal.tsx` | **G4** — "Revoke" button per enrolled-device row (+ `revokeDevice`, confirm). **G3** — "Rotate" button beside the branch reveal code (+ `rotateRevealCode`, confirm) wiring the existing `reveal-code/regenerate` endpoint (the A114 kill switch, previously unreachable). **G8** — "Fleet Health" card now charts the three **health bands** (coloured bars) instead of business type; removed the now-unused type breakdown. |

## Verified (bench)

- Server `tsc` clean (with the lockfile-pinned TypeScript 5.9.3 — note: `npm install`
  on a fresh clone pulled 6.0.3 and tripped a tsconfig deprecation; `npm ci` is the
  correct install and builds clean).
- Admin `vite build` clean; **0 new type errors** (59 pre-existing `boxSizing`/CSS
  debt unchanged, proven by stash-and-count).
- Gates green: supabase-catch, permission-parity, register, doc-refs, table-usage.

## NOT verified here — needs a click-test (admin app has no automated tests)

- **G4 revoke:** open a client → Enrolled Devices → Revoke → confirm the device
  disappears and the till is blocked on next sync.
- **G3 rotate:** Tech Access → generate a token → Rotate beside the reveal code →
  confirm a new code shows and the till picks it up on next sync.
- **G8 chart:** dashboard "Fleet Health" bars should read Healthy/Attention/Critical
  in green/amber/red.

## Rollback

Per file: `git checkout -- apps/server/src/routes/admin.ts apps/admin/src/AdminPortal.tsx`.
