/**
 * routes/webhooks.ts
 *
 * CRUD for webhook endpoints + delivery history.
 *
 * GET    /api/webhooks                     — list all webhooks for business
 * POST   /api/webhooks                     — create webhook
 * PATCH  /api/webhooks/:id                 — update (url, events, status)
 * DELETE /api/webhooks/:id                 — delete
 * GET    /api/webhooks/:id/deliveries      — delivery log (last 50)
 * POST   /api/webhooks/:id/test            — send a test ping
 */

import { Router }      from 'express';
import { sendError } from '../lib/sendError';
import { assertSafeWebhookUrl } from '../lib/webhooks';
import { safeRouter } from '../middleware/asyncHandler';
import crypto          from 'crypto';
import { supabase }    from '../lib/supabase';
import { requireAuth } from '../middleware/auth';

const router = safeRouter();
router.use(requireAuth);

const VALID_EVENTS = ['order.completed', 'order.voided'];

// GET /api/webhooks
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('webhooks')
    .select('id, url, events, status, created_at, updated_at')
    .eq('business_id', req.businessId)
    .order('created_at', { ascending: false });

  if (error) { sendError(res, error); return; }
  res.json(data ?? []);
});

// POST /api/webhooks
router.post('/', async (req, res) => {
  const { url, events = ['order.completed'] } = req.body;

  if (!url?.trim()) { res.status(400).json({ error: 'url is required' }); return; }

  const invalid = events.filter((e: string) => !VALID_EVENTS.includes(e));
  if (invalid.length) {
    res.status(400).json({ error: `Invalid events: ${invalid.join(', ')}. Valid: ${VALID_EVENTS.join(', ')}` });
    return;
  }

  // Generate a signing secret for this endpoint
  const secret = `whsec_${crypto.randomBytes(24).toString('hex')}`;

  const { data, error } = await supabase
    .from('webhooks')
    .insert({
      business_id: req.businessId,
      url:         url.trim(),
      events,
      secret_hash: secret,
      status:      'active',
    })
    .select()
    .single();

  if (error) { sendError(res, error); return; }

  // Return the secret once — it won't be shown again
  res.status(201).json({ ...data, secret });
});

// PATCH /api/webhooks/:id
router.patch('/:id', async (req, res) => {
  const { url, events, status } = req.body;
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (url !== undefined)    updates.url    = url.trim();
  if (status !== undefined) updates.status = status;
  if (events !== undefined) {
    const invalid = events.filter((e: string) => !VALID_EVENTS.includes(e));
    if (invalid.length) {
      res.status(400).json({ error: `Invalid events: ${invalid.join(', ')}` });
      return;
    }
    updates.events = events;
  }

  const { data, error } = await supabase
    .from('webhooks')
    .update(updates)
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .select()
    .single();

  if (error) { sendError(res, error); return; }
  if (!data) { res.status(404).json({ error: 'Webhook not found' }); return; }
  res.json(data);
});

// DELETE /api/webhooks/:id
router.delete('/:id', async (req, res) => {
  const { error } = await supabase
    .from('webhooks')
    .delete()
    .eq('id', req.params.id)
    .eq('business_id', req.businessId);

  if (error) { sendError(res, error); return; }
  res.status(204).send();
});

// GET /api/webhooks/:id/deliveries
router.get('/:id/deliveries', async (req, res) => {
  // Confirm the webhook belongs to this business
  const { data: hook } = await supabase
    .from('webhooks')
    .select('id')
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .single();

  if (!hook) { res.status(404).json({ error: 'Webhook not found' }); return; }

  const { data, error } = await supabase
    .from('webhook_deliveries')
    .select('id, event, response_status, response_body, attempt_count, delivered_at, created_at')
    .eq('webhook_id', req.params.id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) { sendError(res, error); return; }
  res.json(data ?? []);
});

// POST /api/webhooks/:id/test
// Sends a test ping so the owner can verify their endpoint is reachable
router.post('/:id/test', async (req, res) => {
  const { data: hook } = await supabase
    .from('webhooks')
    .select('id, url, secret_hash')
    .eq('id', req.params.id)
    .eq('business_id', req.businessId)
    .single();

  if (!hook) { res.status(404).json({ error: 'Webhook not found' }); return; }

  const body = JSON.stringify({
    event:      'ping',
    created_at: new Date().toISOString(),
    data:       { message: 'SwiftPOS webhook test ping', business_id: req.businessId },
  });

  const headers: Record<string, string> = {
    'Content-Type':     'application/json',
    'X-SwiftPOS-Event': 'ping',
  };

  if (hook.secret_hash) {
    const sig = crypto.createHmac('sha256', hook.secret_hash).update(body).digest('hex');
    headers['X-SwiftPOS-Signature'] = `sha256=${sig}`;
  }

  // SSRF guard — same protection the delivery path uses. Never fetch an
  // internal/private target even for a test ping.
  try {
    await assertSafeWebhookUrl(hook.url);
  } catch (e: any) {
    res.json({ success: false, error: `Webhook URL not allowed: ${e?.message ?? 'unsafe URL'}` });
    return;
  }

  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(hook.url, {
      method: 'POST', headers, body,
      redirect: 'error', // don't follow a redirect to an internal target
      signal: controller.signal,
    });
    res.json({ success: response.ok, status: response.status });
  } catch (err: any) {
    // This error describes the OWNER'S OWN endpoint (connection refused, TLS,
    // timeout) — it's the point of a test ping and contains no SwiftPOS
    // internals, so it's safe (and useful) to surface here.
    console.error('[webhooks] test ping failed:', err?.message ?? err);
    res.json({ success: false, error: err?.message ?? 'Delivery failed' });
  }
});

export default router;
