#!/usr/bin/env node
/**
 * check-no-till-wording.mjs — A586: the product says "POS" or "point of sale", never "till".
 *
 * Owner, 2026-10-23: "ensure we use the word POS or point of sale instead of till". The website already followed it;
 * this gate keeps the product's own words in line: the web dashboard and web POS, the admin portal, the desktop app's
 * screens and the messages its main process shows, the cloud's error messages and emails, the help topics and the
 * printed slips.
 *
 *   node scripts/check-no-till-wording.mjs              # exit 1 on any hit, listing file:line and the text
 *   node scripts/check-no-till-wording.mjs --self-test  # proves a planted "till" is caught and the M-Pesa words pass
 *
 * WHAT IS SCANNED: string literals, template-literal text and JSX text. NOT scanned: comments, import paths, code
 * identifiers (tillId, till_sessions, 'tills' as a table or a key), SQL, and the arguments of developer log calls
 * (console.*, logLine, log, authLog) — those are for developers, not the people using the product.
 *
 * KEPT ON PURPOSE (ALLOWED_PHRASES): Safaricom's M-Pesa product is called a "Till" — "Buy Goods Till", "Till number"
 * on the M-Pesa settings and "TILL NO" on a receipt are its name, not ours. ALLOW_LINES lists the few remaining
 * M-Pesa strings by file and text; keep it short and give every entry a reason.
 *
 * Deliberately pragmatic: a small tokenizer, no TypeScript dependency (the CI job that runs it installs nothing).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Where the product's user-facing words live. */
export const ROOTS = [
  'apps/dashboard/src',
  'apps/admin/src',
  'apps/desktop/src/renderer',
  'apps/desktop/src/main',
  'apps/desktop/src/shared',
  'apps/server/src',
  'shared',
  'packages', // shared-components: code that moved out of the apps' copies
];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-electron', 'test-dist', 'release', 'build', 'coverage', '.vite', 'test', 'tests', '__tests__']);
const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.html']);
const SKIP_FILE = /(\.test\.|\.spec\.|\.d\.ts$|escposRenderer\.js$|\.generated\.)/;

/** Developer log calls: their text is for developers, not for the people using the product. */
const LOG_CALLEE = /^(console\.\w+|logLine|log|authLog|debug)$/;

/** The word, as a word: not part of tillId / till_id / ZapTill / /tills/ / till-sessions. */
const TILL = /(?<![\w$@\-/.])(?:[Tt]ill|TILL)(?:s|S)?(?![\w\-/])/;

/**
 * Safaricom's names — the M-Pesa product is a "Till". Removed from the text before it is checked, so the rest of the
 * string is still checked.
 */
export const ALLOWED_PHRASES = [
  /buy[\s-]*goods(?:\s*\(?\s*till\s*\)?)?(?:\s*(?:no\.?|number|numbers))?/gi,
  /m-?pesa\s+till(?:\s*(?:no\.?|number|numbers))?/gi,
  /\btill\s*(?:no\.?|number|numbers)\s*(?:\/|or)\s*paybill/gi,
  /\bpaybill\s*(?:\/|or)\s*till(?:\s*(?:no\.?|number|numbers))?/gi,
  /\btill\s*(?:\/|or)\s*paybill/gi,
  /\bTILL\s*NO\b\.?/g,
];

/**
 * Strings kept by file and text. Every entry: [the file's path or its end (every copy of a shared file), a substring
 * of the string ('' = the whole file), the reason]. Keep this SHORT.
 */
export const ALLOW_LINES = [
  ['mpesaReceive.ts', '', "M-Pesa's own Buy Goods \"Till number\" — Safaricom's name (every copy of shared/mpesaReceive.ts)"],
  ['permissions.ts', '', 'FROZEN: the catalogue and the built-in roles are registered word for word by migrations 134 and 142 '
    + '(scripts/test-migration-134.mjs, test-migration-159.mjs) — shown through posWording() (shared/businessTerms.ts)'],
];

const SQL = /\b(LIKE\s+'|COALESCE\(|NOT\s+NULL|DEFAULT\s+'|SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(TABLE|INDEX|TRIGGER)|ALTER\s+TABLE|JOIN|WHERE)\b/;

function stripAllowed(s) {
  let t = s;
  for (const re of ALLOWED_PHRASES) t = t.replace(re, ' ');
  return t;
}

