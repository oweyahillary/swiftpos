/**
 * PrinterSettingsModal
 *
 * Quick settings panel for thermal printer configuration.
 * Opened from the POS header via the 🖨 button.
 * Settings persist in localStorage per device.
 */

import { useState } from 'react';
import type { PrinterSettings } from '../../hooks/usePrinterSettings';
import { posTestPrint } from '../../lib/posTestPrint';
import { renderEscPos } from '../../lib/escposRenderer';
import { printBytesToServer } from '../../lib/localPrintServer';
import { shopPosHost, serverPrintOrder } from '../../lib/shopPos';

interface Props {
  settings: PrinterSettings;
  onSave: (updates: Partial<PrinterSettings>) => void;
  onReset: () => void;
  onClose: () => void;
  /** The business name, printed on the test receipt. */
  businessName?: string;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-gray-800 last:border-0">
      <span className="text-gray-300 text-sm">{label}</span>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function SegmentedControl<T extends string | number>({
  value, options, onChange,
}: {
  value: T;
  options: { label: string; value: T }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-lg overflow-hidden border border-gray-700">
      {options.map(opt => (
        <button
          key={String(opt.value)}
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
            value === opt.value
              ? 'bg-action-500 text-black'
              : 'bg-gray-800 text-gray-400 hover:text-white'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`relative w-10 h-5 rounded-full transition-colors ${value ? 'bg-action-500' : 'bg-gray-700'}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${value ? 'translate-x-5' : ''}`} />
    </button>
  );
}

export default function PrinterSettingsModal({ settings, onSave, onReset, onClose, businessName }: Props) {
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const runTest = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      // When this POS has joined a branch server (the PC with the printer), test THROUGH it — that is where receipts
      // really print. null from printOrder means no server is joined/reachable, so posTestPrint falls back to the address.
      const host = shopPosHost();
      const printViaServer = host
        ? () => host.printOrder('receipt', serverPrintOrder({
            orderNumber: 'TEST', orderType: 'counter', cashierName: 'Test print', total: 100,
            cart: [{ product: { id: 'test', name: 'Test item' }, quantity: 1, unitPrice: 100, lineTotal: 100 }],
            payments: [{ method: 'cash', amount: 100 }], change: 0, orderNote: 'Printer test — not a sale',
          })).catch(() => null)
        : undefined;
      const r = await posTestPrint(
        { address: settings.receiptPrinterName, paperWidth: settings.paperWidth, businessName, footerMessage: settings.footerMessage },
        { render: renderEscPos, send: printBytesToServer, printViaServer },
      );
      setTestMsg({
        ok: true,
        text: r.via === 'branch-server'
          ? 'Test receipt sent to the connected computer’s printer. Check it.'
          : `Test receipt sent to ${r.printer}. Check the printer.`,
      });
    } catch (e) {
      setTestMsg({ ok: false, text: e instanceof Error ? e.message : 'Test print failed.' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-50 animate-fade-in" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-sm shadow-2xl animate-pop-in">

          {/* Header */}
          <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
            <div>
              <h2 className="text-white font-semibold">Printer Settings</h2>
              <p className="text-gray-500 text-xs mt-0.5">Saved on this device only</p>
            </div>
            <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors text-xl">✕</button>
          </div>

          {/* Settings */}
          <div className="px-6 py-2">
            <Row label="Paper width">
              <SegmentedControl
                value={settings.paperWidth}
                options={[
                  { label: '58 mm', value: 58 as const },
                  { label: '80 mm', value: 80 as const },
                ]}
                onChange={v => onSave({ paperWidth: v as 58 | 80 })}
              />
            </Row>

            <Row label="Font size">
              <SegmentedControl
                value={settings.fontSize}
                options={[
                  { label: 'Small', value: 'small' as const },
                  { label: 'Normal', value: 'normal' as const },
                ]}
                onChange={v => onSave({ fontSize: v as 'small' | 'normal' })}
              />
            </Row>

            <Row label="Copies">
              <SegmentedControl
                value={settings.copies}
                options={[
                  { label: '1 copy', value: 1 as const },
                  { label: '2 copies', value: 2 as const },
                ]}
                onChange={v => onSave({ copies: v as 1 | 2 })}
              />
            </Row>

            <Row label="Cut marker at bottom">
              <Toggle value={settings.autoCut} onChange={v => onSave({ autoCut: v })} />
            </Row>

            <div className="py-3">
              <label className="block text-gray-300 text-sm mb-2">Footer message</label>
              <input
                type="text"
                value={settings.footerMessage}
                onChange={e => onSave({ footerMessage: e.target.value })}
                maxLength={80}
                placeholder="e.g. Asante! Karibu tena"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-action-500"
              />
              <p className="text-gray-600 text-xs mt-1">Printed at the bottom of every receipt</p>
            </div>

            <div className="py-3 border-t border-gray-800 mt-1">
              <label htmlFor="receipt-printer-addr" className="block text-gray-300 text-sm mb-2">Receipt printer</label>
              <input
                id="receipt-printer-addr"
                type="text"
                value={settings.receiptPrinterName ?? ''}
                onChange={e => { onSave({ receiptPrinterName: e.target.value }); setTestMsg(null); }}
                placeholder="e.g. 192.168.1.50"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-action-500"
              />
              <p className="text-gray-600 text-xs mt-1">
                The network address of this device’s printer. Leave blank if receipts print through a connected computer.
              </p>
              <div className="mt-3 flex items-center gap-3">
                <button
                  onClick={runTest}
                  disabled={testing}
                  className="px-4 py-2 bg-gray-800 border border-gray-700 hover:border-action-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-60"
                >
                  {testing ? 'Printing…' : 'Test print'}
                </button>
                {testMsg && (
                  <output className={`text-xs ${testMsg.ok ? 'text-action-400' : 'text-red-400'}`}>
                    {testMsg.text}
                  </output>
                )}
              </div>
            </div>
          </div>

          {/* Preview note */}
          <div className="mx-6 mb-4 bg-gray-800/60 rounded-xl px-4 py-3">
            <p className="text-gray-400 text-xs">
              <span className="text-action-400 font-medium">Tip:</span> These settings apply to this device only. Each POS or computer can have different settings. Changes take effect on the next print.
            </p>
          </div>

          {/* Footer */}
          <div className="px-6 pb-5 flex items-center gap-3">
            <button
              onClick={onReset}
              className="text-gray-600 hover:text-gray-400 text-xs transition-colors mr-auto"
            >
              Reset to defaults
            </button>
            <button
              onClick={onClose}
              className="px-5 py-2 bg-action-500 hover:bg-action-400 text-black text-sm font-semibold rounded-lg transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
