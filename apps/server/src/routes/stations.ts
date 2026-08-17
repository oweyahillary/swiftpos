/**
 * stations.ts — print stations and which categories route to them.
 *
 * Replaces `categories.is_kitchen`, a single boolean meaning "one kitchen". That
 * boolean is why 3PC Chicken never reached the kitchen: routing was one tick box,
 * nobody had ticked it, and nothing anywhere said so. A category routed nowhere is
 * now something the manager screen can show as unassigned.
 *
 * ROUTING IS PER CATEGORY, NEVER PER ITEM
 *   Owner's decision and the right one. Per-item routing is a field that must be
 *   set correctly on every product forever, and the failure is silent every time
 *   it is missed.
 *
 * A CATEGORY ROUTES TO MANY STATIONS
 *   The same order line prints in several places with different content: the
 *   kitchen sees what is cooked (no drinks), the packing station sees everything,
 *   the customer sees item names only. Chicken belongs to kitchen AND dispatch; a
 *   drink belongs to dispatch alone. That is a set, not a flag.
 *
 * THE PRINTER IS NOT HERE, DELIBERATELY
 *   A station is a business-level idea ("Grill"). Which physical printer serves it
 *   belongs to the terminal, because three tills have three different printers
 *   attached. That binding lives in each till's local printer settings, keyed on
 *   station id.
 */

import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requireAnyPermission } from '../middleware/rbac';
import { supabase } from '../lib/supabase';

const router = safeRouter();
router.use(requireAuth);

const KINDS = ['kitchen', 'dispatch', 'receipt'] as const;
type Kind = (typeof KINDS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/stations
//
// Returns stations WITH their category ids attached. One call, because every
// consumer — the manager screen, the till's catalogue pull — needs both, and
// fetching them separately guarantees a moment where a station's routing looks
// empty while the second request is in flight.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { data: stations, error } = await supabase
    .from('print_stations')
    .select('*')
    .eq('business_id', req.businessId)
    .order('sort_order');

  if (error) { sendError(res, error); return; }

  const ids = (stations ?? []).map((s: { id: string }) => s.id);
  let links: { category_id: string; station_id: string }[] = [];
  if (ids.length > 0) {
    const { data, error: linkErr } = await supabase
      .from('category_stations')
      .select('category_id, station_id')
      .in('station_id', ids);
    if (linkErr) { sendError(res, linkErr); return; }
    links = data ?? [];
  }

  const byStation = new Map<string, string[]>();
  for (const l of links) {
    const list = byStation.get(l.station_id) ?? [];
    list.push(l.category_id);
    byStation.set(l.station_id, list);
  }

  res.json((stations ?? []).map((s: { id: string }) => ({
    ...s,
    category_ids: byStation.get(s.id) ?? [],
  })));
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/stations/unassigned
//
// Categories routed to no station at all — they print nowhere.
//
// Its own endpoint rather than something the client derives, because this is the
// exact fault that lost 3PC Chicken: the information existed but nothing asked
// the question. A screen that has to compute it is a screen that can forget to.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/unassigned', async (req, res) => {
  const { data: cats, error } = await supabase
    .from('categories')
    .select('id, name')
    .eq('business_id', req.businessId)
    .order('name');
  if (error) { sendError(res, error); return; }

  const ids = (cats ?? []).map((c: { id: string }) => c.id);
  if (ids.length === 0) { res.json([]); return; }

  const { data: links, error: linkErr } = await supabase
    .from('category_stations').select('category_id').in('category_id', ids);
  if (linkErr) { sendError(res, linkErr); return; }

  const routed = new Set((links ?? []).map((l: { category_id: string }) => l.category_id));
  res.json((cats ?? []).filter((c: { id: string }) => !routed.has(c.id)));
});

// ── POST /api/stations ───────────────────────────────────────────────────────
// POST /api/stations/seed-defaults
// One-click day-one setup for a venue with no stations yet (register A92).
// Creates Kitchen (kitchen), Packing (dispatch) and Till (receipt), then routes
// every category so none "prints nowhere": cooked categories (is_kitchen) go to
// Kitchen, and ALL categories go to Packing (the packer bags the whole order).
// Till is the customer receipt and carries no category routing. Guarded: refuses
// if any station already exists, so it can't duplicate or clobber a real setup.
router.post('/seed-defaults', requireAnyPermission('stations.manage', 'products.manage'), async (req, res) => {
  const { data: existing } = await supabase
    .from('print_stations').select('id').eq('business_id', req.businessId).limit(1);
  if ((existing ?? []).length > 0) {
    res.status(409).json({ error: 'Stations already exist; seed skipped', created: false });
    return;
  }

  const branchId = req.body?.branch_id ?? null;
  const { data: made, error: mkErr } = await supabase
    .from('print_stations')
    .insert([
      { business_id: req.businessId, branch_id: branchId, name: 'Kitchen', kind: 'kitchen',  sort_order: 0 },
      { business_id: req.businessId, branch_id: branchId, name: 'Packing', kind: 'dispatch', sort_order: 1 },
      { business_id: req.businessId, branch_id: branchId, name: 'Till',    kind: 'receipt',  sort_order: 2 },
    ])
    .select();
  if (mkErr) { sendError(res, mkErr); return; }

  const kitchen = (made ?? []).find(s => s.kind === 'kitchen');
  const packing = (made ?? []).find(s => s.kind === 'dispatch');

  const { data: cats } = await supabase
    .from('categories')
    .select('id, is_kitchen')
    .eq('business_id', req.businessId);
  const all = (cats ?? []).map(c => c.id);
  const cooked = (cats ?? []).filter(c => (c as { is_kitchen?: boolean }).is_kitchen).map(c => c.id);

  const routing: Array<{ category_id: string; station_id: string }> = [];
  if (packing) for (const category_id of all)    routing.push({ category_id, station_id: packing.id });
  if (kitchen) for (const category_id of cooked) routing.push({ category_id, station_id: kitchen.id });
  if (routing.length) {
    const { error: rErr } = await supabase.from('category_stations').insert(routing);
    if (rErr) { sendError(res, rErr); return; }
  }

  res.status(201).json({
    created: true,
    stations: (made ?? []).length,
    routed: { packing: all.length, kitchen: cooked.length },
  });
});

