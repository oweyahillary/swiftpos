# Shared code between desktop + dashboard — analysis & phased proposal

## The foundation already exists (but is under-used)
There IS a root `shared/` workspace: `shared/parkingTariff.ts` and a mature `shared/printing/`
package (ESC/POS, receipt + shift-report rendering, money formatting, spooling, layout). It's
imported by **print-server and desktop** — but **not the dashboard**. So the web app re-implements
what `shared/` already provides. Worse, `apps/desktop/src/shared/parkingTariff.ts` is a *copy* of
`shared/parkingTariff.ts` — even the shared file is duplicated. And there's no root `workspaces`
config, so `shared/` is wired ad-hoc rather than as a real package.

## What's actually duplicated (candidates to share)
1. **Domain types** — `Shift`, `Order`, `Transfer`, `PurchaseOrder`, `CashierSession`, etc. are
   redefined independently in ~a dozen files across dashboard + desktop (e.g. `Shift` in
   ManagerDashboard, OverviewPage, ShiftModal, POSAuthContext). Highest-volume duplication, zero
   runtime risk to share.
2. **Auth / routing logic** — `resolveRoute` (dashboard) and the role/permission constants
   (`MANAGER_DENY`, default sets in server `defaultRolePermissions`) encode the same rules the
   desktop also needs. One source of truth would prevent drift like the A202 owner-wildcard mismatch.
3. **Receipt / report / money formatting** — the dashboard duplicates what `shared/printing`
   (`money.ts`, `shiftReport.ts`, `render.ts`) already does; desktop has its own `ReceiptView` /
   `ZReportView` parallel to the dashboard's.
4. **Calculations** — parking tariff, shift reconciliation math, VAT/levy — pure functions, safe to
   share.

## Why NOT everything can be shared (the real constraint)
Desktop is **Electron: offline, SQLite via IPC, main/renderer split**. Dashboard is **web: online,
REST via `posApi`/`api`**. Their **data-access layers are fundamentally different**, so:
- **Shareable now (pure, runtime-agnostic):** types, calculations, formatting, permission/routing
  rules, validation schemas. No DOM, no `fetch`, no node-only APIs.
- **Hard to share (runtime-coupled):** data access (IPC vs REST) and UI bound to a data source.
  Sharing a *feature's UI* (e.g. the shift panel) requires abstracting the data layer behind an
  interface each app implements — a bigger, incremental job, not a copy-paste move.

This is why "one shared folder for all features" won't work wholesale — the features differ where they
touch data/runtime. But a shared **core** removes most of the real duplication.

## Phased proposal (low-risk first)
- **Phase 0 — make `shared/` a real package.** Add root workspaces (or path aliases) so every app
  imports one `shared/`; delete the `apps/desktop/src/shared/parkingTariff.ts` copy. Small, unblocks
  the rest.
- **Phase 1 — `shared/types` (domain DTOs).** Move Shift/Order/Transfer/PO/CashierSession/etc. to one
  module; replace the duplicated interfaces. Pure win, mechanical, testable. **Best first build.**
- **Phase 2 — `shared/auth`.** `resolveRoute` + the role/permission constants in one place, imported
  by dashboard + desktop + server. Prevents permission drift.
- **Phase 3 — dashboard onto `shared/printing`.** Point the web receipt/report/money code at the
  existing shared package instead of its own copies.
- **Phase 4 (later, incremental) — shared feature UI** behind a data-layer interface, one component at
  a time (start with a read-only one like ZReport). Only if the payoff justifies the abstraction.

## Recommendation
Do Phase 0 + Phase 1 as one focused batch — it's mechanical, removes the most duplication, and can't
break runtime behaviour (types + a package wiring). Phases 2–3 next. Treat Phase 4 as opportunistic,
per component, not a big-bang rewrite. Guardrail: shared modules stay dependency-light and
platform-agnostic (the existing `shared/printing` is the model — pure, tested, no DOM/fetch/node-only).
