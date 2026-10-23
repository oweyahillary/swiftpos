/**
 * branchBranding.ts — A544 (client branding Phase 2, the per-branch slice of A323): a branch can override the business's
 * action theme, brand colour and receipt footer.
 *
 * Owner, 2026-10-21: "phase 2 branding — we need to do it before value add" … "yes start" (per-branch branding). The design
 * is docs/SCOPE-A295-branding.md §14–15: `branch_branding` (migration 156), resolved per field at the till and the web POS
 * as **branch override → business branding → ZapTill default**. A branch may override only its colour, only its theme,
 * only its footer.
 *
 *  Byte-identical copies (scripts/check-shared-sync.mjs), each beside a copy of themes.ts:
 *      shared/branchBranding.ts                 (canonical)
 *      apps/server/src/lib/branchBranding.ts    (the cloud validates a write; /pos/init and /pos/changes)
 *      apps/desktop/src/shared/branchBranding.ts (the till resolves its own branch's look and receipt footer)
 *      apps/dashboard/src/lib/branchBranding.ts (Settings › Branding › Per branch; the web POS resolves its branch)
 *
 *  Self-contained but for ./themes (the registry and the brand-colour rule — ONE rule for both levels).
 *
 *  Premium: only while the business's `themes` flag is on (A325). With it off the cloud serves the till's effective
 *  theme as null and no branch row (`branchBranding: null`), and this resolver ignores any override it is handed while
 *  the business theme is null — stored, never applied.
 */
import { isThemeId, resolveBrandLayer } from './themes';

/** A footer line as the receipt prints it: 48 characters on 80 mm paper (Font A, the receipt's font — A540 / A543). */
export const FOOTER_LINE_MAX = 48;
/** On 58 mm paper a line has 32; a longer one wraps there (the web shows the hint). */
export const FOOTER_LINE_NARROW = 32;
export const FOOTER_MAX_LINES = 6;
export const FOOTER_MAX_CHARS = 300;

/** One branch's override as the cloud serves it (pos/init `branchBranding`, the branch_branding change). null = none. */
export interface BranchBranding {
  branchId: string;
  themeId: string | null;
  accentHex: string | null;
  receiptFooter: string | null;
}
/** The business level (and what the resolver returns). themeId is the cloud's EFFECTIVE theme: null = themes off. */
export interface BrandingLevel {
  themeId?: string | null;
  accentHex?: string | null;
  receiptFooter?: string | null;
}
export interface ResolvedBranding {
  themeId: string | null;
  accentHex: string | null;
  receiptFooter: string;
  /** Which fields came from the branch (the web and the Tech page can say so). */
  fromBranch: { theme: boolean; accent: boolean; footer: boolean };
}

const HEX3 = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/;
const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** #RGB / #RRGGBB → lower-case #rrggbb, or null when it is not a colour. */
export function normaliseHex(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const m = HEX3.exec(s);
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase();
  return HEX6.test(s) ? s.toLowerCase() : null;
}

/** The brand-colour rule (Phase 1 / A323): it must be SEEN on the till's dark screens (3:1) — resolveBrandLayer. */
export function accentWriteError(v: unknown): string | null {
  if (v === null) return null;
  const hex = normaliseHex(v);
  if (!hex) return 'accent_hex must be a #RGB or #RRGGBB hex colour (or null)';
  if (!resolveBrandLayer(hex)) return 'That colour cannot be seen on the till’s dark screens (it needs 3:1) — pick a lighter or stronger shade';
  return null;
}

/** A theme override: null (use the business's) or one of the curated themes. */
export function themeOverrideError(v: unknown): string | null {
  if (v === null) return null;
  return isThemeId(v) ? null : 'theme_id must be one of the curated themes (or null)';
}

/**
 * The receipt footer as it will be stored: plain text, the author's own line breaks kept (P-15), trailing spaces and
 * blank lines at either end dropped. '' → null (no override). Never throws — footerWriteError says what is wrong.
 */
export function cleanFooter(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const lines = v.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const out = lines.join('\n');
  return out === '' ? null : out;
}

/** Why a footer cannot be stored, or null. Plain text only (no markup, no control codes — a receipt printer obeys them). */
export function footerWriteError(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') return 'receipt_footer must be text (or null)';
  const clean = cleanFooter(v);
  if (clean === null) return null;
  if (/[<>]/.test(clean)) return 'The footer is plain text — no < or > (no HTML or markup)';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(clean)) return 'The footer is plain text — no control characters';
  if (clean.length > FOOTER_MAX_CHARS) return `The footer is at most ${FOOTER_MAX_CHARS} characters`;
  const lines = clean.split('\n');
  if (lines.length > FOOTER_MAX_LINES) return `The footer is at most ${FOOTER_MAX_LINES} lines`;
  const wide = lines.findIndex((l) => l.length > FOOTER_LINE_MAX);
  if (wide >= 0) return `Line ${wide + 1} is ${lines[wide].length} characters — a receipt line holds ${FOOTER_LINE_MAX} (80 mm paper); break it into two lines`;
  return null;
}

/** A pulled override (pos/init, a change, a branch server's bundle) → a clean row, or null. Tolerant: a bad field is null. */
export function branchBrandingFromWire(v: unknown): BranchBranding | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const branchId = typeof o.branchId === 'string' && o.branchId ? o.branchId : null;
  if (!branchId) return null;
  const themeId = isThemeId(o.themeId) ? o.themeId : null;
  const hex = normaliseHex(o.accentHex);
  const accentHex = hex && resolveBrandLayer(hex) ? hex : null;
  const footer = typeof o.receiptFooter === 'string' && footerWriteError(o.receiptFooter) === null ? cleanFooter(o.receiptFooter) : null;
  return { branchId, themeId, accentHex, receiptFooter: footer };
}

/**
 * Per field: the branch's override → the business's → the ZapTill default (no theme / no colour / the business footer,
 * '' = the receipt's own thank-you). Only while themes are on (the business's effective theme is not null); otherwise
 * the business level exactly as it was.
 */
export function resolveBranchBranding(business: BrandingLevel | null | undefined, branch: BranchBranding | null | undefined): ResolvedBranding {
  const bizTheme = typeof business?.themeId === 'string' && business.themeId ? business.themeId : null;
  const bizAccent = typeof business?.accentHex === 'string' && business.accentHex ? business.accentHex : null;
  const bizFooter = typeof business?.receiptFooter === 'string' ? business.receiptFooter : '';
  const none = { theme: false, accent: false, footer: false };
  if (!bizTheme || !branch) return { themeId: bizTheme, accentHex: bizAccent, receiptFooter: bizFooter, fromBranch: none };
  const theme = isThemeId(branch.themeId);
  const hex = normaliseHex(branch.accentHex);
  const accent = !!hex && !!resolveBrandLayer(hex);
  const footer = typeof branch.receiptFooter === 'string' && branch.receiptFooter.trim() !== '';
  return {
    themeId: theme ? (branch.themeId as string) : bizTheme,
    accentHex: accent ? hex : bizAccent,
    receiptFooter: footer ? (branch.receiptFooter as string) : bizFooter,
    fromBranch: { theme, accent, footer },
  };
}
