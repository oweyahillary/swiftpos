# MANIFEST 2026-08-27-m — A181 (part 1): a 409 must not be silently marked synced

**Base:** `d5bd396` + the A175–A180 chain. **Desktop change → bump the version +
tag after the build (rule 15); not in this patch (rule 22).**
**Artifact:** `swiftpos-2026-08-27-m.patch`.

## The bug (the ORIGINAL "synced but not on the cloud")

Order numbers are `terminal_code--seq`, `seq` a LOCAL per-till counter. The cloud
enforces `UNIQUE (business_id, branch_id, order_number)`. A reinstalled or second
till at the same branch keeps terminal code `T1` and restarts its counter at 1, so
it re-mints `T1--1, T1--2 …` over numbers an earlier till already stored. The
server refuses the collision with **409 "Order number already exists — please
retry"** — but the client treated 409 as success and marked the order `synced`
(`syncEngine.ts:1552`). A DIFFERENT order holds that number, so the sale read
`synced` on the till and never reached the cloud. Confirmed from the cloud's data:
`T1--1…T1--25` belong to the prior till; the current till's 26–27 Aug orders
(`T1--1…T1--7`) all collided and are absent (~KES 12,510).

## This delivery (part 1 only)

`apps/desktop/src/main/syncEngine.ts` — a 409 in `pushPendingOrders` no longer
calls `markSynced`. It records the server's reason, escalates to `failed` (like
any other rejection), and writes `order push rejected (409): …` to the durable
log. A collision is now VISIBLE (a failed count + a log line) instead of a sale
that silently vanishes from the cloud. (A genuine idempotent duplicate still
returns 200 and is handled by the `res.ok` branch — 409 is only ever an
order-number collision.)

## Files

| File | Change |
|------|--------|
| `apps/desktop/src/main/syncEngine.ts` | 409 → surface as failed + log (was silent `markSynced`). |
| `apps/desktop/test/order-409-not-synced.test.mjs` | NEW. Real engine + 409 responder: never synced, escalates to failed, reason recorded + logged (5/5). |
| `apps/desktop/package.json` | `test:order409` in the `test:desktop` chain. |
| `docs/AUDIT-REGISTER.md` | A181 (open P0) + counts + changelog; next free ID → A182. |
| `docs/MANIFEST-2026-08-27-m.md` | This file. |

## Verification (rule 7)

- `order-409-not-synced.test.mjs` 5/5. main `tsc` clean. Gates green.

## Do this now (operational, no code)

Give each till at a branch a **distinct terminal code** (this machine → e.g. `T2`
in Technician setup). New orders mint `T2--N`, don't collide, and land on the
cloud. Confirm with a test sale.

## Still OPEN — owner decision needed before building (rules 12, 20)

1. **Robust uniqueness** so a human setting T1/T2 isn't the only guard: either the
   cloud constraint becomes per-device (`…, device_id, order_number`) — a
   migration + a reports check — or a new till auto-picks a free terminal code on
   enrol.
2. **Recovery of the already-lost 26–27 Aug orders**: they read `synced` locally
   but are absent on the cloud. Recovery = diff local order ids against the cloud,
   re-number the missing ones to non-colliding values, mark them pending, and
   re-push. Must not duplicate an id already on the cloud. A careful one-off script.

## Apply / rollback

```
git apply --check swiftpos-2026-08-27-m.patch && git apply swiftpos-2026-08-27-m.patch
cd apps/desktop && npx tsc -b tsconfig.main.json --force && npm run test:order409
# rollback: git apply -R swiftpos-2026-08-27-m.patch
```
