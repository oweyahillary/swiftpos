/**
 * PaperWidthControl — one control, used on BOTH printer screens.
 *
 * There are two places to configure printing: the 🖨 modal on the POS screen and
 * the Printers tab in Manager. They had drifted, so a fix landing on one was
 * simply absent from the other — the calibration ticket existed for weeks in the
 * modal while the tab, which is where anyone actually goes to set a printer up,
 * never had it. Sharing the component makes that class of gap impossible.
 */

import { usePaperGeometry } from '../hooks/usePaperGeometry';
import type { PrinterSettings } from '../hooks/usePrinterSettings';

interface Props {
  settings: PrinterSettings;
  save: (patch: Partial<PrinterSettings>) => void;
  /** Prints the nested-bar width test to the receipt printer. */
  onWidthTest?: () => void;
  disabled?: boolean;
}

const SOURCE_STYLE: Record<string, string> = {
  driver: 'text-green-400',
  'head-spec': 'text-amber-400',
  manual: 'text-blue-400',
};

export default function PaperWidthControl({ settings, save, onWidthTest, disabled }: Props) {
  const geo = usePaperGeometry(settings, save);

  const modes: Array<{ key: 'auto' | 58 | 80; label: string }> = [
    { key: 'auto', label: 'Auto' },
    { key: 58, label: '58mm' },
    { key: 80, label: '80mm' },
  ];

  return (
    <div className="space-y-2">
      <label className="block text-sm text-gray-300">Paper width</label>

      <div className="flex rounded-lg overflow-hidden border border-gray-700">
        {modes.map(m => (
          <button
            key={String(m.key)}
            disabled={disabled}
            onClick={() => save({
              paperMode: m.key,
              // Keep the numeric width in step so anything still reading
              // settings.paperWidth directly stays consistent with the toggle.
              ...(m.key === 'auto' ? {} : { paperWidth: m.key }),
            })}
            className={`flex-1 py-2 text-sm transition-colors ${
              settings.paperMode === m.key
                ? 'bg-green-500/10 text-green-400'
                : 'bg-gray-800 text-gray-400 hover:text-white'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* What was decided and WHERE IT CAME FROM. The old toggle gave no
          feedback at all, which is how a till sat on 58mm with an 80mm roll
          in it and nobody noticed for days. */}
      <p className={`text-xs ${SOURCE_STYLE[geo.source] ?? 'text-gray-400'}`}>
        {geo.probing ? 'Reading the printer…' : geo.detail}
      </p>

      {geo.source === 'driver' && (
        <p className="text-[11px] text-gray-500">
          Printing at {geo.widthMm.toFixed(1)}mm.
        </p>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={geo.redetect}
          disabled={disabled || geo.probing || !settings.receiptPrinterName}
          className="text-xs text-gray-300 hover:text-white disabled:text-gray-600 transition-colors"
        >
          ↻ Re-detect
        </button>
        {onWidthTest && (
          <button
            onClick={onWidthTest}
            disabled={disabled || !settings.receiptPrinterName}
            className="text-xs text-gray-300 hover:text-white disabled:text-gray-600 transition-colors"
          >
            📏 Print width test
          </button>
        )}
      </div>

      <details className="pt-1">
        <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300">
          Advanced — override width
        </summary>
        <div className="mt-2 flex items-center gap-2">
          <input
            type="number" min={0} max={80} step={0.5}
            disabled={disabled}
            value={settings.printWidthMm || 0}
            onChange={e => save({ printWidthMm: Number(e.target.value) || 0 })}
            className="w-24 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-white"
          />
          <span className="text-[11px] text-gray-500 leading-tight">
            mm. 0 = use the value above. Too narrow only wastes paper;
            too wide cuts the amounts off the right.
          </span>
        </div>
      </details>
    </div>
  );
}
