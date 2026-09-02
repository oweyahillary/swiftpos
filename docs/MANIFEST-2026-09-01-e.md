# MANIFEST 2026-09-01-e — A3 KDS ticket delivery (read-path fix)

**Base:** dev @ fba45bb (apply after `-d`). Server only.

## What
The KDS board never showed tickets even for a valid order. Root cause is NOT the test
order (tickets are created for every order; `order_items.fire_status` defaults to
'fired') — it's the read query. `GET /kitchen/tickets` used a two-levels-deep embed
filter `.eq('orders.order_items.fire_status', 'fired')` that is fragile in PostgREST
(errors / drops the ticket); on error the KDS client shows 0. Fixed by dropping the
nested filter and hiding 'held' items in JS instead.

| File | Change |
|---|---|
| `apps/server/src/routes/kitchen.ts` | `GET /tickets`: remove the nested `fire_status='fired'` embed filter; fetch tickets reliably; filter 'held' items in JS; hide tickets left with nothing fired. |
| `docs/AUDIT-REGISTER.md` | A3 ticket-delivery fix note. |
| `docs/MANIFEST-2026-09-01-e.md` | This file. |

## Verification (rule 7)
```
apps/server: tsc --noEmit → exit 0
check-register-consistency / doc-refs → OK
```
NOTE: the PostgREST read behaviour can't be exercised in the sandbox (no live stack) —
this is verified by the browser test after redeploy (below).

## Browser-confirm (the real test)
After redeploy: open /kds for a branch, ring an order for that branch → the ticket
appears on the board within **≤30s** (the poll), and advancing it works. Realtime
instant-update is separate (anon+RLS); the poll makes KDS functional.

## Rollback
`git restore apps/server/src/routes/kitchen.ts docs/AUDIT-REGISTER.md && rm docs/MANIFEST-2026-09-01-e.md`