router.post('/', requireAnyPermission('stations.manage', 'products.manage'), async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const kind = String(req.body?.kind ?? 'kitchen') as Kind;

  if (!name) { res.status(400).json({ error: 'name is required' }); return; }
  if (!KINDS.includes(kind)) {
    res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
    return;
  }

  const { data, error } = await supabase
    .from('print_stations')
    .insert({
      business_id: req.businessId,
      branch_id:   req.body?.branch_id ?? null,
      name,
      kind,
      sort_order:  Number(req.body?.sort_order) || 0,
    })
    .select()
    .single();

  // 23505 is the case-insensitive name index. Two stations called "Grill" would
  // be indistinguishable on every ticket header and in every dropdown, so this is
  // a real conflict rather than a server fault.
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      res.status(409).json({ error: `A station called "${name}" already exists here` });
      return;
    }
    sendError(res, error); return;
  }
  res.status(201).json({ ...data, category_ids: [] });
});

// ── PATCH /api/stations/:id ──────────────────────────────────────────────────
router.patch('/:id', requireAnyPermission('stations.manage', 'products.manage'), async (req, res) => {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) { res.status(400).json({ error: 'name cannot be empty' }); return; }
    patch.name = name;
  }
  if (req.body?.kind !== undefined) {
    if (!KINDS.includes(req.body.kind)) {
      res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` }); return;
    }
    patch.kind = req.body.kind;
  }
  if (req.body?.sort_order !== undefined) patch.sort_order = Number(req.body.sort_order) || 0;
  if (req.body?.active !== undefined) patch.active = req.body.active === true;

  const { data, error } = await supabase
    .from('print_stations')
    .update(patch)
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)   // tenant scope, never trust the path alone
    .select()
    .single();

  if (error) {
    if ((error as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'Another station here already has that name' }); return;
    }
    sendError(res, error); return;
  }
  if (!data) { res.status(404).json({ error: 'Station not found' }); return; }
  res.json(data);
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/stations/:id/categories
//
// Replaces the station's category set wholesale. The manager screen edits this as
// a list of tick boxes, so sending the resulting set is both simpler and safer
// than diffing add/remove calls — a dropped request in a diff-based scheme leaves
// routing half-applied, and half-applied routing prints half an order.
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/categories', requireAnyPermission('stations.manage', 'products.manage'), async (req, res) => {
  const stationId = req.params.id;
  const incoming: string[] = Array.isArray(req.body?.category_ids) ? req.body.category_ids : [];

  const { data: station, error: stErr } = await supabase
    .from('print_stations').select('id').eq('id', stationId)
    .eq('business_id', req.businessId).single();
  if (stErr || !station) { res.status(404).json({ error: 'Station not found' }); return; }

  // Only categories belonging to this business. Without this check a crafted
  // request could route another tenant's category to a station here, which would
  // leak their menu structure onto this business's tickets.
  let valid: string[] = [];
  if (incoming.length > 0) {
    const { data: cats, error: catErr } = await supabase
      .from('categories').select('id').eq('business_id', req.businessId).in('id', incoming);
    if (catErr) { sendError(res, catErr); return; }
    valid = (cats ?? []).map((c: { id: string }) => c.id);
  }

  const { error: delErr } = await supabase
    .from('category_stations').delete().eq('station_id', stationId);
  if (delErr) { sendError(res, delErr); return; }

  if (valid.length > 0) {
    const { error: insErr } = await supabase
      .from('category_stations')
      .insert(valid.map(category_id => ({ category_id, station_id: stationId })));
    if (insErr) { sendError(res, insErr); return; }
  }

  res.json({
    station_id: stationId,
    category_ids: valid,
    // Reported rather than silently dropped: a category id that did not survive
    // validation means the screen is showing something stale, and the manager
    // should find that out now rather than when a ticket does not print.
    rejected: incoming.filter(id => !valid.includes(id)),
  });
});

// ── DELETE /api/stations/:id ─────────────────────────────────────────────────
// category_stations cascades (migration 44), so routing rows cannot be stranded.
router.delete('/:id', requireAnyPermission('stations.manage', 'products.manage'), async (req, res) => {
  const { error } = await supabase
    .from('print_stations').delete()
    .eq('id', req.params.id).eq('business_id', req.businessId);
  if (error) { sendError(res, error); return; }
  res.status(204).end();
});

export default router;
