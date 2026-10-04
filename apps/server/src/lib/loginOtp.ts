/**
 * loginOtp.ts — A391: a one-time code at sign-in, for admins (admin portal), owners (dashboard) and managers (web POS).
 *
 * Owner, 2026-10-04: "OTP enabling both admin portal and dashboard" — by email or an authenticator app, "Both, user
 * picks" — "Portal admin is mandatory, owner should be mandatory also managers".
 *
 *   email  (the default — nothing to set up): a 6-digit code is emailed at each sign-in; 10 minutes, 5 tries, used once.
 *   totp   an authenticator app (Google / Microsoft Authenticator), set up once from a QR code (RFC 6238: SHA-1, 30 s,
 *          6 digits, one step either side for a phone clock that is slightly off).
 *
 * The sign-in routes call `otpGate` AFTER the password / PIN is right. No code in the request → the code is sent (email)
 * and the answer is 403 OTP_REQUIRED; the screen asks for it and sends the SAME sign-in again with `otp_code`. A wrong
 * code is a 401 (counted as a failed sign-in by the watchdog). "Remember this browser for 30 days" → `otp_trust`, a
 * signed token the browser sends next time; changing or resetting the method (otp_version + 1) voids it.
 *
 * LOGIN_OTP=off on the cloud turns every code off — for an emergency only (email down and an admin locked out).
 * Tills never come here: a till signs in by enrolment and PIN, offline too.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import qrcode from 'qrcode-generator';
import { supabase } from './supabase';
import { sendEmailChecked } from './mailer';
import { encryptSecret, decryptSecret } from './crypto';

export type OtpKind = 'admin' | 'user';
export type OtpMethod = 'email' | 'totp';

export const OTP = {
  CODE_TTL_MIN: 10,
  MAX_TRIES: 5,
  RESEND_SEC: 45,
  TRUST_DAYS: 30,
  STEP_SEC: 30,
  ISSUER: 'ZapTill',
} as const;

/** LOGIN_OTP=off — the emergency switch. */
export function otpDisabled(): boolean {
  return String(process.env.LOGIN_OTP ?? '').trim().toLowerCase() === 'off';
}

