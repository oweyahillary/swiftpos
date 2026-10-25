import { mpesaFromSettings, mpesaLabel, mpesaReceiptNumber } from '../lib/mpesaReceive';   // A492
import { Router } from 'express';
import { effectiveKeysForRow, clientPermissionMap } from '../lib/effectivePermissions';   // A490
import { offersForBranch } from './offers';   // A445
import { promotionOffersFor } from '../lib/promotionOffers';   // A518
import { enabledFromSetting } from '../lib/paymentCatalogue';   // A429
import { sendError } from '../lib/sendError';
import { parseNotePicks } from '../lib/orderNotes';
import { parseReversalRules, REVERSAL_SETTING_KEYS } from '../lib/reversalRules';
import { parsePosFeatures, POS_FEATURE_KEYS } from '../lib/posFeatures';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';
import { isNodeRole } from '../lib/deviceRegistry';
import { checkDeviceBranch } from '../lib/deviceBinding';   // A446
import { createHash } from 'crypto';   // A446
import { MAX_DISCOUNT_PCT } from '../lib/discountPolicy';
import { themesEnabled, effectiveThemeId } from '../lib/themeAccess';
import { getWebAccess } from '../lib/webAccess';
import { worksAtBranch } from '../lib/branchAccess';   // A426
import { isConfirmedBranchServer } from '../lib/deviceRole';   // A427
import { mayIssueJoinCode } from '../lib/tillJoin';   // A427
import { makeCode, hashCode, expiryFromNow } from '../lib/enrolCode';   // A427
import { cleanCutoff } from '../lib/businessDay';   // 0.6.34
import { cleanHistoryMethods } from '../lib/cashierHistory';
import { cleanSeesSales, historyTotalsOn } from '../lib/cashierShiftSales';   // A416 / A418   // 0.6.37 (A387)
import { getSupportContact } from '../lib/supportContact';   // 0.6.35 (A384)
import { frozenAtBranch, may as mayStock } from '../lib/stockTakeAccess';   // A394 (A535: may)
import { pageAll, chunkPaged } from '../lib/pgQuery';
import { seesCosts, stripFields, COST_FIELDS } from '../lib/costAccess';   // A494
import { readTopicVersion, cachedFallback } from '../lib/syncVersions';   // A528
import { readTill } from '../lib/authCache';                           // A528
import { traffic } from '../lib/trafficStats';                         // A528
import { initAnswer, setInitBuilder, type BuiltInit } from '../lib/posInit';   // A531
import { changesAnswer, ChangesUnavailable } from '../lib/syncChanges';         // A531
import { menusForPos } from '../lib/menus';                                    // A537
import { servedBranchBranding } from '../lib/branchBrandingStore';             // A544
import { businessOutOfStockMode, branchStockView } from '../lib/stockGateStore';  // A563
import { assertBranchAccess } from '../middleware/rbac';                        // A563
import { scaleSettingsOrDefault, SCALE_SETTINGS_KEY } from '../lib/scaleBarcode';   // A577
import { loadCreditRule, approversAt } from '../lib/creditApprovers';   // A585

/** P1-9: a paged read in the { data, error } shape the /init batch destructures (an error instead of a throw). */
async function pagedResult<T>(read: () => Promise<T[]>): Promise<{ data: T[] | null; error: { message: string } | null }> {
  try { return { data: await read(), error: null }; } catch (e: any) { return { data: null, error: { message: e?.message ?? 'read failed' } }; }
}

const router = safeRouter();

router.use(requireAuth);
// A582: a partner (lib/webPartners.ts) names only their own branches here (?branch_id= — the catalogue's prices, the change
// log, the stock view): another branch of the business was answered as asked. Tills and everyone else as before.
router.use((req, res, next) => {
  const asked = typeof req.query.branch_id === 'string' ? req.query.branch_id : '';
  if (req.webPartner && asked && !assertBranchAccess(req, asked)) { res.status(403).json({ error: 'You do not have access to this branch' }); return; }
  next();
});

