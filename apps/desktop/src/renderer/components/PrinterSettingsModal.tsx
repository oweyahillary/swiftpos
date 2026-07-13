import { useEffect, useState } from 'react';
import { usePrinterSettings } from '../hooks/usePrinterSettings';
import { posApi } from '../lib/posApi';
import type { PrinterInfo } from '../lib/posApi';
import { buildThermalDocument } from '../lib/printReceipt';

// Printer settings — per-till, persisted in localStorage.
//
// Printing is NATIVE: the printer list comes from the OS via Electron and
// silent printing goes through the main process. Nothing to install — QZ Tray
// is only needed by the web dashboard, where browsers can't print silently.

interface Props {
  isRestaurant: boolean;
  onClose: () => void;
}

export default function PrinterSettingsModal({ isRestaurant, onClose }: Props) {
  const { settings, save, reset } = usePrinterSettings();
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [testMsg, setTestMsg] = useState('');

  const loadPrinters = () => {
    setLoading(true);
    posApi.print.list()
      .then(setPrinters)
      .catch(() => setPrinters([]))
      .finally(() => setLoading(false));
  };

  useEffect(loadPrinters, []);

  const handleTest = async (printerName: string) => {
    setTestMsg('Printing test ticket…');
    const content = `
      <div style="font-family:'Courier New',monospace;font-size:12px;color:#000;line-height:1.6;">
        <p style="text-align:center;font-size:16px;font-weight:bold;">SWIFTPOS</p>
        <p style="text-align:center;">Printer test</p>
        <p style="border-top:1px dashed #000;margin:8px 0;"></p>
        <p>Printer: ${printerName}</p>
        <p>Paper: ${settings.paperWidth}mm</p>
        <p>${new Date().toLocaleString('en-KE')}</p>
        <p style="border-top:1px dashed #000;margin:8px 0;"></p>
        <p style="text-align:center;">If you can read this, you're good.</p>
      </div>`;
    try {
      const res = await posApi.print.html({
        html: buildThermalDocument(content, settings, 'Printer test', 1),
        deviceName: printerName,
        paperWidthMm: settings.paperWidth,
        copies: 1,
      });
      setTestMsg(res.ok ? `Test sent to ${printerName}` : `Test failed: ${res.error ?? 'unknown error'}`);
    } catch (err: any) {
      setTestMsg(`Test failed: ${err?.message ?? 'unknown error'}`);
    }
  };

  const printerSelect = (value: string, onChange: (name: string) => void) => (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
    >
      <option value="">Print dialog (ask every time)</option>
      {printers.map(p => (
        <option key={p.name} value={p.name}>
          {p.displayName}{p.isDefault ? ' (default)' : ''}
        </option>
      ))}
      {/* Keep a previously saved printer selectable even if it's unplugged right now */}
      {value && !printers.some(p => p.name === value) && <option value={value}>{value} (saved)</option>}
    </select>
  );

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md p-6 space-y-4 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-white font-semibold text-lg">Printers</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">✕</button>
        </div>

        {/* Source note */}
        <div className="flex items-center gap-2 bg-gray-800/60 rounded-lg px-3 py-2">
          <span className="w-2 h-2 rounded-full flex-shrink-0 bg-green-400" />
          <span className="text-xs text-gray-400">
            {loading ? 'Finding printers…' : `Built-in silent printing · ${printers.length} printer${printers.length === 1 ? '' : 's'} found`}
          </span>
          <button onClick={loadPrinters} className="ml-auto text-xs text-green-400 hover:text-green-300 flex-shrink-0">Refresh</button>
        </div>

        {/* Receipt printer */}
        <div className="space-y-1.5">
          <label className="block text-sm text-gray-300 font-medium">Receipt printer</label>
          {printerSelect(settings.receiptPrinterName, name => save({ receiptPrinterName: name }))}
          {settings.receiptPrinterName && (
            <button onClick={() => handleTest(settings.receiptPrinterName)} className="text-xs text-gray-500 hover:text-white transition-colors">
              Print test ticket
            </button>
          )}
        </div>

        {/* Kitchen printer — restaurant/café only */}
        {isRestaurant && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm text-gray-300 font-medium">Kitchen printer (KOT)</label>
              <button
                onClick={() => save({ kitchenEnabled: !settings.kitchenEnabled })}
                className={`text-xs px-2 py-0.5 rounded-md border transition-colors ${settings.kitchenEnabled ? 'border-green-500 text-green-400' : 'border-gray-700 text-gray-500'}`}
              >
                {settings.kitchenEnabled ? 'Enabled' : 'Disabled'}
              </button>
            </div>
            {settings.kitchenEnabled && (
              <>
                {printerSelect(settings.kitchenPrinterName, name => save({ kitchenPrinterName: name }))}
                {settings.kitchenPrinterName && (
                  <button onClick={() => handleTest(settings.kitchenPrinterName)} className="text-xs text-gray-500 hover:text-white transition-colors">
                    Print test ticket
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {/* Paper / copies / cut */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Paper</label>
            <div className="flex rounded-lg overflow-hidden border border-gray-700">
              {([58, 80] as const).map(w => (
                <button key={w} onClick={() => save({ paperWidth: w })}
                  className={`flex-1 py-1.5 text-xs ${settings.paperWidth === w ? 'bg-green-500/10 text-green-400' : 'bg-gray-800 text-gray-400'}`}>
                  {w}mm
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Copies</label>
            <div className="flex rounded-lg overflow-hidden border border-gray-700">
              {([1, 2] as const).map(c => (
                <button key={c} onClick={() => save({ copies: c })}
                  className={`flex-1 py-1.5 text-xs ${settings.copies === c ? 'bg-green-500/10 text-green-400' : 'bg-gray-800 text-gray-400'}`}>
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Cut marker</label>
            <button onClick={() => save({ autoCut: !settings.autoCut })}
              className={`w-full py-1.5 text-xs rounded-lg border ${settings.autoCut ? 'border-green-500 text-green-400 bg-green-500/10' : 'border-gray-700 text-gray-400 bg-gray-800'}`}>
              {settings.autoCut ? 'On' : 'Off'}
            </button>
          </div>
        </div>

        {/* Footer message */}
        <div>
          <label className="block text-xs text-gray-400 mb-1">Receipt footer</label>
          <input
            type="text" value={settings.footerMessage}
            onChange={e => save({ footerMessage: e.target.value })}
            placeholder="Thank you for your business!"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
          />
        </div>

        {testMsg && <p className="text-xs text-gray-400">{testMsg}</p>}

        <div className="flex items-center justify-between pt-1">
          <button onClick={reset} className="text-xs text-gray-600 hover:text-red-400 transition-colors">Reset to defaults</button>
          <button onClick={onClose} className="bg-green-500 hover:bg-green-400 text-gray-950 font-bold rounded-xl px-5 py-2 text-sm transition-colors">Done</button>
        </div>
      </div>
    </div>
  );
}
