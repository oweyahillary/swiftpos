/**
 * windows-teardown.mjs — tell a Windows libuv teardown crash AFTER a green run from a real failure (A548, closes A186).
 *
 * On Windows some PGlite-heavy test files print their own all-passed summary ("29 passed, 0 failed") and THEN die in
 * process teardown: `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c` — libuv's Windows
 * async-close path, after every assertion has already run. The exit code is 127, or 3221226505 (0xC0000409, the
 * fail-fast / stack-buffer code; -1073740791 when read as signed). Every green on the owner's box needed a manual
 * "ignore that one", which is the false red that hides a real red (A60, A186).
 *
 * The rule is narrow on purpose — ALL of these must hold, else it stays a failure:
 *   - the platform is win32 (Linux / CI never gets the allowance);
 *   - the exit code is one of the libuv crash codes above (exit 1 = a test failed = red);
 *   - the run did not time out;
 *   - the output's LAST "N passed, M failed" summary has N > 0 and M = 0;
 *   - no line starts with FAIL.
 * The caller reports it as a pass WITH a note, so the crash stays visible.
 */
export const WINDOWS_TEARDOWN_CODES = Object.freeze([127, 3221226505, -1073740791]);

export function isWindowsTeardownPass({ status, out = '', timedOut = false }, platform = process.platform) {
  if (platform !== 'win32') return false;
  if (timedOut) return false;
  if (!WINDOWS_TEARDOWN_CODES.includes(Number(status))) return false;
  const text = String(out);
  const all = [...text.matchAll(/(\d+) passed, (\d+) failed/g)];
  if (!all.length) return false;
  const last = all[all.length - 1];
  if (!(Number(last[1]) > 0 && Number(last[2]) === 0)) return false;
  if (/^FAIL\b/m.test(text)) return false;
  return true;
}

export const TEARDOWN_NOTE = 'passed; Windows libuv teardown crash after the summary ignored (A186)';
