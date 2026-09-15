# HANDOFF — 2026-09-15 (evening)

Written for the next session. Read this, then `docs/VERIFY-LOG-2026-09-15.md` for the
verification detail, then the register (`docs/AUDIT-REGISTER.md`) which is authoritative.
Working rules live in `HANDOFF-2026-08-08-evening.md §0` and still apply.

---

## Goal
Two threads ran this session:
1. **Ship the shift/day web-parity + split-brain cluster** (A273, A274, A275, A22) and get
   CI green — DONE and merged-to-deploy path.
2. **Run the verification session** on real hardware to move FIX BUILT items → CLOSED, using
   a fresh test business ("B Foods / Mama Ngina") with the Kudo menu.

The standing aim remains: burn down the verification debt (lots built, little floor-verified),
not to write new features — except the small fixes the floor surfaced.

## Current state
- **Branches:** API deploys from `dev` (Render, `swiftpos-20c2.onrender.com`); the web
  front-end deploys from `main` (Vercel, `swiftpos-three.vercel.app`). They are **different
  branches** — see A281. `dev` HEAD before this handoff = `5c265f8`; `main` was rebuilt to
  include A273 today (Vercel production promoted to the dev-HEAD commit).
- **CI:** green on `5c265f8` (all 6 jobs). Getting there took three CI fix rounds
  (deliveries -e/-f/-g): a `sendError` TS2559, a missing RLS statement on the new table, and
  a non-idempotent `CREATE POLICY`. All resolved; migration 102 now verified against real
  Postgres (PGlite) — all 26 migration tests pass.
- **Test DB:** dropped + rebuilt clean on the dev Supabase (`hzypljufxfhzpcvlqtck`). Carries
  the A280 drift (below) but that's outside the shift/POS path.
- **Desktop till:** freshly built **`SwiftPOS Dev 0.5.38`** (`npm run pack:dev`, no version
  bump), installed + enrolled on ONE laptop as Till **T1** against the test business.
- **Register counts now:** A: 0 P0 · **18 P1 · 17 P2 · 11 P3** — D: 0 P0 · 2 P1 · 1 P2 · 2 P3.

## Verified & CLOSED on target today (14)
A265, A266, A260, A274, **A275 (remote day close, end-to-end)**, A182, and the printing set
A235, A249, A251, A240, A245, A239, A241, A243. Spice modifier + VAT 16% validated live on a
real receipt.

## Active files (this cluster)
Shipped code (delivered -a..-g, on `dev`):
- `apps/dashboard/src/pages/pos/CashierScreen.tsx` — A274 shift hard-gate.
- `apps/dashboard/src/pages/pos/ShiftModal.tsx` + `apps/dashboard/src/lib/posTerminal.ts` +
  `apps/dashboard/src/context/POSAuthContext.tsx` — A273 web-covers-a-till (x-device-id).
- `apps/server/src/routes/shifts.ts` — `GET /shifts/terminals`.
- `apps/server/src/routes/day-close.ts` + `routes/index.ts` + `migrations/102_day_close_instructions.sql`
  + `apps/desktop/src/main/syncEngine.ts` — A275 remote day close.
- `apps/desktop/src/main/ipcHandlers.ts` + `apps/server/src/routes/devices.ts` +
  `apps/dashboard/src/pages/FleetPage.tsx` — A22 split-brain.

Files to touch NEXT session (fixes queued):
- `apps/dashboard/src/pages/pos/ShiftModal.tsx` — A273 float-prompt fix (skip float when the
  picked till already has an open drawer; check `/api/shifts/current` on selection).
- `apps/dashboard/src/pages/pos/ReceiptView.tsx` — A277 add the CTL line (show when
  `ctl_amount > 0`); confirm/add `ctl_rate` in `settings/BusinessProfileTab.tsx`.
- A276 (soda-on-kitchen): likely the Kudo import's `is_kitchen` on drinks OR print-station
  routing — diagnose before editing; the router itself is in `shared/` (unit tests green).

## Changes made this session
- Cluster A273/A274/A275/A22 built, CI-fixed (×3), verified where possible, merged to deploy.
- Kudo menu import built (`kudo-menu-import.xlsx`): 67 products, Spice modifier on the 44 food
  items, none on the 23 drinks/sauces.
- Register: **14 items CLOSED** on target; **6 findings OPENED** (A276–A281); A273 kept open
  with the float-prompt note; changelog + this handoff + `VERIFY-LOG-2026-09-15.md` added.

## Failed attempts / dead ends (so they aren't repeated)
- **Blind desktop/CI builds** — shipped -c without running tsc/migrations; caused 3 CI rounds.
  Fix that stuck: install `@electric-sql/pglite` locally and actually run `run-migration-tests`
  before shipping a migration. Do this for any migration change.
- **`setup-clean-db.sh` (no flag)** does NOT fix a drifted schema — it trusts the ledger and
  skips baseline. Only `--reset` (DROP SCHEMA) rebuilds; confirm the DB is disposable first.
- **Chasing a "stale deploy" on Render** — wrong tree. The front-end is on **Vercel/main**,
  not Render. Check Vercel deployments for front-end freshness (A281).
- **The uninstall .bat only clears "SwiftPOS Dev"** — the old prod "SwiftPOS" local DB/config
  survived and confused the new install. Delete both flavours' AppData folders on a reset.
- **Testing web items on the desktop app** — A273/A274/A265/A266/A267 are web-POS items;
  test them in the browser, not the Electron till.

## Next steps
1. **Diagnose A276** (P1, soda on kitchen ticket): get the Soda product settings (is_kitchen?),
   the print-station config, and both ticket photos → decide menu-data vs router fix, then fix.
2. **Enrol Laptop B as Till T2** + promote one machine to node → run **all of Group C**
   (A273 two-surface, D9, A162/A19, A163/A20, A161/A24, A160, A164, A22 promote-refusal).
3. **Build queued fixes:** A273 float-skip, A277 receipt CTL line (+ ctl_rate settings field),
   and scope A278 instant push-to-till.
4. **Re-confirm the 8 pre-rebuild items** on the current build: A259, A262, A257, A256, A179,
   A129, A157, D18 (reported pass, but on the pre-Vercel-rebuild front-end).

## Skipped
- **A236** — didn't build the bridge `.exe` (used the shared build).
- **A267** — needs a time-based wait for token expiry; revisit.
- **CTL** — `ctl_rate` left at 0 on purpose; only set 2% for the A277 check after the receipt
  line is built.

## Proposed / decisions to make
- **A278 instant push-to-till** — owner wants web→till changes without a restart. Cross-stack
  (cloud push + till listener); needs a design decision on the push channel.
- **A280** — regenerate `00_baseline.sql` from a prod snapshot + reconcile `schema-index.json`
  so a clean rebuild reproduces prod (disaster-recovery; overlaps A23).
- **A281** — align front-end/back-end deploy branches (or a documented promote flow) + surface
  the built commit so "is the front-end current?" is a glance.
- **A260 receipt details** — no code needed; fill Address/Phone/Tax PIN in Business Profile.
