# MANIFEST 2026-09-17-c  (desktop surface)

**Base commit:** dev @ 0.5.42 (c55ec43). Extract over project root. One file.
Bench typecheck clean on the edits; CI does the full typecheck (rule 9).

## Root cause (confirmed against the live db)
The Overview zero was NOT the data, status, range, or the shared render catch
(A290 already fixed that — Tables render). It was `getSalesSummary` THROWING: its
return is built from THREE sub-queries — the revenue row (proven to return 6/21870
in DB Browser), a payments JOIN, and an hourly strftime. On a migrated/old-schema
local db a sibling sub-query throws, and because they weren't isolated the whole
function rejected — so revenue + payments + hourly all vanished together while the
renderer's allSettled left the KPI card at 0.

## Files
- `apps/desktop/src/main/managerReports.ts` — A293: isolate the payments and hourly
  sub-queries inside getSalesSummary (revenue row always returns); make
  getTopProducts fail-soft too. Same fail-soft pattern as getTableOccupancy (A290),
  one level deeper. Carries A290's getTableOccupancy guard (already committed).

## Effect
- Revenue / Orders / Avg / VAT render from the row query even if payments or hourly
  throw. Payment-methods and top-sellers render when their queries succeed, empty
  (not blank-everything) when they don't — with a console.warn naming the failure.

## Apply (from repo root) — EXTRACT then commit
    cd /c/swiftpos/pos
    grep -c "getSalesSummary payment split failed" apps/desktop/src/main/managerReports.ts  # must print 1
    # paste the A293 register line into docs/AUDIT-REGISTER.md, then:
    git add apps/desktop/src/main/managerReports.ts docs/MANIFEST-2026-09-17-c.md docs/AUDIT-REGISTER.md
    git commit -m "A293: isolate getSalesSummary sub-queries + fail-soft getTopProducts — Overview no longer blanks on a sibling schema throw"
    git push origin dev
    # ships in the next desktop build (0.5.43)

## Rollback
    git checkout -- apps/desktop/src/main/managerReports.ts

## Register (rule 14)
    A293 → FIX BUILT — Overview revenue showed 0 despite correct data because
    getSalesSummary rejected when a sibling sub-query (payments JOIN / hourly) threw
    on a migrated local schema, taking the revenue row down with it. Isolated the
    payments + hourly sub-queries (row always returns); getTopProducts fail-soft.
    Awaiting on-target confirm on the next build.

## Still to confirm (top sellers)
- If sellers stay empty after this build, run this in DB Browser to see throw vs empty:
      SELECT oi.product_name, SUM(oi.quantity), SUM(oi.subtotal)
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.status='completed' AND o.created_at >= '2026-09-17T00:00:00.000Z'
      GROUP BY oi.product_name;
