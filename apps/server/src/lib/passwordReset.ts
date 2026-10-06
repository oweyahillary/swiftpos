/**
 * passwordReset.ts — A402: an owner resets their own password (migration 124), and changes it when signed in.
 *
 * Owner, 2026-10-05: "add, reset password feature". Before, only ZapTill staff could reset an owner's password (admin
 * portal › reset-owner-password), and a signed-in owner could not change their own.
 *
 *   Forgot  — the owner types their sign-in email; if it is an owner's, a 6-digit code goes to it (15 minutes, 5 tries,
 *             used once). The answer is the same whether or not the email is known — the page never says who is a
 *             customer.
 *   Reset   — email + code + new password (8+ characters): the password is set on the sign-in account, every session
 *             the owner had is signed out (refresh tokens revoked), and "must change password" is cleared.
 *   Change  — signed in: the current password, then the new one.
 *
 * Managers sign in to the web with email and PIN; their PIN is reset by the owner (Staff), as before.
 */
import crypto from 'crypto';
import { supabase } from './supabase';
import { sendEmailChecked } from './mailer';
import { hashCode, newEmailCode, maskEmail } from './loginOtp';
import { revokeBrowserSessions } from './tillSessions';   // A407

export const RESET = { CODE_TTL_MIN: 15, MAX_TRIES: 5, RESEND_SEC: 60, MIN_LENGTH: 8 } as const;

/** A new password the owner typed: 8 to 128 characters, not only spaces. null = fine; otherwise what is wrong. */
export function passwordProblem(pw: unknown): string | null {
  const s = typeof pw === 'string' ? pw : '';
  if (s.trim().length < RESET.MIN_LENGTH) return `Use at least ${RESET.MIN_LENGTH} characters.`;
  if (s.length > 128) return 'That password is too long (128 characters at most).';
  return null;
}

export const cleanEmail = (v: unknown): string => String(v ?? '').trim().toLowerCase();

/** The code's hash: kept apart from sign-in codes ("reset:" in what is hashed), so one can never pass for the other. */
export const resetHash = (code: string, subjectId: string): string => hashCode(code, `reset:${subjectId}`);

/**
 * The owner sign-in account (auth.users id) for an email, or null. An owner is someone whose auth id is a business's
 * owner_id; the email is matched on the sign-in account itself, so a staff row with the same email never qualifies.
 */
export async function ownerAccountForEmail(email: string): Promise<{ authId: string; email: string; name: string | null } | null> {
  if (!email || !email.includes('@')) return null;
  const candidates = new Set<string>();
  const { data: biz } = await supabase.from('businesses').select('owner_id').ilike('email', email).not('owner_id', 'is', null).limit(10);
  for (const b of (biz ?? []) as Array<{ owner_id: string | null }>) if (b.owner_id) candidates.add(b.owner_id);
  const { data: rows } = await supabase.from('users').select('business_id, name').ilike('email', email).limit(20);
  const bizIds = [...new Set(((rows ?? []) as Array<{ business_id: string | null }>).map((r) => r.business_id).filter((x): x is string => !!x))];
  if (bizIds.length) {
    const { data: owned } = await supabase.from('businesses').select('owner_id').in('id', bizIds).not('owner_id', 'is', null);
    for (const b of (owned ?? []) as Array<{ owner_id: string | null }>) if (b.owner_id) candidates.add(b.owner_id);
  }
  const name = ((rows ?? []) as Array<{ name?: string | null }>)[0]?.name ?? null;
  for (const id of candidates) {
    const { data } = await supabase.auth.admin.getUserById(id);
    const e = cleanEmail(data?.user?.email);
    if (e && e === email) return { authId: id, email: e, name };
  }
  return null;
}

function resetEmailHtml(code: string, name: string | null): string {
  return `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#0f172a">
  <p>${name ? `Hi ${String(name).replace(/[<>&]/g, '')},` : 'Hi,'}</p>
  <p>Someone asked to reset the password of your ZapTill account. Your reset code is:</p>
  <p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:12px 0">${code}</p>
  <p>It works for ${RESET.CODE_TTL_MIN} minutes. If you did not ask for this, ignore this email — your password stays as it is.</p>
</div>`;
}

