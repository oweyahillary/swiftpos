// dayOrder.ts — the order a till's trading days are written in (A363, 2026-09-29).
//
// business_days_one_open_per_till (migration 41) allows ONE open day per till. A till that closes yesterday and opens
// today while OFFLINE pushes both days in one batch. Written concurrently, the new open day could land before
// yesterday's close: 23505, refused as duplicate_open_day, and its shift then refused as missing_business_day — both
// parked on the till for good (T1, 2026-09-29: the shift never reached the cloud, its sales waited for two hours).
// So: every closing day first, then the rest. Within a group order does not matter.
export function closesFirst<T extends { status: string }>(rows: T[]): T[][] {
  const closing = rows.filter((r) => r.status === 'closed');
  const others  = rows.filter((r) => r.status !== 'closed');
  return [closing, others].filter((g) => g.length > 0);
}
