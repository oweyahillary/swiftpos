/**
 * /api/admin — SwiftPOS Admin Portal Routes
 * ─────────────────────────────────────────────────────────────────────────────
 * Internal ops dashboard for SwiftPOS agents to manage the client fleet.
 * Auth: separate admin JWT (see middleware/adminAuth.ts).
 *
 * ROUTES
 * ──────
 * Auth
 *   POST   /api/admin/auth/login
 *   POST   /api/admin/auth/logout
 *   GET    /api/admin/auth/me
 *   POST   /api/admin/auth/change-password
 *
 * Fleet
 *   GET    /api/admin/fleet/stats          — dashboard KPI cards
 *   GET    /api/admin/fleet/health         — all businesses with health scores
 *
 * Clients
 *   GET    /api/admin/clients              — paginated client list
 *   POST   /api/admin/clients             — create new business (agent onboarding)
 *   GET    /api/admin/clients/:id          — full client detail
 *   PATCH  /api/admin/clients/:id          — update business profile
 *   POST   /api/admin/clients/:id/suspend
 *   POST   /api/admin/clients/:id/activate
 *
 * Features (feature_flags)
 *   GET    /api/admin/clients/:id/features
 *   PATCH  /api/admin/clients/:id/features/:key
 *
 * Subscription
 *   GET    /api/admin/clients/:id/subscription
 *   POST   /api/admin/clients/:id/subscription/renew
 *
 * Billing (invoices)
 *   GET    /api/admin/clients/:id/billing
 *   POST   /api/admin/clients/:id/billing
 *   PATCH  /api/admin/clients/:id/billing/:invoiceId
 *
 * Notes
 *   GET    /api/admin/clients/:id/notes
 *   POST   /api/admin/clients/:id/notes
 *
 * Audit
 *   GET    /api/admin/audit               — admin audit log
 *
 * Plans
 *   GET    /api/admin/plans
 *
 * Admin Users (super_admin only)
 *   GET    /api/admin/team
 *   POST   /api/admin/team
 *   PATCH  /api/admin/team/:id
 */

import { Router }         from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import bcrypt             from 'bcrypt';
import { supabase }       from '../lib/supabase';
import { seedDefaultRolePermissions } from '../lib/defaultRolePermissions';
import { requireAdmin, requireSuperAdmin, signAdminToken } from '../middleware/adminAuth';

const router = safeRouter();

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function writeAdminAudit(params: {
  adminId:      string;
  adminEmail:   string;
  action:       string;
  resource?:    string;
  businessId?:  string;
  businessName?: string;
  before?:      object;
  after?:       object;
  reason?:      string;
  ip?:          string;
}) {
  await supabase.from('admin_audit_log').insert({
    admin_id:      params.adminId,
    admin_email:   params.adminEmail,
    action:        params.action,
    resource:      params.resource ?? null,
    business_id:   params.businessId ?? null,
    business_name: params.businessName ?? null,
    before_data:   params.before ?? null,
    after_data:    params.after ?? null,
    reason:        params.reason ?? null,
    ip_address:    params.ip ?? null,
  });
}

/** Compute a 0–100 health score for a business based on activity signals. */
function computeHealthScore(data: {
  hasActiveSub:      boolean;
  lastOrderAt:       string | null;
  staffCount:        number;
  productCount:      number;
  ordersThisMonth:   number;
  branchCount:       number;
}): number {
  let score = 0;
  if (data.hasActiveSub) score += 25;

  if (data.lastOrderAt) {
    const daysSince = (Date.now() - new Date(data.lastOrderAt).getTime()) / 86400000;
    if (daysSince <= 7)  score += 25;
    else if (daysSince <= 30) score += 12;
  }

  if (data.staffCount > 1)         score += 15;
  else if (data.staffCount === 1)  score += 8;
  if (data.productCount > 0)       score += 10;
  if (data.ordersThisMonth > 100)  score += 15;
  else if (data.ordersThisMonth > 20) score += 8;
  if (data.branchCount > 1)        score += 10;

  return Math.min(score, 100);
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  const { data: admin } = await supabase
    .from('admin_users')
    .select('id, email, name, password_hash, role, is_active')
    .eq('email', email.toLowerCase().trim())
    .single();

  if (!admin || !admin.is_active) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const ok = await bcrypt.compare(password, admin.password_hash);
  if (!ok) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  await supabase
    .from('admin_users')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', admin.id);

  const token = signAdminToken({ adminId: admin.id, email: admin.email, role: admin.role });

  await writeAdminAudit({
    adminId: admin.id, adminEmail: admin.email,
    action: 'admin.login', resource: 'auth', ip: req.ip,
  });

  res.json({
    token,
    admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
  });
});

router.get('/auth/me', requireAdmin, async (req, res) => {
  const { data } = await supabase
    .from('admin_users')
    .select('id, email, name, role, last_login_at')
    .eq('id', req.adminId)
    .single();
  if (!data) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(data);
});

