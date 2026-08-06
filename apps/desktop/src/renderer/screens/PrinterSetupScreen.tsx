/**
 * PrinterSetupScreen — one screen for the whole print setup.
 *
 * Replaces PrinterSettingsModal, PaperWidthControl, PrintersTab and PrintersPage.
 * Setup was spread across three screens in two apps, which is part of why
 * getting a receipt right meant printing a test, walking to the machine,
 * reading it, and coming back to guess again.
 *
 * Three things are on this screen deliberately:
 *   the station list, so it is obvious which ones have no printer here;
 *   a LIVE PREVIEW, rendered from the same Document the printer receives;
 *   a test print that reports the real result, with the millisecond count.
 *
 * The preview is the important one. It is not a mock-up of a receipt — it is
 * the receipt, drawn with spaces instead of control codes. If it looks right,
 * it IS right, so the layout can be fixed at the counter instead of at the
 * printer.
 */

import { useCallback, useEffect, useState } from 'react';

type PaperWidth = 58 | 80;

interface Station {
  id: string;
  name: string;
  kind: 'kitchen' | 'dispatch' | 'receipt';
}

interface Assignment {
  stationId: string;
  target: string;
  paperWidthMm: PaperWidth;
}

interface QueueCounts {
  [stationId: string]: { queued: number; failed: number };
}

interface TestResult {
  ok: boolean;
  ms?: number;
  bytes?: number;
  error?: string;
  retryable?: boolean;
}

declare global {
  interface Window {
    api: {
      invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
      on(channel: string, cb: () => void): () => void;
    };
  }
}