// GET /api/pos/catalogue-version
// A291: a CHEAP freshness signal so a till can pull the moment a web edit lands
// instead of waiting for the 10-min full-pull floor. Returns the newest updated_at
// across the reference tables that carry the set_updated_at() BEFORE UPDATE trigger
// (products, categories, business_settings, users, tables, branches, branch_printers,
// branch_prices). Any web edit to those bumps a timestamp; the till compares this to
// its last successful pull and pulls ONLY when it moved. Far lighter than /init.
//
// v1 coverage gap (deliberate): category_stations, variant_*, modifier_*, combo_items
// carry no updated_at trigger, so composition/routing edits still ride the 10-min
// floor until v2 adds their triggers. NEVER wedges the till: on any failure it returns
// 200 with version:null and the till simply keeps its floor cadence.
//
// A528 (Render suspended production over bandwidth, 2026-10-19 — owner: "only a change can trigger data sync"): the 16
// reads below ran for EVERY till EVERY 20 s. Now the database keeps the version (migration 150: sync_versions, bumped by
// triggers on those 16 tables) and this answers from ONE row per business, remembered 15 s (lib/syncVersions.ts) — and
// dropped at once when this server writes the business's catalogue (routes/index.ts). The answer is "cv:<version>". A till
// only compares it for equality (syncEngine.ts pullIfCatalogueChanged): the first answer in the new format is a change,
// so every till pulls ONCE after this deploys (and once more after migration 150, if the server ran before it). A branch
// row bumps its business's version, so branch_id needs no second read (a change at one branch makes the others pull once).
// Before migration 150 (or when the row cannot be read) the 16 reads run as before, remembered 60 s per business and branch.
router.get('/catalogue-version', async (req, res) => {
  const branchId = typeof req.query.branch_id === 'string' ? req.query.branch_id : null;
  const biz = req.businessId;
  traffic.count('catalogue.answered');
  const v = await readTopicVersion(biz, 'catalogue');
  if (v !== null) { res.json({ version: `cv:${v}` }); return; }

  // Latest updated_at from one table; null (not throw) if the column/scope is absent,
  // so one odd table can never fail the whole check.
  const latest = async (table: string, col: 'business_id' | 'branch_id' | 'id', val: string | null): Promise<string | null> => {
    if (!val) return null;
    try {
      const { data, error } = await supabase
        .from(table).select('updated_at').eq(col, val)
        .order('updated_at', { ascending: false }).limit(1).maybeSingle();
      if (error || !data?.updated_at) return null;
      return data.updated_at as string;
    } catch { return null; }
  };

  try {
    const version = await cachedFallback(`${biz}|${branchId ?? ''}`, async () => {
      traffic.queries(16);
      const picks = await Promise.all([
        latest('products',         'business_id', biz),
        latest('categories',       'business_id', biz),
        latest('business_settings','business_id', biz),
        latest('business_branding', 'business_id', biz),
        // A325: switching a business's 'themes' flag must reach its tills within the 20-s check, not the 10-min
        // floor. feature_flags has business_id and an updated_at trigger, like the tables above.
        latest('feature_flags', 'business_id', biz),
        latest('users',            'business_id', biz),
        latest('tables',           'business_id', biz),
        latest('branches',         'business_id', biz),
        latest('branch_printers',  'branch_id',   branchId),
        latest('branch_prices',    'branch_id',   branchId),
        // A394: a stock count started, an item counted (released from a freeze), a count closed.
        latest('stock_takes',      'business_id', biz),
        // A445: an offer created, changed, switched off or deleted (updated_at moves on each, deleted_at keeps the row).
        latest('offers',           'business_id', biz),
        // A518: a promotion created, changed or switched off — charged at the sale as an offer, so the tills learn of it.
        latest('promotions',       'business_id', biz),
        // A446: print stations — a station added or changed on the web or another till reaches this till within 20 s
        // (it waited for the 10-minute sync: "No station …" on Test print).
        latest('print_stations',   'business_id', biz),
        // A450: the business itself — a new business name (or currency) on the web reaches every till within 20 s; it
        // waited for the 10-minute pull, and the till then ignored it (the name was written only at sign-in).
        latest('businesses',       'id',          biz),
        // A492: this branch's own settings — a manager's new M-Pesa number on one till reaches the branch's other tills
        // within 20 s (it waited for the 10-minute pull).
        latest('branch_settings',  'branch_id',   branchId),
      ]);
      // ISO-8601 UTC strings sort chronologically; newest is the version.
      return picks.filter(Boolean).sort().pop() ?? null;
    });
    res.json({ version });
  } catch {
    res.json({ version: null }); // never wedge the till over a freshness check
  }
});


// GET /api/pos/changes?since=<seq>&branch_id= — A531: the rows that changed since this till last applied (lib/syncChanges.ts).
// Owner, 2026-10-19: "if I change fries from 100 to 150 the trigger should only send the affected product and price, not the
// whole menu … if Eugene's PIN changes only Eugene's change gets synced, not all 150 staff." Without `since`: where the log
// is now (a till notes it before it takes the whole menu). 404 CHANGES_UNAVAILABLE before migration 151 (the till keeps its
// old way); 503 when the log could not be read (asked again later).
router.get('/changes', async (req, res) => {
  const raw = req.query.since;
  const since = raw === undefined || raw === '' ? null : Number(raw);
  if (since !== null && (!Number.isInteger(since) || since < 0)) { res.status(400).json({ error: 'since must be a whole number' }); return; }
  const branchId = typeof req.query.branch_id === 'string' && req.query.branch_id ? req.query.branch_id : (req.branchId ?? null);
  traffic.count('changes.answered');
  try {
    // A535: and whether the caller may see a level a blind count is counting (a till's own session never — A394).
    const answer = await changesAnswer({ businessId: req.businessId!, branchId, isTill: !!req.isTill, seesCosts: seesCosts(req),
      seesCountedStock: mayStock(req, 'inventory.adjust') }, since);
    res.set('Cache-Control', 'no-store');
    res.json(answer);
  } catch (e) {
    if (e instanceof ChangesUnavailable) {
      if (e.missing) { res.status(404).json({ error: 'This cloud does not keep a change log yet.', code: 'CHANGES_UNAVAILABLE' }); return; }
      res.status(503).json({ error: 'The change log could not be read right now - try again shortly.', code: 'CHANGES_BUSY' }); return;
    }
    sendError(res, e as Error);
  }
});

// POST /api/pos/join-code — A427: the branch server asks for one enrolment code for a till someone at the server has
// just allowed to join (lib/tillJoin.ts). The same single-use, branch-bound, 15-minute code the admin portal issues;
// the till redeems it itself and gets its own session. Only a confirmed branch server, only for its own licensed branch.
router.post('/join-code', async (req, res) => {
  if (!req.isTill || req.surface !== 'desktop' || !req.deviceId) {
    res.status(403).json({ error: 'Only a branch server can add a POS.', code: 'not_a_server' }); return;
  }
  if (!(await isConfirmedBranchServer(req.businessId, req.deviceId))) {
    res.status(403).json({ error: 'This machine is not confirmed as the branch server yet — let it sync once, then try again.', code: 'not_confirmed_server' });
    return;
  }
  const { data: device } = await supabase.from('user_devices').select('branch_id')
    .eq('business_id', req.businessId).eq('device_id', req.deviceId).maybeSingle();
  const branchId = (device as { branch_id?: string | null } | null)?.branch_id ?? null;
  if (!branchId) { res.status(409).json({ error: 'This branch server is not bound to a branch.', code: 'no_branch' }); return; }
  const { data: branch } = await supabase.from('branches').select('id, name, desktop_licensed')
    .eq('id', branchId).eq('business_id', req.businessId).maybeSingle();
  if (!branch) { res.status(404).json({ error: 'Branch not found' }); return; }
  if (!(branch as { desktop_licensed?: boolean }).desktop_licensed) {
    res.status(409).json({ error: 'This branch has no desktop licence — ask ZapTill to assign one.', code: 'BRANCH_NOT_LICENSED' }); return;
  }
  if (!mayIssueJoinCode(req.deviceId)) {
    res.status(429).json({ error: 'Too many points of sale added in the last hour — try again later.', code: 'join_rate' }); return;
  }

  const raw = makeCode();
  const expiresAt = expiryFromNow();
  const { error } = await supabase.from('device_enrolment_codes')
    .insert({ business_id: req.businessId, branch_id: branchId, code_hash: hashCode(raw), expires_at: expiresAt });
  if (error) { sendError(res, error); return; }

  console.log(`[tillJoin] branch server ${req.deviceId} added a till to branch ${branchId} (code expires ${expiresAt})`);
  res.json({
    code: raw, businessId: req.businessId, branchId, branchName: (branch as { name?: string }).name ?? null, expiresAt,
  });
});

