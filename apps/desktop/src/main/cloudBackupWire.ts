/**
 * cloudBackupWire.ts — A601: the desktop-only cut-off's pure rules (cloudBackup.ts has the story and the storage). No
 * database, no Electron: referenceBundle.ts and the tests use it as it is.
 */
export type CloudBackupPhase = 'none' | 'notice' | 'cut';
export interface CloudBackup { on: boolean; phase: CloudBackupPhase; cutoffAt: string | null }

/** The wire value as the cloud (or a branch server) sent it, or undefined when it says nothing usable. Pure. */
export function cleanCloudBackup(v: unknown): CloudBackup | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.on !== 'boolean') return undefined;
  const phase: CloudBackupPhase = o.phase === 'notice' || o.phase === 'cut' ? o.phase : 'none';
  const at = typeof o.cutoffAt === 'string' && Number.isFinite(Date.parse(o.cutoffAt)) ? new Date(Date.parse(o.cutoffAt)).toISOString() : null;
  return { on: o.on, phase, cutoffAt: phase === 'none' ? null : at };
}

/**
 * Where it stands at `now`: a 'notice' whose date has passed is a 'cut' (the cloud's answer may be a day old — the POS
 * takes the whole catalogue daily — and the date is the date). Pure.
 */
export function effectiveCloudBackup(c: CloudBackup | null | undefined, now: number = Date.now()): CloudBackup | null {
  if (!c) return null;
  if (c.phase === 'notice' && c.cutoffAt && now >= Date.parse(c.cutoffAt)) return { on: false, phase: 'cut', cutoffAt: c.cutoffAt };
  return c;
}

/** Is the cloud backup off for this POS now? Pure. */
export function backupOff(c: CloudBackup | null | undefined, now: number = Date.now()): boolean {
  const e = effectiveCloudBackup(c, now);
  return !!e && e.on === false;
}
