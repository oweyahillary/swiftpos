/**
 * printing.ts — how the web POS screens print on a Shop POS (Till stage 1, docs/ANDROID-APP-DESIGN.md §11.4).
 *
 *   joined through a branch server → the whole ticket goes to the server, which prints it with its own stations, printers
 *                                    and spool (shop/branchServer.ts printThroughServer);
 *   no server, or it does not answer → the web POS screens render the ESC/POS bytes (shared/printing) and route them by
 *                                    station as on the web; the bytes go straight to the network printer (RawPrinter,
 *                                    one ticket at a time per printer).
 * A printer that is off is said on the screen in words (the print notice) — the sale was already saved in the cloud before
 * anything printed, so nothing is lost; the cashier reprints from History.
 */
import { RawPrinter } from '../native/plugins';
import { printThroughServer, readServerLink } from './branchServer';
import { notAnAddress, printerAddress, SERVER_NOT_ANSWERING } from './rules';
import type { PosSession } from './tillSession';

export const PRINT_PROBLEM_EVENT = 'zaptill:print-problem';

/** Tell the screen (components/PrintNotice). */
export function notePrintProblem(words: string): void {
  window.dispatchEvent(new CustomEvent<string>(PRINT_PROBLEM_EVENT, { detail: words }));
}

function base64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** ESC/POS bytes to the printer the web POS names. Throws (the web POS counts it as failed) after saying why. */
async function printBytes(target: string, bytes: Uint8Array): Promise<void> {
  const addr = printerAddress(target);
  if (!addr) { notePrintProblem(notAnAddress(target)); throw new Error(notAnAddress(target)); }
  try {
    await RawPrinter.send({ host: addr.host, port: addr.port, data: base64(bytes) });
  } catch (e) {
    const words = `${e instanceof Error ? e.message : String(e)} The sale is saved.`;
    notePrintProblem(words);
    throw new Error(words);
  }
}

let toldServerDown = 0;

/** Through the branch server when this POS joined one; null = print directly. "Not answering" is said once a minute. */
async function printOrder(job: string, order: Record<string, unknown>) {
  let said = false;   // the server's own words (a refusal, printing off there) beat the general "not answering"
  const r = await printThroughServer(job, order, (words) => { said = true; notePrintProblem(words); });
  if (r === null && !said && (await readServerLink()) && Date.now() - toldServerDown > 60_000) {
    toldServerDown = Date.now();
    notePrintProblem(SERVER_NOT_ANSWERING);
  }
  return r;
}

/** What the web POS screens are told about this POS (dashboard lib/shopPos.ts setShopPosHost). */
export function shopPosHostFor(till: PosSession) {
  return {
    terminal: { device_id: till.deviceId, terminal_code: null, device_label: till.posName },
    printBytes,
    printOrder,
  };
}

/**
 * This POS's receipt printer — the web POS screens print the after-payment receipt to the printer named in their own
 * per-device settings (apps/dashboard hooks/usePrinterSettings.ts, key 'swiftpos_printer_settings', receiptPrinterName),
 * which the web sets on its Printers page. On a Shop POS it is set here, on This device, as the printer's address.
 */
const PRINTER_SETTINGS_KEY = 'swiftpos_printer_settings';

export function readReceiptPrinter(): string {
  try { return String((JSON.parse(localStorage.getItem(PRINTER_SETTINGS_KEY) || '{}') as { receiptPrinterName?: string }).receiptPrinterName ?? ''); }
  catch { return ''; }
}

export function saveReceiptPrinter(address: string): void {
  let current: Record<string, unknown> = {};
  try { current = JSON.parse(localStorage.getItem(PRINTER_SETTINGS_KEY) || '{}') as Record<string, unknown>; } catch { current = {}; }
  localStorage.setItem(PRINTER_SETTINGS_KEY, JSON.stringify({ ...current, receiptPrinterName: address.trim() }));
}