// A528: per business and branch, the staff version and the list's own version this server last answered.
const ROSTER_MAX_AGE_MS = 10 * 60_000;
const rosterAnswers = new Map<string, { staffVersion: number; version: string; at: number }>();
function rememberRoster(key: string, v: { staffVersion: number; version: string; at: number }): void {
  rosterAnswers.delete(key); rosterAnswers.set(key, v);
  while (rosterAnswers.size > 5_000) { const k = rosterAnswers.keys().next().value; if (k === undefined) break; rosterAnswers.delete(k); }
}

// active products (with category colour), active categories, main branch id, and variant groups.
// GET /api/pos/branch-staff — hands a branch NODE its staff roster with bcrypt
// PIN hashes so it can authenticate cashiers offline (PHASE5 §4b / A17). This is
// the one route that gives a machine the branch's PIN hashes, so the guard is
// four conditions: the desktop surface, the caller's own business, a device
// registered as a node/office, and that device's own branch. bcrypt only.
router.get('/branch-staff', async (req, res) => {
  if (req.surface !== 'desktop') { res.status(403).json({ error: 'desktop surface only' }); return; }
  // A494: the PIN hashes go to a TILL's own session only, for itself — never a person's sign-in (a cashier's token is not
  // a till), and never for another device named in a header. The till (staffRoster.ts, syncEngine.ts) asks with its own
  // session and its own id in X-Device-Id.
  if (!req.isTill || !req.deviceId) { res.status(403).json({ error: "Only a POS's own session receives the staff list.", code: 'TILL_ONLY' }); return; }
  const deviceId = String(req.headers['x-device-id'] ?? '').split(',')[0].trim();
  if (!deviceId) { res.status(400).json({ error: 'x-device-id required' }); return; }
  if (deviceId !== req.deviceId) { res.status(403).json({ error: 'A POS receives only its own staff list.', code: 'NOT_THIS_TILL' }); return; }

  // A528: the till's row as the sign-in check just read it (lib/authCache.ts — remembered 30 s while joined; blocking,
  // retiring or moving a till through this server forgets it), not a second read on every ask.
  const { data: device } = await readTill(req.businessId, deviceId);

  // A446 (owner, 2026-10-11): "each till should keep a local copy of all staff pin related to that branch" — so a new
  // cashier signs in at once on every till, and a till signs its staff in with no server and no internet. Every till of
  // the business gets its branch's list now (it was the branch server only), as long as it is joined (not retired).
  if (!device || (device as { retired_at?: string | null }).retired_at || (device as { status?: string }).status === 'blocked') {
    res.status(403).json({ error: 'this POS is not joined to the business', code: 'not_joined' });
    return;
  }
  // The branch: the one the cloud bound this till to, else the one its own sign-in names (A415: a till's session names
  // its branch) — and the device is bound to it now. A server or till whose record had no branch used to be refused
  // here ("this device is not bound to a branch") and silently never got the list: new cashiers were "not recognised".
  let branchId = (device as { branch_id?: string | null }).branch_id ?? null;
  if (!branchId && req.branchId) {
    const bound = await checkDeviceBranch(req.businessId!, deviceId, req.branchId);
    if (bound.ok) branchId = bound.boundBranchId ?? req.branchId;
  }
  if (!branchId) { res.status(409).json({ error: 'this POS has not been given a branch yet', code: 'no_branch' }); return; }

  // A528: every till asks every 10-20 s and each ask read the whole staff list. The staff version (migration 150: bumped
  // by users, roles, grants, people's branches, tills joining or leaving; remembered 15 s and dropped when this server
  // changes staff) says whether anything changed since this branch's last answer: if not, and the till already holds
  // that answer (?v=), it is told "unchanged" without the read — the same answer an unchanged list always got, so every
  // till version (1.0.15 on) reads it as before. Read BEFORE the list, so a change during the read shows next time.
  // Before migration 150 (no version) the list is read every time, as before. Re-read at least every 10 minutes anyway.
  const staffVersion = await readTopicVersion(req.businessId, 'staff');
  const held = String(req.query.v ?? '');
  const rosterKey = `${req.businessId}|${branchId}`;
  const last = rosterAnswers.get(rosterKey);
  if (staffVersion !== null && held && last && last.staffVersion === staffVersion && last.version === held
      && Date.now() - last.at < ROSTER_MAX_AGE_MS) {
    traffic.count('staff.roster_unchanged_memory');
    res.json({ branch_id: branchId, version: held, unchanged: true });
    return;
  }

  traffic.queries(1);
  const { data: staffList, error } = await supabase
    .from('users')
    .select(`
      id, name, status, pin_hash,
      roles ( name, role_permissions ( permissions ( key ) ) ),
      user_branches ( branch_id ),
      user_permissions ( granted, permissions ( key ) )
    `)
    .eq('business_id', req.businessId)
    .eq('status', 'active');
  if (error) { sendError(res, error); return; }

  // Effective permissions = role grants then per-user overrides — A490: the one rule (lib/effectivePermissions), sent as
  // the map the clients hold (clientPermissionMap: fine keys + the broad keys an older till checks + the marker; the
  // owner's role {'*': true}) — identical to /verify-pin and the JWT.
  const roster = (staffList ?? [])
    // A426: the same rule as PIN sign-in — no branch assigned means every branch (lib/branchAccess.ts)
    .filter((u: any) => worksAtBranch(u.user_branches, branchId))
    .map((u: any) => {
      const permissions = clientPermissionMap(effectiveKeysForRow(u));
      return {
        staff_id:          u.id,
        name:              u.name,
        role_name:         u.roles?.name ?? null,
        branch_id:         branchId,
        permissions,
        pin_hash:          u.pin_hash ?? null,
        // A494: never sent — no till checks an override PIN offline (pinCache / branchStaff never verify against it); an
        // approval with one is checked by the cloud. The field stays (null) so an older till reads the same shape.
        override_pin_hash: null,
        status:            u.status,
      };
    })
    // bcrypt only — a legacy hash upgrades on the next ONLINE sign-in; the node
    // never tries to match against a format pinCache would refuse anyway.
    .filter((s: { pin_hash: string | null }) => !!s.pin_hash && s.pin_hash.startsWith('$2'))
    .sort((a: { staff_id: string }, b: { staff_id: string }) => a.staff_id.localeCompare(b.staff_id));

  // A446: a version of exactly what is sent — a till that already holds it is told so (it asks every few seconds).
  const version = createHash('sha256').update(JSON.stringify(roster)).digest('hex').slice(0, 24);
  if (staffVersion !== null) rememberRoster(rosterKey, { staffVersion, version, at: Date.now() });
  if (String(req.query.v ?? '') === version) {
    traffic.count('staff.roster_unchanged_read');
    res.json({ branch_id: branchId, version, unchanged: true }); return;
  }
  traffic.count('staff.roster_full');
  res.json({ branch_id: branchId, version, staff: roster });
});

