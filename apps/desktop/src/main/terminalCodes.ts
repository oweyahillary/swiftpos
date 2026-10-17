/**
 * terminalCodes.ts — A519: two tills at a branch never start with the same terminal code.
 *
 * A bill number is `<terminal code>--<counter>` (A500). Every install starts from "T1", so a second till set up at a
 * branch — or a till moved there — became a second "T1": A500 copes with the clash (a replica's number is renamed on the
 * machine that holds both), but the receipts of two tills read alike and the branch's reports name one till for two.
 * This stops it at the source: where the code is CHOSEN (setup's bind step, and any change of it later — config:save),
 * it is checked against the branch's other tills, and the next free code is suggested (T1 → T2 …).
 *
 * Who knows the branch's codes:
 *   - the cloud (GET /api/support/terminal-codes — the branch's approved tills, this machine's own earlier installs left
 *     out; migration 52's unique index is the cloud's guarantee) — asked first; the till has just enrolled, so it can;
 *   - the branch server, when the till joined through it (Find my server): its join answer names the codes its branch's
 *     tills use (their drawers and bill numbers) — the fallback when the cloud cannot be asked.
 *   Neither answers (offline, an older cloud and no server): the code is not refused — setup never stops on a check.
 *
 * Never refused: a code that does not change (a till ALREADY set up and trading keeps its code, whatever a sibling
 * uses), and the code the cloud gave this machine back from its earlier install (A182 restore).
 *
 * Pure apart from codesFromBranchDb (a read of the branch server's own tables), so the tests run it.
 */

export const CODE_RE = /^[A-Z0-9]{1,4}$/;

export const normaliseCode = (c: unknown): string => String(c ?? '').trim().toUpperCase();

/** The next code nobody at the branch uses: T1 → T2 …; a code without a number → its letters + 2 …. 1–4 characters.
 *  (The cloud's routes/support.ts has the same rule for its suggestion.) */
export function nextFreeTerminalCode(inUse: Iterable<string>, wanted?: string | null): string {
  const taken = new Set([...inUse].map(normaliseCode).filter(Boolean));
  const w = normaliseCode(wanted);
  const m = /^([A-Z]*)(\d*)$/.exec(w);
  let prefix = m?.[1] || 'T';
  let n = m?.[2] ? Number(m[2]) : 1;
  if (prefix.length > 3) prefix = prefix.slice(0, 3);
  for (let i = 0; i < 2000; i++) {
    const c = `${prefix}${n}`;
    if (c.length <= 4 && !taken.has(c)) return c;
    n++;
    if (`${prefix}${n}`.length > 4) { prefix = 'T'; n = 1; }
  }
  return w || 'T1';
}

export interface DbLike { prepare(sql: string): { all(...a: unknown[]): unknown[] } }

/**
 * On the branch server: the codes its branch's tills used in the last `days` days — their drawers (shifts.terminal_code)
 * and their bill numbers (`<code>--<n>`), by device, the asking device left out (a till joining again keeps its code).
 */
export function codesFromBranchDb(db: DbLike, exceptDeviceId: string | null | undefined, nowMs = Date.now(), days = 60): string[] {
  const since = new Date(nowMs - days * 86_400_000).toISOString();
  const except = String(exceptDeviceId ?? '');
  const out = new Set<string>();
  try {
    // branch-wide: the codes OTHER tills of this branch already use (this till is skipped below) — the whole point.
    for (const r of db.prepare(`SELECT DISTINCT device_id, terminal_code FROM shifts
        WHERE terminal_code IS NOT NULL AND terminal_code <> '' AND device_id IS NOT NULL AND opened_at >= ?`).all(since) as any[]) {
      if (String(r.device_id) !== except) out.add(normaliseCode(r.terminal_code));
    }
  } catch { /* an older table */ }
  try {
    // branch-wide: the bill-number prefixes OTHER tills of this branch already use (this till is skipped below).
    for (const r of db.prepare(`SELECT device_id, MAX(order_number) AS n FROM orders
        WHERE device_id IS NOT NULL AND order_number LIKE '%--%' AND created_at >= ? GROUP BY device_id`).all(since) as any[]) {
      if (String(r.device_id) === except) continue;
      const code = normaliseCode(String(r.n ?? '').split('--')[0]);
      if (CODE_RE.test(code)) out.add(code);
    }
  } catch { /* an older table */ }
  return [...out].filter((c) => CODE_RE.test(c)).sort();
}

export interface CodeCheckInput {
  code: string;
  /** The code this till holds now (device_config) — unchanged is never refused. */
  current: string | null;
  /** The cloud's answer (null: could not be asked). */
  cloud: { in_use: string[]; suggestion?: string } | null;
  /** The branch server's join answer (null: not joined through one, or an older server). */
  server: string[] | null;
}

export interface CodeVerdict { ok: boolean; taken: boolean; inUse: string[]; suggestion: string; source: 'cloud' | 'server' | 'none'; message: string | null }

/** May this till take `code`? */
export function terminalCodeVerdict(i: CodeCheckInput): CodeVerdict {
  const code = normaliseCode(i.code);
  const source: CodeVerdict['source'] = i.cloud ? 'cloud' : i.server ? 'server' : 'none';
  const inUse = [...new Set((i.cloud?.in_use ?? i.server ?? []).map(normaliseCode).filter(Boolean))].sort();
  const suggestion = i.cloud?.suggestion && !inUse.includes(normaliseCode(i.cloud.suggestion))
    ? normaliseCode(i.cloud.suggestion) : nextFreeTerminalCode(inUse, code || 'T1');
  if (!CODE_RE.test(code)) {
    return { ok: false, taken: false, inUse, suggestion, source, message: 'Terminal code must be 1–4 letters or digits, e.g. T1' };
  }
  if (normaliseCode(i.current) === code) return { ok: true, taken: false, inUse, suggestion: code, source, message: null };
  const taken = inUse.includes(code);
  return {
    ok: !taken, taken, inUse, suggestion, source,
    message: taken ? `${code} is already used by another till at this branch (in use: ${inUse.join(', ')}). Use ${suggestion}.` : null,
  };
}
