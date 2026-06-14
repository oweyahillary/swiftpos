import cron from 'node-cron';
import { processPending } from '../lib/etims/queue';
import { etimsEnabledGlobally } from '../lib/etims/provider';

/**
 * eTIMS retry job — reprocesses failed/unsent fiscalisations so offline-generated
 * invoices reach KRA within the allowed transmission window. No-op when eTIMS is
 * not enabled (ETIMS_PROVIDER=none). Runs every 15 minutes by default.
 */
export function startEtimsRetryJob(): void {
  if (!etimsEnabledGlobally()) {
    console.log('[etimsRetry] eTIMS disabled (ETIMS_PROVIDER=none) — retry job not scheduled');
    return;
  }
  const schedule = process.env.ETIMS_RETRY_CRON ?? '*/15 * * * *';
  cron.schedule(schedule, async () => {
    try {
      const { retried } = await processPending();
      if (retried > 0) console.log(`[etimsRetry] reprocessed ${retried} invoice(s)`);
    } catch (err: any) {
      console.error('[etimsRetry] job failed:', err?.message);
    }
  }, { timezone: 'UTC' });
  console.log(`[etimsRetry] Scheduled: ${schedule} UTC`);
}
