/**
 * POST /api/sync/backfill — A602: a POS's sales history in bulk ("going online later"). Rules: lib/backfill.ts.
 *
 * Body (JSON, gzip'd by the POS — express.json inflates it; the limit is on the inflated size, lib/backfill.ts):
 *   { orders: [{ id: <the POS's order id>, body: <its /api/orders body> }, … ≤ 500],
 *     business_days, shifts, floats, expenses, kitchen_voids: [ … the rows those sales need ] }
 * Answer 200: { ok: true, cash: <the /api/sync/push answer>, results: [{ id, status, http, orderId?, code?, error? }], counts }
 *   status: accepted | duplicate | waiting (424: the drawer is not on the cloud) | refused (the sale's own fault: its HTTP
 *   status and words) | later (not reached this call — a 5xx, the time budget; sent again)
 * The cash rows' own refusal (a 503 SYNC_RETRY, a 409) is the whole call's answer: nothing of the sales is tried.
 *
 * Only a POS (its own session, or a person's PIN sign-in on it — as /api/sync/push). Refused with the normal push's own
 * answers when the business's backup is not on: A581's lock (503 CLOUD_SUBSCRIPTION_ENDED) and A601's desktop-only cut
 * (503 CLOUD_BACKUP_OFF) — requireAuth's gate does both (BACKUP_WRITES lists this path); checked again here so the route
 * stands on its own.
 */
import type { Request, Response } from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { standingFor, syncRefusalBody, backupRefusalBody } from '../lib/cloudPlan';
import { chunkIn } from '../lib/pgQuery';
import { subRequest, runChain } from '../lib/internalCall';
import {
  readBackfillBody, classifySaleAnswer, inPool, countOutcomes, BACKFILL_CONCURRENCY, BACKFILL_BUDGET_MS, BACKFILL_QUIET_KEY,
  type SaleResult, type BackfillQuiet,
} from '../lib/backfill';
import { syncPushHandler } from './sync';
import { createOrder, sellsOrTillSale } from './orders';

const router = safeRouter();
router.use(requireAuth);

router.post('/', async (req: Request, res: Response) => {
  const t0 = Date.now();
  if (!req.isTill && !(req.pinSignIn && req.surface === 'desktop')) {
    res.status(403).json({ error: 'Only a POS sends its sales history here.', code: 'TILL_ONLY' });
    return;
  }
  // The business's backup must be on (A581's lock, A601's cut). A failed read never refuses (as the gate).
  const s = req.businessId ? await standingFor(req.businessId).catch(() => null) : null;
  if (s?.syncRefused) {
    res.locals.cloudLapsed = true; res.set('Retry-After', '900'); res.status(503).json(syncRefusalBody(s)); return;
  }
  if (s?.desktopOnly?.backupOff) {
    res.locals.cloudLapsed = true; res.set('Retry-After', '3600'); res.status(503).json(backupRefusalBody(s)); return;
  }
  const read = readBackfillBody(req.body);
  if (!('value' in read)) { res.status(read.status).json({ error: read.error, code: read.code }); return; }
  const { orders, cash } = read.value;

  // 1. The drawers, days, floats, expenses and kitchen voids — through the /api/sync/push handler itself, always (with
  //    nothing to write it still records the POS as syncing: the watchdog's last_sync_at).
  const cashAnswer = await runChain([syncPushHandler], subRequest(req, { url: '/push', originalUrl: '/api/sync/push', body: cash }));
  if (cashAnswer.status < 200 || cashAnswer.status >= 300) {
    if (cashAnswer.headers['retry-after']) res.set('Retry-After', cashAnswer.headers['retry-after']);
    res.status(cashAnswer.status).json({ ...(cashAnswer.body ?? {}), stage: 'cash' });
    return;
  }

  // 2. The sales. The batch's order ids looked up at once: a sale already on the cloud is a duplicate without a call of
  //    its own; a new one skips the per-sale lookup (createOrder still catches a race on the key).
  let known = new Map<string, { id: string; order_number: string | null }>();
  let lookedUp = false;
  try {
    const rows = await chunkIn<{ id: string; order_number: string | null; idempotency_key: string }>('orders', 'idempotency_key', orders.map((o) => o.id),
      (q) => q.select('id, order_number, idempotency_key').eq('business_id', req.businessId));
    known = new Map(rows.map((r) => [r.idempotency_key, { id: r.id, order_number: r.order_number }]));
    lookedUp = true;
  } catch { /* each sale looks itself up, as a normal push */ }

  const quiets: BackfillQuiet[] = [];
  const results = await inPool<typeof orders[number], SaleResult>(orders, BACKFILL_CONCURRENCY, async (o) => {
    const had = known.get(o.id);
    if (had) return { id: o.id, status: 'duplicate', http: 200, orderId: had.id };
    const quiet: BackfillQuiet = { knownNew: lookedUp, repriced: 0, cashierClaims: 0 };
    quiets.push(quiet);
    try {
      const a = await runChain([sellsOrTillSale, createOrder], subRequest(req, {
        url: '/', originalUrl: '/api/orders', body: o.body, headers: { 'x-idempotency-key': o.id }, extra: { [BACKFILL_QUIET_KEY]: quiet },
      }));
      const status = classifySaleAnswer(a.status, a.body);
      const out: SaleResult = { id: o.id, status, http: a.status };
      if (typeof a.body?.orderId === 'string') out.orderId = a.body.orderId;
      if (status !== 'accepted' && status !== 'duplicate') {
        if (typeof a.body?.code === 'string') out.code = a.body.code;
        const words = typeof a.body?.error === 'string' ? a.body.error : `HTTP ${a.status}`;
        out.error = typeof a.body?.detail === 'string' && a.body.detail ? `${words} — ${a.body.detail}` : words;
      }
      return out;
    } catch (e) {
      return { id: o.id, status: 'later', http: 500, error: `not saved this time: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
    }
  }, (o) => ({ id: o.id, status: 'later', http: 503, code: 'BACKFILL_TIME', error: 'not reached in this upload — sent again' }), t0 + BACKFILL_BUDGET_MS);

  const counts = countOutcomes(results);
  const repriced = quiets.reduce((n, q) => n + q.repriced, 0);
  const claims = quiets.reduce((n, q) => n + q.cashierClaims, 0);
  const up = (cashAnswer.body?.upserted ?? {}) as Record<string, number>;
  const cashRows = Object.values(up).reduce((n, v) => n + (Number(v) || 0), 0);
  const firstRefusal = results.find((r) => r.status === 'refused');
  // The one log line of this call.
  console.log(`[backfill] business ${req.businessId} device ${String(req.header('X-Device-Id') ?? '').split(',')[0].trim().slice(0, 64) || '-'}: `
    + `${orders.length} sale(s) — ${counts.accepted} accepted, ${counts.duplicate} duplicate, ${counts.waiting} waiting for their drawer, `
    + `${counts.refused} refused, ${counts.later} later; ${cashRows} cash row(s)`
    + `${repriced ? `; ${repriced} priced differently now (recorded as before)` : ''}${claims ? `; ${claims} cashier claim(s) not taken` : ''}`
    + `${firstRefusal ? `; first refusal: ${firstRefusal.http} ${String(firstRefusal.error ?? '').slice(0, 120)}` : ''} — ${Date.now() - t0} ms`);
  res.status(200).json({ ok: true, cash: cashAnswer.body ?? null, results, counts });
});

export default router;
