/**
 * alert-format-a592.test.mjs — A592: every admin Telegram message and admin email, clear and good-looking.
 *
 * Owner, 2026-10-26, showing two Telegram messages ("ZapTill nightly backup FAILED — 26 Oct 13:07 / … failed while checking
 * the upload (exit 252) …" and "🔴 STILL HAPPENING — for 214 h 40 min / [a client]: day 2026-10-09 not closed on T1 / The
 * business day ended 397 h 50 min ago …"): "How can we make these messages look better". Then: client problems as "a
 * small, simple table, one row per client problem, with a recommendation column" — Client | Problem | Since | What to do.
 *
 *   cd apps/server && npm run build && cd ../.. && node --no-warnings tests/alert-format-a592.test.mjs
 *
 * RUNS the COMPILED server's lib/alertFormat.js, lib/adminAlertPolicy.js, lib/watchdogRules.js, lib/opsEvents.js and
 * lib/alertNotify.js (Telegram answered by a stub fetch), then scripts/ops/notify-admin.sh and scripts/backup/report.sh
 * against a local HTTP server standing in for Telegram and Resend:
 *   1 escaping — a client called "A&B <Shop>" reaches Telegram as valid HTML (only <b> <i> <pre>, every & an entity)
 *   2 words for time — "8 days 22 h" not "214 h", "16 days", "just now", "Mon 26 Oct 13:07 EAT", "Fri 9 Oct"
 *   3 the messages — "Still open · 8 days", "✅ Resolved after 2 h 10 min", the owner's two-line rows with "→ what to do",
 *     the backup failure ("Step: checking the upload (exit 252 — …)", "Last good backup: Sun 25 Oct (1 day ago)"), buttons
 *     with valid URLs ("Close it remotely" → the admin portal's POS & days), every message under 4096
 *   4 the digest — grouped by severity, 15 rows then "+N more in the admin portal" and a button; the email's table with
 *     the four columns, Gmail-safe (inline styles only), the text part, the footer (Alerts and Email settings)
 *   5 every rule has a short name and a "What to do" of at most 60 characters
 *   6 the plain-text retry: Telegram answers 400 "can't parse entities" → sent again as plain text, the links written out
 *   7 the shell: notify-admin.sh (escaping with sed, curl --data-urlencode, the JSON reply_markup, the 400 retry) and
 *     report.sh's backup message; alert-format.sh says what the server says
 *   8 "POS", never "till", in every message
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A592 report):
 *   - alertFormat.ts escapeHtml without the "&" replacement          → 1 "valid HTML" fails
 *   - alertNotify.ts sendTelegram without the 400 retry               → 6 "sent again as plain text" fails
 *   - notify-admin.sh without the 400 retry                           → 7 "the shell retries as plain text" fails
 *   - notify-admin.sh html_escape without the "<" replacement         → 7 "escaped" fails
 *   - adminAlertPolicy.ts MAX_LINES 1000 (no truncation)              → 4 "+5 more" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.SERVER_DIST || path.join(ROOT, 'apps/server/dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0, skipped = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 5).join('\n      ')}`); } };
if (!fs.existsSync(path.join(DIST, 'lib/alertFormat.js'))) { console.log('\nBuild the server first:\n  cd apps/server && npm run build\n'); process.exit(1); }
process.env.SUPABASE_URL ??= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-only';
const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
const F = require(path.join(DIST, 'lib/alertFormat.js'));
const P = require(path.join(DIST, 'lib/adminAlertPolicy.js'));
const R = require(path.join(DIST, 'lib/watchdogRules.js'));
const O = require(path.join(DIST, 'lib/opsEvents.js'));
const N = require(path.join(DIST, 'lib/alertNotify.js'));

const NOW = new Date('2026-10-26T10:07:00Z');            // Mon 26 Oct 13:07 Nairobi
const ago = (min) => new Date(NOW.getTime() - min * 60_000).toISOString();
const BIZ = '11111111-1111-4111-8111-000000000001';
const LINKS = F.DEFAULT_LINKS;

/** Telegram's HTML, strictly: only <b> <i> <pre> (balanced), no other "<" or ">", every "&" an entity. */
function assertTelegramHtml(html) {
  const stack = [];
  for (const m of html.matchAll(/<(\/?)([a-z]+)>/g)) {
    assert.ok(['b', 'i', 'pre'].includes(m[2]), `tag <${m[2]}>`);
    if (m[1]) assert.equal(stack.pop(), m[2], 'balanced'); else stack.push(m[2]);
  }
  assert.equal(stack.length, 0, 'every tag closed');
  const bare = html.replace(/<\/?(b|i|pre)>/g, '');
  assert.ok(!/[<>]/.test(bare), `a bare < or > in: ${bare.slice(0, 200)}`);
  assert.ok(!/&(?!(amp|lt|gt|quot);)/.test(bare), 'every & is an entity');
  assert.ok(html.length < 4096, `length ${html.length}`);
}
const allText = [];
const keep = (m) => { allText.push(m.subject, m.text, m.tgHtml ?? '', m.html ?? '', m.emailText ?? ''); return m; };

