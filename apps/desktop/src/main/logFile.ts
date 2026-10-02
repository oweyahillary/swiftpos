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
//   * Rolls at ~1 MB into a single .1 backup. Two files, bounded, forever.
//     No dated files: a restaurant till runs for months and nobody prunes.
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

// Rotation ceiling — deliberately 1MB into a single .1 backup (two bounded files,
// no dated pile-up on a machine nobody prunes). A299 added error + event volume,
// which just rolls more often within the same bound rather than raising it — the
// design (and test/logFile.test.mjs) fix this at 1MB.
const MAX_BYTES = 1_000_000;

// Captured BEFORE installConsoleCapture() swaps the globals, so logLine's own
// echo — and the append path — never re-enter the hook and recurse.
const _origConsole = {
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

let _logPath: string | null = null;

// Resolved lazily. app.getPath('userData') is not safe to read at module load
// — the same trap localDb.ts documents at its top.
function logPath(): string {
  if (!_logPath) _logPath = path.join(app.getPath('userData'), 'swiftpos.log');
  return _logPath;
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

function roll(file: string): void {
  try {
    const { size } = fs.statSync(file);
    if (size < MAX_BYTES) return;
    // Single generation. Two bounded files beats an unbounded directory on a
    // machine nobody administers.
    fs.renameSync(file, `${file}.1`);
  } catch {
    /* no file yet, or rename raced — either way, append below is still safe */
  }
}

function appendToFile(line: string): void {
  try {
    const file = logPath();
    roll(file);
    fs.appendFileSync(file, line, 'utf8');
  } catch {
    /* Logging must never break the caller. */
  }
}

/**
 * Append one line. `scope` is a short tag like 'sync' or 'auth' so the file can
 * be grepped; `message` should already be safe to read aloud.
 */
export function logLine(scope: string, message: string): void {
  const line = `${new Date().toISOString()} [${scope}] ${message}\n`;

  // Dev echo via the CAPTURED original, not the live console — after
  // installConsoleCapture() the live console.warn appends to the file, and using
  // it here would double-log this line and recurse.
  _origConsole.warn(line.trimEnd());

  appendToFile(line);
}

/**
 * A299: route the main process's own console.error / console.warn into the log
 * file. Before this, 43 diagnostic console.* calls across main went nowhere on a
 * packaged build — the exact gap that hid the salesSummary IPC error until a
 * DevTools screenshot on 2026-09-18. Call once, early in startup. Idempotent.
 * logLine uses the captured originals above, so it never re-enters this hook.
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
    appendToFile(`${new Date().toISOString()} [console.error] ${fmt(args)}\n`);
  };
  console.warn = (...args: unknown[]) => {
    _origConsole.warn(...args);
    appendToFile(`${new Date().toISOString()} [console.warn] ${fmt(args)}\n`);
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
