/**
 * PrinterSetupScreen — one screen for the whole print setup.
 *
 * Supersedes PrintersTab (the old manager Printers tab, now unrouted). It does
 * NOT replace PrinterSettingsModal or PaperWidthControl: both are still live on
 * the POS screen (POSPage.tsx imports PrinterSettingsModal, which renders
 * PaperWidthControl). An earlier docstring claimed to replace all four, which is
 * how a still-live component gets deleted by the next reader (register A10).
 * Setup used to be spread across screens in two apps, which is part of why
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
import { posApi } from '../lib/posApi';

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
  /** True when the fault was in SwiftPOS, not in the printer or the address. */
  internal?: boolean;
}

// The escpos bridge is declared on Window in renderer/lib/posApi.ts alongside
// the rest of window.swiftpos. This screen previously typed a `window.api`
// bridge that the preload never exposed — the screen would have thrown on its
// first render. See scripts/check-ipc-parity.mjs for why that class of gap
// keeps happening.

export default function PrinterSetupScreen({ stations }: { stations: Station[] }) {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [counts, setCounts] = useState<QueueCounts>({});
  const [selected, setSelected] = useState<string | null>(stations[0]?.id ?? null);
  const [preview, setPreview] = useState<string>('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  /** Printers installed on THIS machine, for the picker. Windows names only. */
  const [localPrinters, setLocalPrinters] = useState<{ name: string; displayName?: string; isDefault?: boolean }[]>([]);
  /** Whether this terminal prints through ESC/POS at all. Off by default. */
  const [thermalOn, setThermalOn] = useState(false);

  // A43: the kitchen-exclusion list the PRINTER applies — cloud-owned and
  // read-only on the till. Ported here from the now-unrouted PrintersTab, whose
  // read-only exclusions box was the only thing living on that dead screen.
  const [liveExclusions, setLiveExclusions] = useState<string>('');
  useEffect(() => {
    let alive = true;
    window.swiftpos.escpos.kitchenExclusions()
      .then(r => { if (alive) setLiveExclusions((r?.terms ?? []).join('\n')); })
      .catch(() => { /* the built-in rule still applies */ });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    void (async () => {
      try { setThermalOn(await window.swiftpos.escpos.enabled()); } catch { /* stays off */ }
    })();
  }, []);

  /** Windows sharing state, keyed by printer name. Empty off Windows. */
  const [shares, setShares] = useState<Record<string, { shared: boolean; shareName: string | null }>>({});

  useEffect(() => {
    // Best effort. A machine with no installed printers is normal for a
    // network-only site, and the free-text field still works.
    void (async () => {
      try { setLocalPrinters(await posApi.print.list()); } catch { /* picker stays hidden */ }
      try { setShares(await posApi.print.shares()); } catch { /* sharing state unknown */ }
    })();
  }, []);

  const station = stations.find(s => s.id === selected) ?? null;
  const assignment = assignments.find(a => a.stationId === selected) ?? null;

  const refresh = useCallback(async () => {
    setAssignments((await window.swiftpos.escpos.assignments()) as Assignment[]);
    const status = (await window.swiftpos.escpos.status()) as { counts: QueueCounts };
    setCounts(status.counts);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => window.swiftpos.escpos.onChanged(() => { void refresh(); }), [refresh]);

  // Re-render the preview whenever the station or the paper width changes, so
  // the effect of switching to 58mm is visible before anything is printed.
  useEffect(() => {
    if (!station) return;
    void (window.swiftpos.escpos.preview({
        stationId: station.id,
        paperWidthMm: assignment?.paperWidthMm ?? 80,
      }) as Promise<string>)
      .then(setPreview)
      .catch(() => setPreview('Preview unavailable.'));
  }, [station, assignment?.paperWidthMm]);

  async function save(target: string, paperWidthMm: PaperWidth) {
    if (!station) return;
    if (!target.trim()) {
      await window.swiftpos.escpos.unassign(station.id);
    } else {
      await window.swiftpos.escpos.assign({
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
      setResult(await window.swiftpos.escpos.test(
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
        <header className="px-4 py-3 border-b border-gray-800 space-y-3">
          <h2 className="text-sm text-gray-400">Stations on this terminal</h2>

          {/*
            The switch that decides whether any of this screen affects a sale.

            Without it, an installer could assign a printer, press Test, watch it
            succeed — and still see no receipt at the counter, because the test
            talks to the printer directly while sales went out through the older
            path. That gap is exactly what this label exists to close.
          */}
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={thermalOn}
              onChange={async e => {
                const r = await window.swiftpos.escpos.setEnabled(e.target.checked);
                setThermalOn(r.enabled);
              }}
              className="mt-0.5 accent-green-500"
            />
            <span className="text-xs leading-relaxed">
              <span className="block text-gray-200">Print through these printers</span>
              {/*
                0.5.27 — this text said "Off. Sales still print the old way;
                nothing on this screen affects them yet." That was true while the
                HTML fallback existed. It does not any more: OFF now means
                NOTHING PRINTS. A label that reassures while the kitchen receives
                nothing is the worst kind of wrong, so the off state is styled and
                worded as the warning it now is.
              */}
              <span className={thermalOn ? 'block text-gray-500' : 'block text-amber-400'}>
                {thermalOn
                  ? 'On. Sales on this terminal print here.'
                  : 'OFF — nothing will print. Turn this on before trading.'}
              </span>
            </span>
          </label>
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

                {/*
                  Detected printers, so USB does not have to be typed.

                  A network printer is easy — the IP is on its self-test page.
                  A USB printer is not: it has to be shared in Windows first and
                  then entered as \\localhost\<exact share name>, and getting the
                  name slightly wrong fails at the test button with a parse
                  error that says nothing about the real cause.

                  print:list already enumerates Windows printers (it is what the
                  old HTML print path used). Reusing it here turns the common
                  case into one click, and the free-text field below still takes
                  an IP or a device node for everything else.
                */}
                {/*
                  Every installed printer, by the name Windows shows in Devices
                  and Printers — no sharing, no UNC paths, no typing.

                  This is deliberately NOT the Word-style print dialog. That
                  dialog prints through the DRIVER: it lays the job out,
                  rasterises it and spools it as an image, which is precisely
                  what turns a 42-column ticket into a mangled one. `printer:`
                  goes to the spooler's RAW datatype instead, so our ESC/POS
                  arrives byte for byte.
                */}
                {localPrinters.length > 0 && (
                  <select
                    value={assignment?.target?.startsWith('printer:') ? assignment.target : ''}
                    onChange={e => {
                      if (!e.target.value) return;
                      void save(e.target.value, assignment?.paperWidthMm ?? 80);
                    }}
                    className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2
                               text-sm focus:outline-none focus:border-gray-500"
                  >
                    <option value="">Pick a printer on this machine…</option>
                    {localPrinters.map(p => (
                      <option key={p.name} value={`printer:${p.name}`}>
                        {p.displayName || p.name}{p.isDefault ? '  (default)' : ''}
                      </option>
                    ))}
                  </select>
                )}

                <input
                  value={assignment?.target ?? ''}
                  onChange={e => void save(e.target.value, assignment?.paperWidthMm ?? 80)}
                  placeholder="or a network printer's IP, e.g. 192.168.1.50"
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2
                             font-mono text-sm focus:outline-none focus:border-gray-500"
                />
                <span className="block text-xs text-gray-500 leading-relaxed">
                  Pick from the list above for anything plugged into this machine —
                  it needs no sharing. This field is for everything else: a network
                  printer&rsquo;s IP address, a shared printer as
                  <span className="font-mono"> \\localhost\Name</span>, or Linux
                  <span className="font-mono"> /dev/usb/lp0</span>. Leave blank so this
                  station does not print here.
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
                          {/*
                            Never guess. This used to say "the printer is off or
                            unreachable" for ANY failure, including a crash in
                            SwiftPOS itself — which sent an installer to check a
                            power cable on a printer that was working fine.
                          */}
                          {result.internal
                            ? 'This is a fault in SwiftPOS, not your printer or the address. Report it with this message.'
                            : result.retryable
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

              {/* A43: ported from PrintersTab (unrouted). Read-only — the list is
                  owned by the cloud and edited on the web dashboard; it reaches
                  this till on the next sync. */}
              <div className="mt-6 max-w-md">
                <h2 className="text-sm text-gray-400 mb-2">
                  Kitchen exclusions — never printed on the kitchen ticket
                </h2>
                <textarea
                  value={liveExclusions}
                  readOnly
                  placeholder="(none — the built-in rule still applies)"
                  spellCheck={false}
                  className="w-full bg-gray-900 border border-gray-800 rounded-xl px-3 py-2
                             text-gray-300 text-sm font-mono h-20 resize-y cursor-default"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Applies on top of the built-in rule, for every till at this branch.
                  Edited on the web dashboard; it reaches this till on the next sync.
                </p>
              </div>
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
