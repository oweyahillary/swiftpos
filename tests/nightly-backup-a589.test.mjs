/**
 * nightly-backup-a589.test.mjs — A589: the nightly backup (00:00 Nairobi), its restore, the alert when it fails, and the
 * outside "production down" check.
 *
 * Owner, 2026-10-25: "how can I be doing backups to protect my client data each night at 12am" · "[emails] maybe when the
 * server is down or overloaded".
 *
 *   node --no-warnings tests/nightly-backup-a589.test.mjs
 *
 * RUNS the real scripts with bash, gpg, jq and sha256sum; psql / pg_dump / pg_restore are small stand-ins (no database
 * here — the real round trip against PostgreSQL was run by hand, A589's report and docs/BACKUPS.md); the mail provider,
 * Telegram and the server's ops endpoint are a local HTTP server:
 *   1 the workflows: nightly-backup.yml at 21:00 UTC (00:00 Nairobi) + manual, the "backup" environment, the report step
 *     always, NEVER upload-artifact / cache of the dump, no secret echoed; uptime-check.yml every 10 min, two failed
 *     checks a minute apart, one issue as the state, told on open and close only; actionlint when it is installed
 *   2 nightly-backup.sh: set -Eeuo pipefail, no trace, umask 077; dump → pg_restore --list → encrypt → (plain dump gone)
 *     → upload, in that order; the passphrase on a file descriptor; the stored file decrypts to the dump; 30 daily and 12
 *     monthly kept; a status object and a history line; a failure: a "fail" result, nothing uploaded, nothing pruned
 *   3 report.sh: the result to the server (kind 'backup'); a failure the server did not take → the admin told from here;
 *     red on a failure
 *   4 restore-backup.sh: a production-looking target refused without --i-know; a wrong passphrase refused; --list-only
 *   5 notify-admin.sh: Resend (else SendGrid) and Telegram, the key in the Authorization header (never printed);
 *     nothing set → exit 3
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted — listed in the A589 report):
 *   - nightly-backup.sh uploading before the encryption           → 2 "encrypted before it leaves" fails
 *   - prune keeping 31 daily                                      → 2 "30 daily, 12 monthly" fails
 *   - the pg_restore --list check removed                         → 2 "a dump pg_restore cannot read" fails
 *   - report.sh notifying only when the post succeeded             → 3 "the server did not take it" fails
 *   - the production guard removed from restore-backup.sh          → 4 "refused" fails
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0, skipped = 0;
const ok = async (n, f) => { try { await f(); pass++; console.log(`PASS  ${n}`); } catch (e) { fail++; console.log(`FAIL  ${n}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 5).join('\n      ')}`); } };

// bash: Git Bash on Windows (never WSL's), the system one elsewhere.
const BASH = process.env.BASH_FOR_TESTS || (process.platform === 'win32'
  ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].find((p) => fs.existsSync(p)) ?? 'bash'
  : 'bash');
const posix = (p) => p.replace(/\\/g, '/');
const have = (cmd) => spawnSync(BASH, ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0;
const TOOLS = ['gpg', 'jq', 'sha256sum', 'curl'].every(have);

const yml = read('.github/workflows/nightly-backup.yml');
const up = read('.github/workflows/uptime-check.yml');
const sh = read('scripts/backup/nightly-backup.sh');
const rep = read('scripts/backup/report.sh');
const rst = read('scripts/restore-backup.sh');
const ntf = read('scripts/ops/notify-admin.sh');

// ── the stand-ins for the PostgreSQL tools, and a sandbox per run ──────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a589-backup-'));
const BIN = path.join(TMP, 'bin');
fs.mkdirSync(BIN);
const stub = (name, body) => { const f = path.join(BIN, name); fs.writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`); fs.chmodSync(f, 0o755); };
stub('psql', `
case "$*" in
  *server_version_num*) echo "\${STUB_SERVER_NUM:-170002}" ;;
  *information_schema.tables*) echo 0 ;;
  *businesses*) echo "businesses: 2" ;;
  *) cat >/dev/null 2>&1 || true ;;
esac`);
stub('pg_dump', `
if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) \${STUB_CLIENT_VER:-17.2}"; exit 0; fi
[ -n "\${STUB_DUMP_FAIL:-}" ] && { echo "pg_dump: error: connection refused" >&2; exit 1; }
for a in "$@"; do case "$a" in --file=*) out="\${a#--file=}" ;; esac; done
printf 'PGDMP stand-in %s\\n' "$*" | sed 's#postgresql://[^ ]*#URL#' > "$out"
head -c 20000 /dev/urandom | base64 >> "$out"
echo "$*" | sed 's#postgresql://[^ ]*#URL#' > "\${STUB_LOG:-/dev/null}"`);
stub('pg_restore', `
if [ "$1" = "--version" ]; then echo "pg_restore (PostgreSQL) 17.2"; exit 0; fi
if [ "$1" = "--list" ]; then
  echo ";"; echo "; Archive created at 2026-10-26 00:00:05 EAT"
  echo "215; 1259 16400 TABLE public businesses postgres"
  [ -z "\${STUB_NO_BUSINESSES:-}" ] && echo "4012; 0 16400 TABLE DATA public businesses postgres"
  echo "4013; 0 16410 TABLE DATA public orders postgres"
  echo "4014; 0 16420 TABLE DATA auth users supabase_auth_admin"
  exit 0
fi
echo "restore $*" >> "\${STUB_LOG:-/dev/null}"`);

const PASS_PHRASE = 'a589-test-passphrase-0123456789';
const run = (script, args = [], env = {}) => {
  const r = spawnSync(BASH, ['-c', 'export PATH="$(cygpath -u "$STUB_BIN" 2>/dev/null || echo "$STUB_BIN"):$PATH"; exec bash "$@"', 'x', posix(path.join(ROOT, script)), ...args], {
    encoding: 'utf8', cwd: ROOT, env: { ...process.env, STUB_BIN: posix(BIN), ...env }, timeout: 120_000,
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
};
const runAsync = (script, args = [], env = {}) => new Promise((resolve) => {
  const p = spawn(BASH, ['-c', 'export PATH="$(cygpath -u "$STUB_BIN" 2>/dev/null || echo "$STUB_BIN"):$PATH"; exec bash "$@"', 'x', posix(path.join(ROOT, script)), ...args], {
    cwd: ROOT, env: { ...process.env, STUB_BIN: posix(BIN), ...env } });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => resolve({ code, out }));
});
const sandbox = (name) => { const d = path.join(TMP, name); fs.mkdirSync(path.join(d, 'run'), { recursive: true }); fs.mkdirSync(path.join(d, 'r2'), { recursive: true }); return d; };
const eatDate = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

// ── a local mail provider / Telegram / ops endpoint ─────────────────────────────────────────────────────────────────
const hits = [];
let opsStatus = 201;
const srv = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    hits.push({ url: req.url, auth: req.headers.authorization ?? null, body: body ? JSON.parse(body) : null });
    if (req.url === '/api/ops/events') { res.writeHead(opsStatus, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'e1' })); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const LOCAL = `http://127.0.0.1:${srv.address().port}`;
const NOTIFY_ENV = { NOTIFY_RESEND_URL: `${LOCAL}/resend`, NOTIFY_SENDGRID_URL: `${LOCAL}/sendgrid`, NOTIFY_TELEGRAM_URL: `${LOCAL}/tg`,
  ADMIN_ALERT_EMAIL: 'boss@zaptill.test', RESEND_API_KEY: 're_secret_test_key_123', TELEGRAM_BOT_TOKEN: 'tg-secret-token', TELEGRAM_CHAT_ID: '4242,99' };

try {
  console.log('\n1. The workflows\n');
  await ok('nightly-backup.yml: weekly, Saturday 21:00 UTC = Sunday 00:00 Nairobi (A591), only once switched on, and by hand; the "backup" environment; read-only token; one at a time', () => {
    assert.match(yml, /- cron: '0 21 \* \* 6'/);
    assert.doesNotMatch(yml, /- cron: '0 21 \* \* \*'/, 'never nightly: a full dump is a whole database of egress');
    assert.match(yml, /if: github\.event_name == 'workflow_dispatch' \|\| vars\.BACKUP_SCHEDULE_ENABLED == 'true'/);
    assert.match(yml, /workflow_dispatch: \{\}/);
    assert.match(yml, /environment: backup/);
    assert.match(yml, /permissions:\s*\n\s*contents: read\s*\n/);
    assert.doesNotMatch(yml, /contents: write|id-token: write/);
    assert.match(yml, /concurrency:\s*\n\s*group: nightly-backup\s*\n\s*cancel-in-progress: false/);
  });
  await ok('the steps: install the PostgreSQL client → the backup script → the report, always (a failure is never silent)', () => {
    const i = yml.indexOf('postgresql-client-${PG_MAJOR}'), b = yml.indexOf('run: bash scripts/backup/nightly-backup.sh'), r = yml.indexOf('run: bash scripts/backup/report.sh');
    assert.ok(i > 0 && b > i && r > b, 'in order');
    assert.match(yml.slice(b, r), /if: always\(\)/);
    assert.match(yml, /apt\.postgresql\.org\.sh/);
    assert.match(yml, /BACKUP_PG_MAJOR \|\| '17'/);
  });
  await ok('never a GitHub artifact or cache of the dump (the repository is public); no secret echoed', () => {
    for (const f of [yml, up]) {
      assert.doesNotMatch(f, /upload-artifact|actions\/cache/);
      assert.doesNotMatch(f, /echo[^\n]*\$\{\{\s*secrets\./, 'a secret echoed');
    }
    for (const s of ['BACKUP_DATABASE_URL', 'BACKUP_PASSPHRASE', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'OPS_INGEST_TOKEN', 'ADMIN_ALERT_EMAIL', 'RESEND_API_KEY']) {
      assert.match(yml, new RegExp(`${s}: \\$\\{\\{ secrets\\.${s} \\}\\}`), s);
    }
    assert.doesNotMatch(yml, /secrets\.DATABASE_URL/, 'not the migration job\'s owner connection');
    for (const f of [sh, rep, rst, ntf]) {
      assert.doesNotMatch(f, /echo[^\n]*\$\{?(BACKUP_PASSPHRASE|BACKUP_DATABASE_URL|R2_SECRET_ACCESS_KEY|RESEND_API_KEY|SENDGRID_API_KEY|TELEGRAM_BOT_TOKEN|OPS_INGEST_TOKEN)\}?/);
      assert.doesNotMatch(f, /--passphrase[ =]["']?\$/, 'the passphrase never on a command line');
      assert.doesNotMatch(f, /^\s*set -x/m);
    }
  });
  await ok('uptime-check.yml: every 10 min; two failed checks a minute apart; one "production-down" issue as the state; told on open and close only', () => {
    assert.match(up, /- cron: '\*\/10 \* \* \* \*'/);
    assert.match(up, /permissions:\s*\n\s*contents: read\s*\n\s*issues: write/);
    assert.match(up, /FIRST=\$\(probe\)[\s\S]*sleep 60[\s\S]*DOWN=\$\(probe\)/);
    assert.match(up, /LABEL=production-down/);
    assert.match(up, /if \[ -n "\$OPEN" \]; then echo "Already reported[^\n]*exit 0; fi/);
    assert.equal((up.match(/bash scripts\/ops\/notify-admin\.sh/g) ?? []).length, 2, 'on open and on close');
    assert.match(up, /gh issue create --label "\$LABEL"/); assert.match(up, /gh issue close "\$NUM"/);
    assert.match(up, /kind:"uptime"/);
    assert.match(up, /"\$API\/health"/); assert.match(up, /api\.zaptill\.co\.ke/); assert.match(up, /app\.zaptill\.co\.ke/);
  });
  await ok('the YAML: no tabs, even indentation; actionlint when installed', () => {
    for (const [n, f] of [['nightly-backup.yml', yml], ['uptime-check.yml', up]]) {
      assert.doesNotMatch(f, /\t/, `${n}: a tab`);
      for (const [i, l] of f.split('\n').entries()) if (l.trim() && !l.trim().startsWith('#')) assert.equal((l.match(/^ */)[0].length) % 2, 0, `${n}:${i + 1} odd indentation`);
      assert.doesNotMatch(f, /\r/, `${n}: CRLF`);
    }
    if (have('actionlint')) {
      const r = spawnSync(BASH, ['-c', 'actionlint .github/workflows/nightly-backup.yml .github/workflows/uptime-check.yml'], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout + r.stderr);
    } else console.log('      (actionlint not installed — the structural checks only)');
  });

  console.log('\n2. nightly-backup.sh\n');
  await ok('the source: set -Eeuo pipefail, no trace, umask 077; dump → list → encrypt → plain dump gone → upload, in that order', () => {
    assert.match(sh, /^set -Eeuo pipefail/m); assert.match(sh, /^set \+x/m); assert.match(sh, /^umask 077/m);
    const at = (re) => { const m = re.exec(sh); assert.ok(m, String(re)); return m.index; };
    const dump = at(/pg_dump --dbname="\$BACKUP_DATABASE_URL" --format=custom/);
    const list = at(/pg_restore --list "\$DUMP"/);
    const enc = at(/--symmetric --cipher-algo AES256/);
    const gone = at(/rm -f "\$DUMP"/);
    const upload = at(/put_object "\$ENC" "\$OBJECT"/);
    const prune = at(/prune daily "\$KEEP_DAILY"/);
    assert.ok(dump < list && list < enc && enc < gone && gone < upload && upload < prune, [dump, list, enc, gone, upload, prune].join(' < '));
    assert.match(sh, /--passphrase-fd 3[^\n]*\n?[^\n]*3<<<"\$BACKUP_PASSPHRASE"/);
    assert.match(sh, /KEEP_DAILY="\$\{BACKUP_KEEP_DAILY:-30\}"/); assert.match(sh, /KEEP_MONTHLY="\$\{BACKUP_KEEP_MONTHLY:-12\}"/);
    assert.match(sh, /trap fail ERR/);
  });
  if (!TOOLS) { skipped++; console.log('SKIP  the runs (bash with gpg, jq, sha256sum and curl not found)'); } else {
    const box = sandbox('ok');
    const r2 = path.join(box, 'r2');
    // 33 old daily folders and 14 monthly ones: after the run 30 + today's … no — 30 in all, and 12.
    for (let d = 1; d <= 33; d++) fs.mkdirSync(path.join(r2, 'daily', new Date(Date.UTC(2026, 7, d)).toISOString().slice(0, 10)), { recursive: true });
    for (let m = 1; m <= 14; m++) fs.mkdirSync(path.join(r2, 'monthly', `${2025 + Math.floor((m + 5) / 12)}-${String(((m + 5) % 12) + 1).padStart(2, '0')}`), { recursive: true });
    const env = { BACKUP_LOCAL_DIR: posix(r2), RUNNER_TEMP: posix(path.join(box, 'run')), BACKUP_DATABASE_URL: 'postgresql://zaptill_backup.ref:SuperSecretDbPw@db.example:5432/postgres',
      BACKUP_PASSPHRASE: PASS_PHRASE, STUB_LOG: posix(path.join(box, 'pg.log')) };
    const r = run('scripts/backup/nightly-backup.sh', [], env);
    const today = path.join(r2, 'daily', eatDate());
    await ok('a good run: exit 0, the encrypted file and its manifest under daily/<Nairobi date>/, the status object and history', () => {
      assert.equal(r.code, 0, r.out);
      const files = fs.readdirSync(today);
      const enc = files.find((f) => /^zaptill-\d{4}-\d{2}-\d{2}T\d{4}EAT\.dump\.gpg$/.test(f));
      assert.ok(enc, files.join(','));
      assert.ok(files.includes(`${enc}.json`));
      const man = JSON.parse(fs.readFileSync(path.join(today, `${enc}.json`), 'utf8'));
      assert.equal(man.tables, 3); assert.equal(man.cipher, 'gpg symmetric AES256');
      const latest = JSON.parse(fs.readFileSync(path.join(r2, 'status/latest.json'), 'utf8'));
      assert.equal(latest.status, 'ok'); assert.equal(latest.object, `daily/${eatDate()}/${enc}`);
      assert.equal(fs.readFileSync(path.join(r2, 'status/history.jsonl'), 'utf8').trim().split('\n').length, 1);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(box, 'run/backup-result.json'), 'utf8')).status, 'ok');
      assert.match(fs.readFileSync(path.join(box, 'pg.log'), 'utf8'), /--format=custom --compress=6 --no-password --schema=public --schema=auth --schema=storage/);
    });
    await ok('encrypted before it leaves: no plain dump stored; it decrypts (passphrase) to a dump; a wrong passphrase does not', () => {
      const enc = fs.readdirSync(today).find((f) => f.endsWith('.dump.gpg'));
      const raw = fs.readFileSync(path.join(today, enc));
      assert.ok(!raw.includes(Buffer.from('PGDMP')), 'the stored bytes are not the dump');
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
      for (const f of walk(r2)) assert.ok(!fs.readFileSync(f).includes(Buffer.from('PGDMP')), `plain data in ${f}`);
      const dec = spawnSync(BASH, ['-c', `gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt "${posix(path.join(today, enc))}" 3<<<"$P" | head -c 5`], { encoding: 'utf8', env: { ...process.env, P: PASS_PHRASE } });
      assert.equal(dec.stdout, 'PGDMP');
      const bad = spawnSync(BASH, ['-c', `gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt "${posix(path.join(today, enc))}" 3<<<"wrong" >/dev/null`], { encoding: 'utf8' });
      assert.notEqual(bad.status, 0);
    });
    await ok('30 daily and 12 monthly kept — the oldest pruned, today\'s kept', () => {
      const daily = fs.readdirSync(path.join(r2, 'daily')).sort();
      assert.equal(daily.length, 30); assert.ok(daily.includes(eatDate()));
      assert.ok(!daily.includes('2026-08-01') && !daily.includes('2026-08-04'), 'the four oldest gone');
      assert.equal(fs.readdirSync(path.join(r2, 'monthly')).length, 12);
    });
    await ok('no secret in what the run prints', () => {
      for (const s of [PASS_PHRASE, 'SuperSecretDbPw']) assert.ok(!r.out.includes(s), s);
      assert.match(r.out, /Backup ok: daily\//);
    });
    await ok('a failed dump: a "fail" result naming the step, nothing uploaded for today, nothing pruned', () => {
      const b2 = sandbox('fail');
      const r2b = path.join(b2, 'r2');
      for (let d = 1; d <= 33; d++) fs.mkdirSync(path.join(r2b, 'daily', new Date(Date.UTC(2026, 7, d)).toISOString().slice(0, 10)), { recursive: true });
      const f = run('scripts/backup/nightly-backup.sh', [], { ...env, BACKUP_LOCAL_DIR: posix(r2b), RUNNER_TEMP: posix(path.join(b2, 'run')), STUB_DUMP_FAIL: '1' });
      assert.notEqual(f.code, 0);
      const res = JSON.parse(fs.readFileSync(path.join(b2, 'run/backup-result.json'), 'utf8'));
      assert.equal(res.status, 'fail'); assert.match(res.error, /failed while dumping the database/);
      assert.equal(fs.readdirSync(path.join(r2b, 'daily')).length, 33, 'nothing pruned after a failure');
      assert.ok(!fs.existsSync(path.join(r2b, 'status')), 'no status written as if it worked');
    });
    await ok('a dump pg_restore cannot read (no public.businesses data) fails; so does an old pg_dump for a newer server', () => {
      const b3 = sandbox('bad');
      const f = run('scripts/backup/nightly-backup.sh', [], { ...env, BACKUP_LOCAL_DIR: posix(path.join(b3, 'r2')), RUNNER_TEMP: posix(path.join(b3, 'run')), STUB_NO_BUSINESSES: '1' });
      assert.notEqual(f.code, 0); assert.match(JSON.parse(fs.readFileSync(path.join(b3, 'run/backup-result.json'), 'utf8')).error, /checking the dump/);
      assert.ok(!fs.existsSync(path.join(b3, 'r2', 'daily')), 'nothing uploaded');
      const v = run('scripts/backup/nightly-backup.sh', [], { ...env, BACKUP_LOCAL_DIR: posix(path.join(b3, 'r2')), RUNNER_TEMP: posix(path.join(b3, 'run')), STUB_SERVER_NUM: '180001' });
      assert.notEqual(v.code, 0); assert.match(v.out, /BACKUP_PG_MAJOR=18/);
    });
    await ok('missing settings are named (never their values); a short passphrase refused', () => {
      const cfg = sandbox('cfg');   // its own result file — the good run's is read below
      const m = run('scripts/backup/nightly-backup.sh', [], { RUNNER_TEMP: posix(path.join(cfg, 'run')), BACKUP_DATABASE_URL: '', R2_BUCKET: '' });
      assert.notEqual(m.code, 0); assert.match(m.out, /BACKUP_DATABASE_URL is not set/);
      const s = run('scripts/backup/nightly-backup.sh', [], { ...env, RUNNER_TEMP: posix(path.join(cfg, 'run')), BACKUP_PASSPHRASE: 'short' });
      assert.notEqual(s.code, 0); assert.match(s.out, /shorter than 20 characters/);
    });

    console.log('\n3. report.sh\n');
    await ok('a good backup: posted to the server (kind backup, ok, size) — no email from here', async () => {
      hits.length = 0; opsStatus = 201;
      const p = await runAsync('scripts/backup/report.sh', [], { ...NOTIFY_ENV, RUNNER_TEMP: posix(path.join(box, 'run')), PROD_URL: LOCAL, OPS_INGEST_TOKEN: 'o'.repeat(40), RUN_URL: 'https://github.test/run/1' });
      assert.equal(p.code, 0, p.out);
      const ev = hits.find((h) => h.url === '/api/ops/events');
      assert.ok(ev); assert.equal(ev.auth, `Bearer ${'o'.repeat(40)}`);
      assert.deepEqual([ev.body.kind, ev.body.status], ['backup', 'ok']); assert.match(ev.body.title, /^Backup OK - [\d.]+ (MB|KB), \d+ s$/);
      assert.equal(ev.body.details.run_url, 'https://github.test/run/1');
      assert.ok(!hits.some((h) => h.url === '/resend' || h.url.startsWith('/tg')), 'no direct email on success');
    });
    await ok('a failure the server took: red, the server tells the admin (no second email from here)', async () => {
      hits.length = 0; opsStatus = 201;
      const p = await runAsync('scripts/backup/report.sh', [], { ...NOTIFY_ENV, RUNNER_TEMP: posix(path.join(TMP, 'fail', 'run')), PROD_URL: LOCAL, OPS_INGEST_TOKEN: 'o'.repeat(40) });
      assert.equal(p.code, 1);
      assert.equal(hits.find((h) => h.url === '/api/ops/events').body.status, 'fail');
      assert.ok(!hits.some((h) => h.url === '/resend'));
    });
    await ok('a failure the server did not take (down / no token): the admin told from here — email and Telegram', async () => {
      hits.length = 0; opsStatus = 503;
      const p = await runAsync('scripts/backup/report.sh', [], { ...NOTIFY_ENV, RUNNER_TEMP: posix(path.join(TMP, 'fail', 'run')), PROD_URL: LOCAL, OPS_INGEST_TOKEN: 'o'.repeat(40) });
      assert.equal(p.code, 1);
      const mail = hits.find((h) => h.url === '/resend');
      assert.ok(mail, p.out); assert.match(mail.body.subject, /ZapTill nightly backup FAILED/); assert.match(mail.body.text, /failed while dumping the database/);
      assert.equal(hits.filter((h) => h.url.startsWith('/tg')).length, 2, 'both Telegram chats');
      hits.length = 0;
      const q = await runAsync('scripts/backup/report.sh', [], { ...NOTIFY_ENV, RUNNER_TEMP: posix(path.join(TMP, 'nothing', 'run')), PROD_URL: LOCAL, OPS_INGEST_TOKEN: '' });
      assert.equal(q.code, 1); assert.match(hits.find((h) => h.url === '/resend').body.text, /did not finish/);
      opsStatus = 201;
    });

    console.log('\n4. restore-backup.sh\n');
    const enc = path.join(today, fs.readdirSync(today).find((f) => f.endsWith('.dump.gpg')));
    await ok('a target that looks like production is refused without --i-know (and a scratch project allowed by PRODUCTION_DB_MATCH)', () => {
      const t = 'postgresql://postgres.prodref:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres';
      const r1 = run('scripts/restore-backup.sh', ['--file', posix(enc), '--target', t, '--yes'], { BACKUP_PASSPHRASE: PASS_PHRASE });
      assert.equal(r1.code, 4, r1.out); assert.match(r1.out, /REFUSED: the target .* looks like PRODUCTION/);
      const r2x = run('scripts/restore-backup.sh', ['--file', posix(enc), '--target', t, '--yes'], { BACKUP_PASSPHRASE: PASS_PHRASE, PRODUCTION_DB_MATCH: 'prodref' });
      assert.equal(r2x.code, 4);
      const r3 = run('scripts/restore-backup.sh', ['--file', posix(enc), '--target', 'postgresql://postgres.scratch:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres', '--yes'],
        { BACKUP_PASSPHRASE: PASS_PHRASE, PRODUCTION_DB_MATCH: 'prodref', STUB_LOG: posix(path.join(TMP, 'restore.log')) });
      assert.equal(r3.code, 0, r3.out); assert.match(r3.out, /Restored in/);
      assert.match(fs.readFileSync(path.join(TMP, 'restore.log'), 'utf8'), /restore .*--no-owner --no-acl/);
    });
    await ok('a wrong passphrase is refused; --list-only lists the tables and restores nothing', () => {
      const w = run('scripts/restore-backup.sh', ['--file', posix(enc), '--list-only'], { BACKUP_PASSPHRASE: 'not-the-passphrase-xxxxxxxx' });
      assert.equal(w.code, 6); assert.match(w.out, /Could not decrypt/);
      const l = run('scripts/restore-backup.sh', ['--file', posix(enc), '--list-only'], { BACKUP_PASSPHRASE: PASS_PHRASE });
      assert.equal(l.code, 0, l.out); assert.match(l.out, /holds 3 tables with data; schemas: auth public/); assert.match(l.out, /public\.businesses/);
      assert.equal(run('scripts/restore-backup.sh', ['--target', 'x'], {}).code, 2, 'one of --latest / --object / --file');
    });

    console.log('\n5. notify-admin.sh\n');
    await ok('Resend and Telegram; the key in the Authorization header and never printed', async () => {
      hits.length = 0;
      const p = await runAsync('scripts/ops/notify-admin.sh', ['ZapTill PRODUCTION DOWN', 'Line one\nLine <two> & three'], NOTIFY_ENV);
      assert.equal(p.code, 0, p.out);
      const m = hits.find((h) => h.url === '/resend');
      assert.equal(m.auth, 'Bearer re_secret_test_key_123');
      assert.deepEqual(m.body.to, ['boss@zaptill.test']); assert.equal(m.body.subject, 'ZapTill PRODUCTION DOWN');
      assert.match(m.body.html, /Line &lt;two&gt; &amp; three/);
      assert.deepEqual(hits.filter((h) => h.url === '/tg/bottg-secret-token/sendMessage').map((h) => h.body.chat_id), ['4242', '99']);
      for (const s of ['re_secret_test_key_123', 'tg-secret-token']) assert.ok(!p.out.includes(s), s);
    });
    await ok('SendGrid when Resend is not set; nothing set → exit 3', async () => {
      hits.length = 0;
      const p = await runAsync('scripts/ops/notify-admin.sh', ['S', 'T'], { ...NOTIFY_ENV, RESEND_API_KEY: '', SENDGRID_API_KEY: 'SG.secret', TELEGRAM_BOT_TOKEN: '' });
      assert.equal(p.code, 0, p.out);
      const m = hits.find((h) => h.url === '/sendgrid');
      assert.equal(m.auth, 'Bearer SG.secret'); assert.deepEqual(m.body.personalizations[0].to, [{ email: 'boss@zaptill.test' }]);
      assert.deepEqual(m.body.from, { email: 'noreply@zaptill.co.ke', name: 'ZapTill' });
      const none = await runAsync('scripts/ops/notify-admin.sh', ['S', 'T'], { ADMIN_ALERT_EMAIL: '', RESEND_API_KEY: '', SENDGRID_API_KEY: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' });
      assert.equal(none.code, 3);
    });
  }

  await ok('the guide: docs/BACKUPS.md with its Word and web copies; the read-only role, the secrets, the monthly restore test', () => {
    const md = read('docs/BACKUPS.md');
    for (const s of ['CREATE ROLE zaptill_backup', 'BYPASSRLS', 'pg_read_all_data', 'default_transaction_read_only', 'BACKUP_PASSPHRASE', 'R2_SECRET_ACCESS_KEY',
      'Testing a restore every month', 'docker run --name zaptill-restore-test', 'Session pooler', '30 daily', '12 monthly', 'The down check']) assert.ok(md.includes(s), s);
    for (const f of ['docs/BACKUPS.docx', 'docs/BACKUPS.html']) assert.ok(fs.statSync(path.join(ROOT, f)).size > 5000, f);
    assert.match(read('docs/BACKUPS.html'), /CREATE ROLE zaptill_backup/);
  });
} finally {
  srv.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(fail ? 1 : 0);
