# MANIFEST 2026-09-04-c — A197 already-built (correction) + A148 decision surface (docs-only)

**Base commit:** current `dev`. **Scope:** register only — no code. **Working rules:** unchanged.

## A197 — already built (rule-17 correction)
A source sweep found both inventory write-actions the entry called "no UI caller" are already wired:
- **Direct branch-stock set** → `POST /api/stock/ingredients/:id/adjust` `type:'set'`, wired in
  IngredientsPage's Adjust modal. Already browser-verified via the A12 test (Set to 42 kg).
- **Transfer approve/complete** → `PATCH /api/stock/transfers/:id/status`, wired in
  StockTransfersPage ("Mark in transit" / "Mark received").
No code change. A197 stays OPEN pending one browser check of the transfer flow (a transfer-flow verify script is delivered alongside this manifest).

## A148 — the remaining "endpoint live, no UI caller" tail: needs YOUR pick (not built)
The register's own 2026-08-23 verification found none of A148's sub-items is a clean wire; each needs
a decision or a small new surface. Presented for a choice rather than built blind:

| Sub-item | Endpoint | What it'd take |
|---|---|---|
| Add one modifier option to a saved group | `POST /api/modifiers/options` | Small UX call: where the "add option" control sits in VariantsDrawer. **Cleanest of the four.** |
| Owner feature-flag toggle | `PUT /api/flags/:key` | Decision: should owners self-manage flags at all? (overlaps the admin toggle) |
| QR-ordering settings | `GET`/`PATCH /api/qr/settings` | Build a small QR settings section |
| Loyalty settings (read) | `GET /api/loyalty/settings` | Build a small loyalty settings section (read-only endpoint) |

Recommendation: leave A148 at P3 unless you want a specific one. The modifier-option add is the only
near-clean build; the rest are new settings surfaces / policy decisions.

## Verification (rule 7)
- `check-register-consistency` (header agrees with body), `check-doc-refs` — green. No code, so no
  build/test changes.
- **Could NOT verify here:** the transfer flow in the browser (A197's remaining close check).
