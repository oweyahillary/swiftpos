/**
 * transferReceipt.ts — A608 part 3 (owner, 2026-10-30: of the retired manager portal's features, receiving a transfer
 * line by line is the one the dashboard needs): what arrived of each line of a transfer. Each line starts at what was sent
 * and may be lowered to 0 — never below 0, never above what was sent, never a word. The cloud checks the same
 * (routes/stock.ts PATCH /transfers/:id/status, received_items) and records only what arrived; this gives the clearer
 * message first. Pure — Stock › Transfers (StockTransfersPage.tsx) and its test read it.
 */
export interface SentLine { product_id: string; quantity: number | string; name?: string | null }

/** The receive step's first values: each line at what was sent. */
export function receiptSeed(items: readonly SentLine[]): Record<string, string> {
  const seed: Record<string, string> = {};
  for (const it of items) seed[it.product_id] = String(Number(it.quantity) || 0);
  return seed;
}

/** What arrived, line by line — each 0..sent — or why not. */
export function receiptLines(items: readonly SentLine[], entered: Readonly<Record<string, string>>):
  { ok: true; received_items: Array<{ product_id: string; quantity_received: number }> } | { ok: false; error: string } {
  const received_items: Array<{ product_id: string; quantity_received: number }> = [];
  for (const it of items) {
    const sent = Number(it.quantity) || 0;
    const raw = String(entered[it.product_id] ?? '').trim();
    const got = raw === '' ? NaN : Number(raw);
    if (!Number.isFinite(got) || got < 0 || got > sent) {
      return { ok: false, error: `${it.name ?? 'An item'}: received must be between 0 and ${sent} (sent).` };
    }
    received_items.push({ product_id: it.product_id, quantity_received: got });
  }
  return { ok: true, received_items };
}
