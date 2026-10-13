// A455: when the monthly pack goes out — pure, so it can be tested without a clock or a database.
//   • only when the owner switched it on (report_schedule.monthly_pack === true)
//   • on the 1st of the month (East Africa Time), from 07:00 — the night's trading has closed
//   • once per month: the month already sent is not sent again (a failure retries on the next run)
import { previousMonth } from '../lib/monthlyPack';

export function decideMonthlySend(
  enabled: boolean,
  nowEatDate: string,        // 'yyyy-MM-dd' in EAT
  nowEatHour: number,        // 0–23 in EAT
  lastSentMonth: string | null,
): string | null {
  if (!enabled) return null;
  if (nowEatDate.slice(8, 10) !== '01') return null;
  if (nowEatHour < 7) return null;
  const month = previousMonth(nowEatDate);
  return lastSentMonth === month ? null : month;
}
