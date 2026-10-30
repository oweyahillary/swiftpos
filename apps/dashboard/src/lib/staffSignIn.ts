/**
 * staffSignIn.ts — A608: how a person signs in, by who they are (owner, 2026-10-29: "For partners we don't need some
 * fields — can the form populate based on the user? For top management let it be email only, they access the dashboard.
 * Change the shop manager to use email on web — they don't key in a PIN on the web POS; PIN on the web strictly remains
 * for cashiers. On the desktop app the PIN remains for managers.")
 *
 *   'web'      Partner and General Manager — email and password, the web dashboard only. No PIN, no approval PIN, no
 *              hourly rate on their card.
 *   'web_pin'  Back office (a Manager, and anyone whose keys go beyond the shop floor — the same signal that used to send
 *              them to the web manager portal, lib/posRouting.ts resolveRoute): email and password on the web dashboard,
 *              and a PIN for the desktop POS. The web POS refuses their PIN (the cloud's /api/auth/pos-login says so).
 *   'pin'      Everyone else (a Cashier, a Waiter…): email and PIN at the POS, as before. Email optional.
 *
 * The owner's own role signs in as the owner (password on the web, PIN on the desktop) — 'web_pin' here, so their card
 * keeps its PIN. Pure: the Add / Edit Staff card (pages/settings/StaffTab.tsx) and its test read it.
 */
export type StaffSignIn = 'web' | 'web_pin' | 'pin';

const norm = (n: unknown): string => String(n ?? '').trim().replace(/[\s_]+/g, ' ').toLowerCase();

/** The General Manager role, by name with case and spaces aside (the role a partner is given — routes/staff.ts partnerRole). */
export function isGeneralManagerRole(name: string | null | undefined): boolean {
  return norm(name) === 'general manager';
}

/** How this person signs in. `backOffice`: their keys go beyond the shop floor (StaffTab's isBackOffice of their keys). */
export function staffSignIn(o: { partner?: boolean; roleName?: string | null; ownerRole?: boolean; backOffice: boolean }): StaffSignIn {
  if (o.ownerRole) return 'web_pin';
  if (o.partner || isGeneralManagerRole(o.roleName)) return 'web';
  return o.backOffice ? 'web_pin' : 'pin';
}

/** The line under the e-mail field: what the e-mail is for. `invites`: this user sends the web invitation on adding (the
 *  owner's dashboard); otherwise the owner gives web access later ("Give web access" on their card). */
export function emailHint(kind: StaffSignIn, invites: boolean): string {
  if (kind === 'pin') return 'Staff use their email and PIN to sign in to the POS.';
  if (!invites) return 'Their sign-in to the web dashboard — the owner gives them web dashboard access.';
  return 'Their sign-in to this web dashboard — the invitation says how to set a password.';
}

/** The PIN field's label. */
export function pinLabel(kind: StaffSignIn, editing: boolean): string {
  if (kind === 'web_pin') return editing ? 'PIN for the desktop POS (leave blank to keep)' : 'PIN for the desktop POS (4–6 digits)';
  return editing ? 'PIN (leave blank to keep)' : 'PIN (4–6 digits)';
}