router.get('/init', async (req, res) => {
  // ── Which branch are we pricing for? ────────────────────────────────────────
  // Per-branch pricing (BRANCH_AUTHORITY_AND_SYNC_DESIGN.md §6): the till is bound
  // to one branch and sends it as ?branch_id. We resolve THAT branch's prices.
  // If absent (legacy callers) we fall back to the main branch below, so behaviour
  // is unchanged for anything not yet sending branch_id.
  const requestedBranchId =
    typeof req.query.branch_id === 'string' ? req.query.branch_id : null;

  // A531 (owner, 2026-10-19: "asking for the same 10 times an hour is not logical"): the answer is built once per
  // catalogue version (buildInit below, kept by lib/posInit.ts) — the next till of the business, and the next ask while
  // nothing changed, costs no database read. Nothing in it is per caller: the licence gate and the cost prices are applied
  // here, per request, as before.
  // Version 0 = the business has no row (sync_versions before migration 150 seeded it, or a test database): not kept.
  const version = await readTopicVersion(req.businessId, 'catalogue');
  const built = await initAnswer(req.businessId!, requestedBranchId, version && version > 0 ? version : null);
  if (!built.ok) { sendError(res, (built as { error: any }).error); return; }
  const { body: initBody, opBranch } = built as { body: Record<string, unknown>; opBranch: { desktop_licensed?: boolean } | null };

  // ── Desktop branch licence check ──────────────────────────────────────────
  // The branch the till OPERATES on must have a paid desktop licence. That is the
  // bound branch it sent, falling back to the main branch only for legacy callers
  // with no binding. D11: this used to read the main branch's flag regardless of
  // where the till was bound, so a till at an unlicensed branch B rode branch A's
  // licence — and a licensed till at B could be locked out by A being unlicensed.
  // If it doesn't, the desktop app can't sync — blocks the POS at the data layer.
  // (PIN entry is also blocked in verify-pin, so this is defence-in-depth.)
  // Desktop-licence gate applies to the DESKTOP surface only. The web POS is
  // gated by web access at login (businesses.web_access_expires_at), NOT by a
  // per-branch desktop licence — so web tokens must not be blocked here.
  if (req.surface === 'desktop' && !opBranch?.desktop_licensed) {
    res.status(403).json({
      error: 'This branch does not have a desktop licence. Please contact ZapTill to activate.',
      code:  'BRANCH_NOT_LICENSED',
    });
    return;
  }

  // A494: cost prices are not sent to someone who may not see them (rule 4). The till stores no cost from here (its
  // products table has no cost column; its menu screens read costs from /api/products with the person's own session), so
  // the till's own session gets none; a person gets them with menu.costs / reports.costs.
  const sendInit = (body: Record<string, unknown>) =>
    res.json(req.isTill || !seesCosts(req) ? stripFields(body, new Set(COST_FIELDS)) : body);
  sendInit(initBody);
});

/** A531: whose /init is built — only the business (nothing per caller is read). */
export interface InitCaller { businessId?: string | null }

/**
 * A531: /init's whole answer for (business, requested branch) — the reads and rules as they always were, returned rather
 * than sent, so lib/posInit.ts keeps it per catalogue version and GET /changes answers a settings change from it.
 */
