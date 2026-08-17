/**
 * PrintersTab — printer setup and diagnostics, from the manager screen.
 *
 * The same settings were previously only reachable from the 🖨 icon on the POS
 * screen, which is the wrong place to be standing when a printer is not working:
 * you end up ringing throwaway sales to produce a ticket to look at.
 *
 * Each printer therefore gets a TEST button that prints a representative sample
 * through the exact code path a real sale uses — same builders, same silent
 * print, same page sizing. A test that took a shortcut would be worse than no
 * test at all, because it would pass while the real thing failed.
 *
 * Settings live in localStorage per device (see usePrinterSettings), so this is
 * per-till configuration and nothing here syncs.
 */

import { useEffect, useState } from 'react';
import { usePrinterSettings, PRINTER_DEFAULTS } from '../hooks/usePrinterSettings';
import { posApi } from '../lib/posApi';
import { printReceipt, buildCalibrationTicket, buildThermalDocument } from '../lib/printReceipt';
import PaperWidthControl from '../components/PaperWidthControl';
import StationsPanel from '../components/StationsPanel';
import { printKOT, buildKOTHtml } from '../lib/printKOT';
import { printDispatcher, buildDispatcherHtml } from '../lib/printDispatcher';
import type { TicketLine } from '../lib/ticketLines';

// A sample order that exercises the things that actually break: a combo with
// components, a line with a variant qualifier, a non-kitchen line that must be
// filtered off the KOT but kept on the dispatcher ticket, and a long name that
// tests wrapping at 58mm.
// stationIds empty throughout: the sample exercises the UNCONFIGURED path, which
// is what a till prints before anyone has set stations up — and therefore the
// behaviour most worth being able to preview.
const SAMPLE_LINES: TicketLine[] = [
  {
    name: 'Kanka Combo', quantity: 2, qualifier: '', isKitchen: false, stationIds: [],
    components: [
      { name: 'Kanka Beef',      quantity: 1, isKitchen: true,  stationIds: [] },
      { name: 'Ugali',           quantity: 1, isKitchen: true,  stationIds: [] },
      { name: 'Kachumbari',      quantity: 1, isKitchen: true,  stationIds: [] },
      { name: 'Coca-Cola 500ml', quantity: 1, isKitchen: false, stationIds: [] },
    ],
  },
  { name: '3PC Chicken & Chips Large', quantity: 1, qualifier: 'Spicy, Extra sauce', components: [], isKitchen: true,  stationIds: [] },
  { name: 'Dasani Water 500ml',        quantity: 3, qualifier: '',                   components: [], isKitchen: false, stationIds: [] },
];

const kitchenSample = SAMPLE_LINES
  .map(l => ({ ...l, components: l.components.filter(c => c.isKitchen) }))
  .filter(l => l.components.length > 0 || (l.components.length === 0 && l.isKitchen));

type Status = { kind: 'idle' | 'busy' | 'ok' | 'warn' | 'err'; msg?: string };

