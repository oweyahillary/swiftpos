/**
 * mpesaSettings.ts — A618: the M-Pesa STK push (Daraja) details, per branch with the business's as default,
 * /api/mpesa/settings/*. Settings › Business › Integrations › M-Pesa (STK push) on the dashboard.
 *
 * Owner, 2026-11-01: "it should be per branch since different branches might have different payment method some paybill
 * some buy goods". Until now the details could be put in only by SQL; STK push itself was tested on dev the same day.
 *
 *   GET    /                     → { serverEnvironment, branchTable, default: Status, branches: [{ id, name, own: Status|null,
 *                                    uses: 'own'|'default'|'none', paysTo, receipt, receiptWarning }] }
 *                                    Status = { configured, type, shortcode, tillNumber, environment, keyLast4, secretSaved,
 *                                    passkeySaved, updatedAt, updatedBy } — NEVER the secret, the passkey or the whole key.
 *   PUT    /default              { type, shortcode, till_number?, consumer_key?, consumer_secret?, passkey?, environment }
 *   PUT    /branches/:branchId   the same, the branch's own (needs migration 186)
 *   DELETE /branches/:branchId   the branch's own removed — it uses the business's again
 *   POST   /test                 { branch_id? } → { ok, source, environment, error? } — a Daraja access token asked for with
 *                                  the saved details (the branch's as a payment there would use them; none = the default's).
 *                                  Nobody is charged, nothing reaches a phone; Safaricom's answer within 15 s.
 *
 * Blank key, secret or passkey on a save keeps the stored one. The secret and the passkey are encrypted (lib/crypto.ts).
 * Who: the OWNER only, signed in as themselves (never a POS's own session, a partner or a manager) — as every mpesa_*
 * business setting is the owner's (business.ts ownerOnlySetting). Where customers' money goes is the owner's decision.
 * The receipt's M-Pesa line is the branch manager's (A492, Manager › Settings › M-Pesa on the POS); when it names another
 * number than the one STK payments go to, the screen says so (receiptMismatch).
 */
import type { Request, Response, NextFunction } from 'express';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';
import { encryptSecret } from '../lib/crypto';
import { sendError } from '../lib/sendError';
import { mpesaFromSettings, type MpesaReceive } from '../lib/mpesaReceive';
import {
  BUSINESS_MPESA_KEYS, branchConfigFrom, businessConfigFrom, cleanMpesaSettings, isMissingTable, keyLast4, payTarget,
  readBranchMpesaRow, readBusinessMpesaRows, receiptMismatch, resolveMpesaConfig, settingsMap, testDarajaConnection,
  type BranchMpesaRow, type MpesaConfig, type MpesaEnvironment, type MpesaSettingsInput,
} from '../lib/branchMpesa';

const router = safeRouter();

const SERVER_ENV: MpesaEnvironment = process.env.MPESA_ENVIRONMENT === 'production' ? 'production' : 'sandbox';
const RECEIPT_KEYS = ['receipt_pay_label', 'receipt_pay_number', 'receipt_pay_account'];
const MIGRATION_MISSING = { error: 'A branch\'s own M-Pesa details need the latest database update (migration 186). The business default still works.', code: 'MIGRATION_186' } as const;

/** The owner, as themselves. */
export function mayManageMpesa(req: Pick<Request, 'isOwner' | 'isTill' | 'webPartner'>): boolean {
  return req.isOwner === true && !req.isTill && req.webPartner !== true;
}
function ownerOnly(req: Request, res: Response, next: NextFunction): void {
  if (!mayManageMpesa(req)) {
    res.status(403).json({ error: 'Only the owner can see or change the M-Pesa details.', code: 'OWNER_ONLY' });
    return;
  }
  next();
}

export interface MpesaStatus {
  configured:   boolean;
  type:         string | null;
  shortcode:    string | null;
  tillNumber:   string | null;
  environment:  string | null;
  keyLast4:     string | null;
  secretSaved:  boolean;
  passkeySaved: boolean;
  updatedAt:    string | null;
  updatedBy:    string | null;
}

/** What the screen may see of a set of details: never a secret, never the whole key. */
function statusOf(p: { config: MpesaConfig | null; type?: unknown; shortcode?: unknown; tillNumber?: unknown; environment?: unknown;
  key?: unknown; secret?: unknown; passkey?: unknown; updatedAt?: unknown; updatedBy?: string | null }): MpesaStatus {
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    configured: p.config !== null, type: s(p.type), shortcode: s(p.shortcode), tillNumber: s(p.tillNumber),
    environment: s(p.environment), keyLast4: keyLast4(p.key), secretSaved: !!s(p.secret), passkeySaved: !!s(p.passkey),
    updatedAt: s(p.updatedAt), updatedBy: p.updatedBy ?? null,
  };
}

