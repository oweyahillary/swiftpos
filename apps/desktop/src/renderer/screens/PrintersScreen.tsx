/**
 * PrintersScreen — the "Printing" destination: one left-nav item with horizontal
 * sub-tabs, so the whole print setup lives in one place (register A83, A90):
 *
 *   Stations    — StationsPanel: create/route/delete Kitchen, Dispatch, etc.,
 *                 map categories, see any category that prints nowhere.
 *   Printers    — PrinterSetupScreen: bind a printer + paper width per station
 *                 on THIS terminal, live preview, test print.
 *   Exclusions  — ExclusionsPanel: the kitchen exclusion list.
 *   Receipt     — ReceiptTextTab: the receipt header/footer text (moved in from
 *                 its own nav item — it is printer-adjacent). (A90.)
 *
 * Per-tab gating (A90): Stations/Printers/Exclusions need `stations.manage`;
 * Receipt needs `receipt.manage` || `settings.manage`. The nav item shows if the
 * user has EITHER, and each tab appears only if permitted — so a manager with
 * only receipt.manage keeps Receipt and does not gain station control.
 */

import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import type { PrinterInfo } from '../lib/posApi';
import { usePrinterSettings } from '../hooks/usePrinterSettings';
import StationsPanel from '../components/StationsPanel';
import ExclusionsPanel from '../components/ExclusionsPanel';
import PrinterSetupScreen from './PrinterSetupScreen';
import { ReceiptTextTab } from '../pages/ManageTabs';

interface Station { id: string; name: string; kind: 'kitchen' | 'dispatch' | 'receipt' }

type Tab = 'stations' | 'printers' | 'exclusions' | 'receipt';

export default function PrintersScreen({
  stations,
  canManageStations = true,
  canManageReceipt = false,
  canEdit = true,
}: {
  stations: Station[];
  canManageStations?: boolean;
  canManageReceipt?: boolean;
  canEdit?: boolean;
}) {
  const tabs: { key: Tab; label: string }[] = [
    ...(canManageStations
      ? ([
          { key: 'stations',   label: 'Stations' },
          { key: 'printers',   label: 'Printers' },
          { key: 'exclusions', label: 'Exclusions' },
        ] as { key: Tab; label: string }[])
      : []),
    ...(canManageReceipt ? ([{ key: 'receipt', label: 'Receipt' }] as { key: Tab; label: string }[]) : []),
  ];

  const [tab, setTab] = useState<Tab>(canManageStations ? 'stations' : 'receipt');
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
        {tabs.map(t => (
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

      {tab === 'stations' && canManageStations && (
        <StationsPanel printers={printers} settings={settings} save={save} canEdit={canEdit} />
      )}
      {tab === 'printers' && canManageStations && <PrinterSetupScreen stations={stations} />}
      {tab === 'exclusions' && canManageStations && <ExclusionsPanel />}
      {tab === 'receipt' && canManageReceipt && <ReceiptTextTab />}
    </div>
  );
}