// Module scope, deliberately. This was defined INSIDE the component body — a
// brand-new component TYPE on every render, so React unmounted and remounted
// the <select> each time the parent re-rendered. Status-dot probes and the
// width detection re-render constantly, so an OPEN dropdown snapped shut the
// instant it opened: on the till this read as "I cannot select another
// printer" / "it is stuck on Microsoft Print to PDF" while the printer list
// was fine all along. A component's identity must be stable across renders.
function PrinterPicker({ label, value, onChange, hint, allowNone, printers }: {
  label: string; value: string; onChange: (v: string) => void; hint: string; allowNone: string;
  printers: Array<{ name: string; displayName: string; isDefault: boolean }>;
}) {
  return (
    <div>
      <label className="block text-sm text-gray-300 mb-1">{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm"
      >
        <option value="">{allowNone}</option>
        {printers.map(p => (
          <option key={p.name} value={p.name}>
            {p.displayName || p.name}{p.isDefault ? '  (Windows default)' : ''}
          </option>
        ))}
        {/* A saved printer stays selectable even if Windows does not list it
            right now (unplugged) — same rule as the POS modal. */}
        {value && !printers.some(p => p.name === value) && <option value={value}>{value} (saved)</option>}
      </select>
      <p className="text-xs text-gray-300 mt-1">{hint}</p>
    </div>
  );
}

export default function PrintersTab({ currency = 'KES' }: { currency?: string }) {
  // Prints the nested-bar width test. This lives here as well as in the POS
  // modal because the Printers tab is where anyone actually sets a printer up,
  // and the test was previously only reachable from the till screen.
  const handleWidthTest = async () => {
    const doc = buildThermalDocument(
      buildCalibrationTicket(settings.paperWidth, posApi.version, settings.printWidthMm || null),
      settings, 'Width test', 1);
    await posApi.print.html({
      html: doc,
      deviceName: settings.receiptPrinterName,
      paperWidthMm: settings.paperWidth,
      copies: 1,
    }).catch(() => {});
  };

  const { settings, save, reset } = usePrinterSettings();
  const [printers, setPrinters] = useState<Array<{ name: string; displayName: string; isDefault: boolean }>>([]);
  // Which station kinds are configured. When a Kitchen station exists, the
  // legacy "Kitchen ticket" card below is REPLACED by a pointer — two screens
  // both claiming to own the kitchen printer is how one gets set and the
  // other silently wins. The legacy values are kept as silent fallbacks for a
  // station with no printer bound (the print path already falls back to them).
  const [stationKinds, setStationKinds] = useState<Set<string>>(new Set());
  const [loading, setLoading]   = useState(true);
  const [loadErr, setLoadErr]   = useState('');
  const [status, setStatus]     = useState<Record<string, Status>>({});

  const setStat = (k: string, s: Status) => setStatus(p => ({ ...p, [k]: s }));

  // Same ping the cashier's modal uses. Prints nothing.
  const [probes, setProbes] = useState<Record<string, { ok: boolean; state: string } | 'checking'>>({});

  // 0.5.27 — the exclusion list the PRINTER applies, not the per-till
  // localStorage copy this screen used to preview with. The two could disagree,
  // so a preview could show a drink dropped that the printer would send. It is
  // read-only here: the value is owned by the cloud today, by the node under
  // PHASE6, and this screen only shows what will happen.
  const [liveExclusions, setLiveExclusions] = useState<string>('');
  useEffect(() => {
    let alive = true;
    window.swiftpos.escpos.kitchenExclusions()
      .then(r => { if (alive) setLiveExclusions((r?.terms ?? []).join('\n')); })
      .catch(() => { /* preview falls back to the built-in rule alone */ });
    return () => { alive = false; };
  }, []);
  const probe = async (deviceName: string) => {
    if (!deviceName) return;
    setProbes(p => ({ ...p, [deviceName]: 'checking' }));
    try {
      const r = await posApi.print.probe(deviceName);
      setProbes(p => ({ ...p, [deviceName]: r }));
    } catch {
      setProbes(p => ({ ...p, [deviceName]: { ok: false, state: 'Could not check' } }));
    }
  };

  const StatusDot = ({ deviceName }: { deviceName: string }) => {
    if (!deviceName) return null;
    const r = probes[deviceName];
    const colour = r === 'checking' ? 'text-gray-300' : r?.ok ? 'text-green-400' : r ? 'text-amber-400' : 'text-gray-300';
    return <span className={`text-xs ${colour}`}>● {r === 'checking' ? 'Checking…' : r ? r.state : '—'}</span>;
  };

  const loadPrinters = async () => {
    setLoading(true); setLoadErr('');
    try {
      setPrinters(await posApi.print.list());
    } catch (e: any) {
      setLoadErr(e?.message ?? 'Could not read the printer list from Windows');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPrinters();
    posApi.manage.listStations()
      .then(sts => setStationKinds(new Set((sts ?? []).filter((x: any) => x.active !== false).map((x: any) => String(x.kind)))))
      .catch(() => { /* stations unreachable = show legacy cards, the safe default */ });
  }, []);
  useEffect(() => {
    [settings.receiptPrinterName, settings.kitchenPrinterName, settings.dispatcherPrinterName]
      .filter(Boolean).forEach(probe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printers, settings.receiptPrinterName, settings.kitchenPrinterName, settings.dispatcherPrinterName]);

  // ── Test prints ─────────────────────────────────────────
  // Each goes through the real helper, so a failure here is a failure at the
  // till. printKOT and printDispatcher report rather than throw when unconfigured.

  // Preview renders the identical HTML in a visible window. Worth stressing why
  // this exists: the print path passes silent:true, which suppresses every OS
  // dialog — so pointing it at "Microsoft Print to PDF" produces no filename
  // prompt and no file. Without a preview there is no way to inspect a ticket
  // until real thermal hardware is on the desk.
  const preview = async (html: string, title: string, k: string) => {
    try {
      await posApi.print.preview({ html, paperWidthMm: settings.paperWidth, title });
      setStat(k, { kind: 'ok', msg: 'Opened in a preview window. Nothing was printed.' });
    } catch (e: any) {
      setStat(k, { kind: 'err', msg: e?.message ?? 'Could not open preview' });
    }
  };

  const receiptSampleHtml = () => {
    const money = (v: number) => v.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const row = (l: string, r: string, bold = false) =>
      `<div style="display:flex;justify-content:space-between;${bold ? 'font-weight:bold;' : ''}"><span>${l}</span><span>${r}</span></div>`;
    const rule = '<p style="border-top:1px dashed #000;margin:4px 0;"></p>';
    return `<div style="font-family:'Courier New',monospace;font-size:12px;color:#000;line-height:1.55;">`
      + `<p style="text-align:center;font-size:17px;font-weight:bold;">TEST PRINT</p>`
      + `<p style="text-align:center;">Receipt printer</p>${rule}`
      + row('Printer:', settings.receiptPrinterName || 'not set')
      + row('Paper:', `${settings.paperWidth}mm`)
      + row('Copies:', String(settings.copies))
      + row('Date:', new Date().toLocaleString('en-KE')) + rule
      + row('Sample item', money(1234.5))
      + row('Another line', money(96.5)) + rule
      + row('TOTAL:', `${currency} ${money(1331)}`, true) + rule
      + `<p style="text-align:center;">${settings.footerMessage || ''}</p>`
      + `<p style="text-align:center;">If the paper stops here, the height is correct.</p></div>`;
  };

  const testReceipt = async () => {
    setStat('receipt', { kind: 'busy' });
    const html = receiptSampleHtml();
    try {
      await printReceipt(html, settings, 'SwiftPOS — test receipt');
      setStat('receipt', {
        kind: settings.receiptPrinterName ? 'ok' : 'warn',
        msg: settings.receiptPrinterName
          ? 'Sent to the printer.'
          : 'No printer chosen, so this went to the Windows print dialog.',
      });
    } catch (e: any) {
      setStat('receipt', { kind: 'err', msg: e?.message ?? 'Print failed' });
    }
  };

  const testKitchen = async () => {
    setStat('kitchen', { kind: 'busy' });
    try {
      const r = await printKOT(kitchenSample, {
        orderNumber: 'TEST-KOT', orderType: 'takeaway',
        staffName: 'Test print', notes: 'This is a test ticket — do not cook.',
      }, { ...settings, kitchenExcludeTerms: liveExclusions });
      setStat('kitchen', r.printed
        ? { kind: 'ok', msg: 'Sent. The drink lines should be absent.' }
        : { kind: 'warn', msg: r.reason ?? 'Kitchen printing is switched off.' });
    } catch (e: any) {
      setStat('kitchen', { kind: 'err', msg: e?.message ?? 'Print failed' });
    }
  };

  const testDispatcher = async () => {
    setStat('dispatcher', { kind: 'busy' });
    if (!settings.dispatcherPrinterName) {
      setStat('dispatcher', { kind: 'warn', msg: 'No printer chosen, so no dispatcher ticket is produced. That is deliberate.' });
      return;
    }
    try {
      await printDispatcher(SAMPLE_LINES, {
        orderNumber: 'TEST-DISPATCH', billNumber: 'T1--000',
        orderType: 'delivery', deliveryPerson: 'Test rider',
        staffName: 'Test print', notes: 'This is a test ticket — do not pack.',
      }, settings);
      setStat('dispatcher', { kind: 'ok', msg: 'Sent. Every line should appear, drinks included.' });
    } catch (e: any) {
      setStat('dispatcher', { kind: 'err', msg: e?.message ?? 'Print failed' });
    }
  };

  // ── UI pieces ───────────────────────────────────────────

  const StatusLine = ({ k }: { k: string }) => {
    const s = status[k];
    if (!s || s.kind === 'idle') return null;
    if (s.kind === 'busy') return <p className="text-xs text-gray-400 mt-2">Printing…</p>;
    const colour = s.kind === 'ok' ? 'text-green-400' : s.kind === 'warn' ? 'text-amber-400' : 'text-red-400';
    return <p className={`text-xs mt-2 ${colour}`}>{s.msg}</p>;
  };


  const Card = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <h3 className="text-white font-semibold">{title}</h3>
      {children}
    </div>
  );

  const Actions = ({ onPrint, onPreview, k, deviceName }: { onPrint: () => void; onPreview: () => void; k: string; deviceName?: string }) => (
    <div className="flex gap-2 items-center flex-wrap">
      {deviceName && (
        <>
          <StatusDot deviceName={deviceName} />
          <button onClick={() => probe(deviceName)}
            className="text-xs text-gray-300 hover:text-white transition-colors mr-1">
            Test connection
          </button>
        </>
      )}
      <button
        onClick={onPreview}
        className="bg-gray-800 hover:bg-gray-700 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
      >
        👁 Preview
      </button>
      <button
        onClick={onPrint}
        disabled={status[k]?.kind === 'busy'}
        className="bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
      >
        🖨 Test print
      </button>
    </div>
  );

  return (
    <div className="max-w-3xl space-y-5">

      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-400">
          Printer setup for <span className="text-white">this till only</span>. Nothing here syncs to the other machines.
        </p>
        <button onClick={loadPrinters} className="text-xs text-gray-400 hover:text-white transition-colors">
          ↻ Refresh list
        </button>
      </div>

      {loading && <p className="text-sm text-gray-300">Reading printers from Windows…</p>}
      {loadErr  && <p className="text-sm text-red-400">{loadErr}</p>}
      {!loading && !loadErr && printers.length === 0 && (
        <p className="text-sm text-amber-400">
          Windows reports no printers installed. Add one in Windows Settings, then press Refresh.
        </p>
      )}

      <Card title="Stations and routing">
        <StationsPanel printers={printers} settings={settings} save={save} canEdit />
      </Card>

      <Card title="Customer receipt">
        <PrinterPicker printers={printers}
          label="Printer"
          value={settings.receiptPrinterName}
          onChange={v => save({ receiptPrinterName: v })}
          allowNone="— Ask each time (Windows print dialog) —"
          hint="Leave unset and every receipt opens a print dialog. Choose a printer for silent printing."
        />
        <div className="flex gap-3">
          <div className="flex-1">
            <PaperWidthControl settings={settings} save={save} onWidthTest={handleWidthTest} />
          </div>
          <div className="flex-1">
            <label className="block text-sm text-gray-300 mb-1">Copies</label>
            <select
              value={settings.copies}
              onChange={e => save({ copies: Number(e.target.value) as 1 | 2 })}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm"
            >
              <option value={1}>1 — customer</option>
              <option value={2}>2 — customer + merchant</option>
            </select>
          </div>
        </div>
        <div>
          <label className="block text-sm text-gray-300 mb-1">Footer message</label>
          <input
            value={settings.footerMessage}
            onChange={e => save({ footerMessage: e.target.value })}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm"
          />
        </div>
        <Actions k="receipt" deviceName={settings.receiptPrinterName} onPrint={testReceipt}
          onPreview={() => preview(receiptSampleHtml(), "Receipt preview", "receipt")} />
        <StatusLine k="receipt" />
      </Card>

      <Card title="Kitchen exclusions">
        <p className="text-sm text-gray-300 mb-1">
          Items that must <span className="font-medium text-gray-100">never print on the kitchen ticket</span> —
          one term per line. Sauces and soft drinks are already excluded by the built-in rule;
          add anything else here (e.g. <span className="font-mono">coleslaw</span>).
        </p>
        {/*
          READ-ONLY as of 0.5.27. This used to be an editable per-till box in
          localStorage, and the live printer used a different, server-synced
          list — so a term typed here changed the preview and nothing else. Two
          lists, one screen, silently disagreeing.

          Now it shows what the printer actually applies. Editing moves to the
          branch under PHASE6; until then it is changed on the web dashboard.
        */}
        <textarea
          value={liveExclusions}
          readOnly
          placeholder="(none — the built-in rule still applies)"
          spellCheck={false}
          className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-gray-300 text-sm font-mono h-20 resize-y cursor-default"
        />
        <p className="text-xs text-gray-400 mt-1">
          Applies on top of the built-in rule, for <span className="font-medium text-gray-300">every till at this branch</span>.
          The dispatcher ticket always prints everything.
        </p>
        <p className="text-xs text-gray-500 mt-1">
          Edited on the web dashboard. It reaches this till on the next sync.
        </p>
      </Card>

      {stationKinds.has('kitchen') ? (
        <Card title="Kitchen ticket">
          <p className="text-sm text-gray-300">
            Handled by <span className="text-gray-100 font-medium">Stations and routing</span> above — the
            Kitchen station decides what prints and which printer serves it on this till.
          </p>
        </Card>
      ) : (
      <Card title="Kitchen ticket">
        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input
            type="checkbox"
            checked={settings.kitchenEnabled}
            onChange={e => save({ kitchenEnabled: e.target.checked })}
            className="accent-green-500"
          />
          Print a kitchen ticket when “Send to kitchen” is pressed
        </label>
        <PrinterPicker printers={printers}
          label="Printer"
          value={settings.kitchenPrinterName}
          onChange={v => save({ kitchenPrinterName: v })}
          allowNone="— None chosen —"
          hint="Only lines in a category marked Kitchen appear here. Drinks and packaged goods are left off."
        />
        <Actions k="kitchen" deviceName={settings.kitchenPrinterName} onPrint={testKitchen}
          onPreview={() => preview(
            buildKOTHtml(kitchenSample, { orderNumber: "TEST-KOT", orderType: "takeaway",
              staffName: "Test print", notes: "Test ticket — do not cook." },
              settings.paperWidth, liveExclusions),
            "Kitchen ticket preview", "kitchen")} />
        <StatusLine k="kitchen" />
      </Card>

      )}

      {stationKinds.has('dispatch') ? (
        <Card title="Dispatcher / packing ticket">
          <p className="text-sm text-gray-300">
            Handled by <span className="text-gray-100 font-medium">Stations and routing</span> above — the
            Packing station prints the whole order on the printer bound to it on this till.
          </p>
        </Card>
      ) : (
      <Card title="Dispatcher / packing ticket">
        <PrinterPicker printers={printers}
          label="Printer"
          value={settings.dispatcherPrinterName}
          onChange={v => save({ dispatcherPrinterName: v })}
          allowNone="— No packing station here —"
          hint="Lists the whole order, drinks included, so the packer can check the bag. Leave unset and no ticket is produced at all."
        />
        <Actions k="dispatcher" deviceName={settings.dispatcherPrinterName} onPrint={testDispatcher}
          onPreview={() => preview(
            buildDispatcherHtml(SAMPLE_LINES, { orderNumber: "TEST-DISPATCH", billNumber: "T1--000",
              orderType: "delivery", deliveryPerson: "Test rider", staffName: "Test print",
              notes: "Test ticket — do not pack." }, settings.paperWidth, "DISPATCH"),
            "Dispatcher ticket preview", "dispatcher")} />
        <StatusLine k="dispatcher" />
      </Card>
      )}

      <div className="flex items-center justify-between pt-2">
        <p className="text-xs text-gray-300">
          Use <span className="text-gray-300">Preview</span> to check layout — printing here is silent, so
          “Microsoft Print to PDF” produces no filename prompt and no file. From the preview window,
          Ctrl+P gives you a normal print dialog if you want a PDF.
        </p>
        <button
          onClick={() => { reset(); setStatus({}); }}
          className="text-xs text-gray-300 hover:text-red-400 transition-colors whitespace-nowrap ml-4"
        >
          Reset to defaults
        </button>
      </div>

      <p className="text-xs text-gray-400">
        Defaults: {PRINTER_DEFAULTS.paperWidth}mm paper, {PRINTER_DEFAULTS.copies} copy, kitchen printing on.
      </p>
    </div>
  );
}