/** People's names by id (who saved the details). */
async function namesOf(businessId: string, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map();
  const { data } = await supabase.from('users').select('id, name').eq('business_id', businessId).in('id', want);
  return new Map(((data ?? []) as Array<{ id: string; name: string }>).map((u) => [u.id, u.name]));
}

/** The branch's own rows, all branches — { rows, table: false } while migration 186 has not run. */
async function readBranchRows(businessId: string): Promise<{ rows: BranchMpesaRow[]; table: boolean }> {
  const { data, error } = await supabase.from('branch_mpesa_settings').select('*').eq('business_id', businessId);
  if (error) {
    if (isMissingTable(error)) return { rows: [], table: false };
    throw new Error(error.message);
  }
  return { rows: (data ?? []) as BranchMpesaRow[], table: true };
}

/** Each branch's receipt M-Pesa line (A492): its own, else the business-wide one. */
async function readReceiptLines(businessId: string): Promise<{ byBranch: Map<string, MpesaReceive | null>; business: MpesaReceive | null }> {
  const [{ data: b, error: bErr }, { data: d, error: dErr }] = await Promise.all([
    supabase.from('branch_settings').select('branch_id, key, value').eq('business_id', businessId).in('key', RECEIPT_KEYS),
    supabase.from('business_settings').select('key, value').eq('business_id', businessId).in('key', RECEIPT_KEYS),
  ]);
  if (bErr || dErr) throw new Error((bErr ?? dErr)!.message);
  const per = new Map<string, Record<string, string>>();
  for (const r of (b ?? []) as Array<{ branch_id: string; key: string; value: unknown }>) {
    const m = per.get(r.branch_id) ?? {};
    m[r.key] = typeof r.value === 'string' ? r.value : r.value == null ? '' : String(r.value);
    per.set(r.branch_id, m);
  }
  const byBranch = new Map<string, MpesaReceive | null>();
  for (const [id, m] of per) byBranch.set(id, mpesaFromSettings(m.receipt_pay_label, m.receipt_pay_number, m.receipt_pay_account));
  const dm = settingsMap(d as Array<{ key: string; value: unknown }>);
  return { byBranch, business: mpesaFromSettings(dm.receipt_pay_label, dm.receipt_pay_number, dm.receipt_pay_account) };
}

async function branchOfBusiness(businessId: string, branchId: string): Promise<boolean> {
  const { data } = await supabase.from('branches').select('id').eq('id', branchId).eq('business_id', businessId).maybeSingle();
  return !!data;
}

/** "Buy Goods 163726" / "Paybill 174379" — where STK payments go with these details. */
function paysTo(cfg: MpesaConfig | null): string | null {
  if (!cfg) return null;
  const t = payTarget(cfg);
  return `${t.kind === 'paybill' ? 'Paybill' : 'Buy Goods'} ${t.number}`;
}

// ── GET /api/mpesa/settings ──────────────────────────────────────────────────────────────────────────────────────────

