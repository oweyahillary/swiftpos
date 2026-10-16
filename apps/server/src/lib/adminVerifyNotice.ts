/**
 * adminVerifyNotice — A507: a change an agent made that a super admin should check.
 *
 * Owner, 2026-10-16, on A495's super-admin-only tax and money settings: "an agent should be able to change but the admin
 * should be notified of the change for verification". An agent (support) may now set a client's VAT rate, currency,
 * business type and KRA PIN (creating or editing a client) and call off a mode switch; every super admin is e-mailed what
 * changed, by whom, before and after, so it is verified the same day. The change itself is in the admin audit log too
 * (writeAdminAudit). A super admin's own change sends nothing. Never blocks or fails the change.
 */
import { supabase } from './supabase';
import { sendEmailChecked } from './mailer';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

export interface VerifyChange { field: string; before?: unknown; after: unknown }

/** Fire-and-forget: e-mail every active super admin. `who`: the agent's e-mail; `what`: one line ("Edited client X"). */
export function notifySuperAdminsToVerify(opts: { who: string; role: string; what: string; client?: string | null; changes: VerifyChange[] }): void {
  if (opts.role === 'super_admin') return;
  void (async () => {
    try {
      const { data, error } = await supabase.from('admin_users').select('email').eq('role', 'super_admin').eq('is_active', true);
      if (error) { console.error(`[admin] A507: could not read the super admins to notify: ${error.message}`); return; }
      const to = (data ?? []).map((r: { email?: string | null }) => r.email).filter((e): e is string => !!e);
      if (!to.length) return;
      const rows = opts.changes.map((c) => `<tr><td style="padding:4px 10px 4px 0"><b>${esc(c.field)}</b></td>`
        + `<td style="padding:4px 10px 4px 0">${'before' in c ? esc(show(c.before)) : ''}</td><td style="padding:4px 0">${esc(show(c.after))}</td></tr>`).join('');
      const sent = await sendEmailChecked({
        to: to.join(','),
        subject: `ZapTill admin: please verify — ${opts.what}`,
        html: `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#0f172a">
  <p><b>${esc(opts.who)}</b> (agent) — ${esc(opts.what)}${opts.client ? ` for <b>${esc(opts.client)}</b>` : ''}.</p>
  <table style="border-collapse:collapse;font-size:14px"><tr><th align="left">Field</th><th align="left">Before</th><th align="left">Now</th></tr>${rows}</table>
  <p>Please check it in the admin portal. If it is wrong, correct it there — it is in the audit log.</p></div>`,
      });
      if (!sent.ok) console.error(`[admin] A507: could not e-mail the super admins: ${sent.error}`);
    } catch (e: any) {
      console.error(`[admin] A507: super admin notice failed: ${e?.message ?? e}`);
    }
  })();
}
