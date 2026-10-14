/**
 * DownloadExcelButton — "Download Excel" on a report tab (A467). Saves exactly what the tab shows for the chosen
 * period and branch (see lib/reportDownload.ts). Disabled while the tab loads, while the file is being made, or when
 * the tab has nothing to download. Works on a phone: the browser saves the .xlsx like any download.
 */
import { useState } from 'react';
import { downloadReport, reportIsEmpty, type ReportDownloadInput } from '../lib/reportDownload';

export default function DownloadExcelButton({ input, loading = false }: { input: ReportDownloadInput | null; loading?: boolean }) {
  const [busy, setBusy] = useState(false);
  const empty = !input || reportIsEmpty(input.sheets);
  return (
    <button type="button" data-testid="report-download"
      disabled={loading || busy || empty}
      title={empty ? 'Nothing to download for this period' : 'Download what this tab shows as an Excel workbook'}
      onClick={async () => {
        if (!input) return;
        setBusy(true);
        try { await downloadReport(input); }
        catch (e: any) { alert(e?.message ?? 'Download failed'); }
        finally { setBusy(false); }
      }}
      className="flex-shrink-0 whitespace-nowrap text-xs font-medium px-3 py-1.5 rounded-lg bg-swift-strong hover:bg-swift-deep disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors">
      {busy && <span className="spin-dot" aria-hidden />}
      {busy ? 'Preparing…' : '↓ Download Excel'}
    </button>
  );
}
