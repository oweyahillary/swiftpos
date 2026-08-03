/**
 * sqlite-open.mjs — get a SQLite handle, whichever driver this machine has.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * There are three ways to reach SQLite from a script in this repo and each one
 * is absent somewhere it matters:
 *
 *   better-sqlite3 at the repo root   the app's driver, Node ABI — but not a
 *                                     dependency of the root package
 *   better-sqlite3 in apps/desktop    present, and rebuilt for ELECTRON's ABI by
 *                                     electron-rebuild, so `require`-ing it from
 *                                     a plain node process throws NODE_MODULE_VERSION
 *   node:sqlite                       built in, but only from Node 22.5. The
 *                                     build machine here runs Node 20.
 *
 * Trying one and assuming is how a check script dies on the machine it was
 * written for. This tries all three, in the order that puts the app's own driver
 * first, and reports which one it got — because a test that quietly ran against
 * a different engine than the app is answering a question nobody asked.
 *
 * The API surface used by callers is the intersection of the two drivers:
 * prepare().get/all/run, exec, close. Not transaction() — better-sqlite3 has it
 * and node:sqlite does not, so callers issue BEGIN/COMMIT or do without.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** Where to look for a Node-ABI better-sqlite3, nearest first. */
function candidateRoots(repoRoot) {
  return [
    { dir: repoRoot, label: 'repo root' },
    { dir: path.join(repoRoot, 'apps', 'desktop'), label: 'apps/desktop' },
  ];
}

/**
 * @returns {{ db: any, driver: string, isAppDriver: boolean }}
 */
export function openSqlite(repoRoot, filename, { readonly = false } = {}) {
  const attempts = [];

  for (const { dir, label } of candidateRoots(repoRoot)) {
    const pkg = path.join(dir, 'package.json');
    if (!fs.existsSync(pkg)) continue;
    try {
      const req = createRequire(pathToFileURL(pkg));
      const Database = req('better-sqlite3');
      const db = new Database(filename, readonly ? { readonly: true, fileMustExist: true } : {});
      return { db, driver: `better-sqlite3 (${label}) — the driver the app uses`, isAppDriver: true };
    } catch (err) {
      const msg = String(err?.message ?? err);
      // The Electron-ABI case, named explicitly. "was compiled against a
      // different Node.js version" is not a phrase that tells anyone what to do.
      attempts.push(
        /NODE_MODULE_VERSION|was compiled against/i.test(msg)
          ? `${label}: present, but built for Electron's ABI (electron-rebuild) — unusable from plain node`
          : `${label}: ${msg.split('\n')[0]}`,
      );
    }
  }

  try {
    // Synchronous require of a builtin, so this stays a plain function.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(filename, readonly ? { readOnly: true } : {});
    return {
      db,
      driver: `node:sqlite (Node ${process.versions.node}) — NOT the app's driver`,
      isAppDriver: false,
    };
  } catch (err) {
    attempts.push(
      /No such built-in module/i.test(String(err?.message))
        ? `node:sqlite: not available — needs Node 22.5+, this is Node ${process.versions.node}`
        : `node:sqlite: ${String(err?.message).split('\n')[0]}`,
    );
  }

  const e = new Error(
    'No usable SQLite driver.\n\n' +
    attempts.map(a => `  • ${a}`).join('\n') +
    '\n\nFix, from the repo root:\n\n' +
    '  npm i --no-save better-sqlite3\n\n' +
    'That fetches a prebuilt binary for this Node version — no compiler needed on\n' +
    'Windows x64 — and does not disturb the Electron-ABI copy in apps/desktop that\n' +
    'the app itself uses.\n',
  );
  e.attempts = attempts;
  throw e;
}