export async function buildInit(req: InitCaller, requestedBranchId: string | null): Promise<BuiltInit> {
  const [
    { data: products, error: pErr },
    { data: categories, error: cErr },
    { data: comboRows },
    { data: receiptTextRows },
    { data: mainBranch, error: brErr },
    { data: boundBranch },
    { data: branchTextRows },
    { data: business },
    { data: branding },
  ] = await Promise.all([
    // P1-9: paged — one plain read stops at the row cap (1000), and a menu past it reached the till cut short, silently.
    pagedResult<any>(() => pageAll(() => supabase
      .from('products')
      .select('*, categories(name, color)')
      .eq('business_id', req.businessId)
      .eq('status', 'active'))),
    // Paged in id order, then put in the menu's own order (sort_order) as before.
    pagedResult<any>(async () => (await pageAll<any>(() => supabase
      .from('categories')
      .select('*')
      .eq('business_id', req.businessId)
      .eq('status', 'active')))
      .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0))),
    // Combo definitions. The till sells a combo as ONE line, but the dispatcher
    // and kitchen tickets must expand it into components — and each component
    // routes to the kitchen on its OWN category, so is_kitchen comes along.
    pagedResult<any>(() => pageAll(() => supabase
      .from('products')
      .select('id, combo_items!combo_id ( quantity, sort_order, product:product_id ( id, name, is_kitchen, category_id, categories ( is_kitchen ) ) )')
      .eq('business_id', req.businessId)
      .eq('is_combo', true)
      .eq('status', 'active'))),
    // Owner-controlled receipt text. Lives in business_settings so it is set
    // once and reaches all three tills, rather than being retyped per device
    // and lost on reinstall.
    supabase
      .from('business_settings')
      .select('key, value')
      .eq('business_id', req.businessId)
      // kitchen_exclusions rides along with the receipt text because it is the
      // same shape of thing: owner-authored, per business, cached on every till.
      .in('key', ['receipt_header', 'receipt_footer', 'kitchen_exclusions', 'continuous_operation', 'business_day_cutoff', 'cashier_history_methods', 'cashier_sees_shift_sales', 'cashier_history_totals', 'payment_methods_enabled', 'order_note_picks', 'receipt_pay_label', 'receipt_pay_number', 'receipt_pay_account',
        SCALE_SETTINGS_KEY,   // A577: the business's scale label layout
        ...REVERSAL_SETTING_KEYS]),
    // The MAIN branch — used only as the fallback operating branch for a till
    // that has not sent its binding yet, and as the `branchId` the desktop falls
    // back to when unbound. maybeSingle, not single: one_main_branch_per_business
    // permits ZERO main branches, and a .single() there errored and failed the
    // whole catalogue pull closed (D11).
    supabase
      .from('branches')
      .select('id, desktop_licensed')
      .eq('business_id', req.businessId)
      .eq('is_main', true)
      .maybeSingle(),
    // The BOUND branch the till actually operates on, when it sent one. Fetched
    // here in the same round-trip and validated to this business, so the desktop
    // licence and per-branch pricing can both key off the real operating branch
    // rather than the main one (D11: a till bound to branch B was licensed by
    // branch A's flag). Resolves to null for legacy callers that send no branch_id.
    requestedBranchId
      ? supabase
          .from('branches')
          .select('id, desktop_licensed')
          .eq('id', requestedBranchId)
          .eq('business_id', req.businessId)   // tenant guard — never resolve another business's branch
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    // A139: this branch's setting overrides (receipt text + hours), same tenant
    // guard as the bound branch; merged over the business defaults below so a
    // franchise branch's own header/footer/hours win. Absent → inherit default.
    requestedBranchId
      ? supabase
          .from('branch_settings')
          .select('key, value')
          .eq('business_id', req.businessId)
          .eq('branch_id', requestedBranchId)
          .in('key', ['receipt_header', 'receipt_footer', 'continuous_operation', 'business_day_cutoff', 'cashier_history_methods', 'cashier_sees_shift_sales', 'cashier_history_totals', 'payment_methods_enabled', 'receipt_pay_label', 'receipt_pay_number', 'receipt_pay_account'])
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from('businesses')
      .select('type, name, currency, vat_rate, ctl_rate, status')
      .eq('id', req.businessId)
      .single(),
    // A304: client branding (accent + base64 logo) for this business, pulled to
    // the till's local `branding` mirror (remote-wins). maybeSingle — the absent
    // row is the norm (branding is optional) and must not fail the pull closed.
    supabase
      .from('business_branding')
      .select('accent_hex, logo_png, logo_receipt, receipt_logo_enabled, theme_id')
      .eq('business_id', req.businessId)
      .maybeSingle(),
  ]);
  // A325: the EFFECTIVE action theme — null while the business's 'themes' flag is off (the till keeps today's
  // look), else its chosen id or the default. Top-level, not inside `branding`: a business can have themes
  // without ever having saved a branding row, and `branding: null` means "leave the till's value alone".
  const themesOn = await themesEnabled(req.businessId);
  const themeId = effectiveThemeId(themesOn, branding?.theme_id);
  // A346: does the business have the web POS? Same entitlement as web sign-in (lib/webAccess.ts) — fully usable = active
  // or in grace (owner, 2026-09-27: "stock should only appear if the web pos is enabled"; reports-only week → no).
  const webPosEnabled = (await getWebAccess(req.businessId, (business as any)?.status)).fullAccess;

  if (pErr || cErr || brErr) {
    return { ok: false, error: (pErr || cErr || brErr) as any };
  }

  // The branch the till OPERATES on (the licence gate, in the route, reads its desktop_licensed — D11): the bound branch it
  // sent, falling back to the main branch only for legacy callers with no binding.
  const opBranch = boundBranch ?? mainBranch;
  // A544: this branch's override of the business branding (theme, brand colour, receipt footer) — only while the business
  // has themes (A325); null otherwise, so a till and the web POS apply none (stored, never applied). Only the till's own
  // branch's row: another branch's override never reaches it.
  const branchBranding = await servedBranchBranding((opBranch as { id?: string } | null)?.id ?? null, themesOn);

  // Fetch variant groups using the resolved product ID array (not a sub-query)
  const productIds = (products ?? []).map((p) => p.id);

  const [{ data: variantGroups, error: vErr }, { data: loyaltyFlag }] = await Promise.all([
    // P1-9: every product id in ONE .in() put ~37 characters per product in the URL — past ~220 products the request
    // line overflowed (8 KB) and /init failed. Chunked (150 ids) and paged; then in the menu's order (sort_order) as before.
    productIds.length > 0
      ? pagedResult<any>(async () => (await chunkPaged<any>(productIds, (chunk) => supabase
          .from('variant_groups')
          .select('*, variant_options(*)')
          .in('product_id', chunk)))
          .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0)))
      : Promise.resolve({ data: [] as any[], error: null }),
    supabase
      .from('feature_flags')
      .select('enabled')
      .eq('business_id', req.businessId)
      .eq('key', 'loyalty_enabled')
      .single(),
  ]);

  if (vErr) {
    return { ok: false, error: vErr as any };
  }

  // Group variant_groups by product_id for fast client-side lookup
  const variantsByProduct: Record<string, typeof variantGroups> = {};
  (variantGroups ?? []).forEach((vg) => {
    if (!variantsByProduct[vg.product_id]) variantsByProduct[vg.product_id] = [];
    variantsByProduct[vg.product_id].push(vg);
  });

  // ── Per-branch price resolution ─────────────────────────────────────────────
  // Price for the same operating branch the licence check resolved — the two must
  // agree on where the till is. opBranch is boundBranch ?? mainBranch, already
  // fetched in the parallel batch above; this used to run a SECOND branch lookup
  // here, and split the two resolutions was how licence and pricing could drift
  // (D11). Overlay each product with branch_price (nullable): the effective price
  // the client charges is COALESCE(branch_price, base_price).
  const pricingBranchId: string | null = opBranch?.id ?? null;

  const productsOut = products ?? [];
  if (pricingBranchId && productIds.length > 0) {
    // P1-9: chunked + paged (the one .in() of every product id overflowed the URL past ~220 products, and the failed
    // read was ignored — the till then sold at the BASE price, silently). A failed read now fails /init: the till keeps
    // the catalogue it has, rather than taking one without its branch's prices.
    let branchPrices: Array<{ product_id: string; price: number }>;
    try {
      branchPrices = await chunkPaged<{ product_id: string; price: number }>(productIds, (chunk) => supabase
        .from('branch_prices')
        .select('id, product_id, price')
        .eq('branch_id', pricingBranchId)
        .in('product_id', chunk));
    } catch (e) { return { ok: false, error: e as Error }; }

    const priceByProduct: Record<string, number> = {};
    (branchPrices ?? []).forEach((bp: any) => { priceByProduct[bp.product_id] = bp.price; });

    for (const p of productsOut as any[]) {
      p.branch_price = priceByProduct[p.id] ?? null;   // null → client uses base_price
    }
  } else {
    for (const p of productsOut as any[]) p.branch_price = null;
  }

  // combo_id -> ordered component list. Flattened here rather than in the till so
  // the desktop stores exactly what it prints and nothing has to understand
  // Supabase's nested join shape offline.
  const comboItems: Record<string, Array<{ product_id: string; name: string; quantity: number; is_kitchen: boolean; category_id: string | null }>> = {};
  for (const c of (comboRows ?? []) as any[]) {
    const items = (c.combo_items ?? [])
      .slice()
      .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((ci: any) => ({
        product_id: ci.product?.id ?? '',
        name:       ci.product?.name ?? '',
        quantity:   Number(ci.quantity ?? 1),
        // Product override wins; NULL falls back to the category. Written out
        // long-hand rather than with ?? because the override is a tri-state and
        // `false` must beat a kitchen category, not be treated as absent.
        is_kitchen: typeof ci.product?.is_kitchen === 'boolean'
          ? ci.product.is_kitchen
          : !!ci.product?.categories?.is_kitchen,
        // A component routes on its OWN category (A248, Phase 1 of print parity),
        // exactly as the desktop does; is_kitchen stays the fallback.
        category_id: ci.product?.category_id ?? null,
      }))
      .filter((i: any) => i.product_id);
    if (items.length) comboItems[c.id] = items;
  }

  // JSONB: a plain string arrives unwrapped, anything else is coerced.
  const receiptText: Record<string, string> = {};
  for (const r of (receiptTextRows ?? []) as any[]) {
    receiptText[r.key] = typeof r.value === 'string' ? r.value : String(r.value ?? '');
  }
  // A139: a branch override, when present, wins over the business default. The
  // till is branch-bound and sent ?branch_id, so it receives its own values with
  // no client change; a branch with no override row inherits the business default.
  // A492: the M-Pesa line is ONE thing (Buy Goods, or Paybill with its account): the branch's own when it has a number,
  // else the business's — never a branch's label with the business's account.
  const businessMpesa = mpesaFromSettings(receiptText.receipt_pay_label, receiptText.receipt_pay_number, receiptText.receipt_pay_account);
  const branchText: Record<string, string> = {};
  for (const r of (branchTextRows ?? []) as any[]) {
    const v = typeof r.value === 'string' ? r.value : String(r.value ?? '');
    branchText[r.key] = v;
    receiptText[r.key] = v;
  }
  const branchMpesa = mpesaFromSettings(branchText.receipt_pay_label, branchText.receipt_pay_number, branchText.receipt_pay_account);
  const mpesa = branchMpesa ?? businessMpesa;

  // A494: the cost prices are removed per caller by the route (after the cache), as before.
  return { ok: true, opBranch: (opBranch as { id?: string; desktop_licensed?: boolean } | null) ?? null, body: {
    products: productsOut,
    comboItems,
    // A304: client branding (accent + logo) → the till writes it to the local
    // `branding` mirror, remote-wins. null when the business has no branding row,
    // which the till reads as "leave the local (tech-set) value alone".
    branding: branding ? {
      accentHex: branding.accent_hex ?? null, logoPng: branding.logo_png ?? null,
      // A311: the receipt raster + the client's opt-in toggle ride the same pull.
      logoReceipt: branding.logo_receipt ?? null,
      receiptLogoEnabled: branding.receipt_logo_enabled === true,
    } : null,
    themeId,
    // A544: the branch's own override ({ branchId, themeId, accentHex, receiptFooter }), or null. The till and the web POS
    // resolve per field: branch → business → ZapTill default (lib/branchBranding.ts). Older tills ignore it.
    branchBranding,
    receiptHeader: receiptText.receipt_header ?? '',
    // 24-hour / continuous operation (A104): when on, an unclosed prior day gets
    // a short grace window at rollover instead of an immediate hard lock, so a
    // round-the-clock branch keeps trading while a manager closes the day.
    continuousOperation: receiptText.continuous_operation === 'true',
    // 0.6.34: when the business day ends, minutes after midnight (0 = midnight); the branch's own value wins.
    businessDayCutoff: cleanCutoff(receiptText.business_day_cutoff) ?? 0,
    // 0.6.37 (A387): the payment methods a cashier's History shows ([] = every method); the branch's own value wins.
    cashierHistoryMethods: cleanHistoryMethods(receiptText.cashier_history_methods) ?? [],
    // A416: a cashier closing a shift sees their sales — off unless the owner/manager turned it on; the branch's own wins.
    cashierSeesShiftSales: cleanSeesSales(receiptText.cashier_sees_shift_sales),
    // A418: a cashier's History total — only while the switch above is on too ("one should be on for the other").
    cashierHistoryTotals: historyTotalsOn(receiptText.cashier_sees_shift_sales, receiptText.cashier_history_totals),
    // A429: the payment methods this branch takes (catalogue codes); the branch's own value wins; absent = the defaults.
    paymentMethodsEnabled: enabledFromSetting(receiptText.payment_methods_enabled),
    // 0.6.35 (A384): the tech allocated to this client (admin portal) — their name and number on the till's Help.
    // Always sent: null = no tech → the Help shows SwiftPOS support's numbers (shared/support.ts). Older tills ignore it.
    support: await getSupportContact(req.businessId),
    // A346: the till shows its Stock screen only when this is true (cached on the till; older tills ignore it).
    webPosEnabled,
    receiptFooter: receiptText.receipt_footer ?? '',
    // A450: how a customer pays the business by M-Pesa, printed under the payments ("Buy Goods: 123456", "Paybill: …").
    // '' = not set (the receipt prints no such line). The branch's own value wins, as for the header and footer.
    // A492: a Paybill's account is printed with its number ("4098201, Account 1234") — so a till on an older build prints
    // it too; `mpesa` is the set-up itself (the till's Manager › Settings shows and edits it).
    receiptPayLabel: mpesa ? mpesaLabel(mpesa.kind) : '',
    receiptPayNumber: mpesaReceiptNumber(mpesa),
    mpesa,
    // Things that must never reach a kitchen ticket — drinks, sauces, packaged
    // sides. Stated by the owner rather than inferred: a keyword guess is wrong
    // occasionally and silently, and the cook is the one who finds out.
    //
    // Per BUSINESS, not per terminal: "cole slaw is not cooked" is a fact about
    // the menu, and a second till must not disagree with the first.
    kitchenExclusions: (() => {
      const raw = receiptTextRows?.find((r: any) => r.key === 'kitchen_exclusions')?.value;
      if (Array.isArray(raw)) return raw.map(String);
      if (typeof raw === 'string') {
        try { const p = JSON.parse(raw); if (Array.isArray(p)) return p.map(String); } catch { /* not json */ }
        return raw.split(/[\r\n,]+/).map(t => t.trim()).filter(Boolean);
      }
      return [] as string[];
    })(),
    // A367: the quick picks for order notes, owner-set per business. Unset → the defaults; a saved empty list → none.
    // Always a list, so a till never has to guess (shared/orderNotes.ts parseNotePicks).
    noteQuickPicks: parseNotePicks(receiptTextRows?.find((r: any) => r.key === 'order_note_picks')?.value),
    // A577: how this business's weighing scales print their labels (shared/scaleBarcode.ts) — always sent, the default
    // when unset or unreadable, so the till and the web POS read scale labels offline. Older tills ignore it.
    scaleBarcodes: scaleSettingsOrDefault(receiptTextRows?.find((r: any) => r.key === SCALE_SETTINGS_KEY)?.value ?? null),
    // 0.6.27: the per-client switches the admin portal sets (feature_flags). Always every key, true or false — an unset
    // switch is off. Older tills ignore it.
    posFeatures: await (async () => {
      const { data } = await supabase.from('feature_flags').select('key, enabled')
        .eq('business_id', req.businessId).in('key', [...POS_FEATURE_KEYS]);
      return parsePosFeatures(data ?? []);
    })(),
    // 0.6.30 (A336 stage 3): the owner's void window and offline void/refund rules — always every rule, defaults where
    // unset. Older tills ignore it.
    reversalRules: parseReversalRules((receiptTextRows ?? []) as Array<{ key: string; value: unknown }>),
    // A394: a stock count at this branch that freezes items — the products not to sell until they have been counted.
    // Always sent: null = nothing frozen. Older tills ignore it.
    stockCount: await frozenAtBranch(req.businessId, (opBranch as { id?: string } | null)?.id ?? null),
    // A445: the offers this branch runs (on, not deleted, for every branch or this one) — the till applies them by its
    // own clock (shared/offers.ts), offline too. Always sent: [] = none. Older tills ignore it.
    // A518: and the promotions charged at the sale, as offers (lib/promotionOffers.ts) — every till applies them already.
    offers: [
      ...(await offersForBranch(req.businessId!, (opBranch as { id?: string } | null)?.id ?? null)),
      ...(await promotionOffersFor(req.businessId!)),
    ],
    categories: categories ?? [],
    // A537: the business's menus (Food, Soft drinks …) — on, not deleted, in order; each category's menu_id names one.
    // Always sent: [] = none (before migration 155 too). Older tills ignore it.
    menus: await menusForPos(req.businessId!),
    // Custom payment methods (A96) — the extras a business accepts beyond the
    // built-in Cash / M-Pesa / Card. Active only; the till caches these so they
    // appear as tender options offline. Per business (owner decision, A95).
    paymentMethods: await (async () => {
      const { data } = await supabase
        .from('payment_methods')
        .select('code, name')
        .eq('business_id', req.businessId)
        .eq('is_active', true)
        .order('sort_order', { ascending: true });
      return (data ?? []).map(m => ({ code: m.code, name: m.name }));
    })(),
    // The desktop falls back to this when it has no binding of its own
    // (syncEngine: effectiveBranchId = boundBranchId || branchId). It is the
    // MAIN branch, deliberately — the fallback for an unbound till, not the
    // operating branch, which the till already knows.
    branchId: mainBranch?.id ?? null,
    pricingBranchId,
    loyaltyEnabled: loyaltyFlag?.enabled ?? false,
    variantsByProduct,
    businessType: business?.type ?? 'retail',
    businessName: business?.name ?? '',
    currency: business?.currency ?? 'KES',
    // The desktop till used to hardcode 16. Send the real rate so it computes
    // and prints the tax this business actually charges — and so a
    // non-VAT-registered business (rate 0) gets no VAT line at all.
    vatRate: business?.vat_rate ?? null,
    // Catering/Tourism Levy. 0 or null = not applicable, and the till's
    // arithmetic collapses to VAT-only.
    ctlRate: business?.ctl_rate ?? 0,
    // The discount ceiling this server enforces on write. Sent so the till
    // clamps to the same number BEFORE it computes a total, takes cash and
    // prints a receipt — otherwise the paper, the drawer and the stored order
    // describe three different discounts and the difference surfaces as a cash
    // shortage nobody can trace.
    maxDiscountPct: MAX_DISCOUNT_PCT,
  } };
}
setInitBuilder(buildInit);   // A531: lib/posInit.ts keeps what this builds

