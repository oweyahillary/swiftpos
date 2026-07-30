import { useEffect, useState } from 'react';
import { usePrinterSettings } from '../hooks/usePrinterSettings';
import { posApi } from '../lib/posApi';
import type { PrinterInfo } from '../lib/posApi';
import { buildThermalDocument, buildCalibrationTicket } from '../lib/printReceipt';
import PaperWidthControl from './PaperWidthControl';

// Printer settings — per-till, persisted in localStorage.
//
// Printing is NATIVE: the printer list comes from the OS via Electron and
// silent printing goes through the main process. Nothing to install — QZ Tray
// is only needed by the web dashboard, where browsers can't print silently.

interface Props {
  isRestaurant: boolean;
  onClose: () => void;
  /**
   * Whether the signed-in person may CHANGE which printer is used.
   *
   * A cashier needs to know the printer is alive and be able to fire a test at
   * it — that is ordinary shift work. Re-pointing the receipt printer is not:
   * done by accident mid-service it sends every customer's receipt to the wrong
   * station, or nowhere, and nobody notices until the queue backs up. Defaults
   * to false so a caller that forgets to pass it gets the safe behaviour.
   */
  canEdit?: boolean;
}

export default function PrinterSettingsModal({ isRestaurant, onClose, canEdit = false }: Props) {
  const { settings, save, reset } = usePrinterSettings();
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [testMsg, setTestMsg] = useState('');
  // Probe results keyed by device name. A ping, not a print — this is the thing
  // a cashier reaches for, so it must never consume paper.
  const [probes, setProbes] = useState<Record<string, { ok: boolean; state: string } | 'checking'>>({});

  const probe = async (deviceName: string) => {
    if (!deviceName) return;
    setProbes(p => ({ ...p, [deviceName]: 'checking' }));
    try {
      const result = await posApi.print.probe(deviceName);
      setProbes(p => ({ ...p, [deviceName]: result }));
    } catch {
      setProbes(p => ({ ...p, [deviceName]: { ok: false, state: 'Could not check' } }));
    }
  };

  // Probe everything that is configured whenever the printer list changes, so
  // the dots are already right when the modal opens.
  useEffect(() => {
    [settings.receiptPrinterName, settings.kitchenPrinterName, settings.dispatcherPrinterName]
      .filter(Boolean).forEach(probe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printers, settings.receiptPrinterName, settings.kitchenPrinterName, settings.dispatcherPrinterName]);

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
        <p style="text-align:center;font-size:10px;">Build v${posApi.version} &middot; ${settings.paperWidth}mm</p>
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

  // Prints a ruler so print scaling can be measured with a physical ruler
  // instead of inferred from photographs of finished receipts.
  const handleCalibrate = async (printerName: string) => {
    setTestMsg('Printing width test…');
    try {
      const res = await posApi.print.html({
        html: buildThermalDocument(
          buildCalibrationTicket(settings.paperWidth, posApi.version, settings.printWidthMm || null),
          settings, 'Width test', 1),
        deviceName: printerName,
        paperWidthMm: settings.paperWidth,
        copies: 1,
      });
      setTestMsg(res.ok
        ? 'Width test sent. The widest bar whose number still prints is the usable width — enter it below.'
        : `Width test failed: ${res.error ?? 'unknown error'}`);
    } catch (err: any) {
      setTestMsg(`Calibration failed: ${err?.message ?? 'unknown error'}`);
    }
  };

  /** Dot + one word. No sentences — the dot is the message. */
  const StatusDot = ({ deviceName }: { deviceName: string }) => {
    if (!deviceName) return null;
    const r = probes[deviceName];
    const colour = r === 'checking' ? 'text-gray-300'
      : r?.ok ? 'text-green-400'
      : r ? 'text-amber-400'
      : 'text-gray-300';
    const text = r === 'checking' ? 'Checking…' : r ? r.state : '—';
    return <span className={`text-xs ${colour}`}>● {text}</span>;
  };

  const printerSelect = (value: string, onChange: (name: string) => void) => {
    return (
      <>
        {canEdit ? (
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
        ) : (
          // Read-only: the name still shows, so a cashier can tell a manager
          // WHICH printer is wrong rather than just "printing is broken".
          <div className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-gray-200 text-sm">
            {value || 'Print dialog (ask every time)'}
          </div>
        )}
        {value && (
          <div className="flex items-center gap-3 mt-1.5">
            <StatusDot deviceName={value} />
            <button onClick={() => probe(value)}
              className="text-xs text-gray-300 hover:text-white transition-colors">
              Test connection
            </button>
            {canEdit && (
              <button onClick={() => handleTest(value)}
                className="text-xs text-gray-300 hover:text-white transition-colors">
                Print test ticket
              </button>
            )}
          </div>
        )}
      </>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md p-6 space-y-4 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-white font-semibold text-lg">Printers</h2>
          <button onClick={onClose} className="text-gray-300 hover:text-white transition-colors">✕</button>
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
          {/* Just record the choice. Paper width is settled by PaperWidthControl,
              which asks the DRIVER for its media size and imageable area. That
              used to be a guess based on whether "80" appeared in the printer's
              name — which is a coin flip on models like "TM-T88" and told us
              nothing about the printable area or its offset. */}
          {printerSelect(settings.receiptPrinterName, name => save({ receiptPrinterName: name }))}
          {settings.receiptPrinterName && (
            <button onClick={() => handleCalibrate(settings.receiptPrinterName)} className="text-xs text-gray-300 hover:text-white transition-colors mr-3">
              📏 Calibration ruler
            </button>
          )}
          {settings.receiptPrinterName && (
            <button onClick={() => handleTest(settings.receiptPrinterName)} className="text-xs text-gray-300 hover:text-white transition-colors">
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
                onClick={() => canEdit && save({ kitchenEnabled: !settings.kitchenEnabled })}
                disabled={!canEdit}
                className={`text-xs px-2 py-0.5 rounded-md border transition-colors ${settings.kitchenEnabled ? 'border-green-500 text-green-400' : 'border-gray-700 text-gray-300'} ${!canEdit ? 'opacity-70 cursor-default' : ''}`}
              >
                {settings.kitchenEnabled ? 'Enabled' : 'Disabled'}
              </button>
            </div>
            {settings.kitchenEnabled && (
              <>
                {printerSelect(settings.kitchenPrinterName, name => save({ kitchenPrinterName: name }))}
              </>
            )}
          </div>
        )}

        {/* Dispatcher printer — the packing ticket. Restaurant/café only.
            Leaving it blank means this site has no packing station, and the
            ticket is simply never produced. */}
        {isRestaurant && (
          <div className="space-y-1.5">
            <label className="block text-sm text-gray-300 font-medium">Dispatcher printer (packing)</label>
            {printerSelect(settings.dispatcherPrinterName, name => save({ dispatcherPrinterName: name }))}
            {canEdit && (
              <p className="text-xs text-gray-400">
                Lists every item with combos broken into components, no prices. Leave blank if this branch doesn't pack orders separately.
              </p>
            )}
          </div>
        )}

        {/* Paper / copies / cut / footer are configuration, not shift work —
            hidden entirely rather than shown disabled, which would only invite
            "why can't I press this" during service. */}
        {canEdit && (
          <PaperWidthControl settings={settings} save={save} onWidthTest={() => handleCalibrate(settings.receiptPrinterName)} />
        )}

        {canEdit && (
        <div className="grid grid-cols-2 gap-3">
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

        )}

        {canEdit && (
        <div>
          <label className="block text-xs text-gray-400 mb-1">Receipt footer</label>
          <input
            type="text" value={settings.footerMessage}
            onChange={e => save({ footerMessage: e.target.value })}
            placeholder="Thank you for your business!"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500"
          />
        </div>
        )}

        {testMsg && <p className="text-xs text-gray-400">{testMsg}</p>}

        <div className="flex items-center justify-between pt-1">
          {canEdit
            ? <button onClick={reset} className="text-xs text-gray-400 hover:text-red-400 transition-colors">Reset to defaults</button>
            : <span />}
          <button onClick={onClose} className="bg-green-500 hover:bg-green-400 text-gray-950 font-bold rounded-xl px-5 py-2 text-sm transition-colors">Done</button>
        </div>
      </div>
    </div>
  );
}
