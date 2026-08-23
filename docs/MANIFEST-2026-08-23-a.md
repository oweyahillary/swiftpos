# MANIFEST — 2026-08-23-a

**Batch:** A140–A148 opened in the audit register. **Docs-only — no zip** (rule 18:
zips are for applying code; a batch that touches nothing but `.md` gets the changed
file and this manifest, no archive).

**Base commit:** `f80f0e9` (`dev` tip at time of edit).

**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1-23. No new rules.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `docs/AUDIT-REGISTER.md` | Inserted nine `### A140`…`### A148` OPEN entries at the top of §A; bumped the `\| Open \|` counts (A-P2 8→15, A-P3 3→5); appended the same IDs to the `\| Counts \|` row; prepended a `2026-08-23` line to the `\| Last updated \|` cell; moved "Next free ID" to A149. | Rule 14 — findings get an ID and an entry. Two prior discussions (products-area feature gaps A140-A142; the endpoint↔UI wiring sweep A143-A148) were agreed but not yet recorded. |
| `docs/MANIFEST-2026-08-23-a.md` | New (this file). | Rule 2 — every batch carries a manifest with a file list and a rollback line. |

## What the entries are

- **A140 · P2** — product/menu bulk CSV import (`POST /api/products/bulk`) is built but reachable only for `minimart`; unreachable from the general `ProductsPage`. One wire.
- **A141 · P2** — no bulk ingredient import; must also seed opening stock (writes `stock_movements`), so it touches the stock path, not just the master list.
- **A142 · P3** — no bulk product-image upload; single-image only. Blocked on a filename↔product matching decision.
- **A143 · P2** — report exports 1-of-7 wired (only `export/sales`); `reports/inventory` has no caller.
- **A144 · P2** — inventory/stock write-actions unwired: `inventory/:id/threshold`, `stock/transfers/:id/status`, `branches/:id/stock/:pid`.
- **A145 · P2** — branch↔user assignment unwired: `assign-user`, `remove-user`.
- **A146 · P2** — notifications/webhook observability unwired: `notifications/test-email`, `webhooks/:id/deliveries`, `webhooks/:id/test`.
- **A147 · P2** — admin-portal endpoints unwired: `clients/:id/web-access`, `admin/audit`, `admin/tech/tokens`.
- **A148 · P3** — misc unwired: `modifiers/options` (create), `flags/:key`, `qr/settings`, `loyalty/settings`.

## Evidence / verification (rule 7)

- Source-read + a static endpoint↔caller cross-reference (309 server endpoints vs every `/api/` reference in `apps/dashboard`, `apps/admin`, `apps/desktop`). Matcher corrected for query strings, the admin `fetch` wrapper (suffix-only call sites), and `` `${BASE}/api/…` `` template calls; 39 endpoints had no caller after correction.
- **All static / bench only (rule 9).** None browser-confirmed (rule 16) — every entry is a candidate for a live pass before it is worked or closed.
- Deliberately excluded and NOT entered: external/till/node/tech callers, the retired `/api/enrol/code` (410), parking-session endpoints (tracked under the README "ParkingPOS unrouted" note), and three ambiguous endpoints held for a per-page check (`credit/customers`, `auth/set-pin`, `products/barcode/:code`).

## Gates run

- `node scripts/check-register-consistency.mjs` → **green** (103→112 entries, header agrees with body, no duplicate IDs).
- `node scripts/check-doc-refs.mjs` → **green** (this manifest resolves the `MANIFEST-2026-08-23-a.md` citation added to the register).

## Rollback

Single command, restores the register to the base commit and deletes this manifest:

```
git checkout f80f0e9 -- docs/AUDIT-REGISTER.md && rm -f docs/MANIFEST-2026-08-23-a.md
```
