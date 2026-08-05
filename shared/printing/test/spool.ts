/**
 * Drives the spool with a fake clock and a fake printer, so every path is
 * exercised deterministically rather than by sleeping and hoping.
 */

import { Spool } from '../src/spool';
import { MemoryJobStore } from '../src/spoolStore.memory';
import { PrinterError } from '../src/transport';

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
};

function make(send: (t: string, b: Buffer) => Promise<void>) {
  let clock = 1_000_000;
  const store = new MemoryJobStore();
  const spool = new Spool(store, {
    send,
    isRetryable: e => (e instanceof PrinterError ? e.retryable : true),
    now: () => clock,
    backoffMs: [100, 200, 400],
    maxAgeMs: 2_000,
  });
  return { store, spool, advance: (ms: number) => { clock += ms; }, at: () => clock };
}

const job = (over: Partial<Parameters<Spool['enqueue']>[0]> = {}) => ({
  stationId: 'st-kitchen',
  stationName: 'Kitchen',
  target: '10.0.0.5:9100',
  bytes: Buffer.from([0x1b, 0x40, 0x41]),
  orderId: 'ord-1',
  kind: 'kitchen',
  ...over,
});

async function main() {
  // ── The till must never wait ────────────────────────────────────────────
  {
    const { spool } = make(() => new Promise(r => setTimeout(r, 5_000)));
    const t0 = Date.now();
    for (let i = 0; i < 50; i++) spool.enqueue(job());
    check('50 jobs enqueued without waiting on the printer', Date.now() - t0 < 50,
      `${Date.now() - t0}ms`);
  }

  // ── Happy path ──────────────────────────────────────────────────────────
  {
    const sent: string[] = [];
    const { spool, store } = make(async t => { sent.push(t); });
    spool.enqueue(job());
    spool.enqueue(job({ stationId: 'st-till', stationName: 'Till', target: '10.0.0.6:9100' }));
    await spool.drain();
    check('both jobs printed', sent.length === 2, sent.join(', '));
    check('nothing left queued', Object.keys(store.countsByStation()).length === 0);
  }

  // ── One job at a time per printer ───────────────────────────────────────
  {
    let concurrent = 0, peak = 0;
    const { spool } = make(async () => {
      concurrent++; peak = Math.max(peak, concurrent);
      await new Promise(r => setImmediate(r));
      concurrent--;
    });
    spool.enqueue(job());
    spool.enqueue(job());
    spool.enqueue(job());
    // Fire ticks concurrently, as the real interval would.
    await Promise.all([spool.tick(), spool.tick(), spool.tick()]);
    check('never two jobs on one printer at once', peak === 1, `peak ${peak}`);
  }

  // ── Retryable failure backs off, then succeeds ──────────────────────────
  {
    let attempts = 0;
    const { spool, store, advance } = make(async () => {
      attempts++;
      if (attempts < 3) throw new PrinterError('printer is off', true);
    });
    spool.enqueue(job());

    await spool.tick();
    check('first attempt failed and requeued', store.list(1)[0].status === 'queued');
    check('not retried before its backoff elapses', (await spool.tick(), attempts === 1),
      `${attempts} attempts`);

    advance(150); await spool.tick();
    advance(250); await spool.tick();
    check('succeeded on the third attempt', attempts === 3 && store.list(1)[0].status === 'done');
  }

  // ── Permanent failure is not retried ────────────────────────────────────
  {
    let attempts = 0;
    const { spool, store, advance } = make(async () => {
      attempts++;
      throw new PrinterError('getaddrinfo ENOTFOUND printer.invalid', false);
    });
    spool.enqueue(job());
    await spool.tick();
    advance(10_000); await spool.tick();
    check('permanent failure tried exactly once', attempts === 1, `${attempts} attempts`);
    check('permanent failure surfaces as failed', store.list(1)[0].status === 'failed');
  }

  // ── Gives up after maxAttempts ──────────────────────────────────────────
  {
    let attempts = 0;
    const { spool, store, advance } = make(async () => {
      attempts++;
      throw new PrinterError('timed out', true);
    });
    spool.enqueue(job());
    for (let i = 0; i < 10; i++) { await spool.drain(); advance(500); }
    check('stops once the job is older than maxAgeMs', attempts >= 3 && attempts <= 6,
      `${attempts} attempts over ${2_000}ms window`);
    check('ends failed, not queued forever', store.list(1)[0].status === 'failed');
  }

  // ── Offline printer catches up when it returns ──────────────────────────
  {
    let online = false;
    const printed: number[] = [];
    const { spool, advance } = make(async (_t, b) => {
      if (!online) throw new PrinterError('printer is off', true);
      printed.push(b.length);
    });
    spool.enqueue(job({ bytes: Buffer.alloc(10) }));
    spool.enqueue(job({ bytes: Buffer.alloc(20) }));
    spool.enqueue(job({ bytes: Buffer.alloc(30) }));
    for (let i = 0; i < 4; i++) { await spool.drain(); advance(200); }
    check('nothing printed while offline', printed.length === 0);
    online = true;
    await spool.drain();
    check('all three printed once it came back', printed.length === 3, printed.join(', '));
    check('printed in the order they were rung', printed.join() === '10,20,30', printed.join());
  }

  // ── Crash recovery ──────────────────────────────────────────────────────
  {
    const { spool, store } = make(async () => { throw new Error('never called'); });
    spool.enqueue(job());
    store.claimNext(1_000_000, []);   // simulate: claimed, then the process died
    check('job was left mid-print', store.list(1)[0].status === 'printing');
    const n = spool.recoverStuck();
    check('stuck job recovered', n === 1 && store.list(1)[0].status === 'queued');
    check('recovered flag set for the duplicate banner', store.list(1)[0].recovered === true);
  }

  // ── Manual retry of a failed job ────────────────────────────────────────
  {
    let ok = false;
    const { spool, store } = make(async () => { if (!ok) throw new PrinterError('x', false); });
    const id = spool.enqueue(job());
    await spool.tick();
    check('failed as expected', store.list(1)[0].status === 'failed');
    ok = true;
    spool.retry(id);
    await spool.drain();
    check('manual retry prints it', store.list(1)[0].status === 'done');
  }

  console.log(failures === 0 ? '\nSpool verified.' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
