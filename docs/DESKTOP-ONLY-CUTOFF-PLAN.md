# Desktop-only clients: cut off from the cloud (A600–A602)

Owner decisions, 28 Oct 2026. Built overnight on 28 Oct; nothing is committed or deployed.

## Why
Nothing in the sync checks the online licence today. Every desktop-only business pushes all its sales, shifts and drawers to Supabase for free. The one paying cloud client carries everyone's hosting, and the free limits are close: log ingestion is at 0.93 of 1 GB.

## Decisions
1. **Partial cut.** For a desktop-only business:
   - **Stays:** setup (joining a POS), sign-in, catalogue and staff changes, and support logs.
   - **Cut:** the backup of sales, orders, shifts, drawers, reversals and day closes, and the background polls that only serve it.
2. **Desktop updates are cut too.** An update becomes a paid support extra: the ZapTill admin releases it to that one business.
3. **A month's notice.** Nothing is cut until the date ZapTill sets. Until then, the POS and the admin portal show the notice.
4. **Old cloud data is kept,** never deleted.
5. **Local backup on every PC first.** This includes a standalone POS, with restore. After the cut, the PC holds the only copy.
6. **Going online later:** new sales first, then history as a bulk backfill in quiet hours, back as far as the owner chooses.

**Who counts as desktop-only:** a business the cloud already calls `not_on_plan` (`apps/server/src/lib/cloudPlan.ts`): no plan, no expiry and no `web_hosting`. Clients on a plan, on a trial, or locked for not paying (A581, which already has its own cut) are not affected.

## Safety switches (deploying changes nothing by itself)
- **The cut-off date:** `DESKTOP_ONLY_CUTOFF_AT`, an ISO date on Render.
  - Unset: nothing changes.
  - Set: until that date, the notice is shown; from that date, the cut applies.
- **Per-business exemption:** the admin-only feature flag `cloud_backup`. When on, the business keeps the backup even with no plan, for goodwill cases. No migration is needed.
- **Per-business updates:** the admin releases an update to a desktop-only business (exact mechanism in A601).

## The work
| ID | What | Where |
|---|---|---|
| **A600** | Local backup on every PC every 6 hours and after the day is closed (the 10 newest kept, a free-space guard), a backup panel the owner and manager can use (no technician sign-in), and restore | desktop |
| **A601** | The cut-off: the date and the notice, refused pushes, desktop updates, the admin portal view, and the POS holding its queue quietly with background polls stopped | cloud + desktop + admin |
| **A602** | Going online later: new sales first, plus a bulk history backfill (compressed, about 500 sales a call, in quiet hours, how far back chosen, progress shown) | cloud + desktop |

## Releases
- **A600 and the desktop side of A601** go in the next desktop release, before the cut-off date. A POS without it would keep trying to push and fail.
- **The cloud side of A601** can deploy at any time, because the date switch is unset.
- **To cut:** set `DESKTOP_ONLY_CUTOFF_AT` to a date at least a month after the notice goes out.
