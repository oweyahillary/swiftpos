# MANIFEST 2026-09-21-m — A277: make the Catering/Tourism Levy (CTL) rate owner-settable

**Supersedes 2026-09-21-l** (Rule 3).

**Base commit:** `9209573` (`dev` tip). NOTE: delivery **-l (A307)** is not yet pushed as of this
build; both touch `AUDIT-REGISTER.md` but different entries — push in order, and if `dev` moved,
re-apply the small register edits by hand (they don't overlap).
**Scope:** server `business.ts` + dashboard `BusinessProfileTab.tsx` + one root test + the register.
**No migration** — `businesses.ctl_rate` already exists (migration 33). **Register ID:** A277.

## Why

Tracing A277 ("receipt omits CTL") showed the receipt **already renders** the CTL line
(`ReceiptView.tsx`) and sales already compute `ctl_amount` — so the levy was never actually
omitted by the receipt. The real gap: **nothing let an owner set `ctl_rate`**. The dashboard
Business Profile and the server write-allowlist both omitted it, so it stayed at 0 and CTL never
appeared. (Same shape as A276: the code was right; a config/field was missing.)

## What changed

| File | Change | ID |
|---|---|---|
| `apps/server/src/routes/business.ts` | Add `ctl_rate` to the `EDITABLE` allowlist + a 0..100 validation block mirroring `vat_rate`. GET already returns it (`select('*')`). | A277 |
| `apps/dashboard/src/pages/settings/BusinessProfileTab.tsx` | Add `ctl_rate` to the record type, a "Catering/Tourism Levy (%)" form field (with help text), and the save payload. | A277 |
| `tests/ctl-rate-editable.test.mjs` | **new** — 6 source-guards (EDITABLE, validation, form type/field/save, receipt-render present). Auto-registered by the CI glob. | A277 |
| `docs/AUDIT-REGISTER.md` | A277 `OPEN`→`FIX BUILT` + fix note + a `2026-09-21 (ctl)` changelog line. (P2 count unchanged — FIX BUILT still counts as open.) | A277 |

## Verification (Rule 7)

Bench, Linux/Node 22:
- **`node tests/ctl-rate-editable.test.mjs` → 6/6** (mutation-checked: dropping the EDITABLE entry
  or the form field turns the named assertion red).
- **Server `tsc` → 0 errors; dashboard `tsc` → 0 errors.**
- `check-register-consistency` OK; the full chain is now closed: owner sets rate → server
  accepts/stores → cart computes `ctl_amount` (existing) → receipt shows CTL (existing) → reports
  show it (existing).

**Could NOT verify here (target-only, Rule 16 — this is what CLOSES A277):** set a nonzero CTL in
Business Profile on a real business, ring a sale, and confirm the receipt prints the CTL line and
the tax report matches. The test business runs `ctl_rate=0` deliberately, so this needs a real
CTL-charging business (or a temporary nonzero rate).

## Rollback (Rule 2)

```bash
git checkout 9209573 -- apps/server/src/routes/business.ts \
  apps/dashboard/src/pages/settings/BusinessProfileTab.tsx docs/AUDIT-REGISTER.md
rm -f tests/ctl-rate-editable.test.mjs
```

## Commit (direct to dev, explicit paths — never `git add -A`)

```bash
git checkout dev && git pull                     # push -l (A307) first if you haven't; then confirm base
git add apps/server/src/routes/business.ts apps/dashboard/src/pages/settings/BusinessProfileTab.tsx \
        tests/ctl-rate-editable.test.mjs docs/AUDIT-REGISTER.md docs/MANIFEST-2026-09-21-m.md
git status --short                               # expect exactly these five
node tests/ctl-rate-editable.test.mjs && node scripts/check-register-consistency.mjs
git commit -m "feat: A277 make CTL (Catering/Tourism Levy) rate owner-settable — receipt line now appears"
git push
```

Ships with the server + dashboard (web) deploy — no desktop release needed.
