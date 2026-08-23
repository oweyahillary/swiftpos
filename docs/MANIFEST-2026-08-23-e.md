# MANIFEST — 2026-08-23-e

**Batch:** A147 — admin-portal web-access expiry setter (the one genuinely-unwired endpoint of the three).
**Cumulative:** follows -a (register), -b (A143), -c (A140), -d (A144). Apply -a → -b → -c → -d → -e.

**Base commit:** `f80f0e9` (`dev` tip). Applies on top of -a…-d.

**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `apps/admin/src/AdminPortal.tsx` | `ClientDetailPage` Overview gained a "Web access expiry" row: shows the current `web_access_expires_at` and a date-picker with **Set**/**Clear** → `PATCH /api/admin/clients/:id/web-access`, updating `detail` locally on success. Added two state vars + a `setWebAccessExpiry` handler. | A147 — the only genuinely-unwired endpoint of the three. |
| `docs/AUDIT-REGISTER.md` | `PROGRESS 2026-08-23` note on A147 + an OBSERVATION about the pre-existing admin type-check failure. Entry stays **OPEN**; counts unchanged. | Rule 14 / 16 / 7. |
| `docs/MANIFEST-2026-08-23-e.md` | New (this file). | Rule 2. |

## Rule-17 correction (important)

Two of the three endpoints A147 listed were **already wired** — the wiring-sweep's suffix-matcher missed them because their call literals carry a `?query`:
- `GET /api/admin/audit` → `AuditPage` calls `req("GET", "/audit?limit=100")`.
- `GET /api/admin/tech/tokens` → `TechPage` calls `req("GET", "/tech/tokens?limit=30")`.

Both have working sidebar pages. Only `PATCH /clients/:id/web-access` was a real gap — and it is distinct from the existing `web_hosting` boolean toggle: it sets `businesses.web_access_expires_at` (the date the renewal ladder measures against), per the server handler's own comment.

## Evidence / verification (rule 7, 9, 20)

- `apps/admin` — `npx vite build` → exit 0.
- `apps/admin` — `npm run type-check` (`tsc --noEmit`) → **68 errors, identical to the pre-batch baseline (verified by restoring the original file and re-running)**. A147 adds **zero** new type errors: the one it would have added (spreading `S.input` on the date input — the file's own systemic `boxSizing` issue) was cast to `React.CSSProperties`.
- `node scripts/check-register-consistency.mjs` → green (A147 still OPEN).
- Environment: Linux bench, Node, admin Vite build. **NOT browser-verified (rule 16):** set an expiry on a client, confirm it persists and displays; clear it; confirm the audit-log and tech-tokens pages (already wired) still render.

## Observation filed for triage (not fixed here — out of A147 scope)

The admin app's `type-check` is **already red** — 68 pre-existing errors, nearly all the same class (inline `S.input`/style objects typed as `string` where `CSSProperties` is expected). If admin `type-check` is (or should be) a CI gate, it is failing independently of this batch. Recommended as its own register ID. Not touched here (a file-wide style-typing fix is unrelated to A147 and carries its own risk — rule 12).

## Rollback

```
git apply -R A147-admin-web-access-expiry.patch
```