router.get('/', requireAuth, ownerOnly, async (req, res) => {
  try {
    const [bizRows, branchRows, receipts, { data: branches, error: brErr }] = await Promise.all([
      readBusinessMpesaRows(req.businessId),
      readBranchRows(req.businessId),
      readReceiptLines(req.businessId),
      supabase.from('branches').select('id, name, status').eq('business_id', req.businessId).order('name'),
    ]);
    if (brErr) throw new Error(brErr.message);
    const biz = settingsMap(bizRows);
    const bizUpdated = bizRows.map((r) => r.updated_at ?? '').filter(Boolean).sort().pop() ?? null;
    const names = await namesOf(req.businessId, [biz.mpesa_updated_by, ...branchRows.rows.map((r) => r.updated_by)]);
    const defaultConfig = businessConfigFrom(biz);
    const own = new Map(branchRows.rows.map((r) => [r.branch_id, r]));

    res.json({
      serverEnvironment: SERVER_ENV,
      branchTable: branchRows.table,
      default: statusOf({
        config: defaultConfig, type: biz.mpesa_type || (biz.mpesa_shortcode ? 'CustomerBuyGoodsOnline' : null), shortcode: biz.mpesa_shortcode,
        tillNumber: biz.mpesa_till_number, environment: biz.mpesa_environment, key: biz.mpesa_consumer_key,
        secret: biz.mpesa_consumer_secret, passkey: biz.mpesa_passkey, updatedAt: bizUpdated,
        updatedBy: biz.mpesa_updated_by ? names.get(biz.mpesa_updated_by) ?? null : null,
      }),
      branches: ((branches ?? []) as Array<{ id: string; name: string; status?: string }>).map((b) => {
        const row = own.get(b.id) ?? null;
        const ownConfig = branchConfigFrom(row);
        const effective = resolveMpesaConfig(ownConfig, defaultConfig);
        const receipt = receipts.byBranch.get(b.id) ?? receipts.business;
        return {
          id: b.id, name: b.name, status: b.status ?? null,
          own: row ? statusOf({
            config: ownConfig, type: row.type, shortcode: row.shortcode, tillNumber: row.till_number, environment: row.environment,
            key: row.consumer_key, secret: row.consumer_secret, passkey: row.passkey, updatedAt: row.updated_at,
            updatedBy: row.updated_by ? names.get(row.updated_by) ?? null : null,
          }) : null,
          uses: ownConfig ? 'own' : defaultConfig ? 'default' : 'none',
          paysTo: paysTo(effective),
          receipt: receipt ? `${receipt.kind === 'paybill' ? 'Paybill' : 'Buy Goods'} ${receipt.number}` : null,
          receiptWarning: receiptMismatch(receipt, effective),
        };
      }),
    });
  } catch (e: any) {
    res.status(503).json({ error: `Could not read the M-Pesa details right now (${e?.message ?? e}).` });
  }
});

// ── Saving ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Encrypts the secret and the passkey given; null = keep the stored one. Throws when the server cannot encrypt. */
function sealed(v: MpesaSettingsInput): { secret: string | null; passkey: string | null } {
  return { secret: v.consumerSecret ? encryptSecret(v.consumerSecret) : null, passkey: v.passkey ? encryptSecret(v.passkey) : null };
}
const CANNOT_ENCRYPT = { error: 'The server cannot keep secrets safely right now (its encryption key is not set). Nothing was saved.', code: 'NO_ENCRYPTION_KEY' } as const;

/** One business setting written (the row updated in place, or added). */
async function writeBusinessSetting(businessId: string, key: string, value: string): Promise<string | null> {
  const { data: existing, error: rErr } = await supabase.from('business_settings').select('id')
    .eq('business_id', businessId).eq('key', key).maybeSingle();
  if (rErr) return rErr.message;
  const { error } = existing
    ? await supabase.from('business_settings').update({ value, updated_at: new Date().toISOString() }).eq('id', (existing as { id: string }).id).eq('business_id', businessId)
    : await supabase.from('business_settings').insert({ business_id: businessId, key, value });
  return error ? error.message : null;
}

router.put('/default', requireAuth, ownerOnly, async (req, res) => {
  let biz: Record<string, string>;
  try { biz = settingsMap(await readBusinessMpesaRows(req.businessId)); }
  catch (e: any) { res.status(503).json({ error: `Could not read the M-Pesa details right now (${e?.message ?? e}).` }); return; }
  const clean = cleanMpesaSettings(req.body, { key: !!biz.mpesa_consumer_key, secret: !!biz.mpesa_consumer_secret, passkey: !!biz.mpesa_passkey });
  if ('error' in clean) { res.status(400).json({ error: clean.error, code: 'BAD_MPESA_SETTINGS' }); return; }
  const v = clean.value;
  let s: { secret: string | null; passkey: string | null };
  try { s = sealed(v); } catch { res.status(503).json(CANNOT_ENCRYPT); return; }

  const writes: Array<[string, string]> = [
    ['mpesa_type', v.type], ['mpesa_shortcode', v.shortcode], ['mpesa_till_number', v.tillNumber ?? ''],
    ['mpesa_environment', v.environment], ['mpesa_updated_by', req.userId ?? ''],
  ];
  if (v.consumerKey) writes.push(['mpesa_consumer_key', v.consumerKey]);
  if (s.secret) writes.push(['mpesa_consumer_secret', s.secret]);
  if (s.passkey) writes.push(['mpesa_passkey', s.passkey]);
  for (const [key, value] of writes) {
    const err = await writeBusinessSetting(req.businessId, key, value);
    if (err) { sendError(res, { message: err }, { message: 'Could not save the M-Pesa details' }); return; }
  }
  console.log(`[mpesa] A618: ${req.businessId} default details saved (${v.type}, ${v.shortcode}, ${v.environment}) by ${req.userId ?? '?'}`);
  res.json({ ok: true });
});

