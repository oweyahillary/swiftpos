/**
 * usePrinterSettings — desktop port.
 *
 * Persists thermal printer preferences in localStorage per device (each till
 * remembers its own settings independently — same model as the dashboard).
 *
 * Extended over the dashboard version with the QZ printer bindings, because
 * the desktop has no branch_printers table to read them from:
 *   receiptPrinterName — QZ printer for customer receipts ('' = browser print)
 *   kitchenPrinterName    — printer for the kitchen prep ticket
 *   dispatcherPrinterName — printer for the packing ticket ('' = feature off)
 *   kitchenEnabled     — whether "Send to kitchen" prints at all
 */

import { useState, useCallback } from 'react';

export interface PrinterSettings {
  paperWidth:         58 | 80;
  fontSize:           'small' | 'normal';
  autoCut:            boolean;
  copies:             1 | 2;             // receipts: 1 = customer, 2 = customer + merchant
  footerMessage:      string;
  receiptPrinterName: string;            // '' = use browser print dialog
  kitchenPrinterName: string;            // '' = use browser print dialog
  // '' = no packing station at this site, so the dispatcher ticket is simply
  // never produced. Unlike the others this does NOT fall back to a dialog.
  dispatcherPrinterName: string;
  kitchenEnabled:     boolean;
  /**
   * How paper width is decided.
   *
   * 'auto' asks the DRIVER (media size and imageable area) and is the default,
   * because the old 58/80 toggle was a setting the user could get wrong with no
   * feedback — a till left on 58mm laid a 48mm column onto an 80mm roll, wasted
   * a third of the paper and truncated long values, and nothing said so.
   * 58 or 80 pin it manually for printers the driver misreports.
   */
  paperMode:          'auto' | 58 | 80;
  /**
   * Last width the DRIVER reported, in mm. Cached here — rather than kept in
   * React state — because printing happens from POSPage, ManagerPage and the
   * sync path, all of which already carry `settings` and none of which can call
   * a hook. Kept SEPARATE from printWidthMm so a detected value never looks
   * like a human decision, and a human decision always wins.
   */
  detectedWidthMm:    number;
  /** Layout width override in mm. 0/undefined = use the print head width
   *  (72.07mm on 80mm paper, 48.05mm on 58mm). Set only when a calibration
   *  print shows this printer can reach further than the head spec. */
  printWidthMm:       number;
}

const STORAGE_KEY = 'swiftpos_printer_settings';

export const PRINTER_DEFAULTS: PrinterSettings = {
  paperWidth:         80,
  fontSize:           'normal',
  autoCut:            true,
  copies:             1,
  footerMessage:      'Thank you for your business!',
  receiptPrinterName: '',
  kitchenPrinterName: '',
  dispatcherPrinterName: '',
  kitchenEnabled:     true,
  printWidthMm:       0,
  paperMode:          'auto',
  detectedWidthMm:    0,
};

function load(): PrinterSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return PRINTER_DEFAULTS;
    return { ...PRINTER_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return PRINTER_DEFAULTS;
  }
}

// Non-hook accessor for code outside React (print helpers).
export function getPrinterSettings(): PrinterSettings { return load(); }

export function usePrinterSettings() {
  const [settings, setSettings] = useState<PrinterSettings>(load);

  const save = useCallback((updates: Partial<PrinterSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...updates };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setSettings(PRINTER_DEFAULTS);
  }, []);

  return { settings, save, reset };
}
