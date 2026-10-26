/**
 * opsEvents.ts — A525: what the production server runs, whether a deploy reached it, what the dependencies carry.
 *
 * Production silently failed EVERY deploy from 1.0.16 to 1.0.18 (a startup guard refused the M-Pesa sandbox under
 * NODE_ENV=production, Render kept the old 1.0.15 instance running) and npm audit showed 7 vulnerabilities nobody was
 * told about. Owner, 2026-10-17: "maybe can we have a UI for all that in the app, these results are written to the db and
 * I can read through".
 *
 *   buildInfo()       the commit this process runs (RENDER_GIT_COMMIT, set by Render) and when it started — /health
 *   recordBoot()      one 'boot' row after the server listens; never throws, never blocks the start
 *   ingestAuth()      POST /api/ops/events: the GitHub workflows' token (OPS_INGEST_TOKEN, at least 32 characters),
 *                     compared in constant time; not a user session
 *   IngestSchema      what a workflow may post: deploy_check, vuln_scan, A589 backup or uptime (boot comes only from the
 *                     server itself)
 *
 * The table is public.ops_events (migration 149) — the service role only.
 */
import crypto from 'crypto';
import { z } from 'zod';
import { supabase } from './supabase';
import {
  type AdminMessage, type AlertLinks, type RenderedMessage, DEFAULT_LINKS, renderMessage, validUrl, guideUrl, systemUrl, eatDay, eatStamp, agoLabel,
} from './alertFormat';   // A592

/** When this process started — fixed at import, which is the start of the server. */
const STARTED_AT = new Date().toISOString();

// A589: 'backup' (.github/workflows/nightly-backup.yml) and 'uptime' (.github/workflows/uptime-check.yml) — migration 174.
export const OPS_KINDS = ['boot', 'deploy_check', 'vuln_scan', 'backup', 'uptime'] as const;
export const OPS_STATUSES = ['ok', 'warn', 'fail'] as const;
export const MIN_TOKEN_LENGTH = 32;
export const MAX_DETAILS_BYTES = 64 * 1024;

/** The full commit Render built this from, or null (local, tests, another host). */
export function fullCommit(env: Record<string, string | undefined> = process.env): string | null {
  const c = String(env.RENDER_GIT_COMMIT ?? '').trim();
  return /^[0-9a-f]{7,64}$/i.test(c) ? c.toLowerCase() : null;
}

/** A525: /health says what it runs — the first 12 characters of the commit (null when unknown) and when it started. */
export function buildInfo(env: Record<string, string | undefined> = process.env): { commit: string | null; started_at: string } {
  const c = fullCommit(env);
  return { commit: c ? c.slice(0, 12) : null, started_at: STARTED_AT };
}

/**
 * A525: the server records its own start — after it listens, never awaited by the caller. A missing table (migration
 * 149 not run yet) or a failed insert is a warning in the log, nothing more: a shop must never fail to trade over this.
 * Skipped under NODE_ENV=test.
 */
export async function recordBoot(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (env.NODE_ENV === 'test') return false;
  try {
    const commit = fullCommit(env);
    const { error } = await supabase.from('ops_events').insert({
      kind: 'boot', status: 'ok', commit, source: 'server',
      title: `Server started — ${commit ? commit.slice(0, 12) : 'commit unknown'}`,
      details: { node: process.version, started_at: STARTED_AT, env: env.NODE_ENV ?? null },
      created_at: new Date().toISOString(),
    });
    if (error) { console.warn('[ops] the start was not recorded (migration 149?):', error.message ?? error); return false; }
    return true;
  } catch (err: any) {
    console.warn('[ops] the start was not recorded:', err?.message ?? String(err));
    return false;
  }
}

/** The ingest token, or null when ingest is off (unset, or shorter than 32 characters). */
export function ingestToken(env: Record<string, string | undefined> = process.env): string | null {
  const t = String(env.OPS_INGEST_TOKEN ?? '').trim();
  return t.length >= MIN_TOKEN_LENGTH ? t : null;
}

