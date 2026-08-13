// Pure decision for the daily-report job (register A54). Kept free of any
// imports/side-effects so it can be unit-tested directly. With the cron firing
// every 15 min, correctness rests entirely on these three rules:
//   • enabled must be true                    (off means off)
//   • today must not already have been sent    (once-per-EAT-day dedup)
//   • now (EAT) must be at/after send_time      (honour the business's time)
export interface ReportSchedule {
  enabled?: boolean;
  send_time?: string;   // 'HH:mm', interpreted in EAT
  recipients?: string[];
}

export function decideDailySend(
  schedule: ReportSchedule | null | undefined,
  nowEatDate: string,           // 'yyyy-MM-dd' in EAT
  nowEatHHMM: string,           // 'HH:mm' in EAT
  lastSentDate: string | null,  // 'yyyy-MM-dd' EAT of the last successful send
): boolean {
  if (!schedule?.enabled) return false;
  if (lastSentDate === nowEatDate) return false;
  const toMin = (s: string) => {
    const [h, m] = String(s).split(':').map(n => parseInt(n, 10) || 0);
    return h * 60 + m;
  };
  return toMin(nowEatHHMM) >= toMin(schedule.send_time || '21:00');
}
