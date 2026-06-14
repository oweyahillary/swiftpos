/**
 * usePrinterSettings — desktop port.
 *
 * Persists thermal printer preferences in localStorage per device (each till
 * remembers its own settings independently — same model as the dashboard).
 *
 * Extended over the dashboard version with the QZ printer bindings, because
 * the desktop has no branch_printers table to read them from:
 *   receiptPrinterName — QZ printer for customer receipts ('' = browser print)
 *   kitchenPrinterName — QZ printer for KOTs ('' = browser print)
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
  kitchenEnabled:     boolean;
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
  kitchenEnabled:     true,
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
