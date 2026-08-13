/**
 * enrol.ts — device enrolment: the OWNER issues a code (register D4, closes D1).
 *
 * The owner, signed into the portal, mints a single-use code for one of their
 * businesses; a till redeems it at POST /api/auth/enrol/redeem (in auth.ts, where
 * the session helpers live and authLimiter protects the brute-force surface).
 * Issuing needs an owner session, so it lives here under /api/enrol, requireAuth.
 *
 * The raw code is returned ONCE and never stored — only its SHA-256. Short-lived
 * (15 min) and single-use, so a leaked code is worth little and briefly.
 */
import crypto from 'node:crypto';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';

const router = safeRouter();
router.use(requireAuth);

// A read-aloud alphabet: no 0/O, 1/I/L — an owner reads the code to whoever is
// at the till, and those are the characters that get misheard and mistyped.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 30 chars
const CODE_LEN = 10;                                // 30^10 ≈ 5.9e14 combinations

function makeCode(): string {
  const bytes = crypto.randomBytes(CODE_LEN);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

const EXPIRES_MS = 15 * 60 * 1000; // 15 minutes

// POST /api/enrol/code — owner mints a code for their business (optionally bound
// to a branch at enrol time).
router.post('/code', async (req: any, res) => {
  if (!req.isOwner) { res.status(403).json({ error: 'Owner only' }); return; }

  const branchId = typeof req.body?.branch_id === 'string' ? req.body.branch_id : null;
  if (branchId) {
    // Tenant guard — never bind to another business's branch.
    const { data: b } = await supabase
      .from('branches').select('id')
      .eq('id', branchId).eq('business_id', req.businessId).maybeSingle();
    if (!b) { res.status(400).json({ error: 'Unknown branch' }); return; }
  }

  const raw       = makeCode();
  const codeHash  = crypto.createHash('sha256').update(raw).digest('hex');
  const expiresAt = new Date(Date.now() + EXPIRES_MS).toISOString();

  const { error } = await supabase.from('device_enrolment_codes').insert({
    business_id: req.businessId,
    branch_id:   branchId,
    code_hash:   codeHash,
    created_by:  req.userId,          // public.users id — FK on the table
    expires_at:  expiresAt,
  });
  if (error) { sendError(res, error); return; }

  // business_id travels back so the till has both halves it needs to redeem.
  res.json({ code: raw, businessId: req.businessId, branchId, expiresAt });
});

export default router;
