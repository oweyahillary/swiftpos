/**
 * register-status.mjs — derive OPEN/CLOSED from an audit-register heading.
 *
 * A heading looks like `A17 · P0 · OPEN · title` — the ID, then a few
 * ·-separated fields, then free-text prose. The status, when stated, is one of
 * those leading fields ("CLOSED 08-12", "OPEN (blocked on the owner)", "PARTLY
 * CLOSED 08-08", "REOPENED AND RE-FIXED 08-10"); absence of one means OPEN.
 *
 * D11 is why this is its own tested function. Its title was "…fails closed and
 * kills the catalogue pull" — and the old check scanned the WHOLE heading for
 * the word "closed", so an OPEN item read as CLOSED and was silently dropped
 * from the open counts (the header only balanced by accident). The fix is to
 * match a status LABEL at the start of a leading field, never a substring buried
 * in the title, which may legitimately contain "open", "closed" or "struck".
 *
 * `rest` is the heading with the leading `### An · ` already removed (the bold
 * `**` markers may still be present; they are stripped here).
 */
export function deriveStatus(rest) {
  const r = String(rest).replace(/\*\*/g, '').toUpperCase();
  // Only the first couple of fields can carry a status; everything after is the
  // title. Split on the register's two field separators (· and |).
  const segs = r.split(/[·|]/).map(s => s.trim());
  const label = segs.slice(0, 2).find(s =>
    /^(PARTLY CLOSED|REOPENED|FIX SHIPPED|CLOSED|OPEN|STRUCK|NOTE)\b/.test(s));
  if (!label) return 'OPEN';                                   // no status field → open
  if (/^REOPENED/.test(label)) return 'OPEN';                  // reopened is open again
  if (/^(PARTLY CLOSED|CLOSED|STRUCK|FIX SHIPPED)/.test(label)) return 'CLOSED';
  return 'OPEN';                                               // OPEN, NOTE
}
