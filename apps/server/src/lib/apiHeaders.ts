/**
 * apiHeaders.ts — the security headers on every answer (helmet), for a JSON API.
 *
 * A528: this server serves JSON (and CSV / spreadsheet downloads) only — no HTML page; the dashboard and the admin portal
 * are on Vercel. helmet's defaults are for HTML documents and added ~1.2 KB to EVERY answer, and every till asks several
 * routes every 20 s (Render suspended production over bandwidth, 2026-10-19). The headers that mean nothing on a JSON
 * answer are off: content-security-policy, cross-origin-opener-policy, origin-agent-cluster, x-dns-prefetch-control,
 * x-download-options, x-permitted-cross-domain-policies, x-xss-protection. Kept: strict-transport-security,
 * x-content-type-options (nosniff: a JSON or CSV answer is never sniffed into a page), cross-origin-resource-policy
 * (cross-origin: the dashboard reads it), referrer-policy, x-frame-options; x-powered-by stays removed.
 */
import helmet from 'helmet';

export function apiHelmet() {
  return helmet({
    crossOriginResourcePolicy:     { policy: 'cross-origin' },
    contentSecurityPolicy:         false,
    crossOriginOpenerPolicy:       false,
    crossOriginEmbedderPolicy:     false,
    originAgentCluster:            false,
    xDnsPrefetchControl:           false,
    xDownloadOptions:              false,
    xPermittedCrossDomainPolicies: false,
    xXssProtection:                false,
  });
}
