import fs from 'fs';
import path from 'path';

/**
 * userDataMove.ts — 0.6.36 (A386): carry a till's data folder across an app rename (SwiftPOS → ZapTill).
 *
 * Electron keeps everything a till owns in userData, named after the app (productName): the database (swiftpos.db),
 * the log, the backups, and Chromium's "Local State" — which holds the key that unlocks the saved sign-in (safeStorage).
 * Renaming the app points userData at a new, empty folder; without this a till would start as a brand-new install,
 * signed out, with its unsynced sales left behind in the old folder.
 *
 * So, once, before anything opens the database (and before Electron's own startup touches the folder):
 *   - the new folder already holds a till's database → nothing to do (already moved, or a fresh install that sold);
 *   - otherwise the first old folder (in `candidates` order) that holds swiftpos.db is MOVED into the new name:
 *       · new folder absent → one rename (instant on the same disk; the old folder is gone);
 *       · new folder present (a log line or Chromium's fresh files got there first) → each old entry replaces the new
 *         one of the same name (the OLD data wins — its Local State is the key the saved sign-in needs), then the empty
 *         old folder is removed;
 *       · an entry that cannot be moved (locked) is COPIED instead and the old folder is left in place — nothing is
 *         ever deleted that was not first placed in the new folder.
 * Never throws: a failure is reported, and the worst case is the till starting fresh (as a new install would).
 */
export type MoveResult =
  | { moved: false; reason: 'already-has-data' | 'nothing-to-move' }
  | { moved: true; from: string; mode: 'rename' | 'merge' | 'copy' }
  | { moved: false; reason: 'failed'; error: string };

const DB = 'swiftpos.db';

export function moveTillData(newDir: string, candidates: string[]): MoveResult {
  try {
    if (fs.existsSync(path.join(newDir, DB))) return { moved: false, reason: 'already-has-data' };
    const parent = path.dirname(newDir);
    const from = candidates.map((n) => path.join(parent, n))
      .find((d) => path.resolve(d) !== path.resolve(newDir) && fs.existsSync(path.join(d, DB)));
    if (!from) return { moved: false, reason: 'nothing-to-move' };

    if (!fs.existsSync(newDir)) {
      try {
        fs.renameSync(from, newDir);
        return { moved: true, from, mode: 'rename' };
      } catch { /* locked or cross-volume: fall through to entry by entry */ }
      fs.mkdirSync(newDir, { recursive: true });
    }

    let copied = false;
    for (const entry of fs.readdirSync(from)) {
      const src = path.join(from, entry);
      const dst = path.join(newDir, entry);
      try {
        if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
        fs.renameSync(src, dst);
      } catch {
        fs.cpSync(src, dst, { recursive: true, force: true });
        copied = true;
      }
    }
    if (!copied) {
      try { fs.rmdirSync(from); } catch { /* not empty after all: leave it */ }
    }
    return { moved: true, from, mode: copied ? 'copy' : 'merge' };
  } catch (err) {
    return { moved: false, reason: 'failed', error: (err as Error)?.message ?? String(err) };
  }
}

/** The old folder names a till's data may be under, newest first, for this app's userData folder name. */
export function oldFolderNames(newFolderName: string): string[] {
  const dev = newFolderName.toLowerCase().includes('dev');
  // 'desktop' — before A284 every till used %APPDATA%\desktop (no productName). DEV builds never used it.
  return dev ? ['SwiftPOS Dev'] : ['SwiftPOS', 'desktop'];
}
