/**
 * FloorPlanTab.tsx
 *
 * Drag-and-drop floor plan designer for restaurant tables.
 * Saves pos_x / pos_y back to the tables table via PATCH /api/tables/:id.
 *
 * Features:
 *  - Drag tables freely on a 800×560 canvas
 *  - Snap-to-grid (40px) toggle
 *  - Section colour-coding
 *  - Rect / circle shapes per table
 *  - Occupied status overlay (reads open orders from POS session — optional)
 *  - "Save layout" batch-saves all positions in parallel
 *  - Zoom in/out
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { api } from '../../lib/api';

interface Table {
  id: string; name: string; capacity: number;
  shape?: 'rect' | 'circle'; zone?: string;
  pos_x?: number; pos_y?: number; status?: 'active' | 'inactive';
}

interface Props {
  branchId: string;
}

const CANVAS_W = 800;
const CANVAS_H = 560;
const GRID     = 40;
const TABLE_W  = 72;
const TABLE_H  = 52;

const SECTION_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  'Main Hall': { bg: '#1e3a5f',  border: '#2563eb', text: '#93c5fd' },
  'Terrace':   { bg: '#14532d',  border: '#16a34a', text: '#86efac' },
  'Private':   { bg: '#3b0764',  border: '#9333ea', text: '#d8b4fe' },
  'Bar':       { bg: '#451a03',  border: '#d97706', text: '#fcd34d' },
  'VIP':       { bg: '#500724',  border: '#db2777', text: '#f9a8d4' },
};
const DEFAULT_COLOR = { bg: '#1f2937', border: '#4b5563', text: '#9ca3af' };

function getColor(section?: string) {
  return section ? (SECTION_COLORS[section] ?? DEFAULT_COLOR) : DEFAULT_COLOR;
}

function snap(v: number) {
  return Math.round(v / GRID) * GRID;
}

export default function FloorPlanTab({ branchId }: Props) {
  const [tables, setTables]       = useState<Table[]>([]);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [dirty, setDirty]         = useState(false);
  const [snapGrid, setSnapGrid]   = useState(true);
  const [zoom, setZoom]           = useState(1);
  const [selected, setSelected]   = useState<string | null>(null);
  const [toast, setToast]         = useState('');

  const dragRef = useRef<{
    id: string; startX: number; startY: number;
    origX: number; origY: number;
  } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => { loadTables(); }, [branchId]);

  async function loadTables() {
    setLoading(true);
    try {
      const data = await api.get<Table[]>(`/api/tables?branch_id=${branchId}&slot_type=dining`);
      // Auto-place any tables with no position
      const placed = (data ?? []).map((t, i) => ({
        ...t,
        pos_x: t.pos_x ?? GRID + (i % 5) * (TABLE_W + GRID),
        pos_y: t.pos_y ?? GRID + Math.floor(i / 5) * (TABLE_H + GRID),
      }));
      setTables(placed);
    } finally { setLoading(false); }
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  }

  async function saveLayout() {
    setSaving(true);
    try {
      await Promise.all(
        tables.map(t =>
          api.patch(`/api/tables/${t.id}`, { pos_x: t.pos_x, pos_y: t.pos_y })
        )
      );
      setDirty(false);
      showToast('Layout saved ✓');
    } catch {
      showToast('Save failed — try again');
    } finally { setSaving(false); }
  }

  // ── Drag handlers ──────────────────────────────────────────────────────────

  const onMouseDown = useCallback((e: React.MouseEvent, tableId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(tableId);
    const table = tables.find(t => t.id === tableId);
    if (!table) return;
    dragRef.current = {
      id: tableId,
      startX: e.clientX,
      startY: e.clientY,
      origX: table.pos_x ?? 0,
      origY: table.pos_y ?? 0,
    };
  }, [tables]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current || !canvasRef.current) return;
    const { id, startX, startY, origX, origY } = dragRef.current;
    const dx = (e.clientX - startX) / zoom;
    const dy = (e.clientY - startY) / zoom;
    let nx = origX + dx;
    let ny = origY + dy;
    if (snapGrid) { nx = snap(nx); ny = snap(ny); }
    // Clamp inside canvas
    nx = Math.max(0, Math.min(CANVAS_W - TABLE_W, nx));
    ny = Math.max(0, Math.min(CANVAS_H - TABLE_H, ny));

    setTables(prev =>
      prev.map(t => t.id === id ? { ...t, pos_x: Math.round(nx), pos_y: Math.round(ny) } : t)
    );
    setDirty(true);
  }, [zoom, snapGrid]);

  const onMouseUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  // Touch support
  const onTouchStart = useCallback((e: React.TouchEvent, tableId: string) => {
    const touch = e.touches[0];
    setSelected(tableId);
    const table = tables.find(t => t.id === tableId);
    if (!table) return;
    dragRef.current = {
      id: tableId,
      startX: touch.clientX,
      startY: touch.clientY,
      origX: table.pos_x ?? 0,
      origY: table.pos_y ?? 0,
    };
  }, [tables]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!dragRef.current) return;
    const touch = e.touches[0];
    const { id, startX, startY, origX, origY } = dragRef.current;
    const dx = (touch.clientX - startX) / zoom;
    const dy = (touch.clientY - startY) / zoom;
    let nx = Math.max(0, Math.min(CANVAS_W - TABLE_W, origX + dx));
    let ny = Math.max(0, Math.min(CANVAS_H - TABLE_H, origY + dy));
    if (snapGrid) { nx = snap(nx); ny = snap(ny); }
    setTables(prev =>
      prev.map(t => t.id === id ? { ...t, pos_x: Math.round(nx), pos_y: Math.round(ny) } : t)
    );
    setDirty(true);
  }, [zoom, snapGrid]);

  const onTouchEnd = useCallback(() => { dragRef.current = null; }, []);

  if (loading) return <div className="text-center py-16 text-gray-500 text-sm">Loading floor plan…</div>;

  if (tables.length === 0) {
    return (
      <div className="text-center py-16">
        <div className="text-4xl mb-3">🪑</div>
        <p className="text-gray-500 text-sm">No tables yet. Create tables in the Tables tab first.</p>
      </div>
    );
  }

  const sections = [...new Set(tables.map(t => t.zone || 'Main Hall'))];

  return (
    <div>
      {toast && (
        <div className="fixed bottom-6 right-6 bg-green-500 text-white px-5 py-2.5 rounded-lg font-semibold z-50 shadow-lg text-sm">
          {toast}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          {/* Snap grid toggle */}
          <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer select-none">
            <div
              onClick={() => setSnapGrid(p => !p)}
              className={`relative w-9 h-5 rounded-full transition-colors ${snapGrid ? 'bg-blue-600' : 'bg-gray-700'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${snapGrid ? 'translate-x-4' : ''}`} />
            </div>
            Snap to grid
          </label>

          {/* Zoom */}
          <div className="flex items-center gap-1.5">
            <button onClick={() => setZoom(z => Math.max(0.5, z - 0.1))}
              className="w-7 h-7 bg-gray-800 hover:bg-gray-700 text-white text-sm rounded-md flex items-center justify-center">−</button>
            <span className="text-xs text-gray-400 w-10 text-center">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(z => Math.min(2, z + 0.1))}
              className="w-7 h-7 bg-gray-800 hover:bg-gray-700 text-white text-sm rounded-md flex items-center justify-center">+</button>
            <button onClick={() => setZoom(1)}
              className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 text-xs rounded-md">Reset</button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {dirty && <span className="text-xs text-amber-400 font-medium">● Unsaved changes</span>}
          <button onClick={saveLayout} disabled={saving || !dirty}
            className="px-4 py-2 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors">
            {saving ? 'Saving…' : 'Save layout'}
          </button>
        </div>
      </div>

      {/* Section legend */}
      <div className="flex flex-wrap gap-2 mb-3">
        {sections.map(section => {
          const c = getColor(section);
          return (
            <div key={section} className="flex items-center gap-1.5 text-xs" style={{ color: c.text }}>
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: c.border }} />
              {section}
            </div>
          );
        })}
      </div>

      {/* Canvas */}
      <div className="overflow-auto rounded-xl border border-gray-800">
        <div style={{ width: CANVAS_W * zoom, height: CANVAS_H * zoom, minWidth: '100%' }}>
          <div
            ref={canvasRef}
            style={{
              position: 'relative',
              width: CANVAS_W,
              height: CANVAS_H,
              transform: `scale(${zoom})`,
              transformOrigin: '0 0',
              background: '#0a0f1a',
              cursor: 'default',
              userSelect: 'none',
            }}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
          >
            {/* Grid dots */}
            {snapGrid && Array.from({ length: Math.floor(CANVAS_H / GRID) + 1 }, (_, row) =>
              Array.from({ length: Math.floor(CANVAS_W / GRID) + 1 }, (_, col) => (
                <div
                  key={`${row}-${col}`}
                  style={{
                    position: 'absolute',
                    left: col * GRID - 1,
                    top: row * GRID - 1,
                    width: 2, height: 2,
                    borderRadius: '50%',
                    background: '#1f2937',
                  }}
                />
              ))
            )}

            {/* Tables */}
            {tables.map(table => {
              const c = getColor(table.zone);
              const isSelected = selected === table.id;
              const isCircle = table.shape === 'circle';
              const x = table.pos_x ?? 0;
              const y = table.pos_y ?? 0;

              return (
                <div
                  key={table.id}
                  onMouseDown={e => onMouseDown(e, table.id)}
                  onTouchStart={e => onTouchStart(e, table.id)}
                  style={{
                    position: 'absolute',
                    left: x,
                    top: y,
                    width: TABLE_W,
                    height: isCircle ? TABLE_W : TABLE_H,
                    borderRadius: isCircle ? '50%' : 10,
                    background: c.bg,
                    border: `2px solid ${isSelected ? '#fff' : c.border}`,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'grab',
                    boxShadow: isSelected ? `0 0 0 3px ${c.border}40` : 'none',
                    transition: 'box-shadow 0.1s',
                    zIndex: isSelected ? 10 : 1,
                  }}
                >
                  <span style={{ color: c.text, fontSize: 12, fontWeight: 600, lineHeight: 1.2, textAlign: 'center', pointerEvents: 'none' }}>
                    {table.name}
                  </span>
                  <span style={{ color: c.text, fontSize: 10, opacity: 0.6, pointerEvents: 'none' }}>
                    👥{table.capacity}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Selected table info */}
      {selected && (() => {
        const t = tables.find(t => t.id === selected);
        if (!t) return null;
        return (
          <div className="mt-3 flex items-center gap-4 text-xs text-gray-500 bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5">
            <span className="text-white font-medium">{t.name}</span>
            <span>Section: {t.zone || 'Main Hall'}</span>
            <span>Shape: {t.shape || 'rect'}</span>
            <span>Capacity: {t.capacity}</span>
            <span>Position: ({t.pos_x}, {t.pos_y})</span>
            <button onClick={() => setSelected(null)} className="ml-auto text-gray-600 hover:text-white">✕</button>
          </div>
        );
      })()}

      <p className="text-xs text-gray-700 mt-3">
        Drag tables to position them. Changes are not saved until you click "Save layout".
      </p>
    </div>
  );
}
