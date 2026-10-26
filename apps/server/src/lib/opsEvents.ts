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

/** The alert text for a failed check — what failed, which commit, where to look, what to do. */
export function failAlertText(ev: IngestEvent): { subject: string; text: string } {
  const d = (ev.details ?? {}) as Record<string, unknown>;
  const lines = [
    `ZapTill ops: ${ev.title}`,
    `Kind: ${KIND_WORDS[ev.kind] ?? ev.kind} · from ${ev.source}`,
    ev.commit ? `Commit: ${ev.commit}` : null,
    typeof d.expected === 'string' ? `Expected: ${d.expected}` : null,
    typeof d.running === 'string' || d.running === null ? `Running: ${d.running ?? 'unknown (no commit on /health)'}` : null,
    typeof d.what_to_do === 'string' ? `What to do: ${d.what_to_do}` : null,
    typeof d.run_url === 'string' ? `GitHub run: ${d.run_url}` : null,
    'Details: the admin portal → System.',
  ].filter(Boolean);
  return { subject: `ZapTill ops — ${ev.title}`.slice(0, 180), text: lines.join('\n') };
}
