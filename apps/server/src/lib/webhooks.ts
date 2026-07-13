/**
 * webhooks.ts  — Outbound webhook dispatcher
 *
 * Fires signed HTTP POST requests to every active webhook URL registered
 * for a business when an event occurs.
 *
 * Events fired:
 *   order.completed  — after a successful sale (pay-first or order-first)
 *   order.voided     — after an order is voided
 *
 * Each delivery is logged in webhook_deliveries with status + response.
 * Failures are logged but never block the main request.
 *
 * Signature:
 *   X-SwiftPOS-Signature: sha256=<hmac-sha256 of raw body using secret_hash>
 *   X-SwiftPOS-Event: order.completed
 *   X-SwiftPOS-Delivery: <webhook_delivery_id>
 */

import crypto  from 'crypto';
import dns     from 'node:dns';
import net     from 'node:net';
import { supabase } from './supabase';

export type WebhookEvent = 'order.completed' | 'order.voided';

interface WebhookRow {
  id: string;
  url: string;
  secret_hash: string | null;
  events: string[];
}

// ── SSRF guard ────────────────────────────────────────────────────────────────
// Webhook URLs are user-supplied. Without validation, an owner could point one at
// internal infrastructure (localhost, private ranges) or the cloud metadata
// endpoint (169.254.169.254) and use our server as a proxy into the network.
// We require https, resolve the host, and reject any private/loopback/link-local
// target. Redirects are disabled at fetch time so a public URL can't 302 to an
// internal one.

function ipv4ToLong(ip: string): number {
  return ip.split('.').reduce((acc, o) => ((acc << 8) + parseInt(o, 10)) >>> 0, 0) >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToLong(ip);
  const inRange = (base: string, bits: number) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToLong(base) & mask);
  };
  return (
    inRange('10.0.0.0', 8)     || // private
    inRange('172.16.0.0', 12)  || // private
    inRange('192.168.0.0', 16) || // private
    inRange('127.0.0.0', 8)    || // loopback
    inRange('169.254.0.0', 16) || // link-local (incl. 169.254.169.254 metadata)
    inRange('0.0.0.0', 8)      || // "this" network
    inRange('100.64.0.0', 10)     // CGNAT
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;      // loopback / unspecified
  if (/^f[cd]/.test(lower)) return true;                    // fc00::/7 unique-local
  if (/^fe[89ab]/.test(lower)) return true;                 // fe80::/10 link-local
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

/** Throws if the URL is not a safe outbound target. Exported for reuse by the
 *  webhook test-ping route so it gets the same SSRF protection as delivery. */
export async function assertSafeWebhookUrl(rawUrl: string): Promise<void> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new Error('invalid URL'); }
  if (u.protocol !== 'https:') throw new Error('must use https');

  const host = u.hostname;
  let ips: string[];
  if (net.isIP(host)) {
    ips = [host];
  } else {
    const resolved = await dns.promises.lookup(host, { all: true });
    ips = resolved.map(r => r.address);
    if (ips.length === 0) throw new Error('host did not resolve');
  }
  for (const ip of ips) {
    const blocked = net.isIP(ip) === 6 ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
    if (blocked) throw new Error(`resolves to blocked address ${ip}`);
  }
}

/**
 * fireWebhook — call this after a successful order completion or void.
 * It is always non-blocking: errors are caught and logged, never thrown.
 *
 * @param businessId  The business that owns the order
 * @param event       'order.completed' | 'order.voided'
 * @param payload     The data to POST (order summary)
 */
export async function fireWebhook(
  businessId: string,
  event: WebhookEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    // 1. Fetch all active webhooks that subscribe to this event
    const { data: hooks, error } = await supabase
      .from('webhooks')
      .select('id, url, secret_hash, events')
      .eq('business_id', businessId)
      .eq('status', 'active');

    if (error || !hooks?.length) return;

    const interested = hooks.filter((h: WebhookRow) =>
      Array.isArray(h.events) && h.events.includes(event)
    );
    if (!interested.length) return;

    const body = JSON.stringify({
      event,
      created_at: new Date().toISOString(),
      data: payload,
    });

    // 2. Fire each webhook in parallel — non-blocking
    await Promise.allSettled(
      interested.map((hook: WebhookRow) => deliverOne(hook, event, body))
    );
  } catch {
    // Never let webhook errors propagate
  }
}

async function deliverOne(
  hook: WebhookRow,
  event: WebhookEvent,
  body: string,
): Promise<void> {
  // Create delivery record first so we have an ID for the header
  const { data: delivery } = await supabase
    .from('webhook_deliveries')
    .insert({
      webhook_id:    hook.id,
      event,
      payload:       JSON.parse(body),
      attempt_count: 1,
    })
    .select('id')
    .single();

  const deliveryId = delivery?.id ?? crypto.randomUUID();

  // Build headers
  const headers: Record<string, string> = {
    'Content-Type':        'application/json',
    'X-SwiftPOS-Event':    event,
    'X-SwiftPOS-Delivery': deliveryId,
  };

  // Sign payload if a secret is configured
  if (hook.secret_hash) {
    const sig = crypto
      .createHmac('sha256', hook.secret_hash)
      .update(body)
      .digest('hex');
    headers['X-SwiftPOS-Signature'] = `sha256=${sig}`;
  }

  let responseStatus: number | null = null;
  let responseBody:   string | null = null;
  let attempts = 0;

  // SSRF guard runs once — an unsafe URL is a hard fail, never retried.
  let urlSafe = true;
  try {
    await assertSafeWebhookUrl(hook.url);
  } catch (err: any) {
    urlSafe = false;
    responseBody = `Blocked: ${err?.message ?? 'unsafe URL'}`;
  }

  // Deliver with a bounded retry + backoff. Retries only on network errors or
  // 5xx (transient); a 4xx is the receiver rejecting us, so we stop. Receivers
  // must be idempotent — every attempt carries the same X-SwiftPOS-Delivery id.
  const MAX_ATTEMPTS = 3;
  if (urlSafe) {
    for (attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
      try {
        const controller = new AbortController();
        const timeout    = setTimeout(() => controller.abort(), 10_000); // 10s timeout

        const res = await fetch(hook.url, {
          method:   'POST',
          headers,
          body,
          redirect: 'error', // a public URL must not 302 to an internal one
          signal:   controller.signal,
        });

        clearTimeout(timeout);
        responseStatus = res.status;
        responseBody   = await res.text().catch(() => null);

        if (res.status < 500) break; // delivered (2xx) or rejected (4xx) — done
      } catch (err: any) {
        responseStatus = null;
        responseBody   = err?.message ?? 'Request failed';
      }
      // Backoff before the next attempt (0.5s, then 1.5s).
      if (attempts < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, attempts * 500));
      }
    }
  }

  // Update delivery record with outcome
  if (delivery?.id) {
    await supabase
      .from('webhook_deliveries')
      .update({
        attempt_count:   Math.max(attempts, 1),
        response_status: responseStatus,
        response_body:   responseBody?.slice(0, 1000) ?? null, // cap at 1KB
        delivered_at:    responseStatus && responseStatus < 300
          ? new Date().toISOString()
          : null,
      })
      .eq('id', delivery.id);
  }
}