/** Does this piece of text (a string's content, or JSX text) say "till" to a person? */
export function saysTill(text) {
  const t = stripAllowed(text);
  if (!TILL.test(t)) return false;
  if (SQL.test(text)) return false;
  // An identifier-like string ('tills', 'till', 'pos.till') — no space and no capital "Till" — is code, not words.
  // (Untrimmed: a template's `till ${n}` piece ends in the space before its value.)
  if (!/\s/.test(text) && !/(?<![\w$@\-/.])(Tills?|TILLS?)(?![\w\-/])/.test(t)) return false;
  return true;
}

const KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);
const DECL = new Set(['const', 'let', 'var', 'return', 'typeof', 'await', 'yield', 'case', 'function', 'import', 'export', 'interface', 'extends', 'keyof', 'satisfies']);

/**
 * Tokenize JS/TS(X) source into pieces: { kind: 'str'|'tpl'|'code', text, line, callee, prev }.
 * `callee` is the nearest enclosing call's name (for the log-call skip), `prev` the significant code before a string.
 */
export function pieces(src) {
  const out = [];
  let i = 0; let line = 1;
  const n = src.length;
  const parens = []; // callee names for '(' — '' for a non-call paren
  const braces = []; // 'code' or 'tpl' — what a '}' closes
  let lastSig = ''; // last significant code char
  let lastWord = ''; // last identifier/keyword in code
  let code = ''; let codeLine = 1; let codeStart = 0;
  const flushCode = () => { if (code) out.push({ kind: 'code', text: code, line: codeLine, start: codeStart }); code = ''; };
  const callee = () => { for (let k = parens.length - 1; k >= 0; k--) if (parens[k]) return parens[k]; return ''; };
  const pushStr = (kind, text, startLine, start) => out.push({ kind, text, line: startLine, start, callee: callee(), prev: lastSig, prevWord: lastWord });

  const readTemplateText = () => {
    // at a char after '`' or after the '}' that closed a '${'
    let s = ''; const startLine = line; const start = i;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { s += src.slice(i, i + 2); if (src[i + 1] === '\n') line++; i += 2; continue; }
      if (c === '`') { pushStr('tpl', s, startLine, start); i++; return 'end'; }
      if (c === '$' && src[i + 1] === '{') { pushStr('tpl', s, startLine, start); i += 2; braces.push('tpl'); return 'expr'; }
      if (c === '\n') line++;
      s += c; i++;
    }
    pushStr('tpl', s, startLine, start); return 'end';
  };

  while (i < n) {
    if (code === '') codeStart = i;
    const c = src[i]; const d = src[i + 1];
    if (c === '\n') { line++; code += c; i++; continue; }
    if (c === '/' && d === '/') { flushCode(); while (i < n && src[i] !== '\n') i++; codeLine = line; continue; }
    if (c === '/' && d === '*') {
      flushCode(); i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2; codeLine = line; continue;
    }
    if (c === '\'' || c === '"') {
      // A real string ends on its own line; a lone apostrophe in JSX text ("Don't") does not — it stays text.
      let j = i + 1; let s = ''; let ok = false;
      while (j < n) {
        const e = src[j];
        if (e === '\\') { s += src.slice(j, j + 2); j += 2; continue; }
        if (e === c) { ok = true; break; }
        if (e === '\n') break;
        s += e; j++;
      }
      if (ok) {
        flushCode(); pushStr('str', s, line, i + 1); i = j + 1; lastSig = c; codeLine = line; continue;
      }
      code += c; i++; continue;
    }
    if (c === '`') {
      flushCode(); i++;
      if (readTemplateText() === 'end') { lastSig = '`'; codeLine = line; }
      else { lastSig = '{'; codeLine = line; }
      continue;
    }
    if (c === '/') {
      // A regex literal where an expression may start; it ends on its own line.
      const regexOk = !lastSig || '(,=:[!&|?{};+-*%~^'.includes(lastSig) || KEYWORDS.has(lastWord) && lastSig === lastWord.slice(-1);
      if (regexOk) {
        let j = i + 1; let inClass = false; let ok = false;
        while (j < n && src[j] !== '\n') {
          const e = src[j];
          if (e === '\\') { j += 2; continue; }
          if (e === '[') inClass = true; else if (e === ']') inClass = false;
          else if (e === '/' && !inClass) { ok = true; break; }
          j++;
        }
        if (ok && j > i + 1) {
          j++; while (j < n && /[a-z]/.test(src[j])) j++;
          code += ' '.repeat(j - i); i = j; lastSig = ')'; continue;
        }
      }
    }
    if (c === '(') {
      // the callee: the identifier chain right before '('
      const m = /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*$/.exec(code.slice(-80));
      parens.push(m ? m[1].replace(/\s+/g, '') : '');
    } else if (c === ')') parens.pop();
    if (c === '{') braces.push('code');
    if (c === '}') {
      const top = braces.pop();
      if (top === 'tpl') {
        flushCode(); i++;
        if (readTemplateText() === 'end') { lastSig = '`'; } else { lastSig = '{'; }
        codeLine = line; continue;
      }
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i; while (j < n && /[\w$]/.test(src[j])) j++;
      const w = src.slice(i, j); code += w; lastWord = w; lastSig = w.slice(-1); i = j; continue;
    }
    if (!/\s/.test(c)) lastSig = c;
    code += c; i++;
  }
  flushCode();
  return out;
}

