# MANIFEST 2026-08-31-p — A146: log test-ping deliveries (webhook observability)

**Base commit:** `189bfc2` (dev). Server only, additive. No DB, no migration.

## What
The webhook Deliveries log was empty for **test pings**: `POST /webhooks/:id/test`
fetched the endpoint but never wrote a `webhook_deliveries` row (real order events DO,
via `deliverOne`). Now the test route logs the ping on both success and failure, so the
observability UI reflects it — the exact FAIL the 2026-08-31 browser test found.

| File | Change |
|---|---|
| `apps/server/src/routes/webhooks.ts` | `POST /:id/test` inserts a `webhook_deliveries` row (event 'ping', response_status, delivered_at) on success, and one with the error on failure. |
| `tests/webhook-test-logs.test.mjs` | **NEW.** Guard: the test route inserts a delivery on both paths, event 'ping', records the response status. |
| `docs/AUDIT-REGISTER.md` | A146: fix recorded (stays OPEN pending browser + the notifications test-email button). |
| `docs/MANIFEST-2026-08-31-p.md` | This file. |

## Verification (rule 7)
```
apps/server: ./node_modules/.bin/tsc --noEmit   → exit 0
node tests/webhook-test-logs.test.mjs            → 1/1, all green
  MUTATION: remove the success-path insert → FAILED; restore → green (rule 23)
node scripts/check-test-registration.mjs / register-consistency / doc-refs → OK
```

## Browser-confirm (rule 16)
Settings → Webhooks → add an endpoint (a webhook.site bin) → Send test → open
Deliveries → the ping now appears with its status. (Real order.completed/voided already
logged; this closes the test-ping gap.)

## Not in this delivery
A146 also lists a missing **test-email button** for `POST /api/notifications/test-email`
(the "notifications half") — small, but it needs a settings home confirmed first; done
next. A143 (report-export mapping) and A144 (3 stock-action controls) are real UI passes,
not mechanical wires — scoped separately.

## Rollback
```
git restore apps/server/src/routes/webhooks.ts docs/AUDIT-REGISTER.md
rm tests/webhook-test-logs.test.mjs docs/MANIFEST-2026-08-31-p.md
```
