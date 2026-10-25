/**
 * supportLogs.ts — A519: "Send logs to support" (Tech page, a technician's session only).
 *
 * Diagnosing a till over the phone meant someone at the shop finding %APPDATA%\ZapTill\swiftpos.log and e-mailing it.
 * Now one button on the Tech page sends the last 24 hours of this till's log to the cloud, where ZapTill's admin portal
 * shows it on the client's page ("Support logs"); the Tech page shows a reference ("Sent — reference K7Q2XM") for the
 * client to read out. Offline, it says so and offers "Save log to file" instead.
 *
 * What is sent:
 *   - a short header: business, branch, terminal code, device id, version, Windows version, memory, the last start's
 *     timing line (A513) and the branch-sync health in one line per channel (A501);
 *   - swiftpos.log (and its rolled files) from the last 24 hours, newest LAST, at most LOG_CAP_BYTES — the oldest lines go
 *     first when there is more; then auth.log's last 24 hours, at most AUTH_CAP_BYTES;
 *   - every secret-looking value removed (logRedact.ts — the cloud removes them again before storing);
 *   - gzip, base64 — under the cloud's 1 MB request limit (MAX_ENCODED_BYTES); a log that still does not fit loses its
 *     oldest lines until it does.
 *
 * A533: the same bundle answers ZapTill support's pull from the admin portal (logPull.ts) — the window is the request's
 * (24 hours, 3 days or 7 days: windowMs), read across the rolled files lazily (lazyLogFiles: an older file is not even
 * opened once the window is filled, or when its last write is older than the window), auth.log only when asked, and a
 * short diagnostics block under the header (BuildOptions.diagnostics) plus the printer errors in the window.
 *
 * Pure apart from reading the log files (the caller hands the paths), so the tests run it on real files.
 */
import fs from 'fs';
import zlib from 'zlib';
import { redactLog } from './logRedact';

export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const LOG_CAP_BYTES = 2 * 1024 * 1024;
export const AUTH_CAP_BYTES = 256 * 1024;
/** The cloud's JSON limit is 1 MB; the header and the JSON around the payload need a little. */
export const MAX_ENCODED_BYTES = 900 * 1024;

const TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/;

/**
 * The lines of these files (newest file FIRST, as logFile rolls them: x.log, x.log.1, …) written in the window, oldest
 * first, at most `cap` bytes — when there is more, the OLDEST are dropped (the newest are what support needs). A line
 * without a time (a stack trace's continuation) belongs to the line before it.
 */
export function windowOfLog(texts: Iterable<string>, nowMs: number, windowMs = WINDOW_MS, cap = LOG_CAP_BYTES): { text: string; dropped: number } {
  const since = nowMs - windowMs;
  const kept: string[] = [];   // newest first while collecting
  let bytes = 0, dropped = 0, full = false;
  for (const t of texts) {
    if (full) break;
    const lines = String(t ?? '').split(/\r?\n/);
    // Group continuation lines with the timed line before them, walking from the newest.
    let block: string[] = [];
    let oldEnough = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line === '' && block.length === 0) continue;
      block.unshift(line);
      const m = TS.exec(line);
      if (!m && i > 0) continue;   // a continuation — its timed line is above it
      const at = m ? Date.parse(m[1]) : NaN;
      const entry = block.join('\n');
      block = [];
      if (Number.isFinite(at) && at < since) { oldEnough = true; break; }
      const b = Buffer.byteLength(entry, 'utf8') + 1;
      if (bytes + b > cap) { dropped++; full = true; break; }
      kept.push(entry); bytes += b;
    }
    if (oldEnough) break;   // older files are older still
  }
  return { text: kept.reverse().join('\n'), dropped };
}

/** Read the files that exist (missing ones are skipped). */
export function readLogFiles(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) { try { if (fs.existsSync(p)) out.push(fs.readFileSync(p, 'utf8')); } catch { /* skipped */ } }
  return out;
}