// A552 (owner, 2026-10-21: "for credit sales we need them on desktop app since its the one used by most clients"): the
// customers a till may sell to on account — every customer of the business with a credit limit or a balance owed — with
// their limit and balance, so the till sells on account offline (main/creditCustomers.ts). Desktop only: the till's own
// session (it pulls with it, like the staff list) or a person signed in on a till. No permission key: the till's own
// session holds none of the customer keys (tillScope), and who may SELL on account is decided at the sale (A511 / A552).
// `at` = when this was read: the till counts its own credit sales the cloud had not yet taken on top of the balance.
// A563 — GET /api/pos/stock-view?branch_id= : the owner's "When an item's stock reaches zero" choice and, unless it is
// "sell", the branch's known levels of tracked items and the combos' items — the web POS greys ("Sold out") or hides
// an item that is out (lib/stockGate.ts) and checks again every 30 s. The cloud refuses the sale too (POST /orders).
router.get('/stock-view', async (req, res) => {
  const branchId = String(req.query.branch_id ?? '');
  if (!branchId) { res.status(400).json({ error: 'branch_id is required' }); return; }
  if (!assertBranchAccess(req, branchId)) { res.status(403).json({ error: 'You do not have access to this branch' }); return; }
  try {
    const { data: br } = await supabase.from('branches').select('id').eq('id', branchId).eq('business_id', req.businessId).maybeSingle();
    if (!br) { res.status(404).json({ error: 'Branch not found' }); return; }
    const mode = await businessOutOfStockMode(req.businessId);
    const view = mode === 'sell' ? { levels: {}, combos: {} } : await branchStockView(req.businessId, branchId);
    res.set('Cache-Control', 'no-store');
    res.json({ mode, ...view });
  } catch (e: any) {
    sendError(res, e);
  }
});