// ── Base32 (RFC 4648) — what authenticator apps read ────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = String(s).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** The 6-digit code for one 30-second step (RFC 6238 / RFC 4226). */
export function totpAt(secretB32: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/** Right now, or one step either side. */
export function verifyTotp(secretB32: string, code: string, now = Date.now()): boolean {
  const c = cleanCode(code);
  if (!c) return false;
  const step = Math.floor(now / 1000 / OTP.STEP_SEC);
  for (const d of [0, -1, 1]) {
    const want = totpAt(secretB32, step + d);
    if (crypto.timingSafeEqual(Buffer.from(want), Buffer.from(c))) return true;
  }
  return false;
}

/** "123 456" / "123-456" → "123456"; anything that is not 6 digits → null. */
export function cleanCode(code: unknown): string | null {
  const c = String(code ?? '').replace(/[\s-]/g, '');
  return /^\d{6}$/.test(c) ? c : null;
}

export function newTotpSecret(): string { return base32Encode(crypto.randomBytes(20)); }

export function otpauthUri(account: string, secretB32: string): string {
  const label = encodeURIComponent(`${OTP.ISSUER}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${OTP.ISSUER}&algorithm=SHA1&digits=6&period=${OTP.STEP_SEC}`;
}

/** The QR code an authenticator app scans, as an <svg> (white background, works on the dark screens). */
export function qrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

/** a.person@shop.co.ke → a•••••n@shop.co.ke — enough to recognise, not to harvest. */
export function maskEmail(email: string): string {
  const [user, domain] = String(email ?? '').split('@');
  if (!domain) return '';
  const shown = user.length <= 2 ? user[0] ?? '' : `${user[0]}${'•'.repeat(Math.min(5, user.length - 2))}${user[user.length - 1]}`;
  return `${shown}@${domain}`;
}

function pepper(): string {
  return process.env.OTP_PEPPER || process.env.JWT_SECRET || process.env.ADMIN_JWT_SECRET || 'zaptill-otp';
}

export function hashCode(code: string, subjectId: string): string {
  return crypto.createHmac('sha256', pepper()).update(`${subjectId}:${code}`).digest('hex');
}

export function newEmailCode(): string { return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'); }

// ── Remember this browser (30 days) ─────────────────────────────────────────
export function signTrust(kind: OtpKind, id: string, version: number, expiresIn: string = `${OTP.TRUST_DAYS}d`): string {
  return jwt.sign({ t: 'otp_trust', k: kind, s: id, v: version }, pepper(), { algorithm: 'HS256', expiresIn } as jwt.SignOptions);
}

export function trustValid(token: unknown, kind: OtpKind, id: string, version: number): boolean {
  if (typeof token !== 'string' || !token) return false;
  try {
    const p: any = jwt.verify(token, pepper(), { algorithms: ['HS256'] });
    return p?.t === 'otp_trust' && p.k === kind && p.s === id && Number(p.v) === Number(version);
  } catch { return false; }
}

// ── Authenticator set-up: the secret travels in a signed, 15-minute token until the first code proves it ─────────────
export function signSetup(kind: OtpKind, id: string, secretB32: string): string {
  return jwt.sign({ t: 'otp_setup', k: kind, s: id, x: secretB32 }, pepper(), { algorithm: 'HS256', expiresIn: '15m' });
}

export function readSetup(token: unknown, kind: OtpKind, id: string): string | null {
  if (typeof token !== 'string' || !token) return null;
  try {
    const p: any = jwt.verify(token, pepper(), { algorithms: ['HS256'] });
    return p?.t === 'otp_setup' && p.k === kind && p.s === id && typeof p.x === 'string' ? p.x : null;
  } catch { return null; }
}

/** Who must enter a code on the web: owners and the manager tier (A391). Cashiers do not. */
export function roleNeedsOtp(roleName: string | null | undefined, isOwner = false): boolean {
  if (isOwner) return true;
  const nm = String(roleName ?? '').toLowerCase().replace(/ /g, '_');
  return ['owner', 'admin', 'manager', 'supervisor', 'branch_manager'].includes(nm);
}

export interface OtpSubject {
  kind: OtpKind;
  id: string;
  email: string;
  name?: string | null;
  method?: string | null;
  secret?: string | null;      // encrypted (otp_totp_secret)
  version?: number | null;
}

/**
 * ok: trust = "remember this browser" (30 days, only when asked); pass = 10 minutes, always — the same sign-in's next
 * step (a manager choosing a branch signs in again with it) must not ask for a second code.
 */
export type GateResult =
  | { ok: true; trust?: string; pass?: string }
  | { ok: false; status: number; body: Record<string, unknown> };

/** The method that will actually be used: an authenticator only when its secret is there. */
export function effectiveMethod(s: Pick<OtpSubject, 'method' | 'secret'>): OtpMethod {
  return s.method === 'totp' && s.secret ? 'totp' : 'email';
}

function codeEmailHtml(code: string, name?: string | null): string {
  return `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#0f172a">
  <p>${name ? `Hi ${String(name).replace(/[<>&]/g, '')},` : 'Hi,'}</p>
  <p>Your ZapTill sign-in code is:</p>
  <p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:12px 0">${code}</p>
  <p>It works for ${OTP.CODE_TTL_MIN} minutes. If you did not just try to sign in, change your password and tell ZapTill support.</p>
</div>`;
}

/** Email a fresh code — unless one went out in the last RESEND_SEC seconds (a double click never sends two). */
const MISSING = 'login_otp_codes is missing — apply migration 119';
function isMissingTable(e: { code?: string; message?: string }): boolean {
  return ['42P01', 'PGRST205', 'PGRST204'].includes(String(e?.code ?? '')) || /login_otp_codes/.test(String(e?.message ?? ''));
}

export async function sendEmailCode(s: OtpSubject): Promise<{ ok: true; resent: boolean } | { ok: false; error: string; missing?: boolean }> {
  const since = new Date(Date.now() - OTP.RESEND_SEC * 1000).toISOString();
  const { data: recent } = await supabase.from('login_otp_codes')
    .select('id').eq('subject_kind', s.kind).eq('subject_id', s.id)
    .is('consumed_at', null).gte('created_at', since).limit(1);
  if ((recent ?? []).length) return { ok: true, resent: false };

  const code = newEmailCode();
  const { error } = await supabase.from('login_otp_codes').insert({
    subject_kind: s.kind, subject_id: s.id, code_hash: hashCode(code, s.id),
    expires_at: new Date(Date.now() + OTP.CODE_TTL_MIN * 60_000).toISOString(),
  });
  if (error) {
    // Migration 119 not applied yet: sign-in is never blocked by a missing table (the cloud says so loudly instead).
    if (isMissingTable(error)) return { ok: false, error: MISSING, missing: true };
    return { ok: false, error: 'Could not prepare a sign-in code. Try again in a minute.' };
  }
  const sent = await sendEmailChecked({ to: s.email, subject: `ZapTill sign-in code: ${code}`, html: codeEmailHtml(code, s.name) });
  if (!sent.ok) {
    console.error(`[otp] code email to ${maskEmail(s.email)} not sent:`, sent.error);
    return { ok: false, error: 'Could not email your sign-in code. Try again in a minute, or call ZapTill support.' };
  }
  return { ok: true, resent: true };
}

/** Check an emailed code: the newest unused one, not expired, under 5 tries. */
export async function checkEmailCode(s: OtpSubject, code: string): Promise<'ok' | 'wrong' | 'expired'> {
  const { data } = await supabase.from('login_otp_codes')
    .select('id, code_hash, expires_at, attempts')
    .eq('subject_kind', s.kind).eq('subject_id', s.id).is('consumed_at', null)
    .order('created_at', { ascending: false }).limit(1);
  const row: any = (data ?? [])[0];
  if (!row || Date.parse(row.expires_at) < Date.now() || (row.attempts ?? 0) >= OTP.MAX_TRIES) return 'expired';
  const want = Buffer.from(String(row.code_hash));
  const got = Buffer.from(hashCode(code, s.id));
  if (want.length === got.length && crypto.timingSafeEqual(want, got)) {
    await supabase.from('login_otp_codes').update({ consumed_at: new Date().toISOString() }).eq('id', row.id);
    return 'ok';
  }
  await supabase.from('login_otp_codes').update({ attempts: (row.attempts ?? 0) + 1 }).eq('id', row.id);
  return 'wrong';
}

/**
 * The gate. Called once the password / PIN is right. body: otp_code?, otp_trust?, otp_remember?, otp_resend?.
 */
export async function otpGate(s: OtpSubject, body: any): Promise<GateResult> {
  if (otpDisabled()) return { ok: true };
  const version = Number(s.version ?? 1);
  if (trustValid(body?.otp_trust, s.kind, s.id, version)) return { ok: true };

  const method = effectiveMethod(s);
  const remember = () => ({
    pass: signTrust(s.kind, s.id, version, '10m'),
    ...(body?.otp_remember ? { trust: signTrust(s.kind, s.id, version) } : {}),
  });
  const code = cleanCode(body?.otp_code);

  if (!code || body?.otp_resend) {
    if (method === 'totp') {
      return { ok: false, status: 403, body: { code: 'OTP_REQUIRED', method, error: 'Enter the 6-digit code from your authenticator app.' } };
    }
    const sent = await sendEmailCode(s);
    if (sent.ok === false && sent.missing) {
      console.error(`[otp] ${sent.error} — ${s.kind} ${maskEmail(s.email)} signed in WITHOUT a code`);
      return { ok: true };
    }
    if (sent.ok === false) return { ok: false, status: 503, body: { code: 'OTP_EMAIL_FAILED', error: sent.error } };
    return { ok: false, status: 403, body: {
      code: 'OTP_REQUIRED', method, sent_to: maskEmail(s.email),
      error: `We emailed a 6-digit code to ${maskEmail(s.email)}. Enter it to sign in.`,
    } };
  }

  if (method === 'totp') {
    let secret = '';
    try { secret = decryptSecret(String(s.secret)); } catch { secret = ''; }
    if (secret && verifyTotp(secret, code)) return { ok: true, ...remember() };
    return { ok: false, status: 401, body: { code: 'OTP_INVALID', method, error: 'That code is not right. Check your authenticator app and try again.' } };
  }

  const r = await checkEmailCode(s, code);
  if (r === 'ok') return { ok: true, ...remember() };
  if (r === 'expired') {
    return { ok: false, status: 401, body: { code: 'OTP_EXPIRED', method, error: 'That code has expired or was tried too often. Send a new code.' } };
  }
  return { ok: false, status: 401, body: { code: 'OTP_INVALID', method, error: 'That code is not right. Check the email and try again.' } };
}

// ── Settings: what the screens show and change (admin portal › My account, dashboard › Sign-in security) ─────────────
// Each table named where it is used (the schema-drift gate checks every column against its .from()).
function readAccount(kind: OtpKind, id: string) {
  return kind === 'admin'
    ? supabase.from('admin_users').select('email, otp_method, otp_totp_secret, otp_version').eq('id', id).maybeSingle()
    : supabase.from('users').select('email, otp_method, otp_totp_secret, otp_version').eq('id', id).maybeSingle();
}

function writeAccount(kind: OtpKind, id: string, patch: { otp_method: OtpMethod; otp_totp_secret: string | null; otp_version: number }) {
  return kind === 'admin'
    ? supabase.from('admin_users').update({ otp_method: patch.otp_method, otp_totp_secret: patch.otp_totp_secret, otp_version: patch.otp_version }).eq('id', id)
    : supabase.from('users').update({ otp_method: patch.otp_method, otp_totp_secret: patch.otp_totp_secret, otp_version: patch.otp_version }).eq('id', id);
}

export async function readOtpSettings(kind: OtpKind, id: string): Promise<{ method: OtpMethod; email: string } | null> {
  const { data } = await readAccount(kind, id);
  if (!data) return null;
  return { method: effectiveMethod({ method: (data as any).otp_method, secret: (data as any).otp_totp_secret }), email: (data as any).email };
}

/** Start authenticator set-up: a new secret, its QR code, and the set-up token the confirm call brings back. */
export function startTotpSetup(kind: OtpKind, id: string, account: string) {
  const secret = newTotpSecret();
  const uri = otpauthUri(account, secret);
  return { secret, uri, qr_svg: qrSvg(uri), setup_token: signSetup(kind, id, secret) };
}

async function bumpVersion(kind: OtpKind, id: string, patch: { otp_method: OtpMethod; otp_totp_secret: string | null }): Promise<string | null> {
  const { data } = await readAccount(kind, id);
  const v = Number((data as any)?.otp_version ?? 1) + 1;
  const { error } = await writeAccount(kind, id, { ...patch, otp_version: v });
  return error ? error.message : null;
}

/** Finish set-up: the first code from the app proves it was scanned. Every remembered browser must sign in again. */
export async function confirmTotpSetup(kind: OtpKind, id: string, setupToken: unknown, code: unknown):
  Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const secret = readSetup(setupToken, kind, id);
  if (!secret) return { ok: false, status: 400, error: 'The set-up expired. Start again.' };
  const c = cleanCode(code);
  if (!c || !verifyTotp(secret, c)) return { ok: false, status: 400, error: 'That code is not right. Check the app shows ZapTill and try the newest code.' };
  let enc: string;
  try { enc = encryptSecret(secret); } catch { return { ok: false, status: 500, error: 'APP_ENCRYPTION_KEY is not set on the cloud — the authenticator cannot be saved.' }; }
  const err = await bumpVersion(kind, id, { otp_method: 'totp', otp_totp_secret: enc });
  return err ? { ok: false, status: 500, error: 'Could not save — is migration 119 applied?' } : { ok: true };
}

/** Back to emailed codes — the person's own choice, or a reset by someone above them (lost phone). */
export async function useEmailCodes(kind: OtpKind, id: string): Promise<string | null> {
  return bumpVersion(kind, id, { otp_method: 'email', otp_totp_secret: null });
}
