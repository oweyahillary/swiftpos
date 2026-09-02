# MANIFEST — 2026-08-23-j

**Batch:** A146 (webhook half) — wire the live-but-unwired webhook observability endpoints.
**Cumulative:** follows -a…-i. Apply after -i.

**Base commit:** `f80f0e9` (`dev` tip). Applies on top of -a…-i.

**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `apps/dashboard/src/pages/settings/WebhooksTab.tsx` | Added a per-webhook **Send test** button (`POST /api/webhooks/:id/test`, result shown inline) and a **Deliveries** toggle that loads `GET /api/webhooks/:id/deliveries` into a per-hook log table (time · event · HTTP status colour-coded · attempts). A test send refreshes an open log. Added a `Delivery` type + observability state/handlers. | A146 — both endpoints were live; WebhooksTab had CRUD but neither. |
| `docs/AUDIT-REGISTER.md` | `PROGRESS 2026-08-23` note on A146. Stays **OPEN** (P2); counts unchanged. | Rule 14 / 16. |
| `docs/MANIFEST-2026-08-23-j.md` | New (this file). | Rule 2. |

## Why this scope (rule 12, 17, 20 — chosen while you were out)

You asked for ~3 cohesive items in one patch. I verified the candidate pool against source first, and only the webhook observability was a clean, decision-free, cohesive fit:

- **A146 webhook test-send + delivery log** — genuine (WebhooksTab lacked both), one page, both endpoints live. ✅ Done here.
- **A146 test-email** — this is the mail piece you asked to keep last; excluded.
- **A8 SplitBillModal** — confirmed genuinely built-but-unmounted with `PATCH /:id/split` live, BUT wiring it needs a POS trigger point and touches money flows — not something to build blind while away. Held.
- **A148 flags (`PUT /api/flags/:key`)** — overlaps the admin feature-flag toggle; no clear owner-dashboard home. Held (needs a decision).
- **A148 qr-settings / A146 loyalty-settings** — no existing settings home; wiring means building new UI, not a wire. Held.

Two clean fixes shipped well beat three rushed/blind ones.

## Verification (rule 7, 8, 9)

- `apps/dashboard` `npx tsc --noEmit` → exit 0.
- `apps/dashboard` `npx vite build` → exit 0.
- `node scripts/check-register-consistency.mjs` → green (A146 still OPEN).
- Environment: Linux bench, Node, dashboard Vite build. **NOT browser-verified (rule 16):** point a webhook at a request-bin, click Send test, confirm the ping arrives and a delivery row shows with its status; open Deliveries and confirm the log renders.

## Rollback

```
git apply -R A146-webhook-observability.patch
```