// ── fixtures: the owner's two messages and more ─────────────────────────────────────────────────────────────────────
const sampleDay = R.daysNotClosed([{ id: 'd1', business_id: BIZ, branch_id: 'br1', terminal_code: 'T1', business_date: '2026-10-09', status: 'open',
  ends_at: ago(397 * 60 + 50), branch_name: 'Main Branch' }], NOW, { [BIZ]: 'Sample Shop' })[0];
const shopDay = R.daysNotClosed([{ id: 'd2', business_id: BIZ, branch_id: 'br1', terminal_code: 'T<2>', business_date: '2026-10-24', status: 'open',
  ends_at: ago(30 * 60), branch_name: 'Main & Co' }], NOW, { [BIZ]: 'A&B <Shop>' })[0];
const signedOut = R.tillsSignedOut([{ id: 'x2', business_id: BIZ, terminal_code: 'T2', status: 'approved', session_lost_at: ago(120), session_lost_reason: 'refused' }],
  NOW, { [BIZ]: 'Pollo Fries' })[0];
const dbDown = R.databaseUnreachable({ ok: false, error: 'connect ECONNREFUSED' })[0];

try {
  console.log('\n1. Escaping\n');
  await ok('escapeHtml: & < > " — "A&B <Shop>" → "A&amp;B &lt;Shop&gt;"', () => {
    assert.equal(F.escapeHtml('A&B <Shop> "x"'), 'A&amp;B &lt;Shop&gt; &quot;x&quot;');
    assert.equal(F.escapeHtml(null), '');
  });
  await ok('a client called "A&B <Shop>" (POS "T<2>"): the Telegram message is valid HTML, the name escaped, never raw', () => {
    const r = keep(P.routeRun({ opened: [{ alert: shopDay, firstSeenAt: ago(10) }], reminders: [], resolved: [] }, P.DEFAULT_ALERT_SETTINGS, NOW).telegramGroup);
    assertTelegramHtml(r.tgHtml);
    assert.ok(r.tgHtml.includes('<b>A&amp;B &lt;Shop&gt;</b>'), r.tgHtml);
    assert.ok(!r.tgHtml.includes('<Shop>'));
    assert.ok(r.text.includes('A&B <Shop>'), 'the plain text keeps the real name');
    const s = { ...P.DEFAULT_ALERT_SETTINGS, instant: [...P.DEFAULT_ALERT_SETTINGS.instant, 'day_not_closed'] };
    const g = keep(P.routeRun({ opened: [{ alert: shopDay, firstSeenAt: ago(10) }], reminders: [], resolved: [] }, s, NOW).instantGroup);
    assert.ok(g.html.includes('A&amp;B &lt;Shop&gt;') && !g.html.includes('<Shop>'), 'the email too');
  });

  console.log('\n2. Words for time (Nairobi)\n');
  await ok('durations: "just now", "45 min", "3 h 15 min", "8 days 22 h" (not "214 h 40 min"), short "16 days", "1 day"', () => {
    assert.equal(F.shortDuration(0.2), 'just now');
    assert.equal(F.shortDuration(45), '45 min');
    assert.equal(F.shortDuration(195), '3 h 15 min');
    assert.equal(F.shortDuration(30 * 60), '1 day');
    assert.equal(F.shortDuration(397 * 60 + 50), '16 days');
    assert.equal(F.durationLabel(214 * 60 + 40), '8 days 22 h');
    assert.equal(F.durationLabel(130), '2 h 10 min');
    assert.equal(F.agoLabel(ago(0), NOW), 'just now');
    assert.equal(F.agoLabel(ago(26 * 60), NOW), '1 day ago');
  });
  await ok('Nairobi: "Mon 26 Oct 13:07 EAT"; 21:30 UTC is already the next day; a business date "Fri 9 Oct"', () => {
    assert.equal(F.eatStamp(NOW), 'Mon 26 Oct 13:07 EAT');
    assert.equal(F.eatDay('2026-10-25T21:30:00Z'), 'Mon 26 Oct');
    assert.equal(F.eatTime('2026-10-25T21:30:00Z'), '00:30 EAT');
    assert.equal(F.dayLabel('2026-10-09', NOW), 'Fri 9 Oct');
    assert.equal(F.eatStamp('nonsense'), '—');
  });

  console.log('\n3. The messages\n');
  await ok('a client problem: "Sample Shop · T1 — Day not closed · 16 days" then "→ Close it at the POS or by Remote Day Close"', () => {
    assert.equal(sampleDay.problem, 'Day Fri 9 Oct still open (ended 16 days ago)');
    const r = keep(P.routeRun({ opened: [{ alert: sampleDay, firstSeenAt: ago(5) }, { alert: signedOut, firstSeenAt: ago(120) }], reminders: [], resolved: [] }, P.DEFAULT_ALERT_SETTINGS, NOW).telegramGroup);
    assertTelegramHtml(r.tgHtml);
    assert.match(r.tgHtml, /^🔴 <b>2 new problems at clients<\/b>/);
    assert.ok(r.tgHtml.includes('• <b>Sample Shop</b> · T1 — Day not closed · 16 days\n    → Close it at the POS or by Remote Day Close'), r.tgHtml);
    assert.ok(r.tgHtml.includes("• <b>Pollo Fries</b> · T2 — POS can't sign in · 2 h\n    → Rejoin the POS from its Tech page (enrolment code)"), r.tgHtml);
    for (const l of r.tgHtml.split('\n').filter((x) => /^(• | {4}→ )/.test(x))) assert.ok(l.replace(/<\/?b>/g, '').length <= 60, `a phone-length row: ${l}`);
    assert.deepEqual(r.buttons.map((b) => b.text), ['Open alerts']);
  });
  await ok('a reminder: "🔴 Still open · 8 days · The database is unreachable", since, what to do, the button', () => {
    const r = keep(P.routeRun({ opened: [], reminders: [{ alert: dbDown, firstSeenAt: ago(214 * 60 + 40) }], resolved: [] }, P.DEFAULT_ALERT_SETTINGS, NOW).instantEach[0]);
    assertTelegramHtml(r.tgHtml);
    assert.match(r.tgHtml, /^🔴 <b>Still open · 8 days · The database is unreachable<\/b>/);
    assert.match(r.tgHtml, /<b>Since:<\/b> Sat 17 Oct 14:27 EAT \(8 days ago\)/);
    assert.match(r.tgHtml, /👉 /);
    assert.doesNotMatch(r.tgHtml, /STILL HAPPENING|214 h/);
    assert.equal(r.subject, '🔴 Still open · 8 days · Cloud: the database is unreachable');
    assert.deepEqual(r.buttons, [{ text: 'Open in admin', url: 'https://admin.zaptill.co.ke/?open=alerts' }]);
  });
  await ok('resolved: "✅ Resolved after 2 h 10 min" and what it was', () => {
    const r = keep(P.routeRun({ opened: [], reminders: [], resolved: [{ key: 'database_unreachable', title: 'Cloud: the database is unreachable', first_seen_at: ago(130) }] }, P.DEFAULT_ALERT_SETTINGS, NOW).telegramGroup);
    assert.equal(r.tgHtml.split('\n').slice(0, 2).join('\n'), '✅ <b>Resolved after 2 h 10 min</b>\nCloud: the database is unreachable');
  });
  await ok('buttons: a day not closed → "Close it remotely" (the client\'s POS & days in the admin portal); only valid URLs; two to a row', () => {
    const b = P.alertButtons({ key: 'day_not_closed:d1', businessId: BIZ }, LINKS);
    assert.deepEqual(b.map((x) => x.text), ['Close it remotely', 'Open in admin']);
    assert.equal(b[0].url, `https://admin.zaptill.co.ke/?client=${BIZ}&tab=tills`);
    for (const x of b) assert.ok(F.validUrl(x.url) && new URL(x.url).protocol === 'https:', x.url);
    assert.ok(P.alertButtons({ key: 'backup_missed', businessId: null }).some((x) => x.text === 'Guide' && x.url.endsWith('/blob/main/docs/BACKUPS.md')));
    const k = F.telegramKeyboard([{ text: 'A', url: 'https://a.test' }, { text: 'B', url: 'javascript:alert(1)' }, { text: 'C', url: 'https://c.test' }, { text: 'D', url: 'https://d.test' }]);
    assert.deepEqual(k.inline_keyboard.map((r) => r.map((x) => x.text)), [['A', 'C'], ['D']], 'the bad URL dropped');
    assert.equal(F.telegramKeyboard([]), null);
    // The admin portal opens what the buttons name.
    const portal = read('apps/admin/src/AdminPortal.tsx');
    assert.match(portal, /const DEEP_PAGES = \["alerts", "system", "billing", "clients", "tech"\];/);
    assert.match(portal, /initialTab=\{clientTab \?\? "overview"\}/);
  });
  await ok('the backup failure (server side): "Backup failed — Mon 26 Oct 13:07 EAT", the step in plain words, the last good backup, Open run · Guide', () => {
    const ev = { kind: 'backup', status: 'fail', title: 'Backup failed - checking the upload (exit 252)', source: 'github',
      details: { error: 'failed while checking the upload (exit 252)', step: 'checking the upload', exit: 252,
        run_url: 'https://github.com/oweyahillary/swiftpos/actions/runs/40301539318', last_good_at: '2026-10-25T09:00:00Z' } };
    const r = keep(O.failAlertText(ev, NOW, LINKS));
    assertTelegramHtml(r.tgHtml);
    assert.equal(r.subject, '🔴 Backup failed · Mon 26 Oct');
    assert.match(r.tgHtml, /^🔴 <b>Backup failed — Mon 26 Oct 13:07 EAT<\/b>/);
    assert.match(r.tgHtml, /<b>Step:<\/b> checking the upload \(exit 252 — the storage command was given an option it does not know\)/);
    assert.match(r.tgHtml, /<b>Last good backup:<\/b> Sun 25 Oct \(1 day ago\)/);
    assert.deepEqual(r.buttons.map((b) => b.text), ['Open run', 'Guide', 'Open in admin']);
    assert.match(r.text, /Open run: https:\/\/github\.com\/oweyahillary\/swiftpos\/actions\/runs\/40301539318/);
    // An older result (no step field) reads the same; never recorded → "never".
    const old = O.failAlertText({ ...ev, details: { error: 'failed while dumping the database (exit 1)', last_good: 'never' } }, NOW, LINKS);
    assert.match(old.text, /Step: dumping the database \(exit 1\)/); assert.match(old.text, /Last good backup: never/);
    assert.equal(O.backupStepWords('uploading to R2 bucket zt', 254), 'uploading to the storage (R2) (exit 254 — the storage refused the request)');
  });
  await ok('a deploy check failure: headline, commit, what to do, Open run', () => {
    const r = keep(O.failAlertText({ kind: 'deploy_check', status: 'fail', title: 'Production runs an old commit', commit: 'abcdef1234567890', source: 'github',
      details: { expected: 'abcdef123456', running: '0123456789ab', what_to_do: 'Open Render and redeploy', run_url: 'https://github.com/x/y/actions/runs/1' } }, NOW, LINKS));
    assertTelegramHtml(r.tgHtml);
    assert.match(r.tgHtml, /^🔴 <b>Deploy check failed<\/b>/); assert.match(r.tgHtml, /<b>Commit:<\/b> abcdef123456/);
    assert.match(r.tgHtml, /👉 Open Render and redeploy/);
  });

  console.log('\n4. The digest\n');
  const rows = (n, sev = 'critical') => Array.from({ length: n }, (_, i) => ({ severity: sev,
    ...P.problemFacts({ ...sampleDay, client: `Client ${i + 1}` }, ago(60), NOW) }));
  await ok('Telegram: grouped by severity, 15 rows, then "+N more in the admin portal" and "Open all N in admin"', () => {
    const d = keep(P.digestTelegram([...rows(12), ...rows(8, 'warning')], { serverErrors: 3, failedSignIns: 1, writeGuard: 0, since: ago(1440) }, NOW,
      ['💳 Cloud locked (1):', '• Mama Duka — locked 2 days'], LINKS));
    assertTelegramHtml(d.tgHtml);
    assert.match(d.tgHtml, /^🗓 <b>Daily check · Mon 26 Oct<\/b>\n12 still open · 8 to look at/);
    assert.ok(d.tgHtml.indexOf('🔴 <b>Still open (12)</b>') < d.tgHtml.indexOf('🟠 <b>To look at (8)</b>'));
    assert.equal((d.tgHtml.match(/^• /gm) ?? []).length, 15 + 1, '15 problems and the billing line');
    assert.match(d.tgHtml, /<i>\+5 more in the admin portal<\/i>/);
    assert.match(d.tgHtml, /💳 <b>Cloud locked \(1\)<\/b>\n• Mama Duka — locked 2 days/);
    assert.match(d.tgHtml, /<i>Since Sun 25 Oct 13:07 EAT: 3 server errors · 1 failed sign-in · 0 POS writes the cloud would block<\/i>/);
    assert.deepEqual(d.buttons, [{ text: 'Open all 20 in admin', url: 'https://admin.zaptill.co.ke/?open=alerts' }]);
    const healthy = keep(P.digestTelegram([], null, NOW, [], LINKS));
    assert.match(healthy.tgHtml, /All clients look healthy\./);
  });
  await ok('every message stays under Telegram\'s 4096 — 300 rows with long names, the billing and the counters', () => {
    const big = rows(300).map((r, i) => ({ ...r, client: `${'Very long client name '.repeat(8)}${i}` }));
    const d = P.digestTelegram(big, { serverErrors: 1, failedSignIns: 1, writeGuard: 1, since: ago(60) }, NOW, Array.from({ length: 50 }, (_, i) => `• Client ${i} — unpaid`), LINKS);
    assertTelegramHtml(d.tgHtml); assert.ok(d.text.length < 4096, `plain ${d.text.length}`);
    const g = P.routeRun({ opened: big.map((_, i) => ({ alert: { ...sampleDay, key: `day_not_closed:${i}`, client: `${'X'.repeat(300)}${i}` }, firstSeenAt: ago(5) })), reminders: [], resolved: [] }, P.DEFAULT_ALERT_SETTINGS, NOW).telegramGroup;
    assertTelegramHtml(g.tgHtml); assert.match(g.tgHtml, /\+285 more in the admin portal/);
  });
  await ok('the digest email: Client | Problem | Since | What to do; a pill per severity; Gmail-safe; a text part; the footer links', () => {
    const m = P.digestEmail([...rows(2), ...rows(1, 'warning')], { serverErrors: 0, failedSignIns: 0, writeGuard: 0, since: ago(1440) }, NOW, LINKS);
    allText.push(m.subject, m.html, m.text);
    assert.equal(m.subject, '🗓 Daily check · Mon 26 Oct — 2 open problems, 1 to look at');
    for (const h of ['Client', 'Problem', 'Since', 'What to do']) assert.ok(m.html.includes(`>${h}</th>`), h);
    assert.ok(m.html.includes('>Day not closed (T1)<') && m.html.includes('>16 days<') && m.html.includes('>Close it at the POS or by Remote Day Close<'));
    assert.match(m.html, />Critical · 2</); assert.match(m.html, />Warning · 1</);
    assert.equal((m.html.match(/<thead>/g) ?? []).length, 2, 'one table per severity');
    assert.doesNotMatch(m.html, /<style|<link|class=|<script/i, 'inline styles only');
    assert.match(m.html, /href="https:\/\/admin\.zaptill\.co\.ke\/\?open=alerts"[^>]*>Admin portal › Alerts</);
    assert.match(m.html, />Email settings</);
    assert.match(m.text, /Client 1 · T1 — Day not closed · 16 days\n {4}→ Close it at the POS or by Remote Day Close/);
    assert.match(m.text, /Admin portal › Alerts: https:\/\/admin\.zaptill\.co\.ke\/\?open=alerts/);
    assert.equal(P.digestEmail([], null, NOW), null);
  });
  await ok('the billing summary email: the same four columns, a recommendation per row', () => {
    const m = P.billingSummaryEmail([{ client: 'Pollo Grill', invoice: 'INV-0042', amount: 3000, currency: 'KES', due: ago(5 * 1440), status: 'Unpaid 5 days — locks in 2 days' }],
      [{ client: 'Mama Duka', invoice: null, amount: null, currency: 'KES', due: null, status: 'Locked (unpaid 7 days)' }], NOW, LINKS);
    allText.push(m.subject, m.html, m.text);
    assert.equal(m.subject, '💳 Billing summary · Mon 26 Oct — 1 notice, 1 still unpaid or locked');
    for (const h of ['Client', 'Problem', 'Since', 'What to do']) assert.ok(m.html.includes(`>${h}</th>`), h);
    assert.ok(m.html.includes('>Unpaid 5 days — locks in 2 days · INV-0042 · KES 3,000<'));
    assert.ok(m.html.includes('>5 days (due Wed 21 Oct)<'));
    assert.ok(m.html.includes('>Call the client — the cloud locks soon<') && m.html.includes('>Record the payment to unlock their cloud<'));
  });

  console.log('\n5. Every rule has a short name and a "What to do"\n');
  await ok('RULE_WORDS: a label and a todo (at most 60 characters) for every rule; every rule in watchdogRules.ts uses its entry', () => {
    const ids = Object.keys(R.RULE_WORDS);
    assert.ok(ids.length >= 17);
    for (const [id, w] of Object.entries(R.RULE_WORDS)) {
      assert.ok(w.label && w.label.length <= 30, `${id} label`);
      assert.ok(w.todo && w.todo.length <= 60, `${id} todo "${w.todo}" (${w.todo?.length})`);
    }
    const src = read('apps/server/src/lib/watchdogRules.ts');
    const keys = [...src.matchAll(/^\s+key: [`']([a-z_]+)[:`']/gm)].map((m) => m[1]);
    assert.ok(keys.length >= 15);
    for (const k of keys) {
      assert.ok(ids.includes(k), `${k} has words`);
      assert.match(src, new RegExp(`key: [\`']${k}[:\`'][^\\n]*\\n\\s+\\.\\.\\.ruleWords\\('${k}'\\),`), `${k} uses them`);
    }
    assert.equal((src.match(/key, severity: '(critical|warning)'[^\n]*\n\s+\.\.\.ruleWords\('till_(not_syncing|quiet)'\),/g) ?? []).length, 3);
    for (const c of P.ALERT_CATEGORIES) assert.ok(P.CATEGORY_TODO[c.id] && P.CATEGORY_TODO[c.id].length <= 60, `category ${c.id}`);
    for (const s of ['Invoice issued', 'Invoice issued — client email NOT delivered', 'Unpaid 5 days', 'Locked (unpaid 7 days)', 'Cloud trial ended', 'Not interested']) {
      assert.ok(P.billingTodo(s).length <= 60, s);
    }
  });
  await ok('the rules\' alerts carry them: a day not closed, a POS signed out, the database', () => {
    assert.deepEqual([sampleDay.label, sampleDay.todo], ['Day not closed', 'Close it at the POS or by Remote Day Close']);
    assert.deepEqual([signedOut.label, signedOut.todo], ["POS can't sign in", 'Rejoin the POS from its Tech page (enrolment code)']);
    assert.equal(dbDown.label, 'Database unreachable');
    const f = P.problemFacts({ title: 'Sample Shop: day Fri 9 Oct not closed on T1', business_id: BIZ, key: 'day_not_closed:d1' }, ago(60), NOW);
    assert.deepEqual([f.label, f.todo], ['Day not closed', 'Close it at the POS or by Remote Day Close'], 'a stored row: by its key');
  });

  console.log('\n6. Telegram refuses the HTML → plain text\n');
  {
    const realFetch = globalThis.fetch;
    const calls = [];
    let reject = true;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body); calls.push(body);
      if (reject && body.parse_mode === 'HTML') return new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities: unexpected end tag" }), { status: 400 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    process.env.TELEGRAM_BOT_TOKEN = 'tg-test'; process.env.TELEGRAM_CHAT_ID = '42';
    try {
      await ok('a 400 "can\'t parse entities" → sent again, once, as plain text with the links written out; the alert is sent', async () => {
        const m = P.routeRun({ opened: [], reminders: [{ alert: dbDown, firstSeenAt: ago(60) }], resolved: [] }, P.DEFAULT_ALERT_SETTINGS, NOW).instantEach[0];
        const err = await N.sendTelegram(m.text, { html: m.tgHtml, buttons: m.buttons });
        assert.equal(err, null, 'sent');
        assert.equal(calls.length, 2);
        assert.equal(calls[0].parse_mode, 'HTML'); assert.ok(calls[0].reply_markup.inline_keyboard[0][0].url.startsWith('https://'));
        assert.equal(calls[1].parse_mode, undefined); assert.equal(calls[1].reply_markup, undefined);
        assert.match(calls[1].text, /Open in admin: https:\/\/admin\.zaptill\.co\.ke\/\?open=alerts/);
        assert.doesNotMatch(calls[1].text, /<b>/);
      });
      await ok('accepted at once → one call; a plain message is never retried', async () => {
        calls.length = 0; reject = false;
        assert.equal(await N.sendTelegram('x', { html: '<b>x</b>' }), null); assert.equal(calls.length, 1);
        calls.length = 0; reject = true;
        assert.equal(await N.sendTelegram('plain only'), null); assert.equal(calls.length, 1); assert.equal(calls[0].parse_mode, undefined);
      });
      await ok('notifyAdmin passes the HTML and the buttons; the links come from ADMIN_PORTAL_URL', async () => {
        assert.deepEqual(N.alertLinks({ ADMIN_PORTAL_URL: 'https://admin.example.test/' }).admin, 'https://admin.example.test');
        assert.deepEqual(N.alertLinks({ ADMIN_PORTAL_URL: 'javascript:x' }).admin, 'https://admin.zaptill.co.ke');
        calls.length = 0; reject = false;
        await N.notifyAdmin('s', 'plain', { email: false, tgHtml: '<b>rich</b>', buttons: [{ text: 'Go', url: 'https://go.test' }] });
        assert.equal(calls[0].text, '<b>rich</b>'); assert.deepEqual(calls[0].reply_markup, { inline_keyboard: [[{ text: 'Go', url: 'https://go.test' }]] });
      });
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_ID;
    }
  }

  console.log('\n7. The GitHub side (notify-admin.sh, report.sh, alert-format.sh)\n');
  const BASH = process.env.BASH_FOR_TESTS || (process.platform === 'win32'
    ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].find((p) => fs.existsSync(p)) ?? 'bash'
    : 'bash');
  const posix = (p) => p.replace(/\\/g, '/');
  const have = (cmd) => spawnSync(BASH, ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0;
  for (const f of ['scripts/ops/notify-admin.sh', 'scripts/ops/alert-format.sh', 'scripts/backup/report.sh']) {
    await ok(`${f}: bash -n, no CRLF`, () => {
      const r = spawnSync(BASH, ['-n', posix(path.join(ROOT, f))], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(read(f), /\r/);
    });
  }
  if (!['jq', 'curl', 'sed'].every(have)) { skipped++; console.log('SKIP  the runs (bash with jq, curl and sed not found)'); } else {
    const hits = [];
    let tgReject = false;
    const srv = http.createServer((req, res) => {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const form = /x-www-form-urlencoded/.test(req.headers['content-type'] ?? '');
        const b = !body ? null : form ? Object.fromEntries(new URLSearchParams(body)) : JSON.parse(body);
        hits.push({ url: req.url, body: b });
        if (req.url.startsWith('/tg') && tgReject && b?.parse_mode === 'HTML') {
          res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" })); return;
        }
        res.writeHead(req.url === '/api/ops/events' ? 503 : 200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const LOCAL = `http://127.0.0.1:${srv.address().port}`;
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a592-'));
    const ENV = { NOTIFY_RESEND_URL: `${LOCAL}/resend`, NOTIFY_TELEGRAM_URL: `${LOCAL}/tg`, ADMIN_ALERT_EMAIL: 'boss@zaptill.test', RESEND_API_KEY: 're_test',
      TELEGRAM_BOT_TOKEN: 'tg-token', TELEGRAM_CHAT_ID: '4242', SENDGRID_API_KEY: '', RUNNER_TEMP: posix(TMP) };
    const sh = (script, args, env = {}) => new Promise((resolve) => {
      const p = spawn(BASH, [posix(path.join(ROOT, script)), ...args], { cwd: ROOT, env: { ...process.env, ...ENV, ...env } });
      let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
      p.on('close', (code) => resolve({ code, out }));
    });
    const tgHits = () => hits.filter((h) => h.url === '/tg/bottg-token/sendMessage');
    try {
      await ok('notify-admin.sh: a bold headline, escaped facts, 👉, URL buttons as a JSON reply_markup; the email in the layout with a text part', async () => {
        hits.length = 0;
        const r = await sh('scripts/ops/notify-admin.sh', ['--tone', 'critical', '--subject', '🔴 Backup failed · Mon 26 Oct',
          '--fact', 'Client|A&B <Shop>', '--fact', 'Step|checking the upload', '--action', 'Fix it & run it again',
          '--button', 'Open run|https://github.com/x/y/actions/runs/1', '--button', 'Bad|ftp://nope', '--button', 'Guide|https://github.com/x/y/blob/main/docs/BACKUPS.md',
          'Backup failed — Mon 26 Oct 13:07 EAT'], {});
        assert.equal(r.code, 0, r.out);
        const t = tgHits(); assert.equal(t.length, 1);
        assert.equal(t[0].body.parse_mode, 'HTML'); assert.equal(t[0].body.chat_id, '4242');
        assertTelegramHtml(t[0].body.text);
        assert.equal(t[0].body.text, '🔴 <b>Backup failed — Mon 26 Oct 13:07 EAT</b>\n\n<b>Client:</b> A&amp;B &lt;Shop&gt;\n<b>Step:</b> checking the upload\n\n👉 Fix it &amp; run it again');
        assert.deepEqual(JSON.parse(t[0].body.reply_markup), { inline_keyboard: [[{ text: 'Open run', url: 'https://github.com/x/y/actions/runs/1' },
          { text: 'Guide', url: 'https://github.com/x/y/blob/main/docs/BACKUPS.md' }]] }, 'the bad URL dropped');
        const m = hits.find((h) => h.url === '/resend').body;
        assert.equal(m.subject, '🔴 Backup failed · Mon 26 Oct');
        assert.ok(m.html.includes('A&amp;B &lt;Shop&gt;') && !m.html.includes('<Shop>'));
        assert.match(m.html, /<a href="https:\/\/github\.com\/x\/y\/actions\/runs\/1"[^>]*>Open run<\/a>/);
        assert.doesNotMatch(m.html, /<style|<link|class=/);
        assert.match(m.text, /Client: A&B <Shop>/); assert.match(m.text, /Open run: https:\/\/github\.com\/x\/y\/actions\/runs\/1/);
      });
      await ok('notify-admin.sh: Telegram answers 400 "can\'t parse entities" → once more as plain text, the links written out; exit 0', async () => {
        hits.length = 0; tgReject = true;
        const r = await sh('scripts/ops/notify-admin.sh', ['--tone', 'warning', '--button', 'Open run|https://github.com/x/y/actions/runs/2', 'Something <odd>'], { ADMIN_ALERT_EMAIL: '' });
        tgReject = false;
        assert.equal(r.code, 0, r.out);
        const t = tgHits(); assert.equal(t.length, 2, r.out);
        assert.equal(t[0].body.parse_mode, 'HTML');
        assert.equal(t[1].body.parse_mode, undefined); assert.equal(t[1].body.reply_markup, undefined);
        assert.equal(t[1].body.text, '🟠 Something <odd>\n\nOpen run: https://github.com/x/y/actions/runs/2');
        assert.match(r.out, /sending it as plain text/);
      });
      await ok('report.sh: a failed backup the server did not take → "🔴 Backup failed — … EAT", Step in plain words, Last good backup, Open run · Guide · Open in admin', async () => {
        hits.length = 0;
        const r2 = path.join(TMP, 'r2'); fs.mkdirSync(path.join(r2, 'status'), { recursive: true });
        fs.writeFileSync(path.join(r2, 'status/latest.json'), JSON.stringify({ status: 'ok', at: new Date(Date.now() - 26 * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z') }));
        const res = path.join(TMP, 'result.json');
        fs.writeFileSync(res, JSON.stringify({ status: 'fail', error: 'failed while checking the upload (exit 252)', step: 'checking the upload', exit: 252, seconds: 40 }));
        const r = await sh('scripts/backup/report.sh', [], { BACKUP_RESULT: posix(res), BACKUP_LOCAL_DIR: posix(r2), PROD_URL: LOCAL, OPS_INGEST_TOKEN: 'o'.repeat(40),
          RUN_URL: 'https://github.com/oweyahillary/swiftpos/actions/runs/40301539318', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'oweyahillary/swiftpos' });
        assert.equal(r.code, 1, r.out);
        const ev = hits.find((h) => h.url === '/api/ops/events').body;
        assert.equal(ev.details.last_good_at.slice(0, 4), String(new Date().getUTCFullYear()), 'the last good backup goes to the server too');
        const t = tgHits(); assert.equal(t.length, 1, r.out);
        const x = t[0].body.text;
        assertTelegramHtml(x);
        assert.match(x, /^🔴 <b>Backup failed — \w{3} \d{1,2} \w{3} \d{2}:\d{2} EAT<\/b>/);
        assert.match(x, /<b>Step:<\/b> checking the upload \(exit 252 — the storage command was given an option it does not know\)/);
        assert.match(x, /<b>Last good backup:<\/b> \w{3} \d{1,2} \w{3} \(1 day ago\)/);
        assert.match(x, /👉 The earlier backups are untouched/);
        assert.doesNotMatch(x, /FAILED|docs\/BACKUPS\.md$/m);
        assert.deepEqual(JSON.parse(t[0].body.reply_markup).inline_keyboard.flat().map((b) => b.text), ['Open run', 'Guide', 'Open in admin']);
        assert.equal(JSON.parse(t[0].body.reply_markup).inline_keyboard[0][1].url, 'https://github.com/oweyahillary/swiftpos/blob/main/docs/BACKUPS.md');
        assert.match(hits.find((h) => h.url === '/resend').body.subject, /^🔴 Backup failed · \w{3} \d{1,2} \w{3}$/);
        // No latest.json at all: "never".
        fs.rmSync(path.join(r2, 'status'), { recursive: true }); hits.length = 0;
        await sh('scripts/backup/report.sh', [], { BACKUP_RESULT: posix(res), BACKUP_LOCAL_DIR: posix(r2), PROD_URL: LOCAL, OPS_INGEST_TOKEN: '' });
        assert.match(tgHits()[0].body.text, /<b>Last good backup:<\/b> never/);
      });
      await ok('alert-format.sh says what the server says: human_minutes = shortDuration, backup_step_words = backupStepWords, eat_stamp', () => {
        const fmt = posix(path.join(ROOT, 'scripts/ops/alert-format.sh'));
        const run = (cmd) => spawnSync(BASH, ['-c', `. "${fmt}"; ${cmd}`], { encoding: 'utf8' }).stdout;
        for (const m of [0, 1, 45, 59, 60, 195, 23 * 60 + 59, 24 * 60, 47 * 60, 48 * 60, 397 * 60 + 50]) assert.equal(run(`human_minutes ${m}`), F.shortDuration(m), `${m} min`);
        for (const [s, c] of [['checking the upload', 252], ['uploading to R2 bucket zt', 254], ['dumping the database', 1], ['checking the dump (pg_restore --list)', 1],
          ['checking the settings', 1], ['pruning old backups', 255], ['dumping the database', 124], ['writing the status', '']]) {
          assert.equal(run(`backup_step_words "${s}" "${c}"`), O.backupStepWords(s, c === '' ? null : c), `${s} ${c}`);
        }
        assert.equal(run('eat_stamp 1792922820'), F.eatStamp(1792922820 * 1000));
        assert.equal(run("html_escape 'A&B <Shop> \"x\"'"), F.escapeHtml('A&B <Shop> "x"'));
      });
      await ok('uptime-check.yml: the down and back messages in the same layout (tone, facts, buttons, human minutes)', () => {
        const up = read('.github/workflows/uptime-check.yml');
        assert.match(up, /\. scripts\/ops\/alert-format\.sh/);
        assert.match(up, /notify-admin\.sh --tone critical --subject "🔴 Production down · \$\(eat_day\)"/);
        assert.match(up, /--button "Open run\|\$RUN_URL"/);
        assert.match(up, /notify-admin\.sh --tone resolved --subject "✅ Production back · down about \$\(human_minutes "\$MIN"\)"/);
        assert.doesNotMatch(up, /PRODUCTION DOWN|ZapTill production is back/);
      });
    } finally {
      srv.close();
      fs.rmSync(TMP, { recursive: true, force: true });
    }
  }

  console.log('\n8. Words\n');
  await ok('"POS", never "till", in every message rendered here', () => {
    assert.ok(allText.length > 20);
    for (const t of allText) assert.doesNotMatch(String(t), /\btills?\b/i, String(t).slice(0, 200));
  });
} catch (e) {
  fail++; console.log('FAIL  (setup)', e);
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(fail ? 1 : 0);
