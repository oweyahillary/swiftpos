/**
 * c2bSettings.ts — A621: M-Pesa payment notifications per branch, /api/mpesa/c2b-settings/*. Settings › Business ›
 * Integrations › M-Pesa on the dashboard, below the STK details (A618).
 *
 *   GET  /                              { serverEnvironment, table, licensed, branches: [BranchC2b] }
 *   PUT  /branches/:branchId            { enabled, store_number? }   the switch, and the Buy Goods store number
 *   POST /branches/:branchId/register   Safaricom told to send this branch's payments to its addresses (a new secret token
 *                                       each time; saved only once Safaricom accepted, so a refusal never breaks the
 *                                       registration that worked before)
 *   POST /branches/:branchId/test-payment { amount? }   SANDBOX ONLY: a test payment from Safaricom's test number
 *   POST /payments/:transId/release     a payment held by a POS whose sale never reached the cloud goes back to every
 *                                       POS's list (Reports › M-Pesa unmatched — owner, 2026-11-03)
 *
 * The OWNER only, signed in as themselves (as the STK details — routes/mpesaSettings.ts mayManageMpesa): where customers'
 * money is reported is the owner's decision. Part of the online licence: switching on, registering and the test payment
 * need it; switching OFF never does (an owner can always stop it).
 * Registering uses the branch's own Daraja details (the business's when it has none) — the same as its STK prompt — and
 * ONE set of addresses per shortcode: two branches cannot both register one number (409 SHORTCODE_IN_USE), and a bank or
 * accounting system already registered on the number stops hearing of payments (the screen warns before).
 */
import type { Request, Response, NextFunction } from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';
import { getMpesaConfig, type MpesaConfig, type MpesaEnvironment } from '../lib/branchMpesa';
import { c2bUrls, cleanStoreNumber, hashC2bToken, newC2bToken, registerShortcode, transIdParam } from '../lib/c2b';
import { readAllC2bSettings, readC2bSettings, releaseHeldPayment, writeC2bSettings, type C2bSettingsRow } from '../lib/c2bStore';
import { registerC2bUrls, simulateC2bPayment } from '../lib/c2bDaraja';
import { c2bLicensed, NOT_LICENSED } from '../lib/c2bAccess';
import { noteC2bChange } from '../lib/c2bActivity';
import { mayManageMpesa } from './mpesaSettings';

const router = safeRouter();

const MIGRATION_MISSING = { error: 'M-Pesa payment notifications need the latest database update (migration 188).', code: 'MIGRATION_188' } as const;

const serverEnvironment = (): MpesaEnvironment => (process.env.MPESA_ENVIRONMENT === 'production' ? 'production' : 'sandbox');
const callbackBase = (): string => process.env.MPESA_CALLBACK_BASE_URL ?? 'https://api.zaptill.co.ke';

function ownerOnly(req: Request, res: Response, next: NextFunction): void {
  if (!mayManageMpesa(req)) {
    res.status(403).json({ error: 'Only the owner can see or change M-Pesa payment notifications.', code: 'OWNER_ONLY' });
    return;
  }
  next();
}

async function branchName(businessId: string, branchId: string): Promise<string | null> {
  const { data } = await supabase.from('branches').select('name').eq('id', branchId).eq('business_id', businessId).maybeSingle();
  return (data as { name?: string } | null)?.name ?? null;
}

/** The environment Safaricom is asked in: the details' own (A618), else the server's. */
const environmentOf = (cfg: MpesaConfig): MpesaEnvironment => cfg.environment ?? serverEnvironment();

/** What the screen shows of a branch. Never the token or its hash. */
function branchView(b: { id: string; name: string }, row: C2bSettingsRow | null, cfg: MpesaConfig | null) {
  return {
    id: b.id,
    name: b.name,
    enabled: row?.enabled === true,
    storeNumber: row?.store_number ?? null,
    mpesaType: cfg?.type ?? null,
    stkShortcode: cfg?.shortcode ?? null,
    environment: cfg ? environmentOf(cfg) : null,
    registeredAt: row?.token_hash ? row.registered_at : null,
    registeredShortcode: row?.token_hash ? row.registered_shortcode : null,
    registeredEnvironment: row?.token_hash ? row.registered_environment : null,
    lastError: row?.last_error ?? null,
  };
}

