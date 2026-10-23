/**
 * adminInstaller.ts — A570 (2026-10-22): "Download ZapTill" in the admin portal, through OUR server.
 *
 * Owner: "yes this is something i have wanted since in future we will get a vps which will hold our apps and move away
 * from github and make the repo private".
 *
 *   GET  /api/admin/desktop/installer?client=<id>           — what may be downloaded: the source (vps / github / none and
 *        why), the latest release, the version approved for that client (its Desktop updates), and — super admins only —
 *        every downloadable version for the picker.
 *   GET  /api/admin/desktop/installer/:version/info         — the file's name, size, SHA-256 (GitHub's digest) and SHA-512
 *        (the release's latest.yml) so a technician can check the file.
 *   POST /api/admin/desktop/installer/:version/ticket       — { client? } → a one-use link valid 2 minutes, so the BROWSER
 *        downloads the file itself (its own progress bar, straight to disk) without the admin's token in a URL.
 *   GET  /api/admin/desktop/installer/:version              — the installer, streamed from lib/installerSource.ts
 *        (Authorization: Bearer <admin token>, or ?ticket=). Every download is audited: who, which version, when.
 *
 * Who: any active admin (requireAdmin). An agent may download the LATEST release or the version approved for the client
 * named; any other version is a super admin's (the picker). The source and any token stay on the cloud.
 *
 * Mounted at /admin/desktop before /admin (routes/index.ts).
 */
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import jwt from 'jsonwebtoken';
import { safeRouter } from '../middleware/asyncHandler';
import { requireAdmin } from '../middleware/adminAuth';
import { supabase } from '../lib/supabase';
import { isVersion, listDesktopReleasesOrStale } from '../lib/desktopReleases';
import {
  installerSource, openInstaller, installerInfo, downloadableVersions, latestVersion, NOT_CONFIGURED_MESSAGE,
} from '../lib/installerSource';

const router = safeRouter();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TICKET_TTL_S = 120;
const TICKET_PURPOSE = 'installer_download';
/** Tickets already used (jti → expiry ms). One instance's memory: a ticket is short-lived and one-use per instance. */
const usedTickets = new Map<string, number>();

function adminSecret(): string { return process.env.ADMIN_JWT_SECRET as string; }

/** The releases (GitHub list), or [] with the reason — the list is information here, never a gate on its own. */
async function releaseList(): Promise<{ versions: string[]; latest: string | null; warning: string | null }> {
  try {
    const { releases, warning } = await listDesktopReleasesOrStale();
    return { versions: downloadableVersions(releases), latest: latestVersion(releases), warning };
  } catch (e: any) {
    return { versions: [], latest: null, warning: `Could not read the releases: ${e?.message ?? e}` };
  }
}

async function approvedFor(clientId: unknown): Promise<{ id: string; name: string | null; approved: string | null } | null> {
  const id = typeof clientId === 'string' ? clientId : '';
  if (!UUID.test(id)) return null;
  const { data } = await supabase.from('businesses').select('id, name, desktop_approved_version').eq('id', id).maybeSingle();
  if (!data) return null;
  const v = (data as any).desktop_approved_version;
  return { id, name: (data as any).name ?? null, approved: isVersion(v) ? v : null };
}

/**
 * May this admin download `version`? A super admin: any. An agent: the latest release, or the version approved for the
 * client named. The answer is the reason when not.
 */
async function mayDownload(role: string, version: string, clientId: unknown): Promise<string | null> {
  if (role === 'super_admin') return null;
  const client = await approvedFor(clientId);
  if (client?.approved === version) return null;
  const { latest } = await releaseList();
  if (latest === version) return null;
  return 'Only a super admin can download a version other than the latest or the one approved for this client.';
}

async function auditDownload(req: any, version: string, fileName: string, source: string, size: number | null, client: { id: string; name: string | null } | null, via: string): Promise<void> {
  const { error } = await supabase.from('admin_audit_log').insert({
    admin_id: req.adminId, admin_email: req.adminEmail, action: 'desktop.installer.download', resource: 'desktop_installer',
    business_id: client?.id ?? null, business_name: client?.name ?? null, before_data: null,
    after_data: { version, file: fileName, source, size, via }, reason: null, ip_address: req.ip ?? null,
  });
  if (error) console.error('[admin installer] audit not written:', error.message);
}

// ── What may be downloaded ────────────────────────────────────────────────────────────────────────────────────────────
router.get('/installer', requireAdmin, async (req, res) => {
  const src = installerSource();
  const [{ versions, latest, warning }, client] = await Promise.all([releaseList(), approvedFor(req.query.client)]);
  const isSuper = req.adminRole === 'super_admin';
  res.set('Cache-Control', 'no-store');
  res.json({
    source: src.kind === 'none' ? null : src.kind,
    problem: src.kind === 'none' ? NOT_CONFIGURED_MESSAGE : null,
    warning,
    latest,
    approved: client?.approved ?? null,
    versions: isSuper ? versions : [],
    can_pick: isSuper,
  });
});

