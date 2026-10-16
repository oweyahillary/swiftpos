import { Router } from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import { supabase } from '../lib/supabase';
import { seedDefaultRolePermissions } from '../lib/defaultRolePermissions';
import { isOwnerRoleName } from '../lib/ownerRole';
import { adminInputProblems } from '../lib/adminRules';

const router = safeRouter();

/** A495: what is wrong with an onboarding request's fields, or null. */
export function onboardingProblem(b: any): string | null {
  const text = (v: unknown, max: number, required = false) =>
    v === undefined || v === null || v === '' ? !required : typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
  const checks: Array<[unknown, number, boolean, string]> = [
    [b?.businessName, 120, true, 'Business name'], [b?.businessType, 40, true, 'Business type'],
    [b?.branchName, 100, true, 'Branch name'], [b?.ownerEmail, 254, true, 'Owner email'],
    [b?.ownerName, 120, false, 'Owner name'], [b?.phone, 30, false, 'Phone'], [b?.email, 254, false, 'Email'],
    [b?.taxPin, 20, false, 'KRA PIN'], [b?.logoUrl, 500, false, 'Logo address'], [b?.branchAddress, 300, false, 'Branch address'],
    [b?.branchCity, 100, false, 'Branch city'], [b?.branchPhone, 30, false, 'Branch phone'],
  ];
  for (const [v, max, req, label] of checks) if (!text(v, max, req)) return `${label} is missing or too long (up to ${max} characters).`;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.ownerEmail).trim())) return 'Owner email is not a valid email.';
  if (b?.mustChangePassword !== undefined && typeof b.mustChangePassword !== 'boolean') return 'mustChangePassword must be true or false.';
  return adminInputProblems({ currency: b?.currency, ...(b?.vatRate === undefined || b?.vatRate === null || b?.vatRate === '' ? {} : { vat_rate: b.vatRate }) });
}