/**
 * A533: the files one at a time, newest first — a file is read only when the window still needs it: one last written
 * before `sinceMs` holds nothing in the window (and the files after it are older still), so reading stops there. A
 * 7-day pull on a till with ten 5 MB files reads what it sends, not 50 MB.
 */
export function* lazyLogFiles(paths: string[], sinceMs: number): Generator<string> {
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue;
      if (fs.statSync(p).mtimeMs < sinceMs) return;
    } catch { continue; }
    let text: string | null = null;
    try { text = fs.readFileSync(p, 'utf8'); } catch { text = null; }
    if (text !== null) yield text;
  }
}

/** A533: "24 hours" / "3 days" / "7 days" — what the section rules say. */
export function rangeLabel(windowMs: number): string {
  const h = Math.round(windowMs / 3_600_000);
  return h % 24 === 0 && h > 24 ? `${h / 24} days` : `${h} hours`;
}

/** A533: the printer's trouble in the window (a support case is often "the printer stopped") — the last `max` lines. */
export function printerErrorLines(logText: string, max = 20): { count: number; lines: string[] } {
  const hits = String(logText ?? '').split(/\r?\n/)
    .filter((l) => /print|escpos|receipt|kitchen ticket/i.test(l) && /fail|error|offline|refused|not found|timed? ?out|unreachable|ECONN/i.test(l));
  return { count: hits.length, lines: hits.slice(-max).map((l) => l.slice(0, 300)) };
}

/** swiftpos.log, swiftpos.log.1 … — newest first. */
export function rolledPaths(base: string, keep: number): string[] {
  return [base, ...Array.from({ length: Math.max(0, keep - 1) }, (_, i) => `${base}.${i + 1}`)];
}

export interface SupportHeader {
  business: string | null; businessId: string | null; branch: string | null; branchId: string | null;
  terminal: string | null; deviceId: string | null; deviceName: string | null; role: string | null;
  version: string; os: string; ramGb: number | null; freeGb: number | null;
  startup: string | null; sync: string[]; tech: string | null; at: string;
}

/** The header as text — the first lines of the file support reads. */
export function headerText(h: SupportHeader): string {
  const lines = [
    `ZapTill support log — ${h.at}`,
    `Business: ${h.business ?? '?'} (${h.businessId ?? '?'})`,
    `Branch: ${h.branch ?? '?'} (${h.branchId ?? '?'})`,
    `Terminal: ${h.terminal ?? '?'}${h.deviceName ? ` · ${h.deviceName}` : ''} · ${h.role ?? 'till'} · device ${h.deviceId ?? '?'}`,
    `Version: ${h.version} · ${h.os} · RAM ${h.ramGb ?? '?'} GB (${h.freeGb ?? '?'} GB free)`,
    `Last start: ${h.startup ?? '(not recorded)'}`,
    `Branch sync: ${h.sync.length ? h.sync.join(' | ') : '(no branch server)'}`,
    `Sent by: ${h.tech ?? 'a technician'}`,
  ];
  return lines.join('\n');
}

/** One line per A501 channel: "push ok 12:03, 0 failures" / "pull 3 failures — last: HTTP 403 …". */
export function syncSummary(channels: Array<{ channel: string; lastOkAt: string | null; lastError: string | null; failures: number }> | null | undefined): string[] {
  return (channels ?? []).map((c) => c.failures > 0
    ? `${c.channel}: ${c.failures} failure${c.failures === 1 ? '' : 's'} — ${String(c.lastError ?? '').slice(0, 120)}`
    : `${c.channel}: ok${c.lastOkAt ? ` ${c.lastOkAt.slice(11, 16)}Z` : ' (not yet)'}`);
}

/** A533: a pull's window, caps and parts (the Tech page's button keeps the defaults: 24 hours, 2 MB, auth.log). */
export interface BuildOptions {
  windowMs?: number; logCap?: number; authCap?: number;
  /** auth.log (the sign-in history) — false leaves it out entirely. */
  includeAuth?: boolean;
  /** Lines under the header (version, sync, push channel, disk …) — kept when the pack trims the oldest log lines. */
  diagnostics?: string[];
}

