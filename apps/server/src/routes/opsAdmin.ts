/**
 * opsAdmin.ts — A525: the admin portal's System page reads the ops events (public.ops_events, migration 149).
 *
 *   GET /api/admin/ops/events?kind=&status=&page=&size=   newest first, a page at a time ({ events, total, page, size })
 *   GET /api/admin/ops/summary                            the latest start, deploy check and dependency scan, and what
 *                                                         this server runs now (live: commit, started_at); A528: traffic
 *                                                         since start (lib/trafficStats.ts)
 *
 * Super admins only (requireAdmin + requireSuperAdmin) — an agent and a business's own token are refused. Read only.
 * Owner, 2026-10-17: "these results are written to the db and I can read through".
 */
import { safeRouter } from '../middleware/asyncHandler';
import { requireAdmin, requireSuperAdmin } from '../middleware/adminAuth';
import { supabase } from '../lib/supabase';
import { buildInfo, OPS_KINDS, OPS_STATUSES } from '../lib/opsEvents';
import { trafficSnapshot } from '../lib/trafficStats';   // A528

const router = safeRouter();
const COLS = 'id, kind, status, commit, title, details, source, created_at';
const SIZES = [25, 50, 100];
const unavailable = { error: 'Ops events are not available right now (migration 149?).', code: 'OPS_EVENTS_UNAVAILABLE' };

router.use(requireAdmin, requireSuperAdmin);

router.get('/events', async (req, res) => {
  const kind = String(req.query.kind ?? '').trim();
  const status = String(req.query.status ?? '').trim();
  if (kind && !(OPS_KINDS as readonly string[]).includes(kind)) { res.status(400).json({ error: `kind must be one of ${OPS_KINDS.join(', ')}` }); return; }
  if (status && !(OPS_STATUSES as readonly string[]).includes(status)) { res.status(400).json({ error: `status must be one of ${OPS_STATUSES.join(', ')}` }); return; }
  const sizeIn = Number(req.query.size);
  const size = SIZES.includes(sizeIn) ? sizeIn : 50;
  const pageIn = Math.floor(Number(req.query.page));
  const page = Number.isFinite(pageIn) && pageIn >= 1 ? Math.min(pageIn, 10_000) : 1;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filtered = (q: any) => {
    if (kind) q = q.eq('kind', kind);
    if (status) q = q.eq('status', status);
    return q;
  };
  // The total on its own (head) read, the page on another: the pager needs the total, not the page's length.
  const counted = await filtered(supabase.from('ops_events').select('id', { count: 'exact', head: true }));
  if (counted.error) { res.status(503).json(unavailable); return; }
  const from = (page - 1) * size;
  const { data, error } = await filtered(supabase.from('ops_events').select(COLS))
    .order('created_at', { ascending: false }).range(from, from + size - 1);
  if (error) { res.status(503).json(unavailable); return; }
  res.json({ events: data ?? [], total: Number(counted.count ?? 0), page, size });
});

router.get('/summary', async (_req, res) => {
  const latest = async (kind: string) => {
    const { data, error } = await supabase.from('ops_events').select(COLS).eq('kind', kind)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return data ?? null;
  };
  try {
    const [boot, deploy_check, vuln_scan] = await Promise.all([latest('boot'), latest('deploy_check'), latest('vuln_scan')]);
    // A528: what this server has answered since it started, and what the polled answers cost the database.
    res.json({ live: buildInfo(), boot, deploy_check, vuln_scan, traffic: trafficSnapshot() });
  } catch {
    // The page still says what this server runs, even before migration 149.
    res.status(503).json({ ...unavailable, live: buildInfo(), traffic: trafficSnapshot() });
  }
});

export default router;