/** In code (JSX), a "till" that reads as words: `Rejoin this till`, `>Till<`, `the till.` — not `till.id`, `const till`. */
export function jsxTillHits(codeText) {
  const hits = [];
  const re = new RegExp(TILL.source, 'g');
  let m;
  while ((m = re.exec(codeText))) {
    const before = codeText.slice(Math.max(0, m.index - 40), m.index);
    const after = codeText.slice(m.index + m[0].length, m.index + m[0].length + 40);
    const prevWord = /([A-Za-z_$][\w$]*)\s*$/.exec(before)?.[1] ?? '';
    const prevCh = before.replace(/\s+$/, '').slice(-1);
    const nextCh = after.replace(/^[ \t]+/, '').slice(0, 1);
    const next2 = after.replace(/^[ \t]+/, '').slice(0, 2);
    if (DECL.has(prevWord)) continue;
    if ('.?[('.includes(prevCh) && !/\s$/.test(before)) continue;
    if (prevCh === ',' || prevCh === '{' || prevCh === '(' || prevCh === '...'.slice(-1) && /\.\.\.\s*$/.test(before)) continue;
    const wordBefore = /[A-Za-z]\s+$/.test(before); // "(taken on a till)" is words; "f(a, till)" is not
    if (/^[=;[!]/.test(nextCh) || /^\(/.test(after) || /^\?\.|^\.[A-Za-z_$]|^\?\?|^\|\||^&&/.test(next2)) continue;
    if (nextCh === ':' && !wordBefore) continue;
    if (nextCh === ',' && !/^,\s/.test(after.replace(/^[ \t]+/, ''))) continue;
    if ((nextCh === '}' || nextCh === ')') && (!wordBefore || prevWord === 'of' || prevWord === 'in')) continue;
    // words around it: a word or '>' / '}' before; a word, end, punctuation or '<' after
    const proseBefore = /[A-Za-z0-9,'’>}"]\s+$/.test(before) || /[>]\s*$/.test(before);
    const proseAfter = /^\s+[^\s=;)\]}|&?.:,]/.test(after) || /^[.,!?:)]?\s*(<|$|\n|\{)/.test(after) || /^[.,!?;:)]\s/.test(after) || /^'s\b/.test(after);
    if (proseBefore && proseAfter) hits.push(m.index);
  }
  return hits;
}

function lineAt(text, idx) { let l = 0; for (let k = 0; k < idx; k++) if (text[k] === '\n') l++; return l; }