router.get('/installer/:version/info', requireAdmin, async (req, res) => {
  const version = String(req.params.version);
  if (!isVersion(version)) { res.status(400).json({ error: 'Not a version (x.y.z).', code: 'INVALID_VERSION' }); return; }
  const r = await installerInfo(version);
  if (r.ok === false) { res.status(r.status).json({ error: r.error, code: r.code }); return; }
  res.set('Cache-Control', 'no-store');
  res.json(r.info);
});

// ── A one-use link for the browser ────────────────────────────────────────────────────────────────────────────────────
router.post('/installer/:version/ticket', requireAdmin, async (req, res) => {
  const version = String(req.params.version);
  if (!isVersion(version)) { res.status(400).json({ error: 'Not a version (x.y.z).', code: 'INVALID_VERSION' }); return; }
  const client = (req.body as { client?: unknown } | undefined)?.client;
  const refusal = await mayDownload(req.adminRole, version, client);
  if (refusal) { res.status(403).json({ error: refusal, code: 'SUPER_ADMIN_REQUIRED' }); return; }
  if (installerSource().kind === 'none') { res.status(503).json({ error: NOT_CONFIGURED_MESSAGE, code: 'INSTALLER_SOURCE_NOT_CONFIGURED' }); return; }
  const ticket = jwt.sign(
    { purpose: TICKET_PURPOSE, adminId: req.adminId, email: req.adminEmail, role: req.adminRole, version,
      client: typeof client === 'string' && UUID.test(client) ? client : null, jti: crypto.randomUUID() },
    adminSecret(), { algorithm: 'HS256', expiresIn: TICKET_TTL_S });
  res.set('Cache-Control', 'no-store');
  res.json({ url: `/api/admin/desktop/installer/${version}?ticket=${encodeURIComponent(ticket)}`, expires_in: TICKET_TTL_S });
});

/** ?ticket= (a one-use link) or the admin's own token. */
async function ticketOrAdmin(req: any, res: any, next: any): Promise<void> {
  const t = req.query?.ticket;
  if (typeof t !== 'string' || !t) { await requireAdmin(req, res, next); return; }
  let p: any;
  try { p = jwt.verify(t, adminSecret(), { algorithms: ['HS256'] }); }
  catch { res.status(401).json({ error: 'This download link has expired — press Download again.', code: 'TICKET_INVALID' }); return; }
  if (p?.purpose !== TICKET_PURPOSE || !p.adminId || p.version !== String(req.params.version) || typeof p.jti !== 'string') {
    res.status(401).json({ error: 'This download link is not valid.', code: 'TICKET_INVALID' }); return;
  }
  const now = Date.now();
  for (const [k, exp] of usedTickets) if (exp < now) usedTickets.delete(k);
  if (usedTickets.has(p.jti)) { res.status(401).json({ error: 'This download link was already used — press Download again.', code: 'TICKET_USED' }); return; }
  usedTickets.set(p.jti, (Number(p.exp) || 0) * 1000 || now + TICKET_TTL_S * 1000);
  req.adminId = p.adminId; req.adminEmail = p.email; req.adminRole = p.role;
  req.installerClient = p.client ?? null;
  req.installerVia = 'link';
  next();
}

// ── The installer itself ──────────────────────────────────────────────────────────────────────────────────────────────
router.get('/installer/:version', ticketOrAdmin, async (req: any, res) => {
  const version = String(req.params.version);
  if (!isVersion(version)) { res.status(400).json({ error: 'Not a version (x.y.z).', code: 'INVALID_VERSION' }); return; }
  const clientId = req.installerClient ?? req.query.client;
  const refusal = await mayDownload(req.adminRole, version, clientId);
  if (refusal) { res.status(403).json({ error: refusal, code: 'SUPER_ADMIN_REQUIRED' }); return; }

  const opened = await openInstaller(version);
  if (opened.ok === false) { res.status(opened.status).json({ error: opened.error, code: opened.code }); return; }

  await auditDownload(req, version, opened.fileName, opened.source, opened.size, await approvedFor(clientId), req.installerVia ?? 'token');

  res.status(200);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${opened.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  if (opened.size) res.setHeader('Content-Length', String(opened.size));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Streamed: the source's body flows to the admin chunk by chunk — never held whole in memory. An admin who cancels
  // closes the response, and pipeline stops reading from the source.
  try {
    await pipeline(Readable.fromWeb(opened.body as any), res);
  } catch (e: any) {
    if (!res.headersSent) res.status(502).json({ error: 'The download stopped.' });
    else res.destroy();
    if (e?.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.warn('[admin installer] download stopped:', e?.message ?? e);
  }
});

export default router;
