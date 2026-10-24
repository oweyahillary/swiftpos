/**
 * updateNotice.ts — A541: what the update bar says, and to whom.
 *
 * Owner, 2026-10-20: "Something I have noticed since we added the autostart feature most apps are not updating, they are
 * stuck in the old version." A till or a branch server that is never closed (and, without the ZapTill Updater task, may
 * not install by itself — Windows would ask for permission with nobody there) can hold a downloaded update for days.
 * After READY_NOTICE_AFTER_MS, the person signed in who is back office (a manager, a supervisor, the owner — the A519 /
 * A499 rule, `canRestart`) is told plainly what to do, with the A519 one-tap restart. A cashier never sees this notice
 * (owner preference: no cashier banners) — their bar reads as before.
 *
 * Pure: the test bundles it (test/update-stuck-a541.test.mjs).
 */
export const READY_NOTICE_AFTER_MS = 72 * 60 * 60_000;

export interface BarStatus { state: string; version: string | null; percent: number | null; downloadedAt?: number | null }
export type BarContent =
  | { kind: 'none' }
  | { kind: 'downloading'; title: string; text: string }
  | { kind: 'ready'; title: string; text: string; button: string | null }
  | { kind: 'stale'; title: string; text: string; button: string };

/** The ready-for-days notice, word for word. */
export function staleNoticeText(version: string | null): string {
  return `ZapTill ${version ?? ''} is ready — close ZapTill tonight (tray icon → Quit) or restart Windows to install it.`.replace(/\s{2,}/g, ' ');
}

export function updateBarContent(s: BarStatus, canRestart: boolean, now = Date.now()): BarContent {
  if (s.state === 'downloading') {
    return { kind: 'downloading', title: 'Updating…', text: `Downloading ZapTill ${s.version ?? ''}${typeof s.percent === 'number' ? ` — ${s.percent}%` : ''}. You can keep working.` };
  }
  if (s.state !== 'downloaded') return { kind: 'none' };
  const at = typeof s.downloadedAt === 'number' && Number.isFinite(s.downloadedAt) ? s.downloadedAt : null;
  if (canRestart && at !== null && now - at >= READY_NOTICE_AFTER_MS) {
    return { kind: 'stale', title: 'Update waiting', text: staleNoticeText(s.version), button: 'Restart now and install' };
  }
  return { kind: 'ready', title: 'Update ready', text: `ZapTill ${s.version ?? ''} installs when ZapTill is closed, or by itself when the POS is idle.`,
    button: canRestart ? 'Restart & update now' : null };
}