router.get('/credit-customers', async (req, res) => {
  if (req.surface !== 'desktop') { res.status(403).json({ error: 'desktop surface only' }); return; }
  try {
    const at = new Date().toISOString();
    const rows = await pageAll<any>(() => supabase.from('customers')
      .select('id, name, phone, credit_limit, credit_balance, status')
      .eq('business_id', req.businessId)
      .or('credit_limit.gt.0,credit_balance.gt.0'));
    const customers = rows
      .filter((c) => c && c.status !== 'deleted' && (Number(c.credit_limit) > 0 || Number(c.credit_balance) > 0))
      .slice(0, 5000)
      .map((c) => ({ id: c.id, name: c.name ?? '', phone: c.phone ?? null, status: c.status ?? 'active',
        credit_limit: Number(c.credit_limit) || 0, credit_balance: Number(c.credit_balance) || 0 }));
    // A585: who approves a sale on account at THIS branch — the owner's choice (off = A552's customers.credit rule). The
    // till keeps it with the list, so it holds offline. owner_id: the owner always approves.
    const branchId = req.branchId ?? (typeof req.query.branch_id === 'string' ? req.query.branch_id : null);
    const [rule, { data: biz }] = await Promise.all([loadCreditRule(req.businessId),
      supabase.from('businesses').select('owner_id').eq('id', req.businessId).maybeSingle()]);
    const approval = { on: rule.on, approvers: rule.on ? approversAt(rule, branchId) : [], owner_id: (biz as { owner_id?: string | null } | null)?.owner_id ?? null };
    res.set('Cache-Control', 'no-store');
    res.json({ at, customers, approval });
  } catch (e: any) {
    sendError(res, e);
  }
});

