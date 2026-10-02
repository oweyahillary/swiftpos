/**
 * routes/tenant.ts — A378: what a client's sign-in address shows before anyone signs in.
 *
 * GET /api/tenant/:subdomain — public (no auth): the business's name, logo and accent colour, so
 * africanfries.<root>/login can show African Fries' logo. Nothing else — no id, no contact details, no status.
 * 404 for a subdomain no business has (the page then says so instead of showing a sign-in form).
 */
import { safeRouter } from '../middleware/asyncHandler';
import { supabase } from '../lib/supabase';
import { findTenant } from '../lib/tenant';

const router = safeRouter();

router.get('/:subdomain', async (req, res) => {
  const found = await findTenant(req.params.subdomain);
  if (found.kind === 'error') { res.status(503).json({ error: 'Could not look up this address — please try again' }); return; }
  if (found.kind !== 'found') { res.status(404).json({ error: 'No SwiftPOS business uses this address', code: 'UNKNOWN_SUBDOMAIN' }); return; }

  const [{ data: brand }, { data: biz }] = await Promise.all([
    supabase.from('business_branding').select('accent_hex, logo_png').eq('business_id', found.tenant.id).maybeSingle(),
    supabase.from('businesses').select('logo_url').eq('id', found.tenant.id).maybeSingle(),
  ]);
  // A few minutes in the browser: the page loads it on every visit; a logo change shows within five minutes.
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    name:   found.tenant.name,
    logo:   (brand as any)?.logo_png || (biz as any)?.logo_url || null,
    accent: (brand as any)?.accent_hex || null,
  });
});

export default router;
