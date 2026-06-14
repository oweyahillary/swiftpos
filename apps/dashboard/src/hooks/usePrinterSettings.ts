/**
 * usePrinterSettings
 *
 * Persists thermal printer preferences in localStorage per device.
 * Each till/computer remembers its own settings independently.
 */

import { useState, useCallback } from 'react';

export interface PrinterSettings {
  paperWidth:    58 | 80;           // mm
  fontSize:      'small' | 'normal';
  autoCut:       boolean;           // print cut marker at bottom
  copies:        1 | 2;            // 1 = customer only, 2 = customer + merchant
  footerMessage: string;           // custom footer e.g. "Asante! Karibu tena"
}

const STORAGE_KEY = 'swiftpos_printer_settings';

const DEFAULTS: PrinterSettings = {
  paperWidth:    80,
  fontSize:      'normal',
  autoCut:       true,
  copies:        1,
  footerMessage: 'Thank you for your business!',
};

function load(): PrinterSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS;
  }
}

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
    setSettings(DEFAULTS);
  }, []);

  return { settings, save, reset };
}

export { DEFAULTS as PRINTER_DEFAULTS };
