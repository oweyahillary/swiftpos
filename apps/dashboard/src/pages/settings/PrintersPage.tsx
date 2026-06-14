/**
 * PrintersPage — Station-based printer setup
 *
 * Two sections:
 *  1. Full-order printers (Receipt, Master KOT, Dispatcher) — no category filter
 *  2. Station printers (Kitchen, Beverages, custom) — user picks categories
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/api';
import { useBranch } from '../../context/BranchContext';
import {
  getQZStatus, connectQZ, getQZPrinters,
  onQZStatusChange, type QZStatus, testPrint,
} from '../../lib/localPrintServer';
import type { BranchPrinter } from '../../lib/printKOT';
import ConfirmModal, { useConfirm } from '../../components/ConfirmModal';

interface Category { id: string; name: string; }

// ── Station definitions ────────────────────────────────────────────────────────

type FullOrderType = 'receipt' | 'kot' | 'expeditor';
type StationType   = 'kitchen' | 'bar';

interface FullOrderSlot {
  type:  FullOrderType;
  icon:  string;
  label: string;
  desc:  string;
}

const FULL_ORDER_SLOTS: FullOrderSlot[] = [
  { type: 'receipt',   icon: '🧾', label: 'Customer Receipt', desc: 'Full receipt printed for the customer after payment. Prints all items.' },
  { type: 'kot',       icon: '📋', label: 'Master KOT',       desc: 'Full order copy — all items. Kitchen expeditors use this to see the complete order.' },
  { type: 'expeditor', icon: '🚀', label: 'Dispatcher',       desc: 'Packaging and presentation copy. All items. Used at the pass or packing station.' },
];

const STATION_TYPES: { type: StationType; icon: string; label: string; hint: string }[] = [
  { type: 'kitchen', icon: '👨‍🍳', label: 'Kitchen',       hint: 'e.g. Grill, Salads, Oven — pick which food categories go here' },
  { type: 'bar',     icon: '☕',  label: 'Beverages',     hint: 'e.g. Hot drinks, Cold drinks — pick which drink categories go here' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function QZStatus({ status }: { status: QZStatus }) {
  const map: Record<QZStatus, { label: string; cls: string }> = {
    connected:    { label: '🟢 Print Server Connected', cls: 'text-green-400 bg-green-500/10 border-green-500/20' },
    connecting:   { label: '🟡 Connecting…',            cls: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
    disconnected: { label: '⚪ Print Server Offline',    cls: 'text-gray-400 bg-gray-800 border-gray-700' },
    unavailable:  { label: '⚫ Print Server Not Found',  cls: 'text-gray-500 bg-gray-800 border-gray-700' },
  };
  const { label, cls } = map[status];
  return <span className={`px-2.5 py-1 rounded-lg text-xs font-medium border ${cls}`}>{label}</span>;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange}
      className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${checked ? 'bg-green-500' : 'bg-gray-700'}`}>
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
    </button>
  );
}

// ── Hardware form (shared between full-order and station modals) ───────────────

interface HardwareForm {
  printer_name:    string;
  paper_width:     58 | 80;
  connection_type: 'qz' | 'browser';
  enabled:         boolean;
  is_default_receipt: boolean;
}

const DEFAULT_HW: HardwareForm = {
  printer_name: '', paper_width: 80,
  connection_type: 'browser', enabled: true, is_default_receipt: false,
};

function HardwareFields({
  form, setForm, qzStatus, qzPrinters, showDefaultReceipt,
}: {
  form: HardwareForm;
  setForm: (fn: (f: HardwareForm) => HardwareForm) => void;
  qzStatus: QZStatus;
  qzPrinters: string[];
  showDefaultReceipt?: boolean;
}) {
  return (
    <div className="space-y-4">
      {/* Paper width */}
      <div>
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Paper width</label>
        <div className="flex rounded-lg overflow-hidden border border-gray-700">
          {([58, 80] as const).map(w => (
            <button key={w} onClick={() => setForm(f => ({ ...f, paper_width: w }))}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${form.paper_width === w ? 'bg-green-500 text-black' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
              {w}mm
            </button>
          ))}
        </div>
      </div>

      {/* Connection type */}
      <div>
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Print method</label>
        <div className="flex rounded-lg overflow-hidden border border-gray-700">
          {(['browser', 'qz'] as const).map(ct => (
            <button key={ct} onClick={() => setForm(f => ({ ...f, connection_type: ct }))}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${form.connection_type === ct ? 'bg-green-500 text-black' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
              {ct === 'qz' ? '⚡ Print Server' : '🌐 Browser dialog'}
            </button>
          ))}
        </div>
        {form.connection_type === 'qz' && qzStatus !== 'connected' && (
          <p className="text-amber-400 text-xs mt-1">⚠ Print server is not running on this device.</p>
        )}
      </div>

      {/* OS printer name */}
      <div>
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
          OS Printer name
          {form.connection_type === 'qz' && <span className="text-red-400 ml-1 normal-case font-normal">* required for Print Server</span>}
        </label>
        {qzStatus === 'connected' && qzPrinters.length > 0 ? (
          <select value={form.printer_name} onChange={e => setForm(f => ({ ...f, printer_name: e.target.value }))}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-green-500">
            <option value="">— Select printer —</option>
            {qzPrinters.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        ) : (
          <input type="text" placeholder="e.g. EPSON TM-T20III"
            value={form.printer_name} onChange={e => setForm(f => ({ ...f, printer_name: e.target.value }))}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm font-mono placeholder-gray-600 focus:outline-none focus:border-green-500" />
        )}
        <p className="text-gray-600 text-xs mt-1">
          {qzStatus === 'connected' ? 'Printers detected from your device.' : 'Must match the exact name in your OS printer list.'}
        </p>
      </div>

      {/* Default receipt */}
      {showDefaultReceipt && (
        <div className="flex items-center justify-between py-1">
          <div>
            <p className="text-gray-300 text-sm">Default receipt printer</p>
            <p className="text-gray-500 text-xs">Customer receipts print here automatically</p>
          </div>
          <Toggle checked={form.is_default_receipt} onChange={() => setForm(f => ({ ...f, is_default_receipt: !f.is_default_receipt }))} />
        </div>
      )}

      {/* Enabled */}
      <div className="flex items-center justify-between py-1">
        <p className="text-gray-300 text-sm">Printer enabled</p>
        <Toggle checked={form.enabled} onChange={() => setForm(f => ({ ...f, enabled: !f.enabled }))} />
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function PrintersPage() {
  const { activeBranchId, branches: contextBranches } = useBranch();

  const [confirmState, showConfirm, closeConfirm] = useConfirm();
  const [printers, setPrinters]     = useState<BranchPrinter[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading]       = useState(true);
  const [qzStatus, setQzStatus]     = useState<QZStatus>(getQZStatus());
  const [qzPrinters, setQzPrinters] = useState<string[]>([]);
  const [toast, setToast]           = useState('');

  // Full-order printer modal
  const [foModal, setFoModal]   = useState<FullOrderSlot | null>(null);
  const [foEditId, setFoEditId] = useState<string | null>(null);
  const [foHw, setFoHw]         = useState<HardwareForm>(DEFAULT_HW);

  // Station printer modal
  const [stModal, setStModal]     = useState(false);
  const [stEditId, setStEditId]   = useState<string | null>(null);
  const [stType, setStType]       = useState<StationType>('kitchen');
  const [stName, setStName]       = useState('');
  const [stCats, setStCats]       = useState<string[]>([]);
  const [stHw, setStHw]           = useState<HardwareForm>(DEFAULT_HW);
  const [stCustomLabel, setStCustomLabel] = useState('');

  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<BranchPrinter | null>(null);

  // ── Derived ──────────────────────────────────────────────────────────────────

  const branchId = activeBranchId ?? contextBranches[0]?.id ?? '';

  // ── Load ─────────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    try {
      const [pd, cd] = await Promise.all([
        api.get<BranchPrinter[]>(`/api/printers?branch_id=${branchId}`),
        api.get<Category[]>('/api/categories'),
      ]);
      setPrinters(pd ?? []);
      setCategories(cd ?? []);
    } finally { setLoading(false); }
  }, [branchId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => onQZStatusChange(setQzStatus), []);
  useEffect(() => {
    if (qzStatus === 'connected') getQZPrinters().then(setQzPrinters);
  }, [qzStatus]);

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(''), 3000); }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function printerOfType(type: BranchPrinter['type']): BranchPrinter | undefined {
    return printers.find(p => p.type === type);
  }

  function stationPrinters(): BranchPrinter[] {
    return printers.filter(p => p.type === 'kitchen' || p.type === 'bar');
  }

  function catName(id: string) {
    return categories.find(c => c.id === id)?.name ?? id;
  }

  // ── Full-order modal ──────────────────────────────────────────────────────────

  function openFoModal(slot: FullOrderSlot) {
    const existing = printerOfType(slot.type);
    setFoEditId(existing?.id ?? null);
    setFoHw(existing ? {
      printer_name:       existing.printer_name ?? '',
      paper_width:        existing.paper_width,
      connection_type:    existing.connection_type,
      enabled:            existing.enabled,
      is_default_receipt: existing.is_default_receipt,
    } : DEFAULT_HW);
    setFoModal(slot);
    setError('');
  }

  async function saveFo() {
    if (!foModal) return;
    setSaving(true); setError('');
    try {
      const payload = {
        name:               foModal.label,
        type:               foModal.type,
        category_ids:       [],
        branch_id:          branchId,
        printer_name:       foHw.printer_name || null,
        paper_width:        foHw.paper_width,
        connection_type:    foHw.connection_type,
        enabled:            foHw.enabled,
        is_default_receipt: foHw.is_default_receipt,
      };
      if (foEditId) {
        await api.patch(`/api/printers/${foEditId}`, payload);
      } else {
        await api.post('/api/printers', payload);
      }
      showToast('Printer saved');
      setFoModal(null);
      load();
    } catch (e: any) { setError(e.message ?? 'Save failed'); }
    finally { setSaving(false); }
  }

  // ── Station modal ──────────────────────────────────────────────────────────

  function openAddStation() {
    setStEditId(null);
    setStType('kitchen');
    setStName('Kitchen');
    setStCats([]);
    setStHw(DEFAULT_HW);
    setStCustomLabel('');
    setError('');
    setStModal(true);
  }

  function openEditStation(p: BranchPrinter) {
    setStEditId(p.id);
    setStType(p.type as StationType);
    setStName(p.name);
    setStCats(p.category_ids ?? []);
    setStHw({
      printer_name:       p.printer_name ?? '',
      paper_width:        p.paper_width,
      connection_type:    p.connection_type,
      enabled:            p.enabled,
      is_default_receipt: false,
    });
    setStCustomLabel('');
    setError('');
    setStModal(true);
  }

  async function saveSt() {
    if (!stName.trim()) { setError('Station name is required'); return; }
    setSaving(true); setError('');
    try {
      const payload = {
        name:            stName,
        type:            stType,
        category_ids:    stCats,
        branch_id:       branchId,
        printer_name:    stHw.printer_name || null,
        paper_width:     stHw.paper_width,
        connection_type: stHw.connection_type,
        enabled:         stHw.enabled,
        is_default_receipt: false,
      };
      if (stEditId) {
        await api.patch(`/api/printers/${stEditId}`, payload);
      } else {
        await api.post('/api/printers', payload);
      }
      showToast('Station saved');
      setStModal(false);
      load();
    } catch (e: any) { setError(e.message ?? 'Save failed'); }
    finally { setSaving(false); }
  }

  function toggleCat(id: string) {
    setStCats(prev => prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]);
  }

  // ── Delete ────────────────────────────────────────────────────────────────────

  async function deletePrinter(p: BranchPrinter) {
    try {
      await api.delete(`/api/printers/${p.id}`);
      setDeleteConfirm(null);
      load();
      showToast('Printer removed');
    } catch (e: any) { setError(e.message ?? 'Delete failed'); }
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  const stations = stationPrinters();

  if (!branchId) {
    return (
      <div className="p-6 text-center text-gray-500">
        Select a branch from the selector above to configure printers.
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl space-y-8">
      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 bg-green-500 text-white px-5 py-2.5 rounded-lg font-semibold z-50 shadow-lg">{toast}</div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Printers</h1>
          <p className="text-sm text-gray-500 mt-1">Configure receipt and kitchen printers for this branch</p>
        </div>
        <div className="flex items-center gap-3">
          <QZStatus status={qzStatus} />
          {qzStatus === 'disconnected' && (
            <button onClick={() => connectQZ()}
              className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-medium rounded-lg transition-colors">
              Reconnect
            </button>
          )}
        </div>
      </div>

      {/* Print server banner */}
      {qzStatus === 'unavailable' && (
        <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-4 flex gap-3">
          <span className="text-xl flex-shrink-0">🖨️</span>
          <div>
            <p className="text-blue-300 text-sm font-medium">Enable silent printing with SwiftPOS Print Server</p>
            <p className="text-blue-400/60 text-xs mt-0.5">
              Install <span className="font-mono text-blue-300">SwiftPOS-PrintServer.exe</span> from your installation folder, then run <span className="font-mono text-blue-300">install-windows-service.bat</span> as Administrator. Receipts and KOTs will print instantly with no dialog.
            </p>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center text-gray-500 text-sm py-12">Loading printers…</div>
      ) : (
        <>
          {/* ── Section 1: Full-order printers ── */}
          <div>
            <div className="mb-3">
              <h2 className="text-base font-bold text-white">Full order printers</h2>
              <p className="text-xs text-gray-500 mt-0.5">These always print all items — no category filter needed.</p>
            </div>

            <div className="grid grid-cols-3 gap-4">
              {FULL_ORDER_SLOTS.map(slot => {
                const existing = printerOfType(slot.type);
                return (
                  <div
                    key={slot.type}
                    className={`rounded-xl border p-4 cursor-pointer transition-all hover:border-gray-600 ${
                      existing
                        ? existing.enabled
                          ? 'border-green-500/40 bg-green-500/5'
                          : 'border-gray-700 bg-gray-900 opacity-60'
                        : 'border-dashed border-gray-700 bg-gray-900/50 hover:bg-gray-900'
                    }`}
                    onClick={() => openFoModal(slot)}
                  >
                    <div className="text-2xl mb-2">{slot.icon}</div>
                    <div className="text-sm font-bold text-white mb-0.5">{slot.label}</div>
                    <div className="text-xs text-gray-500 leading-relaxed mb-3">{slot.desc}</div>

                    {existing ? (
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5">
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${existing.enabled ? 'bg-green-400' : 'bg-gray-600'}`} />
                          <span className="text-xs text-gray-400 truncate">{existing.printer_name || 'Browser dialog'}</span>
                        </div>
                        <div className="text-xs text-gray-600">{existing.paper_width}mm · {existing.connection_type === 'qz' ? 'Print Server' : 'Browser'}</div>
                        <div className="text-xs text-blue-400 mt-1">Click to edit →</div>
                      </div>
                    ) : (
                      <div className="text-xs text-gray-600">Not configured — click to set up</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Section 2: Station printers ── */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-base font-bold text-white">Station printers</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  Each station only receives items from its assigned categories. Add as many stations as you need.
                </p>
              </div>
              <button
                onClick={openAddStation}
                className="px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white text-sm font-bold rounded-lg transition-colors"
              >
                + Add Station
              </button>
            </div>

            {stations.length === 0 ? (
              <div className="border border-dashed border-gray-700 rounded-xl py-10 text-center">
                <div className="text-3xl mb-2">🖨️</div>
                <p className="text-sm text-gray-500">No station printers yet</p>
                <p className="text-xs text-gray-600 mt-1">Add a Kitchen, Beverages, or custom station to route KOTs to specific printers.</p>
                <button onClick={openAddStation} className="mt-4 text-xs text-blue-400 hover:text-blue-300 transition-colors">+ Add first station →</button>
              </div>
            ) : (
              <div className="space-y-3">
                {stations.map(p => {
                  const stInfo = STATION_TYPES.find(s => s.type === p.type);
                  return (
                    <div key={p.id} className={`bg-gray-900 border rounded-xl p-4 ${p.enabled ? 'border-gray-800' : 'border-gray-800/50 opacity-60'}`}>
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          <span className="text-2xl flex-shrink-0">{stInfo?.icon ?? '🖨️'}</span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-white font-semibold">{p.name}</span>
                              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400">
                                {stInfo?.label ?? p.type}
                              </span>
                              {!p.enabled && (
                                <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-600">Disabled</span>
                              )}
                            </div>

                            {/* Category pills */}
                            <div className="flex flex-wrap gap-1.5 mt-2">
                              {p.category_ids.length === 0 ? (
                                <span className="text-xs text-amber-400/80 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full">
                                  ⚠ No categories — prints nothing
                                </span>
                              ) : p.category_ids.map(id => (
                                <span key={id} className="text-xs bg-blue-500/10 text-blue-400 border border-blue-500/20 px-2 py-0.5 rounded-full">
                                  {catName(id)}
                                </span>
                              ))}
                            </div>

                            <div className="flex items-center gap-3 mt-2">
                              <span className="text-xs text-gray-600">{p.paper_width}mm</span>
                              <span className="text-xs text-gray-600">{p.connection_type === 'qz' ? '⚡ Print Server' : '🌐 Browser'}</span>
                              {p.printer_name && <span className="text-xs text-gray-600 font-mono truncate">{p.printer_name}</span>}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 flex-shrink-0">
                          {p.connection_type === 'qz' && p.printer_name && qzStatus === 'connected' && (
                            <button
                              onClick={async () => {
                                try { await testPrint(p.printer_name!, p.paper_width); showToast(`Test sent to ${p.name}`); }
                                catch (e: any) { showToast(`Test failed: ${e.message}`); }
                              }}
                              className="text-xs text-gray-500 hover:text-amber-400 px-2 py-1 rounded hover:bg-gray-800 transition-colors"
                            >Test</button>
                          )}
                          <button onClick={() => openEditStation(p)}
                            className="text-xs text-gray-500 hover:text-white px-2 py-1 rounded hover:bg-gray-800 transition-colors">Edit</button>
                          <button onClick={() => showConfirm({
              title: `Remove "${p.name}"?`,
              message: 'KOTs will no longer route to this printer.',
              intent: 'warning',
              confirmLabel: 'Remove',
              onConfirm: () => deletePrinter(p),
            })}
                            className="text-xs text-gray-500 hover:text-red-400 px-2 py-1 rounded hover:bg-gray-800 transition-colors">Remove</button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Full-order modal ──────────────────────────────────────────────────── */}
      {foModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md shadow-2xl flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-gray-800 flex-shrink-0 flex items-center gap-3">
              <span className="text-2xl">{foModal.icon}</span>
              <div>
                <h2 className="text-white font-bold">{foModal.label}</h2>
                <p className="text-xs text-gray-500">{foModal.desc}</p>
              </div>
            </div>

            <div className="overflow-y-auto flex-1 px-6 py-5">
              <div className="mb-5 bg-green-500/5 border border-green-500/20 rounded-lg px-4 py-2.5">
                <p className="text-xs text-green-400">✓ Prints all order items — no category setup needed</p>
              </div>
              <HardwareFields
                form={foHw} setForm={setFoHw}
                qzStatus={qzStatus} qzPrinters={qzPrinters}
                showDefaultReceipt={foModal.type === 'receipt'}
              />
              {error && <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mt-4">{error}</p>}
            </div>

            <div className="px-6 py-4 border-t border-gray-800 flex justify-between items-center flex-shrink-0">
              {foEditId ? (
                <button onClick={() => { setDeleteConfirm(printerOfType(foModal.type)!); setFoModal(null); }}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors">Remove printer</button>
              ) : <div />}
              <div className="flex gap-3">
                <button onClick={() => setFoModal(null)} className="px-4 py-2 text-gray-400 hover:text-white text-sm transition-colors">Cancel</button>
                <button onClick={saveFo} disabled={saving}
                  className="px-5 py-2 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-sm font-bold rounded-lg transition-colors">
                  {saving ? 'Saving…' : foEditId ? 'Save changes' : 'Add printer'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Station modal ─────────────────────────────────────────────────────── */}
      {stModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-lg shadow-2xl flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-gray-800 flex-shrink-0">
              <h2 className="text-white font-bold">{stEditId ? `Edit — ${stName}` : 'Add station printer'}</h2>
              <p className="text-xs text-gray-500 mt-0.5">Choose which categories print at this station</p>
            </div>

            <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">
              {/* Station type */}
              {!stEditId && (
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Station type</label>
                  <div className="grid grid-cols-2 gap-2">
                    {STATION_TYPES.map(st => (
                      <button key={st.type}
                        onClick={() => {
                          setStType(st.type);
                          setStName(stCustomLabel || st.label);
                        }}
                        className={`flex items-center gap-2.5 p-3 rounded-xl border text-left transition-colors ${
                          stType === st.type
                            ? 'border-blue-500 bg-blue-500/10'
                            : 'border-gray-700 bg-gray-800 hover:border-gray-600'
                        }`}>
                        <span className="text-xl">{st.icon}</span>
                        <div>
                          <p className={`text-sm font-semibold ${stType === st.type ? 'text-blue-400' : 'text-white'}`}>{st.label}</p>
                          <p className="text-xs text-gray-500">{st.hint}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Station name */}
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Station name</label>
                <input type="text" placeholder="e.g. Kitchen, Grill, Hot Drinks"
                  value={stName} onChange={e => setStName(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500" />
              </div>

              {/* Category selector */}
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                  Categories that print here
                </label>
                {categories.length === 0 ? (
                  <p className="text-xs text-gray-500">No categories found — add categories in Menu → Categories first.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {categories.map(cat => (
                      <button key={cat.id} onClick={() => toggleCat(cat.id)}
                        className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                          stCats.includes(cat.id)
                            ? 'bg-blue-500/15 border-blue-500 text-blue-400'
                            : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
                        }`}>
                        {cat.name}
                      </button>
                    ))}
                  </div>
                )}
                {stCats.length === 0 && (
                  <p className="text-xs text-amber-400/80 mt-2">
                    ⚠ Select at least one category — otherwise this printer receives nothing.
                  </p>
                )}
                {stCats.length > 0 && (
                  <p className="text-xs text-green-400/80 mt-2">
                    ✓ Items from {stCats.length} categor{stCats.length === 1 ? 'y' : 'ies'} will print here.
                  </p>
                )}
              </div>

              {/* Hardware */}
              <div className="border-t border-gray-800 pt-5">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">Hardware setup</p>
                <HardwareFields
                  form={stHw} setForm={setStHw}
                  qzStatus={qzStatus} qzPrinters={qzPrinters}
                />
              </div>

              {error && <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}
            </div>

            <div className="px-6 py-4 border-t border-gray-800 flex justify-end gap-3 flex-shrink-0">
              <button onClick={() => setStModal(false)} className="px-4 py-2 text-gray-400 hover:text-white text-sm transition-colors">Cancel</button>
              <button onClick={saveSt} disabled={saving}
                className="px-5 py-2 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-sm font-bold rounded-lg transition-colors">
                {saving ? 'Saving…' : stEditId ? 'Save changes' : 'Add station'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal state={confirmState} onClose={closeConfirm} />
    </div>
  );
}