export default function PrinterSetupScreen({ stations }: { stations: Station[] }) {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [counts, setCounts] = useState<QueueCounts>({});
  const [selected, setSelected] = useState<string | null>(stations[0]?.id ?? null);
  const [preview, setPreview] = useState<string>('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  const station = stations.find(s => s.id === selected) ?? null;
  const assignment = assignments.find(a => a.stationId === selected) ?? null;

  const refresh = useCallback(async () => {
    setAssignments(await window.api.invoke<Assignment[]>('print:assignments'));
    const status = await window.api.invoke<{ counts: QueueCounts }>('print:status');
    setCounts(status.counts);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => window.api.on('print:changed', () => { void refresh(); }), [refresh]);

  // Re-render the preview whenever the station or the paper width changes, so
  // the effect of switching to 58mm is visible before anything is printed.
  useEffect(() => {
    if (!station) return;
    void window.api
      .invoke<string>('print:preview', {
        stationId: station.id,
        paperWidthMm: assignment?.paperWidthMm ?? 80,
      })
      .then(setPreview)
      .catch(() => setPreview('Preview unavailable.'));
  }, [station, assignment?.paperWidthMm]);

  async function save(target: string, paperWidthMm: PaperWidth) {
    if (!station) return;
    if (!target.trim()) {
      await window.api.invoke('print:unassign', station.id);
    } else {
      await window.api.invoke('print:assign', {
        stationId: station.id, target: target.trim(), paperWidthMm,
      });
    }
    setResult(null);
    await refresh();
  }

  async function test() {
    if (!station || !assignment) return;
    setTesting(true);
    setResult(null);
    try {
      setResult(await window.api.invoke<TestResult>('print:test',
        { stationId: station.id, paperWidthMm: assignment.paperWidthMm },
        assignment.target));
    } finally {
      setTesting(false);
    }
  }

  const unassigned = stations.filter(s => !assignments.some(a => a.stationId === s.id));

  return (
    <div className="flex h-full bg-gray-950 text-gray-100">
      {/* Stations */}
      <aside className="w-72 border-r border-gray-800 flex flex-col">
        <header className="px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm text-gray-400">Stations on this terminal</h2>
        </header>

        <ul className="flex-1 overflow-y-auto">
          {stations.map(s => {
            const a = assignments.find(x => x.stationId === s.id);
            const c = counts[s.id];
            return (
              <li key={s.id}>
                <button
                  onClick={() => { setSelected(s.id); setResult(null); }}
                  className={`w-full text-left px-4 py-3 border-b border-gray-900 transition-colors ${
                    selected === s.id ? 'bg-gray-800' : 'hover:bg-gray-900'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span>{s.name}</span>
                    {c?.failed ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-red-900/60 text-red-200">
                        {c.failed} failed
                      </span>
                    ) : c?.queued ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-amber-900/60 text-amber-200">
                        {c.queued} waiting
                      </span>
                    ) : null}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {a ? a.target : 'No printer here'}
                    {a ? ` · ${a.paperWidthMm}mm` : ''}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>

        {unassigned.length > 0 && (
          <p className="px-4 py-3 text-xs text-gray-500 border-t border-gray-800">
            {unassigned.length} station{unassigned.length > 1 ? 's have' : ' has'} no printer on
            this terminal and will not print here. That is normal if another terminal handles them.
          </p>
        )}
      </aside>

      {/* Settings and preview */}
      <main className="flex-1 flex min-w-0">
        {station ? (
          <>
            <section className="w-96 p-6 space-y-6 border-r border-gray-800 overflow-y-auto">
              <div>
                <h1 className="text-lg">{station.name}</h1>
                <p className="text-sm text-gray-500 mt-1">
                  {station.kind === 'receipt'
                    ? 'Prints the customer receipt and opens the drawer.'
                    : station.kind === 'kitchen'
                    ? 'Prints only what is cooked.'
                    : 'Prints everything that goes in the bag.'}
                </p>
              </div>

              <label className="block space-y-1.5">
                <span className="text-sm text-gray-400">Printer</span>
                <input
                  value={assignment?.target ?? ''}
                  onChange={e => void save(e.target.value, assignment?.paperWidthMm ?? 80)}
                  placeholder="192.168.1.50"
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2
                             font-mono text-sm focus:outline-none focus:border-gray-500"
                />
                <span className="block text-xs text-gray-500 leading-relaxed">
                  Network printer: its IP address. Windows shared printer:
                  <span className="font-mono"> \\localhost\Name</span>. USB on Linux:
                  <span className="font-mono"> /dev/usb/lp0</span>. Leave blank so this station
                  does not print here.
                </span>
              </label>

              <div className="space-y-1.5">
                <span className="text-sm text-gray-400">Paper width</span>
                <div className="flex gap-2">
                  {([80, 58] as PaperWidth[]).map(w => (
                    <button
                      key={w}
                      onClick={() => void save(assignment?.target ?? '', w)}
                      disabled={!assignment}
                      className={`flex-1 py-2 rounded-lg border text-sm transition-colors ${
                        (assignment?.paperWidthMm ?? 80) === w
                          ? 'bg-gray-700 border-gray-500'
                          : 'bg-gray-900 border-gray-700 hover:border-gray-600'
                      } disabled:opacity-40`}
                    >
                      {w}mm
                    </button>
                  ))}
                </div>
                <span className="block text-xs text-gray-500">
                  Must match the roll physically loaded. A mismatch is the commonest cause of a
                  receipt whose right-hand column wraps.
                </span>
              </div>

              <div className="space-y-2">
                <button
                  onClick={() => void test()}
                  disabled={!assignment || testing}
                  className="w-full py-2.5 rounded-lg bg-gray-100 text-gray-900 text-sm
                             hover:bg-white disabled:opacity-40 disabled:hover:bg-gray-100"
                >
                  {testing ? 'Printing…' : 'Test print'}
                </button>

                {result && (
                  <div
                    className={`text-sm rounded-lg px-3 py-2 ${
                      result.ok
                        ? 'bg-emerald-950/60 text-emerald-200'
                        : 'bg-red-950/60 text-red-200'
                    }`}
                  >
                    {result.ok ? (
                      <>Printed {result.bytes} bytes in {result.ms}ms.</>
                    ) : (
                      <>
                        {result.error}
                        <span className="block text-xs opacity-70 mt-1">
                          {result.retryable
                            ? 'Looks like the printer is off or unreachable. Check power and cable.'
                            : 'The address itself looks wrong. Check the spelling.'}
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>
            </section>

            <section className="flex-1 p-6 overflow-auto min-w-0">
              <h2 className="text-sm text-gray-400 mb-3">
                Preview — exactly what this printer will produce
              </h2>
              <pre className="font-mono text-xs leading-relaxed text-gray-200 bg-gray-900
                              border border-gray-800 rounded-xl p-4 inline-block">
                {preview}
              </pre>
            </section>
          </>
        ) : (
          <div className="flex-1 grid place-items-center text-gray-500 text-sm">
            No stations configured yet.
          </div>
        )}
      </main>
    </div>
  );
}
