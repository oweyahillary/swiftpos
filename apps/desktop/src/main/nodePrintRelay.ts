/**
 * nodePrintRelay.ts — POST /node/print: a Shop POS tablet prints through its branch server (Till stage 1,
 * docs/ANDROID-APP-DESIGN.md §11).
 *
 * Owner, 2026-11-05: the branch server is there "so that printing can be easier". A tablet that joined this server sends
 * the whole ticket — the same order the desktop's own sale screen prints — and the server prints it exactly as it prints
 * its own sales: ITS stations and category routing, ITS printer assignments (a USB printer on the server PC included) and
 * ITS spool, one queue per printer (printWorker), so two tablets printing at once never garble a ticket. Printers are set
 * up once, on the server.
 *
 * Nothing new prints here: every job goes through queueThermal (ipc/shared.ts → escposBridge.printSale → printWorker),
 * the desktop's own path, unchanged. The route is authenticated like every /node/* call a POS makes (the branch access
 * code, and the device key the tablet got when the server allowed it to join — nodeServer.ts); this module only checks
 * the job and words the answer for the tablet's screen.
 */

/** What a tablet asks the server to print. */
export type RelayJob = 'receipt' | 'kitchen' | 'proforma' | 'void';
const JOBS: ReadonlySet<string> = new Set(['receipt', 'kitchen', 'proforma', 'void']);

/** A ticket's lines — far more than any real order, so a bad request cannot keep the spool busy. */
export const MAX_RELAY_LINES = 300;

type Kind = 'kitchen' | 'dispatch' | 'receipt';

export interface RelayDeps {
  queueThermal: (payload: any, kinds: Kind[], reprint?: { at: Date; count: number }, proforma?: boolean) => { skipped: string[]; failed: string[] };
  escposEnabled: () => boolean;
  /** Print bill is part of the online licence on the desktop (escpos:printBill) — the same for a tablet's. Throws when off. */
  requireOnlineLicence: () => void;
}

export interface RelayAnswer {
  status: number;
  body: { ok: boolean; skipped: string[]; failed: string[]; problem: string | null };
}

const refuse = (status: number, problem: string): RelayAnswer => ({ status, body: { ok: false, skipped: [], failed: [], problem } });

/** The stations each job prints on, and whether it is a proforma bill — the desktop's own choices (ipc/sale.ts, kitchen.ts). */
function kindsOf(job: RelayJob): { kinds: Kind[]; proforma: boolean } {
  if (job === 'receipt') return { kinds: ['receipt'], proforma: false };
  if (job === 'proforma') return { kinds: ['receipt'], proforma: true };
  return { kinds: ['kitchen', 'dispatch'], proforma: false };   // the kitchen fire, and a kitchen VOID
}

/** The order as printed: a bill is never a receipt (no number, no payments — escpos:printBill's own rule). */
function orderFor(job: RelayJob, order: Record<string, unknown>): Record<string, unknown> {
  if (job === 'proforma') return { ...order, order_number: '', payments: [], change_given: 0, tip_amount: 0, kitchen_void: undefined };
  if (job === 'void') return order;
  return { ...order, kitchen_void: undefined };   // only a 'void' job prints under the VOID banner
}

/** Words for the tablet's screen when something did not print. null = everything printed. */
export function relayProblem(skipped: string[], failed: string[]): string | null {
  const parts: string[] = [];
  if (skipped.length) parts.push(`No printer on the branch server for: ${skipped.join(', ')}.`);
  if (failed.length) parts.push(`The branch server could not print: ${failed.join(', ')}.`);
  return parts.length ? `${parts.join(' ')} The sale is saved.` : null;
}

/** Print one tablet's job through this server's own print path. Never throws. */
export function relayPrint(body: unknown, deps: RelayDeps): RelayAnswer {
  const b = (body ?? {}) as { job?: unknown; order?: unknown };
  const job = String(b.job ?? '');
  if (!JOBS.has(job)) return refuse(400, 'Unknown print job.');
  const order = b.order;
  if (!order || typeof order !== 'object' || Array.isArray(order)) return refuse(400, 'No order to print.');
  const items = (order as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_RELAY_LINES) return refuse(400, 'The order has no lines to print.');
  if (job === 'void' && !(order as { kitchen_void?: unknown }).kitchen_void) return refuse(400, 'A void ticket needs the void.');
  if (job === 'proforma') {
    try { deps.requireOnlineLicence(); }
    catch { return refuse(403, 'Print bill is part of the ZapTill online licence.'); }
  }
  if (!deps.escposEnabled()) return refuse(409, 'Printing is off on the branch server — turn it on under 🖨 Printer settings there. The sale is saved.');
  const { kinds, proforma } = kindsOf(job as RelayJob);
  try {
    const r = deps.queueThermal(orderFor(job as RelayJob, order as Record<string, unknown>), kinds, undefined, proforma);
    const problem = relayProblem(r.skipped, r.failed);
    return { status: 200, body: { ok: !problem, skipped: r.skipped, failed: r.failed, problem } };
  } catch {
    return refuse(500, 'The branch server could not print this ticket — see its log. The sale is saved.');
  }
}

// ── The server's print path, registered once at start (ipcHandlers.ts) — nodeServer.ts has no IPC context of its own ──
let deps: RelayDeps | null = null;
export function setRelayPrinter(d: RelayDeps | null): void { deps = d; }
export function relayPrinter(): RelayDeps | null { return deps; }
