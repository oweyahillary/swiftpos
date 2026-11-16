/**
 * posTestPrint.ts — a "test print" the cashier can run from the POS Printer Settings to prove a thermal printer is
 * reachable, WITHOUT ringing up a real sale.
 *
 * WHY
 * ---
 * On a Shop POS (Android) the receipt printer is a NETWORK printer named by its address ("192.168.1.50" or
 * "192.168.1.50:9100"); the app sends ESC/POS bytes to it directly (apps/android/src/shop/printing.ts → RawPrinter).
 * Until now there was no way to set that address or confirm the printer works short of completing a sale — so a new till
 * could not be checked on setup. This renders a small, obviously-a-test receipt with the SAME renderer a real receipt
 * uses (escposRenderer, built from shared/printing) and sends it down the SAME transport seam (printBytesToServer, which
 * on a Shop POS hands the bytes to RawPrinter; on a PC, to the Print Bridge). So a passing test proves the real receipt
 * path, not a toy one.
 *
 * The renderer and the transport are INJECTED (deps) so the decision logic here stays pure and unit-testable without a
 * DOM, the generated bundle, or a real printer. The Printer Settings modal passes the real `renderEscPos` and
 * `printBytesToServer`.
 */
import type { ReceiptOrder, ReceiptBusinessConfig } from './buildReceiptOrder';

export interface TestPrintOpts {
  /** The printer's network address, e.g. "192.168.1.50" or "192.168.1.50:9100" (a Windows printer name on a PC). */
  address?: string;
  paperWidth: 58 | 80;
  businessName?: string;
  footerMessage?: string;
}

export interface TestPrintDeps {
  /** escposRenderer.renderEscPos — order + business → ESC/POS bytes. */
  render: (order: ReceiptOrder, business: ReceiptBusinessConfig, paperWidth: 58 | 80) => Uint8Array;
  /** localPrintServer.printBytesToServer — bytes to the named target (RawPrinter on a Shop POS, the bridge on a PC). */
  send: (target: string, bytes: Uint8Array) => Promise<void>;
  /**
   * Print the sample THROUGH a joined branch server — the computer that holds the printer (the owner's "USB printer on a
   * PC" case). Resolves to how many of its stations printed, or null when no server is joined / it cannot be reached (then
   * we fall back to the direct address below). Omitted in a plain browser.
   */
  printViaServer?: () => Promise<{ printed: number; configured: number } | null>;
}

export type TestPrintVia = 'branch-server' | 'direct';

/** Trim and collapse the address; never throws. */
export function normalizeAddress(a?: string): string {
  return (a ?? '').trim();
}

/** A tiny, unmistakably-a-test receipt (money in CENTS, as shared/printing expects). Pure. */
export function sampleReceiptOrder(now: Date = new Date()): ReceiptOrder {
  return {
    billNumber:  'TEST',
    orderType:   'counter',
    cashierName: 'Test print',
    soldAt:      now.toISOString(),
    lines: [
      { name: 'Test item', quantity: 1, unitPrice: 10000, lineTotal: 10000, units: [], stationIds: [] },
    ],
    payments:    [{ label: 'Cash', amount: 10000 }],
    changeGiven: 0,
    total:       10000,
    kotCount:    0,
    note:        'Printer test — this is not a sale.',
  };
}

/** Minimal business config so the renderer has a name and the required tax fields. Pure. */
export function sampleBusinessConfig(name?: string, footerMessage?: string): ReceiptBusinessConfig {
  return {
    name:            (name ?? '').trim() || 'ZapTill',
    currencyCode:    'KES',
    vatRate:         0,
    ctlRate:         0,
    thankYouMessage: (footerMessage ?? '').trim() || 'Printer is working — you are set.',
  };
}

/**
 * Print a sample receipt the way a REAL receipt would be printed, so a pass proves the real path:
 *   1. through a joined branch server (the PC with the printer) when there is one — the "USB printer on a PC" case;
 *   2. otherwise straight to the network printer at `address` — the "IP printer" case.
 * Resolves with which path printed; throws with a cashier-readable reason the modal shows (an empty address with no server
 * is a friendly "enter an address", not a transport error).
 */
export async function posTestPrint(opts: TestPrintOpts, deps: TestPrintDeps): Promise<{ printer: string; via: TestPrintVia }> {
  // The branch server is where receipts really go when the tablet has joined one, so test it first.
  if (deps.printViaServer) {
    const r = await deps.printViaServer();
    if (r) {
      if (r.printed > 0) return { printer: 'the connected computer', via: 'branch-server' };
      if (r.configured === 0) {
        throw new Error('The connected computer has no receipt printer set up. Set one there, or enter a network address below.');
      }
      throw new Error('The connected computer received the test but nothing printed — check its printer is on and has paper.');
    }
    // null → no server joined / not reachable: fall through to the direct address.
  }

  const address = normalizeAddress(opts.address);
  if (!address) {
    throw new Error('Enter the printer’s network address (for example 192.168.1.50) to test it, or connect to the computer that has the printer.');
  }
  const bytes = deps.render(
    sampleReceiptOrder(),
    sampleBusinessConfig(opts.businessName, opts.footerMessage),
    opts.paperWidth,
  );
  // 'printer:' prefix: the same target shape the real receipt uses (apps/dashboard PaymentModal, A244) — on a Shop POS the
  // seam parses the address out of it; on a PC the bridge sends it to that Windows printer rather than dialling it as a host.
  await deps.send('printer:' + address, bytes);
  return { printer: address, via: 'direct' };
}
