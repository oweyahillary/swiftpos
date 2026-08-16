/**
 * PrintersScreen — one "Printers" destination with horizontal sub-tabs, so the
 * whole print setup lives under a single left-nav item (register A83):
 *
 *   Stations    — StationsPanel: create/route/delete Kitchen, Grill, Dispatch,
 *                 map categories, and see any category that prints nowhere. This
 *                 was orphaned when PrinterSetupScreen superseded PrintersTab —
 *                 only printer-binding and exclusions were ported, so station
 *                 management became unreachable. Restored here.
 *   Printers    — PrinterSetupScreen: bind a printer + paper width to each
 *                 station on THIS terminal, live preview, test print.
 *   Exclusions  — ExclusionsPanel: the kitchen exclusion list (dispatcher list
 *                 lands here in Phase 2).
 */

import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import type { PrinterInfo } from '../lib/posApi';
import { usePrinterSettings } from '../hooks/usePrinterSettings';
import StationsPanel from '../components/StationsPanel';
import ExclusionsPanel from '../components/ExclusionsPanel';
import PrinterSetupScreen from './PrinterSetupScreen';

interface Station { id: string; name: string; kind: 'kitchen' | 'dispatch' | 'receipt' }

type Tab = 'stations' | 'printers' | 'exclusions';
const TABS: { key: Tab; label: string }[] = [
  { key: 'stations',   label: 'Stations' },
  { key: 'printers',   label: 'Printers' },
  { key: 'exclusions', label: 'Exclusions' },
];

export default function PrintersScreen({ stations, canEdit = true }: { stations: Station[]; canEdit?: boolean }) {
  const [tab, setTab] = useState<Tab>('stations');
  const { settings, save } = usePrinterSettings();
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);

  useEffect(() => {
    void (async () => {
      try { setPrinters(await posApi.print.list()); } catch { /* picker degrades to free text */ }
    })();
  }, []);

  return (
    <div>
      <div className="flex gap-1 border-b border-gray-800 mb-5">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 transition-colors ${
              tab === t.key
                ? 'border-green-500 text-white'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'stations' && (
        <StationsPanel printers={printers} settings={settings} save={save} canEdit={canEdit} />
      )}
      {tab === 'printers' && <PrinterSetupScreen stations={stations} />}
      {tab === 'exclusions' && <ExclusionsPanel />}
    </div>
  );
}