// ── GET ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

router.get('/', requireAuth, ownerOnly, async (req, res) => {
  try {
    const [{ rows, table }, { data: branches, error }, licensed] = await Promise.all([
      readAllC2bSettings(req.businessId),
      supabase.from('branches').select('id, name').eq('business_id', req.businessId).order('name'),
      c2bLicensed(req.businessId),
    ]);
    if (error) throw new Error(error.message);
    const byBranch = new Map(rows.map((r) => [r.branch_id, r]));
    const list = (branches ?? []) as Array<{ id: string; name: string }>;
    const configs = await Promise.all(list.map((b) => getMpesaConfig(req.businessId, b.id)));
    res.json({
      serverEnvironment: serverEnvironment(),
      table,
      licensed,
      branches: list.map((b, i) => branchView(b, byBranch.get(b.id) ?? null, configs[i])),
    });
  } catch (e: any) {
    res.status(503).json({ error: `Could not read the payment notifications right now (${e?.message ?? e}).` });
  }
});

// ── The switch and the store number ──────────────────────────────────────────────────────────────────────────────────

router.put('/branches/:branchId', requireAuth, ownerOnly, async (req, res) => {
  const branchId = String(req.params.branchId);
  if (!(await branchName(req.businessId, branchId))) { res.status(404).json({ error: 'Branch not found' }); return; }
  const enabled = req.body?.enabled === true;
  const store = cleanStoreNumber(req.body?.store_number);
  if ('error' in store) { res.status(400).json({ error: store.error, code: 'BAD_STORE_NUMBER' }); return; }
  if (enabled && !(await c2bLicensed(req.businessId))) { res.status(403).json(NOT_LICENSED); return; }
  const err = await writeC2bSettings(req.businessId, branchId, { enabled, store_number: store.value }, req.userId ?? null);
  if (err?.missingTable) { res.status(503).json(MIGRATION_MISSING); return; }
  if (err) { res.status(500).json({ error: `Could not save (${err.message}).` }); return; }
  noteC2bChange(branchId);
  console.log(`[c2b] A621: ${req.businessId} branch ${branchId} payment notifications ${enabled ? 'on' : 'off'} by ${req.userId ?? '?'}`);
  res.json({ ok: true });
});

// ── Register with Safaricom ──────────────────────────────────────────────────────────────────────────────────────────

/** The branch's switch and Daraja details, or the reason registering / testing cannot go ahead (answered). */
async function readyBranch(req: Request, res: Response): Promise<{ branchId: string; row: C2bSettingsRow; cfg: MpesaConfig } | null> {
  const branchId = String(req.params.branchId);
  if (!(await branchName(req.businessId, branchId))) { res.status(404).json({ error: 'Branch not found' }); return null; }
  if (!(await c2bLicensed(req.businessId))) { res.status(403).json(NOT_LICENSED); return null; }
  const row = await readC2bSettings(req.businessId, branchId);
  if (!row?.enabled) { res.status(409).json({ error: 'Switch payment notifications on for this branch first.', code: 'C2B_OFF' }); return null; }
  const cfg = await getMpesaConfig(req.businessId, branchId);
  if (!cfg) { res.status(422).json({ error: 'Save the M-Pesa (STK push) details for this branch first — Safaricom is asked with them.', code: 'NOT_CONFIGURED' }); return null; }
  return { branchId, row, cfg };
}

/** Another branch of the business already registered this number (one set of addresses per number at Safaricom). */
async function otherBranchOnNumber(businessId: string, branchId: string, shortcode: string, env: MpesaEnvironment): Promise<string | null> {
  const { rows } = await readAllC2bSettings(businessId);
  const other = rows.find((r) => r.branch_id !== branchId && r.token_hash && r.registered_shortcode === shortcode && r.registered_environment === env);
  return other ? (await branchName(businessId, other.branch_id)) ?? 'another branch' : null;
}