/** Scan one file's source; returns [{ line, text }]. */
export function scanSource(rel, src) {
  const found = [];
  const allowFor = ALLOW_LINES.filter(([f]) => rel === f || rel.endsWith('/' + f));
  if (allowFor.some(([, sub]) => sub === '')) return [];
  const allowed = (text) => allowFor.some(([, sub]) => text.includes(sub));
  if (rel.endsWith('.html')) {
    // Text outside tags and attribute values; skip <script>/<style> bodies.
    const body = src.replace(/<script[\s\S]*?<\/script>/gi, (s) => s.replace(/[^\n]/g, ' '))
      .replace(/<style[\s\S]*?<\/style>/gi, (s) => s.replace(/[^\n]/g, ' '))
      .replace(/<!--[\s\S]*?-->/g, (s) => s.replace(/[^\n]/g, ' '));
    const re = />([^<]+)</g; let m;
    while ((m = re.exec(body))) if (saysTill(m[1]) && !allowed(m[1])) found.push({ line: lineAt(body, m.index) + 1, text: m[1].trim() });
    const at = /\b(title|placeholder|alt|aria-label|content|value)="([^"]*)"/g;
    while ((m = at.exec(body))) if (saysTill(m[2]) && !allowed(m[2])) found.push({ line: lineAt(body, m.index) + 1, text: m[2].trim() });
    // and the scripts inside, as JS
    const scripts = [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    for (const s of scripts) {
      const offsetLine = lineAt(src, s.index);
      for (const h of scanSource(rel.replace(/\.html$/, '.inline.js'), s[1])) found.push({ line: h.line + offsetLine, text: h.text });
    }
    return found;
  }
  // A line that says `till-wording: ok` in a comment is code that handles the word itself (posWording), not words.
  const srcLines = src.split('\n');
  const okLine = (ln) => /till-wording: ok/.test(srcLines[ln - 1] ?? '');
  for (const p of pieces(src)) {
    if (okLine(p.line)) continue;
    if (p.kind === 'code') {
      for (const idx of jsxTillHits(p.text)) {
        const ln = p.text.slice(0, idx).split('\n');
        const whole = p.text.split('\n')[ln.length - 1].trim();
        if (!allowed(whole) && saysTill(whole.replace(/[{}]/g, ' ') + ' x')) found.push({ line: p.line + ln.length - 1, text: whole });
      }
      continue;
    }
    if (LOG_CALLEE.test(p.callee)) continue;
    if (p.prevWord === 'from' || p.prevWord === 'import' || p.prevWord === 'require') continue;
    if (saysTill(p.text) && !allowed(p.text)) found.push({ line: p.line, text: p.text.replace(/\s+/g, ' ').trim() });
  }
  return found;
}

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(p); }
    else if (EXTS.has(path.extname(e.name).toLowerCase()) && !SKIP_FILE.test(e.name)) yield p;
  }
}

export function scanRepo(root = ROOT) {
  const hits = []; let files = 0;
  for (const r of ROOTS) {
    const abs = path.join(root, r);
    try { if (!statSync(abs).isDirectory()) continue; } catch { continue; }
    for (const f of walk(abs)) {
      const rel = path.relative(root, f).split(path.sep).join('/');
      // shared/ holds the canonical copies of what the apps carry; its printing package's tests and build are not product text.
      if (rel.startsWith('shared/') && /\/(node_modules|test|dist)\//.test(rel)) continue;
      files++;
      for (const h of scanSource(rel, readFileSync(f, 'utf8'))) hits.push(`${rel}:${h.line}  ${h.text.slice(0, 140)}`);
    }
  }
  return { hits, files };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes('--self-test')) {
  const cases = [
    ['caught: a string', "const m = 'Rejoin this till';", 1],
    ['caught: a capital label', "const label = 'Till';", 1],
    ['caught: JSX text', 'const x = <p>This till is not set up yet.</p>;', 1],
    ['caught: a template', 'const s = `Till ${n} is offline`;', 1],
    ['caught: a printed line', "lines.push('Till: ' + name);", 1],
    ['passes: M-Pesa Buy Goods', "const h = 'Buy Goods Till number';", 0],
    ['passes: TILL NO on a receipt', "const r = 'TILL NO: ' + no;", 0],
    ['passes: identifiers', "const till = row.till; const t = 'tills'; db.from('till_sessions');", 0],
    ['passes: an import path', "import { a } from './tillChanges';", 0],
    ['passes: a comment', '// the till signs in here\nconst a = 1;', 0],
    ['passes: a developer log', "console.warn('till offline', id);", 0],
    ['passes: SQL', "db.prepare('SELECT * FROM tills WHERE id = ?');", 0],
    ['passes: POS wording', "const m = 'Rejoin this POS';", 0],
    ['passes: ZapTill', "const m = 'Download ZapTill';", 0],
  ];
  let bad = 0;
  for (const [name, src, want] of cases) {
    const got = scanSource('apps/x/src/planted.tsx', src).length;
    if (got !== want) { bad++; console.log(`FAIL — ${name}: ${got} hit(s), expected ${want}`); }
  }
  console.log(bad ? `FAIL — self-test: ${bad} case(s) wrong` : `OK — self-test: ${cases.length} cases (a planted "till" is caught; M-Pesa words, identifiers, comments, logs and SQL pass).`);
  process.exit(bad ? 1 : 0);
} else if (isMain) {
  const { hits, files } = scanRepo();
  console.log(`check-no-till-wording: ${files} file(s) scanned under ${ROOTS.join(', ')}.`);
  if (hits.length) {
    console.log(`FAIL — ${hits.length} user-visible "till" word(s). Say "POS" or "point of sale" (A586); M-Pesa's own "Till" names are allowed:`);
    for (const h of hits) console.log('  ' + h);
    process.exit(1);
  }
  console.log('OK — no user-visible "till" wording.');
}