/** Constant time, whatever the lengths: both sides hashed first. */
export function tokenMatches(given: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(given, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/** 'disabled' (503) | 'denied' (401) | 'ok' for an Authorization header. */
export function ingestAuth(authorization: string | undefined, env: Record<string, string | undefined> = process.env): 'disabled' | 'denied' | 'ok' {
  const expected = ingestToken(env);
  if (!expected) return 'disabled';
  const h = String(authorization ?? '');
  if (!h.startsWith('Bearer ')) return 'denied';
  return tokenMatches(h.slice(7).trim(), expected) ? 'ok' : 'denied';
}

export const IngestSchema = z.object({
  // 'boot' only ever comes from the server itself (recordBoot) — a workflow cannot say the server started.
  kind: z.enum(['deploy_check', 'vuln_scan', 'backup', 'uptime']),
  status: z.enum(OPS_STATUSES),
  commit: z.string().trim().max(64).nullable().optional(),
  title: z.string().trim().min(1).max(200),
  details: z.record(z.string(), z.unknown()).default({})
    .refine((d) => Buffer.byteLength(JSON.stringify(d), 'utf8') <= MAX_DETAILS_BYTES, { message: `details must be at most ${MAX_DETAILS_BYTES / 1024} KB` }),
  source: z.string().trim().min(1).max(40).default('github'),
});
export type IngestEvent = z.infer<typeof IngestSchema>;

const KIND_WORDS: Record<string, string> = { deploy_check: 'deploy check', vuln_scan: 'dependency scan', backup: 'nightly backup', uptime: 'uptime check' };

/**
 * A592: a backup step and its exit code in plain words. The steps are scripts/backup/nightly-backup.sh's STEP; the
 * codes are the aws CLI's (252 a command it could not read, 253 the settings or keys, 254 the storage refused, 255 any
 * other failure) — scripts/ops/alert-format.sh says the same for the workflow's own message.
 */
export function backupStepWords(step: string | null | undefined, code: number | null | undefined): string {
  let s = String(step ?? '').trim() || 'an unknown step';
  if (/^checking the dump/.test(s)) s = 'checking the dump can be read';
  else if (/^checking the PostgreSQL versions/.test(s)) s = 'connecting to the database';
  else if (/^checking the settings/.test(s)) s = 'checking the settings (a secret is missing)';
  else if (/^uploading to /.test(s)) s = 'uploading to the storage (R2)';
  const aws = /upload|storage|R2|pruning|monthly copy|status/.test(s);
  const why: Record<number, string> = aws
    ? { 252: 'the storage command was given an option it does not know', 253: 'the storage settings or keys are wrong', 254: 'the storage refused the request', 255: 'the storage command failed' }
    : {};
  if (code === 124) return `${s} — timed out`;
  if (code === 130 || code === 143) return `${s} — cancelled`;
  return typeof code === 'number' && Number.isFinite(code) && code !== 0 ? `${s} (exit ${code}${why[code] ? ` — ${why[code]}` : ''})` : s;
}

/** The step and exit code out of the result's error ("failed while checking the upload (exit 252)"). */
function stepOf(d: Record<string, unknown>): { step: string | null; code: number | null } {
  if (typeof d.step === 'string') return { step: d.step, code: typeof d.exit === 'number' ? d.exit : null };
  const m = /failed while (.+?) \(exit (\d+)\)/.exec(String(d.error ?? ''));
  return m ? { step: m[1], code: Number(m[2]) } : { step: null, code: null };
}

/**
 * The alert for a failed check (A592: laid out — headline, the facts, what to do, buttons). A backup: "🔴 Backup failed —
 * Mon 26 Oct 13:07 EAT", the step in plain words, the last good backup; a deploy check or a scan: the commit, expected and
 * running, what to do. Buttons: the GitHub run, the guide, the admin portal's System page.
 */
export function failAlertMessage(ev: IngestEvent, now: Date = new Date(), links: AlertLinks = DEFAULT_LINKS): AdminMessage {
  const d = (ev.details ?? {}) as Record<string, unknown>;
  const run = typeof d.run_url === 'string' && validUrl(d.run_url) ? d.run_url : null;
  const buttons = [
    ...(run ? [{ text: 'Open run', url: run }] : []),
    ...(ev.kind === 'backup' ? [{ text: 'Guide', url: guideUrl(links, 'docs/BACKUPS.md') }] : []),
    { text: 'Open in admin', url: systemUrl(links) },
  ];
  if (ev.kind === 'backup') {
    const { step, code } = stepOf(d);
    const lastAt = typeof d.last_good_at === 'string' ? d.last_good_at : null;
    const last = d.last_good === 'never' ? 'never' : lastAt ? `${eatDay(lastAt)} (${agoLabel(lastAt, now)})` : null;
    return {
      tone: 'critical',
      headline: `Backup failed — ${eatStamp(now)}`,
      subject: `🔴 Backup failed · ${eatDay(now)}`,
      facts: [
        ['Step', step ? backupStepWords(step, code) : String(d.error ?? ev.title)],
        ...(last ? [['Last good backup', last] as [string, string]] : []),
      ],
      action: 'The earlier backups are untouched. Fix the cause, then run it again: GitHub › Actions › Nightly backup › Run workflow.',
      buttons,
    };
  }
  const facts: Array<[string, string]> = [];
  if (ev.commit) facts.push(['Commit', ev.commit.slice(0, 12)]);
  if (typeof d.expected === 'string') facts.push(['Expected', d.expected]);
  if (typeof d.running === 'string' || d.running === null) facts.push(['Running', String(d.running ?? 'unknown (no commit on /health)')]);
  return {
    tone: 'critical',
    headline: `${(KIND_WORDS[ev.kind] ?? ev.kind).replace(/^./, (c) => c.toUpperCase())} failed`,
    subject: `🔴 ${ev.title}`,
    summary: ev.title,
    facts,
    action: typeof d.what_to_do === 'string' ? d.what_to_do : 'Details: the admin portal › System.',
    buttons,
  };
}

/** The alert for a failed check, rendered (subject, plain text, Telegram HTML and buttons, the email). */
export function failAlertText(ev: IngestEvent, now: Date = new Date(), links: AlertLinks = DEFAULT_LINKS): RenderedMessage {
  return renderMessage(failAlertMessage(ev, now, links), links);
}