router.post('/branches/:branchId/register', requireAuth, ownerOnly, async (req, res) => {
  const ready = await readyBranch(req, res);
  if (!ready) return;
  const { branchId, row, cfg } = ready;
  const env = environmentOf(cfg);
  const shortcode = registerShortcode(cfg, row.store_number);
  const other = await otherBranchOnNumber(req.businessId, branchId, shortcode, env);
  if (other) {
    res.status(409).json({ error: `${other} already receives the payments to ${shortcode}. Safaricom reports a number's payments to one place only.`, code: 'SHORTCODE_IN_USE' });
    return;
  }
  const token = newC2bToken();
  const urls = c2bUrls(callbackBase(), token);
  if ('error' in urls) { res.status(422).json({ error: urls.error, code: 'BAD_CALLBACK_URL' }); return; }

  const r = await registerC2bUrls(cfg, env, { shortcode, confirm: urls.confirm, validate: urls.validate });
  if ('error' in r) {
    await writeC2bSettings(req.businessId, branchId, { last_error: r.error.slice(0, 300) }, req.userId ?? null);
    res.status(502).json({ error: `Safaricom refused: ${r.error}`, code: 'REGISTER_REFUSED' });
    return;
  }
  const err = await writeC2bSettings(req.businessId, branchId, {
    token_hash: hashC2bToken(token), registered_at: new Date().toISOString(), registered_shortcode: shortcode,
    registered_environment: env, last_error: null,
  }, req.userId ?? null);
  if (err) {
    console.error(`[c2b] A621: Safaricom registered ${shortcode} for branch ${branchId} but the token was NOT saved — register again:`, err.message);
    res.status(500).json({ error: 'Safaricom accepted, but the server could not save it. Register again.' });
    return;
  }
  noteC2bChange(branchId);
  console.log(`[c2b] A621: ${req.businessId} branch ${branchId} registered ${shortcode} (${env}) by ${req.userId ?? '?'}`);
  res.json({ ok: true, shortcode, environment: env });
});

// ── A test payment (sandbox) ─────────────────────────────────────────────────────────────────────────────────────────

router.post('/branches/:branchId/test-payment', requireAuth, ownerOnly, async (req, res) => {
  const ready = await readyBranch(req, res);
  if (!ready) return;
  const { row, cfg } = ready;
  if (environmentOf(cfg) !== 'sandbox' || row.registered_environment !== 'sandbox' || !row.registered_shortcode) {
    res.status(409).json({ error: 'A test payment works only with Sandbox details, after registering.', code: 'NOT_SANDBOX' });
    return;
  }
  const asked = Math.round(Number(req.body?.amount));
  const amount = Number.isFinite(asked) && asked >= 1 && asked <= 70_000 ? asked : 1;
  const billRef = typeof req.body?.bill_ref === 'string' ? req.body.bill_ref.slice(0, 20) : null;
  const r = await simulateC2bPayment(cfg, { shortcode: row.registered_shortcode, amount, billRef });
  if ('error' in r) { res.status(502).json({ error: `Safaricom refused the test payment: ${r.error}`, code: 'SIMULATE_REFUSED' }); return; }
  res.json({ ok: true, amount });
});

// ── A held payment given back (Reports › M-Pesa unmatched) ───────────────────────────────────────────────────────────

router.post('/payments/:transId/release', requireAuth, ownerOnly, async (req, res) => {
  const transId = transIdParam(req.params.transId);
  if (!transId) { res.status(400).json({ error: 'That is not an M-Pesa code.', code: 'BAD_CODE' }); return; }
  const branchId = await releaseHeldPayment(req.businessId, transId);
  if (!branchId) { res.status(409).json({ error: 'That payment is not held by a POS any more.', code: 'NOT_HELD' }); return; }
  noteC2bChange(branchId);
  res.json({ ok: true });
});

export default router;