router.put('/branches/:branchId', requireAuth, ownerOnly, async (req, res) => {
  const branchId = String(req.params.branchId);
  if (!(await branchOfBusiness(req.businessId, branchId))) { res.status(404).json({ error: 'Branch not found' }); return; }
  const { data: existing, error: rErr } = await supabase.from('branch_mpesa_settings').select('*')
    .eq('business_id', req.businessId).eq('branch_id', branchId).maybeSingle();
  if (rErr) {
    if (isMissingTable(rErr)) { res.status(503).json(MIGRATION_MISSING); return; }
    sendError(res, rErr, { message: 'Could not read the branch\'s M-Pesa details' }); return;
  }
  const row = existing as BranchMpesaRow | null;
  const clean = cleanMpesaSettings(req.body, { key: !!row?.consumer_key, secret: !!row?.consumer_secret, passkey: !!row?.passkey });
  if ('error' in clean) { res.status(400).json({ error: clean.error, code: 'BAD_MPESA_SETTINGS' }); return; }
  const v = clean.value;
  let s: { secret: string | null; passkey: string | null };
  try { s = sealed(v); } catch { res.status(503).json(CANNOT_ENCRYPT); return; }

  const { error } = await supabase.from('branch_mpesa_settings').upsert({
    branch_id: branchId, business_id: req.businessId, type: v.type, shortcode: v.shortcode, till_number: v.tillNumber,
    consumer_key: v.consumerKey ?? row!.consumer_key, consumer_secret: s.secret ?? row!.consumer_secret, passkey: s.passkey ?? row!.passkey,
    environment: v.environment, updated_at: new Date().toISOString(), updated_by: req.userId ?? null,
  }, { onConflict: 'branch_id' });
  if (error) {
    if (isMissingTable(error)) { res.status(503).json(MIGRATION_MISSING); return; }
    sendError(res, error, { message: 'Could not save the branch\'s M-Pesa details' }); return;
  }
  console.log(`[mpesa] A618: ${req.businessId} branch ${branchId} own details saved (${v.type}, ${v.shortcode}, ${v.environment}) by ${req.userId ?? '?'}`);
  res.json({ ok: true });
});

router.delete('/branches/:branchId', requireAuth, ownerOnly, async (req, res) => {
  const branchId = String(req.params.branchId);
  if (!(await branchOfBusiness(req.businessId, branchId))) { res.status(404).json({ error: 'Branch not found' }); return; }
  const { error } = await supabase.from('branch_mpesa_settings').delete().eq('business_id', req.businessId).eq('branch_id', branchId);
  if (error && !isMissingTable(error)) { sendError(res, error, { message: 'Could not remove the branch\'s M-Pesa details' }); return; }
  console.log(`[mpesa] A618: ${req.businessId} branch ${branchId} own details removed by ${req.userId ?? '?'} — the default applies`);
  res.json({ ok: true });
});

// ── POST /api/mpesa/settings/test ────────────────────────────────────────────────────────────────────────────────────

router.post('/test', requireAuth, ownerOnly, async (req, res) => {
  const branchId = typeof req.body?.branch_id === 'string' && req.body.branch_id ? String(req.body.branch_id) : null;
  if (branchId && !(await branchOfBusiness(req.businessId, branchId))) { res.status(404).json({ error: 'Branch not found' }); return; }
  let config: MpesaConfig | null;
  try {
    const def = businessConfigFrom(settingsMap(await readBusinessMpesaRows(req.businessId)));
    config = resolveMpesaConfig(branchConfigFrom(await readBranchMpesaRow(req.businessId, branchId)), def);
  } catch (e: any) { res.status(503).json({ error: `Could not read the M-Pesa details right now (${e?.message ?? e}).` }); return; }
  if (!config) { res.status(422).json({ error: 'Nothing to test — save the M-Pesa details first.', code: 'NOT_CONFIGURED' }); return; }
  const environment = config.environment ?? SERVER_ENV;
  const r = await testDarajaConnection(config, environment);
  res.json({ ...r, source: config.source, environment });
});

export default router;
