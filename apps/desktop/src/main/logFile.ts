// Durable log for the main process.
//
// WHY THIS EXISTS
// ---------------
// On 2026-08-07 a till stopped syncing and there was no way to find out why.
// The catalogue pull failed with a bare `if (!res.ok) return false` — status
// discarded, body discarded — and every other diagnostic in this process went
// to console.warn, which on a packaged Windows build goes nowhere. Diagnosing
// it needed physical access to the machine and a SQLite browser.
//
// A `console.warn` nobody can read is not logging. This writes to a file a
// tech can open, or that can be read out over the phone by whoever is standing
// at the till.
//
// SCOPE — deliberately small
//   * Append-only text, one line per event, ISO timestamp first.
//   * A477 (owner, 2026-10-14: "logs big enough that nothing is skipped"): rolls at 5 MB, keeping 10 files
//     (swiftpos.log, swiftpos.log.1 … swiftpos.log.9 — 50 MB at most). The two 1 MB files of before rotated away the
//     start of the 2026-10-12 sign-out within hours. Bounded, still: a till runs for months and nobody prunes.
//   * A477: a message repeated within 10 minutes is counted, not written again; when another message arrives (or the
//     10 minutes pass) one line says "the previous message repeated N times between HH:MM and HH:MM". A caller
//     retrying many times a minute no longer pushes everything else out of the file.
//   * A477: auth.log beside it — the till's sign-in history only (renewals, acks, device grants, refusals, sign-in
//     source, rejoins), 2 MB × 20 files, so months of it survive a busy swiftpos.log.
//   * Never throws. A logger that can break the caller is worse than no
//     logger, and this one is called from the sync loop's error paths — the
//     exact place where a second failure is hardest to reason about.
//   * No secrets. Callers pass messages; tokens must never be among them.
//
// NOT a replacement for the cashier-facing badge. That answers "is my sale
// safe". This answers "why did it stop", days later, for someone technical.

import { app } from 'electron';
import fs from 'fs';
import path from 'path';

// A477: 5 MB × 10 files for swiftpos.log; 2 MB × 20 for auth.log (test/logFile.test.mjs pins both).
export const MAX_BYTES = 5_000_000;
export const KEEP_FILES = 10;
export const AUTH_MAX_BYTES = 2_000_000;
export const AUTH_KEEP_FILES = 20;
/** A477: an identical message within this window is counted, not written. */
export const REPEAT_WINDOW_MS = 10 * 60_000;

