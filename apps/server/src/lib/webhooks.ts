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
import { supabase } from './supabase';

export type WebhookEvent = 'order.completed' | 'order.voided';

interface WebhookRow {
  id: string;
  url: string;
  secret_hash: string | null;
  events: string[];
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

  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 10_000); // 10s timeout

    const res = await fetch(hook.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    responseStatus = res.status;
    responseBody   = await res.text().catch(() => null);
  } catch (err: any) {
    responseStatus = null;
    responseBody   = err?.message ?? 'Request failed';
  }

  // Update delivery record with outcome
  if (delivery?.id) {
    await supabase
      .from('webhook_deliveries')
      .update({
        response_status: responseStatus,
        response_body:   responseBody?.slice(0, 1000) ?? null, // cap at 1KB
        delivered_at:    responseStatus && responseStatus < 300
          ? new Date().toISOString()
          : null,
      })
      .eq('id', delivery.id);
  }
}