const VALID_TYPES = [
  'restaurant', 'cafe', 'retail',
  'minimart', 'parking', 'petrol_station', 'other',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/onboarding
//
// Called once by the SwiftPOS agent after signing up with Supabase auth.
// Creates the business, first branch, default roles, and the owner user row.
// Sets must_change_password = true so the owner is forced to change their
// password on first login.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);

  if (authError || !user) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  const {
    businessName,
    businessType,
    ownerName,
    phone,
    email,
    taxPin,
    vatRate,
    currency,
    logoUrl,
    branchName,
    branchAddress,
    branchCity,
    branchPhone,
    ownerEmail,
    mustChangePassword,
  } = req.body;

  // ── Validation ──────────────────────────────────────────────────────────────
  if (!businessName || !businessType || !branchName || !currency || !ownerEmail) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }
  // A495: every field checked — kinds and lengths, VAT 0–100, a three-letter currency.
  const problem = onboardingProblem(req.body);
  if (problem) { res.status(400).json({ error: problem }); return; }
  // A495: the owner row is the signed-up account's — never another person's email under this sign-up.
  if (String(ownerEmail).trim().toLowerCase() !== String(user.email ?? '').trim().toLowerCase()) {
    res.status(400).json({ error: 'The owner email must be the email you signed up with' });
    return;
  }
  // A495: one sign-up, one business — the same account calling again made a second tenant it owned.
  const { data: owned, error: ownedErr } = await supabase
    .from('businesses').select('id').eq('owner_id', user.id).limit(1);
  if (ownedErr) { res.status(503).json({ error: 'Could not check your account right now — try again' }); return; }
  if ((owned ?? []).length) {
    res.status(409).json({ error: 'This account already owns a business. Sign in instead.', code: 'ALREADY_ONBOARDED' });
    return;
  }

  const normalizedType = (businessType as string).toLowerCase().replace(/\s+/g, '_');
  if (!VALID_TYPES.includes(normalizedType as typeof VALID_TYPES[number])) {
    res.status(400).json({
      error: `Invalid business type. Must be one of: ${VALID_TYPES.join(', ')}`,
    });
    return;
  }

  // Tracks the business row so we can roll the whole onboarding back if any
  // later step fails. Every child table references businesses(id) ON DELETE
  // CASCADE, so deleting the business cleans up branch/roles/user/etc. — no
  // orphaned half-provisioned tenant left behind. (Audit finding M4.)
  let createdBusinessId: string | null = null;

  try {
    // ── 1. Create business ──────────────────────────────────────────────────
    const { data: business, error: bErr } = await supabase
      .from('businesses')
      .insert({
        name:       businessName.trim(),
        type:       normalizedType,
        owner_name: ownerName?.trim(),
        phone:      phone?.trim() || null,
        email:      email?.trim() || ownerEmail,
        tax_pin:    taxPin?.trim() || null,
        vat_rate:   vatRate === undefined || vatRate === null || vatRate === '' ? 16 : Number(vatRate),
        currency:   String(currency).trim().toUpperCase(),
        logo_url:   logoUrl || null,
        owner_id:   user.id,
      })
      .select()
      .single();

    if (bErr) throw bErr;
    createdBusinessId = business.id;

    // ── 2. Create first branch ──────────────────────────────────────────────
    const { data: branch, error: brErr } = await supabase
      .from('branches')
      .insert({
        business_id: business.id,
        name:        branchName.trim(),
        address:     branchAddress?.trim() || null,
        city:        branchCity?.trim() || null,
        phone:       branchPhone?.trim() || null,
        is_main:     true,
      })
      .select()
      .single();

    if (brErr) throw brErr;

    // ── 3. Seed default roles ───────────────────────────────────────────────
    const { data: roles, error: rErr } = await supabase
      .from('roles')
      .insert(
        ['Admin', 'Manager', 'Cashier'].map(name => ({
          business_id: business.id,
          name,
          is_default:  true,
        }))
      )
      .select();

    if (rErr) throw rErr;

    // ── 3b. Grant default permissions to the seeded roles ───────────────────
    // Without this the roles exist with zero rights (empty roles screen, no
    // staff access). Owners are unaffected (wildcard via auth middleware).
    await seedDefaultRolePermissions(roles);

    // ── 4. Create owner user row ────────────────────────────────────────────
    // A495: the owner's role is found by lib/ownerRole.ts (owner / admin), the one rule every check reads.
    const adminRole = roles.find(r => isOwnerRoleName(r.name));

    const { data: ownerUser, error: uErr } = await supabase
      .from('users')
      .insert({
        business_id:          business.id,
        name:                 ownerName?.trim() || ownerEmail.split('@')[0],
        email:                ownerEmail,
        role_id:              adminRole?.id ?? null,
        // A495: a PIN hash is never taken from the caller (the page stopped sending one; any value here would be a
        // hash the server never made). The owner sets a PIN after signing in.
        pin_hash:             null,
        status:               'active',
        must_change_password: mustChangePassword !== false,
      })
      .select()
      .single();

    if (uErr) throw uErr;

    // ── 5. Link owner to main branch ────────────────────────────────────────
    const { error: ubErr } = await supabase
      .from('user_branches')
      .insert({ user_id: ownerUser.id, branch_id: branch.id });

    if (ubErr) throw ubErr;

    // ── 6. Onboarding progress ──────────────────────────────────────────────
    const { error: opErr } = await supabase
      .from('onboarding_progress')
      .insert({
        business_id:           business.id,
        business_profile_done: true,
        staff_added_done:      true,
        owner_pin_set:         false,
      });

    if (opErr) throw opErr;

    // ── 7. Auto-create trial subscription ──────────────────────────────────
    const { data: trialPlan } = await supabase
      .from('plans')
      .select('id')
      .eq('name', 'Trial')
      .single();

    if (trialPlan) {
      await supabase.from('subscriptions').insert({
        business_id: business.id,
        plan_id:     trialPlan.id,
        status:      'trial',
        starts_at:   new Date().toISOString(),
        expires_at:  new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
    }

    res.status(201).json({ business, branch, ownerUserId: ownerUser.id });
  } catch (err: any) {
    console.error('[onboarding]', err);
    // Roll back a half-provisioned tenant so a retry starts clean.
    if (createdBusinessId) {
      const { error: cleanupErr } = await supabase
        .from('businesses')
        .delete()
        .eq('id', createdBusinessId);
      if (cleanupErr) {
        console.error('[onboarding] rollback failed for business', createdBusinessId, cleanupErr.message);
      }
    }
    res.status(500).json({ error: 'Onboarding failed' });
  }
});

export default router;
