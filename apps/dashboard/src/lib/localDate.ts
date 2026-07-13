// Local-date helpers.
//
// `new Date().toISOString().slice(0, 10)` returns the UTC calendar date, which is
// the WRONG day for anyone east of UTC (e.g. Kenya, UTC+3) during the local
// evening/early-morning — it made every "today" default land on yesterday. These
// helpers format using the browser's LOCAL date components instead.

export function localDateStr(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function localDateStrDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return localDateStr(d);
}