/** The whole file: header, the log, auth.log — every secret removed. */
export function buildSupportText(header: SupportHeader, logTexts: Iterable<string>, authTexts: Iterable<string>, nowMs: number,
  opts: BuildOptions = {}): { text: string; droppedOld: boolean } {
  const windowMs = opts.windowMs ?? WINDOW_MS;
  const logCap = opts.logCap ?? LOG_CAP_BYTES;
  const range = rangeLabel(windowMs);
  const log = windowOfLog(logTexts, nowMs, windowMs, logCap);
  const withAuth = opts.includeAuth !== false;
  const auth = withAuth ? windowOfLog(authTexts, nowMs, windowMs, opts.authCap ?? AUTH_CAP_BYTES) : { text: '', dropped: 0 };
  const diag: string[] = [];
  if (opts.diagnostics) {
    // Plain lines, no section rule: packSupportText keeps everything above the first rule when it trims.
    const pe = printerErrorLines(log.text);
    diag.push('Diagnostics:', ...opts.diagnostics.map((l) => `  ${l}`),
      `  Printer errors in the window: ${pe.count}${pe.count > pe.lines.length ? ` (the last ${pe.lines.length})` : ''}`,
      ...pe.lines.map((l) => `    ${l}`), '');
  }
  const text = [
    headerText(header), '', ...diag,
    `── swiftpos.log, last ${range}${log.dropped ? ` (older lines left out: over ${Math.round(logCap / 1048576)} MB)` : ''} ──`, log.text, '',
    ...(withAuth ? [`── auth.log, last ${range}${auth.dropped ? ' (older lines left out)' : ''} ──`, auth.text, ''] : []),
  ].join('\n');
  return { text: redactLog(text), droppedOld: log.dropped > 0 || auth.dropped > 0 };
}

/** gzip + base64 under MAX_ENCODED_BYTES: the header is kept, the oldest log lines are dropped until it fits. */
export function packSupportText(text: string, max = MAX_ENCODED_BYTES): { b64: string; bytes: number; trimmed: boolean } {
  let body = text;
  let trimmed = false;
  for (let i = 0; i < 12; i++) {
    const b64 = zlib.gzipSync(Buffer.from(body, 'utf8'), { level: 9 }).toString('base64');
    if (b64.length <= max) return { b64, bytes: Buffer.byteLength(body, 'utf8'), trimmed };
    // Keep the header (up to the first section rule) and the newer half of what follows.
    const cut = body.indexOf('\n── ');
    const head = cut > 0 ? body.slice(0, cut) : '';
    const rest = cut > 0 ? body.slice(cut) : body;
    const from = rest.indexOf('\n', Math.floor(rest.length / 2));
    body = `${head}\n(older lines left out to fit)${rest.slice(from > 0 ? from : Math.floor(rest.length / 2))}`;
    trimmed = true;
  }
  const b64 = zlib.gzipSync(Buffer.from(body.slice(-200_000), 'utf8')).toString('base64');
  return { b64, bytes: 200_000, trimmed: true };
}

/** What the Tech page shows for the cloud's answer. */
export function sendVerdict(status: number | null, body: any): { ok: true; reference: string } | { ok: false; offline: boolean; message: string } {
  if (status === null) return { ok: false, offline: true, message: 'This POS cannot reach the cloud right now. Save the log to a file instead, and send it another way.' };
  if (status >= 200 && status < 300 && typeof body?.reference === 'string') return { ok: true, reference: body.reference };
  if (status === 429) return { ok: false, offline: false, message: body?.error ?? 'Five logs were sent from this POS in the last hour — wait a little, or save the log to a file.' };
  if (status === 404) return { ok: false, offline: false, message: 'The cloud does not take logs yet (an older cloud). Save the log to a file instead.' };
  if (status >= 500 || status === 502 || status === 503) return { ok: false, offline: true, message: 'The cloud is not answering right now. Save the log to a file instead.' };
  return { ok: false, offline: false, message: body?.error ?? `The cloud refused the log (HTTP ${status}).` };
}
