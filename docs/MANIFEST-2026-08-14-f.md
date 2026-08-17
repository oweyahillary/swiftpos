# MANIFEST 2026-08-14-f — batch enrolment codes + enrolled-device roster (A69, A70)

**This is a DELTA on top of your pushed `dev`** (base `a9d7be6`), not a from-
scratch cumulative — letters a–e are already committed. Apply these files over
`dev`.

**No desktop change** this round, so no version bump and **`package.json` is not
shipped** — your committed 0.5.31 stands (shipping my copy would regress it).

**Register:** A69 extended (batch); A70 opened (P3, roster). Header A-P3 2→3.

---

## Files (whole, over base `a9d7be6` — `git status` first, rule 4)

| File | What |
|---|---|
| `apps/server/src/routes/admin.ts` | A69: enrol-code endpoint takes `count` (1–20), mints N single-use codes, returns `codes[]`. A70: new `GET /clients/:id/devices` roster. |
| `apps/admin/src/AdminPortal.tsx` | A69: "how many tills?" prompt + code list. A70: "Enrolled Devices" card in Overview. |
| `tests/enrol-endpoints.test.mjs` | 29 checks (batch + roster guards); batch guard mutation-checked. |
| `docs/AUDIT-REGISTER.md` | A69 batch note + A70 entry + header counts. |
| `docs/MANIFEST-2026-08-14-f.md` | this file. |

## What it does
- **Batch:** admin clicks "Enrol till" → "How many tills? (1–20)" → gets that many
  single-use, branch-bound codes, listed with the Business ID and copy buttons.
  Still one code per device — batching just mints them together. A *reusable*
  branch code was declined (a leak on a per-branch, no-seat-cap model is
  unbounded).
- **Roster:** the client Overview now shows "Enrolled Devices" — label, role
  (till/node/office), bound branch, status, last-seen, app version — read from
  `user_devices`, scoped to the business.

## Rollback
```bash
cd /c/swiftpos/pos
git checkout a9d7be6 -- apps/server/src/routes/admin.ts apps/admin/src/AdminPortal.tsx \
  tests/enrol-endpoints.test.mjs docs/AUDIT-REGISTER.md
rm docs/MANIFEST-2026-08-14-f.md
```

## Apply + deploy
```bash
cd /c/swiftpos/pos
git status
unzip -o ~/Downloads/swiftpos-2026-08-14-f.zip
# redeploy the cloud (Render) — new GET /devices + batch response
# redeploy the admin (Vercel) — batch prompt + devices card
```
No desktop rebuild needed this round.

---

## Verified on the bench (rule 7 — Linux, Node 20; rule 9)
- `apps/server` `tsc --noEmit`: **0 errors** project-wide.
- `tests/enrol-endpoints.test.mjs`: **29/29**, run. Batch guard **mutation-checked**
  (widening the 1–20 cap turns it red).
- Gates green: `check-register-consistency` (header==body), `check-doc-refs`,
  `check-supabase-catch`, `check-table-usage`, `check-own-rows`.
- Admin `tsc`: my additions add no new errors.

## NOT verified here — the live checks (rules 9, 16)
- Batch: request N (say 3) → N distinct codes listed; each redeems on one till and
  is then dead; N+1th redeem of a used code refused.
- Roster: an enrolled till appears with the right branch + role + version; count
  matches reality.
- `count` clamped: 0 or 999 → server issues between 1 and 20.
- `node scripts/run-all.mjs` before shipping.