// Captured BEFORE installConsoleCapture() swaps the globals, so logLine's own
// echo — and the append path — never re-enter the hook and recurse.
const _origConsole = {
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

let _logPath: string | null = null;
let _authPath: string | null = null;

// Resolved lazily. app.getPath('userData') is not safe to read at module load
// — the same trap localDb.ts documents at its top.
function logPath(): string {
  if (!_logPath) _logPath = path.join(app.getPath('userData'), 'swiftpos.log');
  return _logPath;
}
function authPath(): string {
  if (!_authPath) _authPath = path.join(app.getPath('userData'), 'auth.log');
  return _authPath;
}

// Where a tech should look. Surfaced so it can be shown in the UI or read out
// over the phone rather than guessed at.
export function getLogPath(): string {
  try {
    return logPath();
  } catch {
    return '(unavailable)';
  }
}

/** A477: the till's sign-in history (auth.log). */
export function getAuthLogPath(): string {
  try { return authPath(); } catch { return '(unavailable)'; }
}

/** Roll `file` once it reaches `max`: file → file.1 → … → file.(keep-1); the oldest is dropped. */
function roll(file: string, max: number, keep: number): void {
  try {
    const { size } = fs.statSync(file);
    if (size < max) return;
    fs.rmSync(`${file}.${keep - 1}`, { force: true });
    for (let i = keep - 2; i >= 1; i--) {
      if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
  } catch {
    /* no file yet, or rename raced — either way, append below is still safe */
  }
}

function appendTo(file: string, line: string, max: number, keep: number): void {
  try {
    roll(file, max, keep);
    fs.appendFileSync(file, line, 'utf8');
  } catch {
    /* Logging must never break the caller. */
  }
}

function appendToFile(line: string): void {
  try { appendTo(logPath(), line, MAX_BYTES, KEEP_FILES); } catch { /* never */ }
}

// ── A477: repeats are counted, not written ───────────────────────────────────

let _clock: () => number = () => Date.now();
/** Test seam: the time the logger sees. */
export function _setLogClock(fn: (() => number) | null): void { _clock = fn ?? (() => Date.now()); }

interface Recent {
  key: string; scope: string; windowStart: number;
  count: number; firstAt: number; lastAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}
let _recent: Recent | null = null;

const iso = (ms: number): string => new Date(ms).toISOString();
const hhmm = (ms: number): string => iso(ms).slice(11, 16);

/** Write the "repeated N times" line for the message held back, if any. */
function flushRepeats(now: number): void {
  const r = _recent;
  if (!r) return;
  if (r.timer) { clearTimeout(r.timer); r.timer = null; }
  if (r.count === 0) return;
  const n = r.count;
  r.count = 0;
  appendToFile(`${iso(now)} [${r.scope}] the previous message repeated ${n} time${n === 1 ? '' : 's'} between ${hhmm(r.firstAt)} and ${hhmm(r.lastAt)} (UTC)\n`);
}

/** Test seam (and shutdown): write what is held back now, and start afresh. */
export function _flushRepeats(): void {
  try { flushRepeats(_clock()); } catch { /* never */ }
  _recent = null;
}

function emit(scope: string, message: string, echo: boolean): void {
  const now = _clock();
  const key = `${scope}\u0000${message}`;
  const r = _recent;
  if (r && r.key === key && now - r.windowStart < REPEAT_WINDOW_MS) {
    if (r.count === 0) {
      r.firstAt = now;
      // The window ends with nothing else logged: say so then.
      r.timer = setTimeout(() => { _flushRepeats(); }, Math.max(0, r.windowStart + REPEAT_WINDOW_MS - now));
      (r.timer as { unref?: () => void } | null)?.unref?.();
    }
    r.count++;
    r.lastAt = now;
    return;
  }
  flushRepeats(now);
  const line = `${iso(now)} [${scope}] ${message}\n`;
  if (echo) _origConsole.warn(line.trimEnd());
  appendToFile(line);
  _recent = { key, scope, windowStart: now, count: 0, firstAt: 0, lastAt: 0, timer: null };
}

/**
 * Append one line. `scope` is a short tag like 'sync' or 'auth' so the file can
 * be grepped; `message` should already be safe to read aloud.
 */
export function logLine(scope: string, message: string): void {
  // Dev echo via the CAPTURED original, not the live console — after
  // installConsoleCapture() the live console.warn appends to the file, and using
  // it here would double-log this line and recurse.
  try { emit(scope, message, true); } catch { /* Logging must never break the caller. */ }
}

/**
 * A477: one event in the till's sign-in history (auth.log) — renewal ok / refused (with the code), ack, device grant,
 * machine mismatch, sign-in source (local / cloud / node), rejoin. Append-only, never collapsed. Never throws; no secrets.
 */
export function authLog(event: string, detail = ''): void {
  try {
    const text = String(detail ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    appendTo(authPath(), `${iso(_clock())} [${event}]${text ? ` ${text}` : ''}\n`, AUTH_MAX_BYTES, AUTH_KEEP_FILES);
  } catch { /* never */ }
}

/**
 * A299: route the main process's own console.error / console.warn into the log
 * file. Before this, 43 diagnostic console.* calls across main went nowhere on a
 * packaged build — the exact gap that hid the salesSummary IPC error until a
 * DevTools screenshot on 2026-09-18. Call once, early in startup. Idempotent.
 * logLine uses the captured originals above, so it never re-enters this hook.
 * A477: repeats collapse here too.
 */
let _captured = false;
export function installConsoleCapture(): void {
  if (_captured) return;
  _captured = true;
  const fmt = (args: unknown[]): string =>
    args
      .map((a) =>
        a instanceof Error
          ? a.stack || a.message
          : typeof a === 'object'
            ? (() => { try { return JSON.stringify(a); } catch { return String(a); } })()
            : String(a),
      )
      .join(' ')
      .replace(/\s+/g, ' ')
      .slice(0, 2000);
  console.error = (...args: unknown[]) => {
    _origConsole.error(...args);
    try { emit('console.error', fmt(args), false); } catch { /* never */ }
  };
  console.warn = (...args: unknown[]) => {
    _origConsole.warn(...args);
    try { emit('console.warn', fmt(args), false); } catch { /* never */ }
  };
}

/**
 * Summarise a failed fetch without ever putting a token in the file.
 *
 * The body is capped hard: a 500 from an HTML error page can be tens of
 * kilobytes, and the useful part — the server's `ref`, which keys the full
 * detail in the server log — is always near the front.
 */
export async function describeResponse(res: {
  status: number;
  statusText?: string;
  text: () => Promise<string>;
}): Promise<string> {
  let body = '';
  try {
    body = (await res.text()).slice(0, 500).replace(/\s+/g, ' ').trim();
  } catch {
    body = '(body unreadable)';
  }
  const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
  // ASCII separator on purpose: this line is read with `type swiftpos.log` in a
  // Windows console, which is cp850 and renders an em dash as mojibake.
  return body ? `${status} - ${body}` : status;
}