router.post('/auth/change-password', requireAdmin, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!new_password || new_password.length < 8) {
    res.status(400).json({ error: 'New password must be at least 8 characters' });
    return;
  }

  const { data: admin } = await supabase
    .from('admin_users').select('password_hash').eq('id', req.adminId).single();
  if (!admin) { res.status(404).json({ error: 'Not found' }); return; }

  const ok = await bcrypt.compare(current_password, admin.password_hash);
  if (!ok) { res.status(400).json({ error: 'Current password is incorrect' }); return; }

  const hash = await bcrypt.hash(new_password, 12);
  await supabase.from('admin_users')
    .update({ password_hash: hash, updated_at: new Date().toISOString() })
    .eq('id', req.adminId);

  await writeAdminAudit({ adminId: req.adminId, adminEmail: req.adminEmail, action: 'admin.change_password', resource: 'auth' });
  res.json({ success: true });
});

// ─── FLEET ────────────────────────────────────────────────────────────────────

router.get('/fleet/stats', requireAdmin, async (req, res) => {
  const [
    { count: total },
    { count: active },
    { count: suspended },
    { count: newThisMonth },
  ] = await Promise.all([
    supabase.from('businesses').select('*', { count: 'exact', head: true }),
    supabase.from('businesses').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('businesses').select('*', { count: 'exact', head: true }).eq('status', 'suspended'),
    supabase.from('businesses').select('*', { count: 'exact', head: true })
      .gte('created_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()),
  ]);

  // Revenue MTD from completed invoices
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const { data: invoices } = await supabase
    .from('invoices')
    .select('amount')
    .eq('status', 'paid')
    .gte('paid_at', startOfMonth);
  const revenueMtd = (invoices ?? []).reduce((s: number, i: any) => s + Number(i.amount), 0);

  // Recent signups (last 5)
  const { data: recent } = await supabase
    .from('businesses')
    .select('id, name, type, status, created_at')
    .order('created_at', { ascending: false })
    .limit(5);

  res.json({
    total:        total ?? 0,
    active:       active ?? 0,
    suspended:    suspended ?? 0,
    new_this_month: newThisMonth ?? 0,
    revenue_mtd:  revenueMtd,
    recent_signups: recent ?? [],
  });
});

router.get('/fleet/health', requireAdmin, async (req, res) => {
  // ── Rewritten to use bulk queries instead of N+1 per-business queries ──────
  // Old approach: 6 Supabase calls per business = 60 calls for 10 clients.
  // New approach: 7 bulk queries total regardless of client count.

  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

  const [
    { data: businesses, error },
    { data: staffRows },
    { data: productRows },
    { data: branchRows },
    { data: subRows },
    { data: lastOrderRows },
    { data: mtdOrderRows },
  ] = await Promise.all([
    supabase.from('businesses').select('id, name, type, status, currency, created_at').order('created_at', { ascending: false }),
    supabase.from('users').select('business_id').eq('status', 'active'),
    supabase.from('products').select('business_id').eq('status', 'active'),
    supabase.from('branches').select('business_id').eq('status', 'active'),
    supabase.from('subscriptions').select('business_id, status, expires_at').eq('status', 'active'),
    supabase.from('orders').select('business_id, created_at').eq('status', 'completed').gte('created_at', new Date(Date.now() - 90 * 86400000).toISOString()).order('created_at', { ascending: false }),
    supabase.from('orders').select('business_id').eq('status', 'completed').gte('created_at', startOfMonth),
  ]);

  if (error) { res.status(500).json({ error: error.message }); return; }

  // Build lookup maps from bulk results
  const staffCount:   Record<string, number> = {};
  const productCount: Record<string, number> = {};
  const branchCount:  Record<string, number> = {};
  const subMap:       Record<string, any>    = {};
  const lastOrderMap: Record<string, string> = {};
  const mtdCount:     Record<string, number> = {};

  (staffRows    ?? []).forEach((r: any) => { staffCount[r.business_id]   = (staffCount[r.business_id]   ?? 0) + 1; });
  (productRows  ?? []).forEach((r: any) => { productCount[r.business_id] = (productCount[r.business_id] ?? 0) + 1; });
  (branchRows   ?? []).forEach((r: any) => { branchCount[r.business_id]  = (branchCount[r.business_id]  ?? 0) + 1; });
  (subRows      ?? []).forEach((r: any) => { subMap[r.business_id]       = r; });
  (mtdOrderRows ?? []).forEach((r: any) => { mtdCount[r.business_id]     = (mtdCount[r.business_id]     ?? 0) + 1; });

  // Last order per business — rows are already ordered desc so first match wins
  (lastOrderRows ?? []).forEach((r: any) => {
    if (!lastOrderMap[r.business_id]) lastOrderMap[r.business_id] = r.created_at;
  });

  const enriched = (businesses ?? []).map((biz: any) => {
    const sc = staffCount[biz.id]   ?? 0;
    const pc = productCount[biz.id] ?? 0;
    const bc = branchCount[biz.id]  ?? 0;
    const om = mtdCount[biz.id]     ?? 0;
    const sub = subMap[biz.id]      ?? null;
    const lastOrder = lastOrderMap[biz.id] ?? null;

    const health = computeHealthScore({
      hasActiveSub:    !!sub,
      lastOrderAt:     lastOrder,
      staffCount:      sc,
      productCount:    pc,
      ordersThisMonth: om,
      branchCount:     bc,
    });

    return {
      ...biz,
      staff_count:       sc,
      product_count:     pc,
      branch_count:      bc,
      subscription:      sub,
      last_order_at:     lastOrder,
      orders_this_month: om,
      health_score:      health,
    };
  });

  res.json(enriched);
});

// ─── CLIENTS ──────────────────────────────────────────────────────────────────

const VALID_TYPES = ['restaurant','cafe','retail','minimart','parking','petrol_station','other'] as const;

// POST /api/admin/clients — agent-created business onboarding
// Creates Supabase auth user + business + branch + default roles + owner user row
router.post('/clients', requireAdmin, async (req, res) => {
  const {
    businessName, businessType, ownerName, ownerEmail, ownerPassword,
    phone, currency = 'KES', vatRate = 16,
    branchName = 'Main Branch', branchAddress,
  } = req.body;

  if (!businessName?.trim())  { res.status(400).json({ error: 'businessName is required' }); return; }
  if (!businessType)           { res.status(400).json({ error: 'businessType is required' }); return; }
  if (!ownerEmail?.trim())    { res.status(400).json({ error: 'ownerEmail is required' }); return; }
  if (!ownerPassword || ownerPassword.length < 8) {
    res.status(400).json({ error: 'ownerPassword must be at least 8 characters' }); return;
  }

  const normalizedType = (businessType as string).toLowerCase().replace(/\s+/g, '_');
  if (!VALID_TYPES.includes(normalizedType as typeof VALID_TYPES[number])) {
    res.status(400).json({ error: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}` }); return;
  }

  try {
    // 1. Create Supabase auth user for the owner
    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
      email:          ownerEmail.trim(),
      password:       ownerPassword,
      email_confirm:  true,
    });
    if (authErr) { res.status(400).json({ error: `Auth creation failed: ${authErr.message}` }); return; }
    const supabaseUserId = authData.user.id;

    // 2. Create business
    const { data: business, error: bErr } = await supabase
      .from('businesses')
      .insert({
        name:       businessName.trim(),
        type:       normalizedType,
        owner_name: ownerName?.trim() || ownerEmail.split('@')[0],
        phone:      phone?.trim() || null,
        email:      ownerEmail.trim(),
        vat_rate:   parseFloat(String(vatRate)) || 16,
        currency,
        owner_id:   supabaseUserId,
        status:     'active',
      })
      .select()
      .single();
    if (bErr) throw bErr;

    // 3. Create main branch
    const { data: branch, error: brErr } = await supabase
      .from('branches')
      .insert({
        business_id: business.id,
        name:        branchName.trim(),
        address:     branchAddress?.trim() || null,
        is_main:     true,
        status:      'active',
      })
      .select()
      .single();
    if (brErr) throw brErr;

    // 4. Seed default roles
    const { data: roles, error: rErr } = await supabase
      .from('roles')
      .insert(
        ['owner', 'manager', 'cashier'].map(name => ({
          business_id: business.id,
          name,
          is_default:  true,
        }))
      )
      .select();
    if (rErr) throw rErr;

    // 4b. Grant default permissions to the seeded roles (otherwise roles are
    // created with zero rights — empty roles screen, no staff access).
    await seedDefaultRolePermissions(roles);

    // 5. Create owner user row in users table
    const ownerRole = roles.find(r => r.name === 'owner') ?? roles[0];
    const { data: ownerUser, error: uErr } = await supabase
      .from('users')
      .insert({
        business_id:          business.id,
        name:                 ownerName?.trim() || ownerEmail.split('@')[0],
        email:                ownerEmail.trim(),
        role_id:              ownerRole?.id ?? null,
        status:               'active',
        must_change_password: true,
      })
      .select()
      .single();
    if (uErr) throw uErr;

    // 6. Link owner to main branch
    await supabase.from('user_branches').insert({ user_id: ownerUser.id, branch_id: branch.id });

    // 7. Onboarding progress
    await supabase.from('onboarding_progress').insert({
      business_id:           business.id,
      business_profile_done: true,
      staff_added_done:      false,
      owner_pin_set:         false,
    });

    // 8. Auto-create trial subscription (30 days)
    const { data: trialPlan } = await supabase
      .from('plans').select('id').ilike('name', 'trial').single();
    if (trialPlan) {
      await supabase.from('subscriptions').insert({
        business_id: business.id,
        plan_id:     trialPlan.id,
        status:      'trial',
        starts_at:   new Date().toISOString(),
        expires_at:  new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
    }

    // Audit log
    await writeAdminAudit({
      adminId:    req.adminId,
      adminEmail: req.adminEmail,
      action:     'create_client',
      businessId: business.id,
      resource:   'business',
    });

    res.status(201).json({ business, branch, ownerUserId: ownerUser.id });

  } catch (err: any) {
    console.error('[admin/create-client]', err);
    res.status(500).json({ error: err.message ?? 'Client creation failed' });
  }
});

router.get('/clients', requireAdmin, async (req, res) => {
  const { search, status, type, limit = '50', offset = '0' } = req.query as Record<string, string>;

  let query = supabase
    .from('businesses')
    .select('id, name, type, status, currency, phone, email, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .limit(parseInt(limit))
    .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

  if (status) query = query.eq('status', status);
  if (type)   query = query.eq('type', type);
  if (search) query = query.ilike('name', `%${search}%`);

  const { data, count, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ clients: data ?? [], total: count ?? 0 });
});

router.get('/clients/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;

  const [
    { data: biz },
    { data: branches },
    { count: staffCount },
    { count: productCount },
    { data: sub },
    { data: plan },
    { data: recentOrders },
    { data: flags },
  ] = await Promise.all([
    supabase.from('businesses').select('*').eq('id', id).single(),
    supabase.from('branches').select('id, name, is_main, status, city').eq('business_id', id),
    supabase.from('users').select('*', { count: 'exact', head: true }).eq('business_id', id).eq('status', 'active'),
    supabase.from('products').select('*', { count: 'exact', head: true }).eq('business_id', id).eq('status', 'active'),
    supabase.from('subscriptions').select('*, plans(name, price, billing_cycle, features)').eq('business_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('subscriptions').select('plan_id').eq('business_id', id).maybeSingle(),
    supabase.from('orders').select('id, total, created_at, status').eq('business_id', id).order('created_at', { ascending: false }).limit(10),
    supabase.from('feature_flags').select('key, enabled, notes').eq('business_id', id),
  ]);

  if (!biz) { res.status(404).json({ error: 'Business not found' }); return; }

  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const { data: mtdData } = await supabase
    .from('orders')
    .select('total')
    .eq('business_id', id)
    .eq('status', 'completed')
    .gte('created_at', startOfMonth);

  const revenueMtd = (mtdData ?? []).reduce((s: number, o: any) => s + Number(o.total), 0);

  res.json({
    ...biz,
    branches:      branches ?? [],
    staff_count:   staffCount ?? 0,
    product_count: productCount ?? 0,
    subscription:  sub ?? null,
    recent_orders: recentOrders ?? [],
    revenue_mtd:   revenueMtd,
    features:      flags ?? [],
  });
});

router.patch('/clients/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, phone, email, address, tax_pin, vat_rate, currency } = req.body;

  const { data: before } = await supabase.from('businesses').select('name, status, type').eq('id', id).single();

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (name      !== undefined) updates.name      = name;
  if (phone     !== undefined) updates.phone     = phone;
  if (email     !== undefined) updates.email     = email;
  if (address   !== undefined) updates.address   = address;
  if (tax_pin   !== undefined) updates.tax_pin   = tax_pin;
  if (vat_rate  !== undefined) updates.vat_rate  = vat_rate;
  if (currency  !== undefined) updates.currency  = currency;

  const { data, error } = await supabase
    .from('businesses').update(updates).eq('id', id).select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }

  await writeAdminAudit({
    adminId: req.adminId, adminEmail: req.adminEmail,
    action: 'business.update', resource: 'business',
    businessId: id, businessName: before?.name,
    before: before ?? undefined, after: updates,
  });

  res.json(data);
});

router.post('/clients/:id/suspend', requireAdmin, async (req, res) => {
  const { reason } = req.body;
  const { data: biz } = await supabase.from('businesses').select('name, status').eq('id', req.params.id).single();
  if (!biz) { res.status(404).json({ error: 'Not found' }); return; }
  if (biz.status === 'suspended') { res.status(409).json({ error: 'Already suspended' }); return; }

  await supabase.from('businesses')
    .update({ status: 'suspended', updated_at: new Date().toISOString() })
    .eq('id', req.params.id);

  await writeAdminAudit({
    adminId: req.adminId, adminEmail: req.adminEmail,
    action: 'business.suspend', resource: 'business',
    businessId: req.params.id, businessName: biz.name,
    before: { status: biz.status }, after: { status: 'suspended' }, reason,
  });

  res.json({ success: true });
});

router.post('/clients/:id/activate', requireAdmin, async (req, res) => {
  const { data: biz } = await supabase.from('businesses').select('name, status').eq('id', req.params.id).single();
  if (!biz) { res.status(404).json({ error: 'Not found' }); return; }

  await supabase.from('businesses')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('id', req.params.id);

  await writeAdminAudit({
    adminId: req.adminId, adminEmail: req.adminEmail,
    action: 'business.activate', resource: 'business',
    businessId: req.params.id, businessName: biz.name,
    before: { status: biz.status }, after: { status: 'active' },
  });

  res.json({ success: true });
});

// ─── FEATURES (feature_flags) ─────────────────────────────────────────────────

router.get('/clients/:id/features', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('feature_flags')
    .select('id, key, enabled, notes, set_by, updated_at')
    .eq('business_id', req.params.id)
    .order('key');
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

router.patch('/clients/:id/features/:key', requireAdmin, async (req, res) => {
  const { id, key } = req.params;
  const { enabled, notes } = req.body as { enabled: boolean; notes?: string };

  const { data: biz } = await supabase.from('businesses').select('name').eq('id', id).single();

  const { data, error } = await supabase
    .from('feature_flags')
    .upsert({
      business_id: id, key, enabled,
      notes:    notes ?? null,
      set_by:   req.adminEmail,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'business_id,key' })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  await writeAdminAudit({
    adminId: req.adminId, adminEmail: req.adminEmail,
    action: enabled ? 'feature.enable' : 'feature.disable', resource: 'feature',
    businessId: id, businessName: biz?.name ?? undefined,
    after: { key, enabled },
  });

  res.json(data);
});

// ─── SUBSCRIPTION ─────────────────────────────────────────────────────────────

router.get('/clients/:id/subscription', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*, plans(id, name, price, billing_cycle, features)')
    .eq('business_id', req.params.id)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

router.post('/clients/:id/subscription/renew', requireAdmin, async (req, res) => {
  const { plan_id, years = 1, payment_ref, notes } = req.body;
  const { id } = req.params;

  if (!plan_id) { res.status(400).json({ error: 'plan_id is required' }); return; }

  const { data: biz } = await supabase.from('businesses').select('name').eq('id', id).single();
  const { data: plan } = await supabase.from('plans').select('name, price').eq('id', plan_id).single();

  // Expire current subscription
  await supabase.from('subscriptions')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .eq('business_id', id)
    .eq('status', 'active');

  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + Number(years));

  const { data, error } = await supabase
    .from('subscriptions')
    .insert({
      business_id: id,
      plan_id,
      status: 'active',
      starts_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(),
    })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  // Auto-create invoice if plan has a price
  if (plan && plan.price > 0) {
    const nextInvNum = await getNextInvoiceNumber();
    await supabase.from('invoices').insert({
      business_id:      id,
      subscription_id:  data.id,
      invoice_number:   nextInvNum,
      amount:           Number(plan.price) * Number(years),
      currency:         'KES',
      status:           payment_ref ? 'paid' : 'pending',
      payment_method:   payment_ref ? 'manual' : null,
      payment_reference: payment_ref ?? null,
      period_start:     new Date().toISOString(),
      period_end:       expiresAt.toISOString(),
      paid_at:          payment_ref ? new Date().toISOString() : null,
    });
  }

  await writeAdminAudit({
    adminId: req.adminId, adminEmail: req.adminEmail,
    action: 'subscription.renew', resource: 'subscription',
    businessId: id, businessName: biz?.name ?? undefined,
    after: { plan: plan?.name, years, expires_at: expiresAt.toISOString() },
    reason: notes,
  });

  res.json(data);
});

async function getNextInvoiceNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const { count } = await supabase
    .from('invoices')
    .select('*', { count: 'exact', head: true })
    .like('invoice_number', `INV-${year}-%`);
  const seq = String((count ?? 0) + 1).padStart(4, '0');
  return `INV-${year}-${seq}`;
}

// ─── BILLING (invoices) ───────────────────────────────────────────────────────

router.get('/clients/:id/billing', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('invoices')
    .select('*')
    .eq('business_id', req.params.id)
    .order('created_at', { ascending: false });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

router.post('/clients/:id/billing', requireAdmin, async (req, res) => {
  const { description, amount, currency = 'KES', due_at, notes } = req.body;
  if (!description || !amount) {
    res.status(400).json({ error: 'description and amount are required' });
    return;
  }

  const invoiceNumber = await getNextInvoiceNumber();
  const { data: biz } = await supabase.from('businesses').select('name').eq('id', req.params.id).single();

  const { data, error } = await supabase
    .from('invoices')
    .insert({
      business_id:    req.params.id,
      invoice_number: invoiceNumber,
      amount:         Number(amount),
      currency,
      status:         'pending',
      period_start:   new Date().toISOString(),
    })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  await writeAdminAudit({
    adminId: req.adminId, adminEmail: req.adminEmail,
    action: 'invoice.create', resource: 'invoice',
    businessId: req.params.id, businessName: biz?.name,
    after: { invoice_number: invoiceNumber, amount, currency },
  });

  res.status(201).json(data);
});

router.patch('/clients/:id/billing/:invoiceId', requireAdmin, async (req, res) => {
  const { invoiceId } = req.params;
  const { status, payment_reference, payment_method, paid_at } = req.body;

  const updates: Record<string, unknown> = {};
  if (status             !== undefined) updates.status             = status;
  if (payment_reference  !== undefined) updates.payment_reference  = payment_reference;
  if (payment_method     !== undefined) updates.payment_method     = payment_method;
  if (paid_at            !== undefined) updates.paid_at            = paid_at;
  if (status === 'paid' && !paid_at)    updates.paid_at            = new Date().toISOString();

  const { data, error } = await supabase
    .from('invoices').update(updates).eq('id', invoiceId).select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// ─── NOTES ────────────────────────────────────────────────────────────────────

router.get('/clients/:id/notes', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('admin_client_notes')
    .select('*')
    .eq('business_id', req.params.id)
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

router.post('/clients/:id/notes', requireAdmin, async (req, res) => {
  const { body, pinned = false } = req.body;
  if (!body?.trim()) { res.status(400).json({ error: 'body is required' }); return; }

  const { data: admin } = await supabase
    .from('admin_users').select('name').eq('id', req.adminId).single();

  const { data, error } = await supabase
    .from('admin_client_notes')
    .insert({
      business_id: req.params.id,
      admin_id:    req.adminId,
      admin_name:  admin?.name ?? req.adminEmail,
      body:        body.trim(),
      pinned,
    })
    .select()
    .single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

// ─── AUDIT LOG ────────────────────────────────────────────────────────────────

router.get('/audit', requireAdmin, async (req, res) => {
  const { business_id, action, limit = '50', offset = '0' } = req.query as Record<string, string>;

  let query = supabase
    .from('admin_audit_log')
    .select('*', { count: 'exact' })
    .order('event_time', { ascending: false })
    .limit(parseInt(limit))
    .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

  if (business_id) query = query.eq('business_id', business_id);
  if (action)      query = query.ilike('action', `%${action}%`);

  const { data, count, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ logs: data ?? [], total: count ?? 0 });
});

// ─── PLANS ────────────────────────────────────────────────────────────────────

router.get('/plans', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('plans').select('*').order('price');
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

// ─── TEAM (admin users — super_admin only) ────────────────────────────────────

router.get('/team', requireAdmin, requireSuperAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('admin_users')
    .select('id, email, name, role, is_active, last_login_at, created_at')
    .order('created_at');
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

router.post('/team', requireAdmin, requireSuperAdmin, async (req, res) => {
  const { email, name, password, role = 'agent' } = req.body;
  if (!email || !name || !password) {
    res.status(400).json({ error: 'email, name, and password are required' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  const hash = await bcrypt.hash(password, 12);
  const { data, error } = await supabase
    .from('admin_users')
    .insert({ email: email.toLowerCase().trim(), name, password_hash: hash, role })
    .select('id, email, name, role, is_active, created_at')
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  await writeAdminAudit({
    adminId: req.adminId, adminEmail: req.adminEmail,
    action: 'team.create', resource: 'admin_user',
    after: { email, name, role },
  });

  res.status(201).json(data);
});

router.patch('/team/:id', requireAdmin, requireSuperAdmin, async (req, res) => {
  const { name, role, is_active } = req.body;
  if (req.params.id === req.adminId && is_active === false) {
    res.status(400).json({ error: 'You cannot deactivate your own account' });
    return;
  }
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (name      !== undefined) updates.name      = name;
  if (role      !== undefined) updates.role      = role;
  if (is_active !== undefined) updates.is_active = is_active;

  const { data, error } = await supabase
    .from('admin_users').update(updates).eq('id', req.params.id)
    .select('id, email, name, role, is_active').single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

export default router;

// ─── BRANCH DESKTOP LICENCES ──────────────────────────────────────────────────
// Each branch requires its own one-off desktop licence fee.
// Multiple devices within a branch are all covered — the unit is the branch.

/**
 * GET /api/admin/clients/:id/branches
 * Returns all branches for a client with their desktop licence status.
 */
router.get('/clients/:id/branches', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('branches')
    .select('id, name, is_main, status, city, desktop_licensed, desktop_licensed_at, desktop_licensed_by')
    .eq('business_id', req.params.id)
    .order('is_main', { ascending: false })
    .order('created_at');

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

/**
 * POST /api/admin/clients/:id/branches/:branchId/licence
 * Enable or disable desktop licence for a specific branch.
 * Body: { licensed: boolean, invoice_ref?: string, notes?: string }
 *
 * On enable  → sets desktop_licensed = true, auto-creates invoice if price provided.
 * On disable → sets desktop_licensed = false (desktop app blocked on next sync).
 */
router.post('/clients/:id/branches/:branchId/licence', requireAdmin, async (req, res) => {
  const { id, branchId } = req.params;
  const { licensed, invoice_amount, invoice_ref, notes } = req.body as {
    licensed:        boolean;
    invoice_amount?: number;
    invoice_ref?:    string;
    notes?:          string;
  };

  // Verify branch belongs to this business
  const { data: branch, error: branchErr } = await supabase
    .from('branches')
    .select('id, name, desktop_licensed, business_id')
    .eq('id', branchId)
    .eq('business_id', id)
    .single();

  if (branchErr || !branch) {
    res.status(404).json({ error: 'Branch not found' });
    return;
  }

  // No-op if already in requested state
  if (branch.desktop_licensed === licensed) {
    res.json({ message: `Branch is already ${licensed ? 'licensed' : 'unlicensed'}`, branch });
    return;
  }

  const updates: Record<string, unknown> = {
    desktop_licensed:    licensed,
    desktop_licensed_at: licensed ? new Date().toISOString() : null,
    desktop_licensed_by: licensed ? req.adminEmail : null,
    updated_at:          new Date().toISOString(),
  };

  const { data: updated, error: updateErr } = await supabase
    .from('branches')
    .update(updates)
    .eq('id', branchId)
    .select()
    .single();

  if (updateErr) { res.status(500).json({ error: updateErr.message }); return; }

  // Auto-create invoice when licensing a new branch
  if (licensed && invoice_amount && invoice_amount > 0) {
    const year  = new Date().getFullYear();
    const { count } = await supabase
      .from('invoices')
      .select('*', { count: 'exact', head: true })
      .like('invoice_number', `INV-${year}-%`);
    const seq          = String((count ?? 0) + 1).padStart(4, '0');
    const invoiceNumber = `INV-${year}-${seq}`;

    await supabase.from('invoices').insert({
      business_id:       id,
      invoice_number:    invoiceNumber,
      amount:            invoice_amount,
      currency:          'KES',
      status:            invoice_ref ? 'paid' : 'pending',
      payment_reference: invoice_ref ?? null,
      paid_at:           invoice_ref ? new Date().toISOString() : null,
    });
  }

  // Audit trail
  const { data: biz } = await supabase.from('businesses').select('name').eq('id', id).single();
  await writeAdminAudit({
    adminId:      req.adminId,
    adminEmail:   req.adminEmail,
    action:       licensed ? 'branch.licence.enable' : 'branch.licence.disable',
    resource:     'branch',
    businessId:   id,
    businessName: biz?.name,
    before:       { branch_name: branch.name, desktop_licensed: branch.desktop_licensed },
    after:        { branch_name: branch.name, desktop_licensed: licensed },
    reason:       notes,
  });

  res.json(updated);
});

// ─── TECH ACCESS TOKENS ───────────────────────────────────────────────────────

const TECH_HMAC_SECRET = process.env.TECH_HMAC_SECRET ?? 'swiftpos-tech-dev-secret-change-at-install';

function generateTechToken(payload: {
  techId: string; techName: string;
  branchId: string; businessId: string;
}): string {
  const exp     = Math.floor(Date.now() / 1000) + 48 * 3600; // 48h
  const body    = Buffer.from(JSON.stringify({ ...payload, scope: 'tech_access', exp })).toString('base64url');
  const sig     = crypto.createHmac('sha256', TECH_HMAC_SECRET).update(body).digest('hex');
  return `${body}.${sig}`;
}

/**
 * POST /api/admin/tech/generate-token
 * Generate a 48h offline tech access token for a specific branch.
 * Auto-approves but creates a notification requiring confirmation.
 */
router.post('/tech/generate-token', requireAdmin, async (req, res) => {
  const { branch_id, business_id } = req.body;
  if (!branch_id || !business_id) {
    res.status(400).json({ error: 'branch_id and business_id are required' });
    return;
  }

  // Verify branch belongs to business
  const { data: branch } = await supabase
    .from('branches').select('id, name, business_id').eq('id', branch_id).eq('business_id', business_id).single();
  if (!branch) { res.status(404).json({ error: 'Branch not found' }); return; }

  // Check if this tech has unconfirmed previous access — if so, require manual
  const { data: flag } = await supabase
    .from('tech_approval_flags').select('requires_manual').eq('admin_id', req.adminId).maybeSingle();
  if (flag?.requires_manual) {
    res.status(403).json({
      error: 'Your last access request was never confirmed by an admin. Manual approval required before generating new tokens.',
      code:  'MANUAL_APPROVAL_REQUIRED',
    });
    return;
  }

  const { data: admin } = await supabase.from('admin_users').select('name').eq('id', req.adminId).single();
  const { data: biz }   = await supabase.from('businesses').select('name').eq('id', business_id).single();

  const rawToken  = generateTechToken({ techId: req.adminId, techName: admin?.name ?? req.adminEmail, branchId: branch_id, businessId: business_id });
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

  // Store token record
  const { data: tokenRecord, error } = await supabase
    .from('tech_access_tokens')
    .insert({
      admin_id:    req.adminId,
      admin_name:  admin?.name ?? req.adminEmail,
      business_id,
      branch_id,
      branch_name: branch.name,
      token_hash:  tokenHash,
      expires_at:  expiresAt,
      status:      'active',
    })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  // Create confirmation notification (admin must confirm within 48h)
  await supabase.from('admin_audit_log').insert({
    admin_id:      req.adminId,
    admin_email:   req.adminEmail,
    action:        'tech.access.auto_approved',
    resource:      'tech_token',
    business_id,
    business_name: biz?.name,
    after_data: {
      tech:        admin?.name,
      branch:      branch.name,
      token_id:    tokenRecord.id,
      expires_at:  expiresAt,
      note:        'Auto-approved. Confirm this access was authorized within 48h.',
    },
  });

  await writeAdminAudit({
    adminId: req.adminId, adminEmail: req.adminEmail,
    action: 'tech.token.generate', resource: 'tech_token',
    businessId: business_id, businessName: biz?.name,
    after: { branch: branch.name, expires_at: expiresAt },
  });

  res.json({
    token:      rawToken,    // shown once — tech copies this to their phone
    token_id:   tokenRecord.id,
    expires_at: expiresAt,
    branch:     branch.name,
    business:   biz?.name,
  });
});

/**
 * GET /api/admin/tech/tokens
 * List recent tech access tokens — for the admin confirmation queue.
 */
router.get('/tech/tokens', requireAdmin, async (req, res) => {
  const { status, limit = '50' } = req.query as Record<string, string>;

  let query = supabase
    .from('tech_access_tokens')
    .select('id, admin_name, branch_name, status, expires_at, used_at, confirmed_at, revoked_at, created_at, businesses(name)')
    .order('created_at', { ascending: false })
    .limit(parseInt(limit));

  if (status) query = query.eq('status', status);

  // Non-super-admin sees only their own tokens
  if (req.adminRole !== 'super_admin') query = query.eq('admin_id', req.adminId);

  const { data, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

/**
 * POST /api/admin/tech/tokens/:id/confirm
 * Confirm that tech access was authorized. Clears any manual-approval flag.
 */
router.post('/tech/tokens/:id/confirm', requireAdmin, async (req, res) => {
  const { data: token } = await supabase
    .from('tech_access_tokens').select('*').eq('id', req.params.id).single();
  if (!token) { res.status(404).json({ error: 'Token not found' }); return; }

  await supabase.from('tech_access_tokens')
    .update({ confirmed_at: new Date().toISOString() })
    .eq('id', req.params.id);

  // Clear the manual-approval flag for this tech
  await supabase.from('tech_approval_flags')
    .upsert({ admin_id: token.admin_id, requires_manual: false, last_unconfirmed_at: null, updated_at: new Date().toISOString() }, { onConflict: 'admin_id' });

  res.json({ success: true });
});

/**
 * POST /api/admin/tech/tokens/:id/revoke
 * Revoke an active token. The offline revocation cache refreshes every 5 min.
 */
router.post('/tech/tokens/:id/revoke', requireAdmin, async (req, res) => {
  const { reason } = req.body;
  const { data: token } = await supabase
    .from('tech_access_tokens').select('*').eq('id', req.params.id).single();
  if (!token) { res.status(404).json({ error: 'Token not found' }); return; }

  await supabase.from('tech_access_tokens').update({
    status:     'revoked',
    revoked_at: new Date().toISOString(),
    revoked_by: req.adminEmail,
  }).eq('id', req.params.id);

  // Set manual-approval flag on this tech
  await supabase.from('tech_approval_flags')
    .upsert({ admin_id: token.admin_id, requires_manual: true, last_unconfirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: 'admin_id' });

  await writeAdminAudit({
    adminId: req.adminId, adminEmail: req.adminEmail,
    action: 'tech.token.revoke', resource: 'tech_token',
    businessId: token.business_id, businessName: token.branch_name,
    reason,
  });

  res.json({ success: true });
});

// ─── MODE SWITCH MANAGEMENT ───────────────────────────────────────────────────

function generateSwitchToken(branchId: string, fromMode: string, toMode: string): string {
  // 12-character alphanumeric code — easy to type on site
  const rand = crypto.randomBytes(9).toString('base64url').slice(0, 12).toUpperCase();
  return rand;
}

/**
 * POST /api/admin/mode-switch/generate
 * Admin generates a one-time mode switch token for a branch.
 * Token is valid for 7 days — gives the tech time to schedule the site visit.
 */
router.post('/mode-switch/generate', requireAdmin, async (req, res) => {
  const { business_id, branch_id, to_mode, notes } = req.body;
  if (!business_id || !branch_id || !to_mode) {
    res.status(400).json({ error: 'business_id, branch_id, and to_mode are required' });
    return;
  }

  const { data: branch } = await supabase
    .from('branches').select('id, name, deploy_mode').eq('id', branch_id).eq('business_id', business_id).single();
  if (!branch) { res.status(404).json({ error: 'Branch not found' }); return; }

  if (branch.deploy_mode === to_mode) {
    res.status(409).json({ error: `Branch is already in ${to_mode} mode` }); return;
  }

  // Cancel any pending switch for this branch
  await supabase.from('mode_switch_requests')
    .update({ status: 'cancelled' })
    .eq('branch_id', branch_id)
    .eq('status', 'pending');

  const rawToken  = generateSwitchToken(branch_id, branch.deploy_mode, to_mode);
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const { data: biz } = await supabase.from('businesses').select('name').eq('id', business_id).single();

  const { data: switchReq, error } = await supabase
    .from('mode_switch_requests')
    .insert({
      business_id, branch_id,
      from_mode:   branch.deploy_mode,
      to_mode,
      token_hash:  tokenHash,
      generated_by: req.adminEmail,
      approved_by:  req.adminEmail,
      status:      'pending',
      expires_at:  expiresAt,
      notes,
    })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  await writeAdminAudit({
    adminId: req.adminId, adminEmail: req.adminEmail,
    action: 'mode_switch.generate', resource: 'branch',
    businessId: business_id, businessName: biz?.name,
    after: { branch: branch.name, from: branch.deploy_mode, to: to_mode },
    reason: notes,
  });

  res.json({
    switch_token: rawToken,   // shown once — share with tech securely
    request_id:   switchReq.id,
    from_mode:    branch.deploy_mode,
    to_mode,
    branch:       branch.name,
    expires_at:   expiresAt,
    instruction:  `Tech enters this code on site: ${rawToken}`,
  });
});

/**
 * GET /api/admin/mode-switch/requests
 * List mode switch requests with their status.
 */
router.get('/mode-switch/requests', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('mode_switch_requests')
    .select('*, businesses(name), branches(name)')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

/**
 * POST /api/admin/mode-switch/:id/cancel
 * Cancel a pending switch request.
 */
router.post('/mode-switch/:id/cancel', requireAdmin, async (req, res) => {
  await supabase.from('mode_switch_requests')
    .update({ status: 'cancelled' })
    .eq('id', req.params.id)
    .eq('status', 'pending');
  res.json({ success: true });
});
