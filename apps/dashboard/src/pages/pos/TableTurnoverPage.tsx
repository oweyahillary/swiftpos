/**
 * TableTurnoverPage — live dwell-time flags for occupied dine-in tables, plus an
 * average-turnover report. Live tab polls /api/orders/turnover; report tab reads
 * /api/orders/turnover/report for a date range.
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/api';
import { useBranch } from '../../context/BranchContext';

interface LiveRow {
  order_id: string; table_number: string | null; covers: number;
  seated_at: string | null; minutes_seated: number; over: boolean;
}
interface ReportRow { table_number: string; covers_served: number; avg_minutes: number; }

function hm(mins: number) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function TableTurnoverPage() {
  const { activeBranchId } = useBranch();
  const [tab, setTab] = useState<'live' | 'report'>('live');
  const [threshold, setThreshold] = useState(90);
  const [live, setLive] = useState<LiveRow[]>([]);
  const [report, setReport] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);

  const loadLive = useCallback(async () => {
    if (!activeBranchId) { setLive([]); setLoading(false); return; }
    try {
      const data = await api.get<{ threshold_minutes: number; tables: LiveRow[] }>(`/api/orders/turnover?branch_id=${activeBranchId}`);
      setThreshold(data.threshold_minutes);
      setLive(data.tables ?? []);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [activeBranchId]);

  const loadReport = useCallback(async () => {
    if (!activeBranchId) return;
    try {
      const data = await api.get<{ tables: ReportRow[] }>(`/api/orders/turnover/report?branch_id=${activeBranchId}`);
      setReport(data.tables ?? []);
    } catch { /* ignore */ }
  }, [activeBranchId]);

  // Live tab polls every 30s.
  useEffect(() => {
    if (tab !== 'live') return;
    loadLive();
    const t = setInterval(loadLive, 30000);
    return () => clearInterval(t);
  }, [tab, loadLive]);

  useEffect(() => { if (tab === 'report') loadReport(); }, [tab, loadReport]);

  if (!activeBranchId) {
    return <div className="p-6 text-gray-400">Select a specific branch to see table turnover.</div>;
  }

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold text-white mb-1">Table Turnover</h1>
      <p className="text-sm text-gray-400 mb-5">Live dwell time and average turnover per table.</p>

      <div className="flex gap-2 mb-5">
        <button onClick={() => setTab('live')}
          className={`px-3 py-1.5 rounded-lg text-sm ${tab === 'live' ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-400'}`}>
          Live tables
        </button>
        <button onClick={() => setTab('report')}
          className={`px-3 py-1.5 rounded-lg text-sm ${tab === 'report' ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-400'}`}>
          Turnover report
        </button>
      </div>

      {tab === 'live' ? (
        loading ? <p className="text-gray-500">Loading…</p> : live.length === 0 ? (
          <p className="text-gray-500">No occupied dine-in tables right now.</p>
        ) : (
          <>
            <p className="text-xs text-gray-500 mb-3">Tables seated longer than {threshold} min are flagged.</p>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {live.map(t => (
                <div key={t.order_id}
                  className={`rounded-xl p-4 border ${t.over ? 'bg-red-500/10 border-red-500/40' : 'bg-gray-900 border-gray-800'}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-white font-semibold">{t.table_number ? `Table ${t.table_number}` : 'Order'}</span>
                    {t.over && <span className="text-red-400 text-xs font-medium">● Over</span>}
                  </div>
                  <p className={`text-2xl font-bold mt-1 ${t.over ? 'text-red-400' : 'text-white'}`}>{hm(t.minutes_seated)}</p>
                  <p className="text-xs text-gray-500 mt-1">{t.covers} cover{t.covers === 1 ? '' : 's'}</p>
                </div>
              ))}
            </div>
          </>
        )
      ) : (
        report.length === 0 ? <p className="text-gray-500">No completed dine-in orders in range.</p> : (
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-500 text-left text-xs border-b border-gray-800">
                  <th className="p-3">Table</th><th className="p-3 text-right">Covers served</th><th className="p-3 text-right">Avg turnover</th>
                </tr>
              </thead>
              <tbody>
                {report.map(r => (
                  <tr key={r.table_number} className="border-b border-gray-800">
                    <td className="p-3 text-white">Table {r.table_number}</td>
                    <td className="p-3 text-right text-gray-300">{r.covers_served}</td>
                    <td className="p-3 text-right text-gray-300">{hm(r.avg_minutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
