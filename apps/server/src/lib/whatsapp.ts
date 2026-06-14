// SwiftPOS — WhatsApp receipt sender.
//
// Same pattern as lib/etims: a provider seam selected by env, so the delivery
// mechanism is swappable and nothing in the order flow knows the details.
//   WHATSAPP_PROVIDER = 'none'   -> NullProvider (default; nothing is sent)
//   WHATSAPP_PROVIDER = 'cloud'  -> Meta WhatsApp Cloud API
//   WHATSAPP_PROVIDER = 'twilio' -> Twilio WhatsApp
//
// ⚠️ EXTERNAL DEPENDENCY — like the KRA sandbox, actually delivering a message
// needs credentials you must provision:
//   • Cloud API: a Meta app + WhatsApp Business number + WHATSAPP_TOKEN +
//     WHATSAPP_PHONE_ID, and (because a receipt is business-initiated) a
//     PRE-APPROVED message template. Free-form text only works inside a 24h
//     customer-service window, which a receipt usually isn't — so we send a
//     template message by default.
//   • Twilio: account SID + auth token + a WhatsApp-enabled from number.
// The HTTP shapes below follow each provider's documented API, but VERIFY your
// template name/params against your approved template before go-live.

export interface WhatsAppMessage {
  toPhone: string;          // E.164-ish; we normalise common KE formats
  templateName: string;     // approved template (Cloud API) — e.g. 'receipt'
  bodyParams: string[];     // ordered template variables, e.g. [business, total, receiptUrl]
  fallbackText: string;     // used by providers that send free-form (Twilio)
}

export interface WhatsAppResult { providerId: string; raw: unknown; }

export interface WhatsAppProvider {
  readonly name: string;
  send(msg: WhatsAppMessage): Promise<WhatsAppResult>;
}

export class WhatsAppNotConfiguredError extends Error {
  constructor(m = 'WhatsApp provider not configured') { super(m); this.name = 'WhatsAppNotConfiguredError'; }
}

// Normalise a Kenyan number to international format without '+': 07XX… -> 2547XX…
export function normalisePhone(raw: string): string {
  const d = (raw || '').replace(/[^\d]/g, '');
  if (d.startsWith('0')) return '254' + d.slice(1);
  if (d.startsWith('254')) return d;
  if (d.startsWith('7') || d.startsWith('1')) return '254' + d;
  return d;
}

class NullProvider implements WhatsAppProvider {
  readonly name = 'none';
  async send(): Promise<WhatsAppResult> { throw new WhatsAppNotConfiguredError(); }
}

// Meta WhatsApp Cloud API — sends an approved template message.
class CloudProvider implements WhatsAppProvider {
  readonly name = 'cloud';
  private token = process.env.WHATSAPP_TOKEN ?? '';
  private phoneId = process.env.WHATSAPP_PHONE_ID ?? '';
  private lang = process.env.WHATSAPP_TEMPLATE_LANG ?? 'en';

  async send(msg: WhatsAppMessage): Promise<WhatsAppResult> {
    if (!this.token || !this.phoneId) throw new WhatsAppNotConfiguredError('WHATSAPP_TOKEN/PHONE_ID not set');
    const url = `https://graph.facebook.com/v21.0/${this.phoneId}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      to: normalisePhone(msg.toPhone),
      type: 'template',
      template: {
        name: msg.templateName,
        language: { code: this.lang },
        components: [{
          type: 'body',
          parameters: msg.bodyParams.map(t => ({ type: 'text', text: t })),
        }],
      },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`WhatsApp Cloud API ${res.status}: ${json?.error?.message ?? res.statusText}`);
    return { providerId: json?.messages?.[0]?.id ?? '', raw: json };
  }
}

// Twilio WhatsApp — sends free-form text (the fallbackText).
class TwilioProvider implements WhatsAppProvider {
  readonly name = 'twilio';
  private sid = process.env.TWILIO_ACCOUNT_SID ?? '';
  private token = process.env.TWILIO_AUTH_TOKEN ?? '';
  private from = process.env.TWILIO_WHATSAPP_FROM ?? '';   // e.g. 'whatsapp:+14155238886'

  async send(msg: WhatsAppMessage): Promise<WhatsAppResult> {
    if (!this.sid || !this.token || !this.from) throw new WhatsAppNotConfiguredError('TWILIO_* not set');
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Messages.json`;
    const form = new URLSearchParams({
      From: this.from,
      To: `whatsapp:+${normalisePhone(msg.toPhone)}`,
      Body: msg.fallbackText,
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.sid}:${this.token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${json?.message ?? res.statusText}`);
    return { providerId: json?.sid ?? '', raw: json };
  }
}

let _provider: WhatsAppProvider | null = null;
export function getWhatsAppProvider(): WhatsAppProvider {
  if (_provider) return _provider;
  switch ((process.env.WHATSAPP_PROVIDER ?? 'none').toLowerCase()) {
    case 'cloud':  _provider = new CloudProvider(); break;
    case 'twilio': _provider = new TwilioProvider(); break;
    default:       _provider = new NullProvider();
  }
  return _provider;
}

export function whatsAppEnabledGlobally(): boolean {
  return (process.env.WHATSAPP_PROVIDER ?? 'none').toLowerCase() !== 'none';
}

// High-level: send a receipt for an order and log the attempt. Never throws to
// the caller — a delivery failure must not affect the sale. `supabase` is passed
// in to avoid a circular import with the route layer.
export async function sendReceiptWhatsApp(
  supabase: any,
  args: { businessId: string; orderId: string; toPhone: string; businessName: string; total: string; receiptText: string; templateName?: string },
): Promise<void> {
  const provider = getWhatsAppProvider();
  const insertLog = async (status: string, providerId?: string, error?: string) => {
    await supabase.from('whatsapp_deliveries').insert({
      business_id: args.businessId, order_id: args.orderId, to_phone: args.toPhone,
      status, provider_id: providerId ?? null, error: error ?? null,
    });
  };

  try {
    const result = await provider.send({
      toPhone: args.toPhone,
      templateName: args.templateName ?? 'receipt',
      bodyParams: [args.businessName, args.total],
      fallbackText: args.receiptText,
    });
    await insertLog('sent', result.providerId);
  } catch (err: any) {
    if (err instanceof WhatsAppNotConfiguredError) await insertLog('skipped');
    else { await insertLog('failed', undefined, err?.message); console.error('[whatsapp] send failed:', err?.message); }
  }
}