// A404 — the test-data clears ZapTill made for this business (admin portal, A396) after `after`, oldest first; the
// till removes the same periods from its own database (main/testDataClear.ts). After the last one it applied (A522).
// A482: `menu` = that clear deleted the whole menu (migration 132) — the till empties its own menu too. Before 132 the
// column is missing: the clears are listed without it (menu false).
// A522 (owner, 2026-10-17: "not all tills will run 24/7"): keyed to the till's LAST APPLIED clear (`after`, whatever its
// age) — a till switched off for more than 60 days used to have the floor jump past a clear it never applied, keeping
// the test sales and the test day that then locked it. The 60-day floor stays only for a till that has applied none yet
// (a new till must not replay an old clear — a whole-menu clear would empty the menu it has just pulled).
router.get('/test-data-clears', async (req, res) => {
  const floor = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const asked = typeof req.query.after === 'string' && !Number.isNaN(Date.parse(req.query.after)) ? req.query.after : null;
  const after = asked ?? floor;
  const clearsOf = (cols: string) => supabase.from('test_data_purges').select(cols)
    .eq('business_id', req.businessId).gt('created_at', after).order('created_at', { ascending: true }).limit(20);
  let { data, error } = await clearsOf('id, from_at, to_at, created_at, menu');
  if (error) ({ data, error } = await clearsOf('id, from_at, to_at, created_at'));
  if (error) { res.json([]); return; }   // before migration 122: nothing to clear
  res.set('Cache-Control', 'no-store');
  res.json(data ?? []);
});

export default router;