/** Email a reset code — unless one went out in the last minute (a double click never sends two). */
export async function sendResetCode(acct: { authId: string; email: string; name: string | null }): Promise<'sent' | 'recent' | 'failed'> {
  const since = new Date(Date.now() - RESET.RESEND_SEC * 1000).toISOString();
  const { data: recent } = await supabase.from('password_reset_codes').select('id')
    .eq('subject_id', acct.authId).is('consumed_at', null).gte('created_at', since).limit(1);
  if ((recent ?? []).length) return 'recent';
  const code = newEmailCode();
  const { error } = await supabase.from('password_reset_codes').insert({
    subject_id: acct.authId, email: acct.email, code_hash: resetHash(code, acct.authId),
    expires_at: new Date(Date.now() + RESET.CODE_TTL_MIN * 60_000).toISOString(),
  });
  if (error) { console.error('[password-reset] could not store a code — is migration 124 applied?', error.message); return 'failed'; }
  const sent = await sendEmailChecked({ to: acct.email, subject: `ZapTill password reset code: ${code}`, html: resetEmailHtml(code, acct.name) });
  if (!sent.ok) { console.error(`[password-reset] email to ${maskEmail(acct.email)} not sent:`, sent.error); return 'failed'; }
  return 'sent';
}

/** Check a reset code: the newest unused one, not expired, under 5 tries. A right code is used up. */
export async function checkResetCode(authId: string, code: string): Promise<'ok' | 'wrong' | 'expired'> {
  const { data } = await supabase.from('password_reset_codes')
    .select('id, code_hash, expires_at, attempts')
    .eq('subject_id', authId).is('consumed_at', null)
    .order('created_at', { ascending: false }).limit(1);
  const row = ((data ?? []) as Array<{ id: string; code_hash: string; expires_at: string; attempts: number | null }>)[0];
  if (!row || Date.parse(row.expires_at) < Date.now() || (row.attempts ?? 0) >= RESET.MAX_TRIES) return 'expired';
  const want = Buffer.from(String(row.code_hash));
  const got = Buffer.from(resetHash(code, authId));
  if (want.length === got.length && crypto.timingSafeEqual(want, got)) {
    await supabase.from('password_reset_codes').update({ consumed_at: new Date().toISOString() }).eq('id', row.id);
    return 'ok';
  }
  await supabase.from('password_reset_codes').update({ attempts: (row.attempts ?? 0) + 1 }).eq('id', row.id);
  return 'wrong';
}

/**
 * Set the new password on the sign-in account; sign the owner out of every browser (their refresh tokens — the users
 * rows of the businesses they own, and the account id itself — revoked) unless `keepSession` names the one to keep;
 * never a till's session (A406); clear "must change password".
 */
export async function setOwnerPassword(authId: string, password: string, keepSession?: string | null): Promise<string | null> {
  const { error } = await supabase.auth.admin.updateUserById(authId, { password });
  if (error) return error.message || 'Could not set the password.';
  const { data: biz } = await supabase.from('businesses').select('id').eq('owner_id', authId);
  const bizIds = ((biz ?? []) as Array<{ id: string }>).map((b) => b.id);
  const { data: acct } = await supabase.auth.admin.getUserById(authId);
  const email = cleanEmail(acct?.user?.email);
  let userIds: string[] = [authId];
  if (bizIds.length && email) {
    const { data: rows } = await supabase.from('users').select('id').in('business_id', bizIds).ilike('email', email);
    userIds = [...userIds, ...((rows ?? []) as Array<{ id: string }>).map((r) => r.id)];
    await supabase.from('users').update({ must_change_password: false }).in('id', userIds.slice(1));
  }
  // A406/A407: the owner's browsers only — a till's own session names no person (A415), so it is never among them;
  // this browser stays.
  await revokeBrowserSessions(userIds, bizIds, keepSession);
  return null;
}
