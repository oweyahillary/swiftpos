/**
 * lib-memdb.mjs — a small in-memory PostgREST for the cloud-audit tests (2026-10-14): the COMPILED server's
 * supabase.from() / .rpc() replaced by tables in memory, with the filters, paging, writes and conditional updates the
 * routes use, and a way to make one read or write fail (to prove a failure is answered as a failure).
 *
 *   const mem = installMemDb(supabase);
 *   mem.db = { shifts: [...], ... };
 *   mem.fail = (table, op, filters, payload) => (table === 'expenses' && op === 'select' ? { message: 'timeout', code: '57014' } : null);
 *
 * Not a test file itself (no .test. in the name): imported by the tests that need it.
 */
export function installMemDb(supabase) {
  // latency(table, op) → ms before a READ answers (the write itself stays atomic): lets two requests overlap for a race test.
  const mem = { realOr: false, db: {}, fail: () => null, latency: () => 0, rowCap: Infinity, calls: [], nextId: 1, rpc: async () => ({ data: null, error: null }) };
  // latency may also return a Promise (a barrier): the read answers when it settles.
  const later = (table, op, fn, filters) => {
    const l = op === 'select' ? mem.latency(table, op, filters) : 0;
    if (l && typeof l.then === 'function') return l.then(fn);
    const ms = Number(l) || 0;
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)).then(fn) : Promise.resolve().then(fn);
  };
  const cmp = (x, v, op) => {
    if (x === null || x === undefined) return false;
    const a = typeof v === 'number' ? Number(x) : String(x), b = typeof v === 'number' ? v : String(v);
    return op === 'gte' ? a >= b : op === 'lte' ? a <= b : op === 'gt' ? a > b : a < b;
  };
  // A593: split at the top-level commas (not inside and(…)).
  const splitTop = (s) => { const out = []; let depth = 0, cur = ''; for (const ch of s) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch; } if (cur) out.push(cur); return out; };
  const condTest = (item) => {
    if (item.startsWith('and(') && item.endsWith(')')) { const parts = splitTop(item.slice(4, -1)).map(condTest); return (r) => parts.every((t) => t(r)); }
    if (item.startsWith('or(') && item.endsWith(')')) { const parts = splitTop(item.slice(3, -1)).map(condTest); return (r) => parts.some((t) => t(r)); }
    const [col, op0, ...rest] = item.split('.');
    let op = op0, neg = false, val = rest.join('.');
    if (op === 'not') { neg = true; op = rest[0]; val = rest.slice(1).join('.'); }
    const lit = val === 'null' ? null : val === 'true' ? true : val === 'false' ? false : val;
    const one = (r) => {
      const x = r[col];
      if (op === 'is') return lit === null ? x == null : x === lit;
      if (op === 'in') {
        const list = splitTop(String(val).replace(/^\(/, '').replace(/\)$/, '')).map((v) => v.replace(/^"(.*)"$/, '$1'));
        return x != null && list.includes(String(x));
      }
      if (op === 'eq') return x != null && String(x) === String(val);
      if (op === 'neq') return x != null && String(x) !== String(val);
      if (['gt', 'gte', 'lt', 'lte'].includes(op)) {
        if (x == null) return false;
        const num = /^-?\d+(\.\d+)?$/.test(val);
        const a = num ? Number(x) : (Number.isFinite(Date.parse(x)) && Number.isFinite(Date.parse(val)) ? Date.parse(x) : String(x));
        const b = num ? Number(val) : (typeof a === 'number' ? Date.parse(val) : String(val));
        return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
      }
      throw new Error(`lib-memdb: or() operator ${op} not supported`);
    };
    return neg ? (r) => !one(r) : one;
  };
  const orTest = (expr) => { const parts = splitTop(expr).map(condTest); return (r) => parts.some((t) => t(r)); };
  supabase.from = (table) => {
    const f = []; const filters = {}; let op = 'select'; let payload = null; let opts = null;
    let rng = null; let lim = null; let ord = null; let head = false; let cols = '*'; let returning = false;
    const list = () => (mem.db[table] ??= []);
    const rows = () => list().filter((r) => f.every((fn) => fn(r)));
    const run = () => {
      mem.calls.push({ table, op, filters: { ...filters }, payload });
      const err = mem.fail(table, op, filters, payload, cols);
      if (err) return { data: null, error: err };
      if (op === 'insert') {
        const ins = [].concat(payload).map((x) => ({ id: x.id ?? `row-${mem.nextId++}`, ...x }));
        for (const r of ins) if (list().some((e) => e.id === r.id)) return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${table}_pkey"` } };
        list().push(...ins);
        return { data: ins.map((r) => ({ ...r })), error: null };
      }
      if (op === 'upsert') {
        const out = [];
        // As Postgres: the conflict target when one is named (A492: branch_settings on branch_id,key), else the id.
        const target = String(opts?.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        for (const x of [].concat(payload)) {
          const have = target.length
            ? list().find((e) => target.every((k) => e[k] === x[k]))
            : list().find((e) => e.id === x.id);
          if (have) { if (!opts?.ignoreDuplicates) { Object.assign(have, x); out.push({ ...have }); } }
          else { const r = { ...x }; list().push(r); out.push({ ...r }); }
        }
        return { data: out, error: null };
      }
      if (op === 'update') { const hit = rows(); hit.forEach((r) => Object.assign(r, payload)); return { data: hit.map((r) => ({ ...r })), error: null }; }
      if (op === 'delete') { const hit = rows(); mem.db[table] = list().filter((r) => !hit.includes(r)); return { data: hit, error: null }; }
      let all = rows();
      if (ord) all = [...all].sort((a, b) => (String(a[ord[0]] ?? '') < String(b[ord[0]] ?? '') ? -1 : String(a[ord[0]] ?? '') > String(b[ord[0]] ?? '') ? 1 : 0) * (ord[1] ? 1 : -1));
      if (rng) all = all.slice(rng[0], rng[1] + 1);
      if (lim !== null) all = all.slice(0, lim);
      all = all.slice(0, mem.rowCap);   // Supabase's db-max-rows: a plain read is cut short silently
      if (head) return { data: null, count: all.length, error: null };
      return { data: all.map((r) => ({ ...r })), count: all.length, error: null };
    };
    const q = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'select') return (c, o) => { if (o?.head) head = true; if (op !== 'select') returning = true; else cols = c ?? '*'; return q; };
        if (prop === 'eq') return (k, v) => { filters[k] = v; f.push((r) => r[k] === v); return q; };
        if (prop === 'neq') return (k, v) => { f.push((r) => r[k] !== v); return q; };
        if (prop === 'in') return (k, a) => { filters[`${k}:in`] = a; f.push((r) => a.includes(r[k])); return q; };
        if (prop === 'is') return (k, v) => { f.push((r) => (v === null ? r[k] == null : r[k] === v)); return q; };
        if (prop === 'not') return (k, o2, v) => { f.push((r) => (o2 === 'is' && v === null ? r[k] != null : r[k] !== v)); return q; };
        if (['gte', 'lte', 'gt', 'lt'].includes(prop)) return (k, v) => { f.push((r) => cmp(r[k], v, prop)); return q; };
        // A564: a pattern with % matches as LIKE does (any run of characters), case-insensitive; without one, equality as before.
        if (prop === 'ilike') return (k, v) => {
          const pat = String(v);
          const re = pat.includes('%') ? new RegExp(`^${pat.split('%').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i') : null;
          f.push((r) => (re ? re.test(String(r[k] ?? '')) : String(r[k] ?? '').toLowerCase() === pat.toLowerCase())); return q;
        };
        // A593: PostgREST's or=(…) — applied only when a test asks (mem.realOr = true): `col.op.value` items (eq neq gt gte
        // lt lte is in, `col.not.op.value`) and and(…) groups. Off (the default, as before A593): ignored — no filter.
        if (prop === 'or') return (expr) => { if (mem.realOr) { const t = orTest(String(expr)); f.push((r) => t(r)); } return q; };
        if (prop === 'order') return (k, o) => { ord = [k, o?.ascending !== false]; return q; };
        if (prop === 'range') return (a, b) => { rng = [a, b]; return q; };
        if (prop === 'limit') return (n) => { lim = n; return q; };
        if (prop === 'insert') return (p) => { op = 'insert'; payload = p; return q; };
        if (prop === 'upsert') return (p, o) => { op = 'upsert'; payload = p; opts = o ?? null; return q; };
        if (prop === 'update') return (p) => { op = 'update'; payload = p; return q; };
        if (prop === 'delete') return () => { op = 'delete'; return q; };
        if (prop === 'maybeSingle') return () => later(table, op, () => { const r = run(); return r.error ? { data: null, error: r.error } : { data: r.data?.[0] ?? null, error: null }; }, filters);
        if (prop === 'single') return () => later(table, op, () => { const r = run(); const x = r.data?.[0]; return r.error ? { data: null, error: r.error } : x ? { data: x, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } }; }, filters);
        if (prop === 'then') return (res, rej) => later(table, op, () => { const r = run(); return r.error ? { data: null, error: r.error } : { data: (op === 'select' || returning) ? r.data : (op === 'insert' || op === 'upsert' ? null : r.data), count: r.count, error: null }; }).then(res, rej);
        return () => q;
      },
    });
    return q;
  };
  supabase.rpc = (...a) => mem.rpc(...a);
  return mem;
}
