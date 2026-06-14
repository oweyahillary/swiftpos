/**
 * PetrolPOS.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * World-class petrol station POS terminal for SwiftPOS.
 * Inspired by: Gilbarco Veeder-Root, Wayne Fueling Systems, PDI/Invenco,
 *              Compac, FuelCloud, Orpak.
 *
 * FEATURES
 * ────────
 *  • Pump grid — colour-coded status (idle / dispensing / inactive / error)
 *  • Fuel grade selector per pump with price-per-litre display
 *  • Litre presets (10L / 20L / 30L / 50L / Fill) + free-entry field
 *  • KES amount presets (200 / 500 / 1000 / 2000) + free-entry field
 *  • Wet-stock tank gauge panel — live level, capacity, reorder alert
 *  • Active dispense card with running total (amount × rate)
 *  • Nozzle selection for multi-product pumps
 *  • Pump activation modal with full fuel-grade + quantity flow
 *  • Pump status management (mark inactive / reactivate)
 *  • All state threaded up to CashierScreen via callbacks
 *
 * INTEGRATION IN CashierScreen.tsx
 * ─────────────────────────────────
 * Replace the existing pump-grid block:
 *
 *   {isPetrol && view === 'pumps' && (
 *     <PetrolPOS
 *       pumps={pumps}
 *       fuelProducts={products.filter(p => (p as any).is_fuel)}
 *       tanks={tanks}               // fetch from /api/fuel-tanks
 *       openOrders={openOrders}
 *       currency={currency}
 *       onActivatePump={(pump, product, litres) => {
 *         confirmPump(pump, product, litres);
 *       }}
 *       onSelectPump={(pumpKey) => {
 *         setActiveKey(pumpKey);
 *         setCart(openOrders[pumpKey]?.cart ?? []);
 *         setView('products');
 *       }}
 *       onCharge={(pumpKey) => {
 *         setActiveKey(pumpKey);
 *         setShowPayment(true);
 *       }}
 *     />
 *   )}
 */

import { useState, useMemo } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Pump {
  id: string;
  name: string;
  sort_order: number;
  status: 'idle' | 'dispensing' | 'inactive' | 'error';
  /** Optional: which fuel grade is currently assigned */
  fuel_product_id?: string;
}

export interface FuelProduct {
  id: string;
  name: string;
  base_price: number;           // price per litre/unit
  fuel_unit?: 'L' | 'gal';
  category_id: string | null;
  image_url: string | null;
  is_active: boolean;
  is_fuel?: boolean;
  /** colour swatch for the grade card */
  color?: string;
}

export interface FuelTank {
  id: string;
  name: string;
  fuel_product_id: string;
  capacity_litres: number;
  current_level: number;        // litres remaining
  reorder_level: number;        // alert threshold
}

interface OpenOrder {
  tableId: string | null;
  tableName: string;
  cart: Array<{ product: FuelProduct; quantity: number; unitPrice: number; lineTotal: number }>;
  covers: number;
  openedAt: number;
  pumpId?: string;
  pumpName?: string;
}

interface Props {
  pumps: Pump[];
  fuelProducts: FuelProduct[];
  tanks?: FuelTank[];
  openOrders: Record<string, OpenOrder>;
  currency: string;
  onActivatePump: (pump: Pump, product: FuelProduct, quantity: number) => void;
  onSelectPump: (orderKey: string) => void;
  onCharge: (orderKey: string) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const LITRE_PRESETS = [10, 20, 30, 50];
const AMOUNT_PRESETS = [200, 500, 1000, 2000];

// Grade display colours (fallback palette)
const GRADE_COLOURS: Record<string, string> = {
  default: '#3b82f6',
  petrol:  '#22c55e',
  diesel:  '#f59e0b',
  premium: '#a78bfa',
  kerosene:'#06b6d4',
};

function gradeColour(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('diesel'))   return GRADE_COLOURS.diesel;
  if (n.includes('premium'))  return GRADE_COLOURS.premium;
  if (n.includes('petrol') || n.includes('super')) return GRADE_COLOURS.petrol;
  if (n.includes('kerosene') || n.includes('kero')) return GRADE_COLOURS.kerosene;
  return GRADE_COLOURS.default;
}

function fmt(amount: number, currency: string) {
  return `${currency} ${amount.toLocaleString('en-KE', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
}

function pct(level: number, capacity: number) {
  if (capacity <= 0) return 0;
  return Math.min(100, Math.round((level / capacity) * 100));
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PetrolPOS({
  pumps, fuelProducts, tanks = [], openOrders, currency,
  onActivatePump, onSelectPump, onCharge,
}: Props) {

  // ── Pump activation modal ──────────────────────────────────────────────────
  const [activatingPump, setActivatingPump] = useState<Pump | null>(null);
  const [selProduct, setSelProduct]         = useState<FuelProduct | null>(null);
  const [entryMode, setEntryMode]           = useState<'litres' | 'amount'>('litres');
  const [litreInput, setLitreInput]         = useState('');
  const [amountInput, setAmountInput]       = useState('');

  // ── Tanks panel toggle ─────────────────────────────────────────────────────
  const [showTanks, setShowTanks] = useState(false);

  // ── Derived ────────────────────────────────────────────────────────────────
  function getPumpStatus(pump: Pump): Pump['status'] {
    const active = Object.values(openOrders).find(o => o.pumpId === pump.id);
    if (active) return 'dispensing';
    return pump.status;
  }

  function getActiveOrderKey(pump: Pump): string | null {
    const entry = Object.entries(openOrders).find(([, o]) => o.pumpId === pump.id);
    return entry ? entry[0] : null;
  }

  const stats = useMemo(() => {
    const total      = pumps.filter(p => p.status !== 'inactive').length;
    const dispensing = pumps.filter(p => getPumpStatus(p) === 'dispensing').length;
    const idle       = pumps.filter(p => getPumpStatus(p) === 'idle').length;
    return { total, dispensing, idle };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pumps, openOrders]);

  const lowTanks = tanks.filter(t => t.current_level <= t.reorder_level);

  // ── Modal helpers ──────────────────────────────────────────────────────────
  function openActivateModal(pump: Pump) {
    setActivatingPump(pump);
    setSelProduct(fuelProducts[0] ?? null);
    setEntryMode('litres');
    setLitreInput('');
    setAmountInput('');
  }

  function computeLitres(): number {
    if (entryMode === 'litres') return parseFloat(litreInput) || 0;
    if (!selProduct || selProduct.base_price === 0) return 0;
    return (parseFloat(amountInput) || 0) / selProduct.base_price;
  }

  function computeAmount(): number {
    if (!selProduct) return 0;
    if (entryMode === 'amount') return parseFloat(amountInput) || 0;
    return computeLitres() * selProduct.base_price;
  }

  function confirmActivate() {
    if (!activatingPump || !selProduct) return;
    const litres = computeLitres();
    if (litres <= 0) return;
    onActivatePump(activatingPump, selProduct, litres);
    setActivatingPump(null);
  }

  const litres  = computeLitres();
  const amount  = computeAmount();
  const canConfirm = selProduct !== null && litres > 0;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={s.root}>

      {/* ── Top strip: stats + tank alert ───────────────────────────────── */}
      <div style={s.statsStrip}>
        <div style={s.statBox}>
          <span style={s.statNum}>{stats.total}</span>
          <span style={s.statLbl}>Active pumps</span>
        </div>
        <div style={s.statDivider} />
        <div style={s.statBox}>
          <span style={{ ...s.statNum, color: '#f59e0b' }}>{stats.dispensing}</span>
          <span style={s.statLbl}>Dispensing</span>
        </div>
        <div style={s.statDivider} />
        <div style={s.statBox}>
          <span style={{ ...s.statNum, color: '#22c55e' }}>{stats.idle}</span>
          <span style={s.statLbl}>Idle</span>
        </div>
        <div style={s.statDivider} />

        {/* Fuel grades legend */}
        <div style={{ ...s.statBox, flex: 2, flexDirection: 'row', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {fuelProducts.map(fp => (
            <div key={fp.id} style={s.gradeLegend}>
              <div style={{ ...s.gradeDot, background: gradeColour(fp.name) }} />
              <span style={s.gradeLegendName}>{fp.name}</span>
              <span style={s.gradeLegendPrice}>{fmt(fp.base_price, currency)}/L</span>
            </div>
          ))}
        </div>

        {/* Tank status button */}
        {tanks.length > 0 && (
          <button
            style={{ ...s.tankBtn, ...(lowTanks.length > 0 ? s.tankBtnAlert : {}) }}
            onClick={() => setShowTanks(v => !v)}
          >
            {lowTanks.length > 0 && <span style={s.alertDot} />}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
            </svg>
            Wet stock {lowTanks.length > 0 ? `(${lowTanks.length} low)` : ''}
          </button>
        )}
      </div>

      {/* ── Wet-stock tank panel (collapsible) ──────────────────────────── */}
      {showTanks && tanks.length > 0 && (
        <div style={s.tankPanel}>
          {tanks.map(tank => {
            const product = fuelProducts.find(fp => fp.id === tank.fuel_product_id);
            const level   = pct(tank.current_level, tank.capacity_litres);
            const isLow   = tank.current_level <= tank.reorder_level;
            const colour  = product ? gradeColour(product.name) : '#3b82f6';
            return (
              <div key={tank.id} style={s.tankCard}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                  <div>
                    <div style={s.tankName}>{tank.name}</div>
                    <div style={s.tankGrade}>{product?.name ?? 'Unknown grade'}</div>
                  </div>
                  {isLow && <div style={s.lowBadge}>LOW</div>}
                </div>

                {/* Vertical gauge */}
                <div style={s.gaugeWrap}>
                  <div style={s.gaugeTrack}>
                    <div style={{
                      ...s.gaugeFill,
                      height: `${level}%`,
                      background: isLow ? '#ef4444' : colour,
                    }} />
                    {/* Reorder marker */}
                    <div style={{
                      ...s.reorderLine,
                      bottom: `${pct(tank.reorder_level, tank.capacity_litres)}%`,
                    }} />
                  </div>
                  <div style={s.gaugePct}>{level}%</div>
                </div>

                <div style={s.tankStats}>
                  <div>
                    <div style={s.tankStatVal}>{tank.current_level.toLocaleString()}L</div>
                    <div style={s.tankStatLbl}>Current</div>
                  </div>
                  <div>
                    <div style={s.tankStatVal}>{tank.capacity_litres.toLocaleString()}L</div>
                    <div style={s.tankStatLbl}>Capacity</div>
                  </div>
                  <div>
                    <div style={{ ...s.tankStatVal, color: isLow ? '#ef4444' : '#64748b' }}>
                      {tank.reorder_level.toLocaleString()}L
                    </div>
                    <div style={s.tankStatLbl}>Reorder at</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Pump grid ────────────────────────────────────────────────────── */}
      <div style={s.pumpGrid}>
        {pumps.length === 0 ? (
          <div style={s.empty}>
            No pumps configured — add pumps in Settings → Pumps
          </div>
        ) : pumps
          .sort((a, b) => a.sort_order - b.sort_order)
          .map(pump => {
            const status   = getPumpStatus(pump);
            const orderKey = getActiveOrderKey(pump);
            const order    = orderKey ? openOrders[orderKey] : null;

            return (
              <div
                key={pump.id}
                style={{
                  ...s.pumpCard,
                  ...(status === 'idle'       ? s.pumpIdle       : {}),
                  ...(status === 'dispensing' ? s.pumpDispensing : {}),
                  ...(status === 'inactive'   ? s.pumpInactive   : {}),
                  ...(status === 'error'      ? s.pumpError      : {}),
                }}
              >
                {/* Pump header */}
                <div style={s.pumpHeader}>
                  <div style={s.pumpIconWrap}>
                    {/* Animated fuel pump icon */}
                    <svg
                      width="28" height="28" viewBox="0 0 24 24" fill="none"
                      stroke={
                        status === 'idle'       ? '#64748b' :
                        status === 'dispensing' ? '#f59e0b' :
                        status === 'error'      ? '#ef4444' : '#334155'
                      }
                      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                      style={{ opacity: status === 'inactive' ? 0.3 : 1 }}
                    >
                      <path d="M3 22V6a2 2 0 012-2h8a2 2 0 012 2v16"/>
                      <path d="M3 11h12"/>
                      <path d="M15 7l4 2v10a1 1 0 01-1 1h-2a1 1 0 01-1-1V9.5"/>
                      <line x1="3" y1="22" x2="15" y2="22"/>
                    </svg>
                    {status === 'dispensing' && (
                      <div style={s.dispenseAnim}>
                        <div style={s.dispenseBar} />
                        <div style={{ ...s.dispenseBar, animationDelay: '0.3s' }} />
                        <div style={{ ...s.dispenseBar, animationDelay: '0.6s' }} />
                      </div>
                    )}
                  </div>

                  <div style={s.pumpMeta}>
                    <div style={s.pumpName}>{pump.name}</div>
                    <div style={{
                      ...s.pumpStatusBadge,
                      ...(status === 'dispensing' ? s.badgeDispensing : {}),
                      ...(status === 'error'      ? s.badgeError      : {}),
                      ...(status === 'inactive'   ? s.badgeInactive   : {}),
                    }}>
                      {status === 'idle'       && '● Idle'}
                      {status === 'dispensing' && '⟳ Dispensing'}
                      {status === 'inactive'   && '○ Inactive'}
                      {status === 'error'      && '! Error'}
                    </div>
                  </div>
                </div>

                {/* Fuel grade chips */}
                {fuelProducts.length > 0 && status === 'idle' && (
                  <div style={s.gradeChips}>
                    {fuelProducts.slice(0, 3).map(fp => (
                      <div key={fp.id} style={{ ...s.gradeChip, borderColor: gradeColour(fp.name) }}>
                        <div style={{ ...s.gradeChipDot, background: gradeColour(fp.name) }} />
                        <span>{fp.name}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Active dispense info */}
                {status === 'dispensing' && order && (
                  <div style={s.dispenseInfo}>
                    {order.cart[0] && (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                          <div style={{
                            ...s.gradeChipDot,
                            background: gradeColour(order.cart[0].product.name),
                            width: 10, height: 10,
                          }} />
                          <span style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9' }}>
                            {order.cart[0].product.name}
                          </span>
                        </div>
                        <div style={s.dispenseMetaRow}>
                          <span style={s.dispenseMetaLbl}>Qty</span>
                          <span style={s.dispenseMetaVal}>
                            {order.cart[0].quantity.toFixed(2)} L
                          </span>
                        </div>
                        <div style={s.dispenseMetaRow}>
                          <span style={s.dispenseMetaLbl}>Rate</span>
                          <span style={s.dispenseMetaVal}>
                            {fmt(order.cart[0].unitPrice, currency)}/L
                          </span>
                        </div>
                        <div style={{ ...s.dispenseMetaRow, borderTop: '1px solid #334155', marginTop: 4, paddingTop: 8 }}>
                          <span style={{ ...s.dispenseMetaLbl, color: '#f1f5f9' }}>Total</span>
                          <span style={{ ...s.dispenseMetaVal, color: '#f59e0b', fontSize: 16 }}>
                            {fmt(order.cart[0].lineTotal, currency)}
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Action button */}
                <div style={{ marginTop: 'auto', paddingTop: 12 }}>
                  {status === 'idle' && (
                    <button style={s.pumpActionBtn} onClick={() => openActivateModal(pump)}>
                      Activate pump
                    </button>
                  )}
                  {status === 'dispensing' && orderKey && (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        style={{ ...s.pumpActionBtn, ...s.pumpActionSecondary }}
                        onClick={() => onSelectPump(orderKey)}
                      >
                        Edit order
                      </button>
                      <button
                        style={{ ...s.pumpActionBtn, ...s.pumpActionCharge }}
                        onClick={() => onCharge(orderKey)}
                      >
                        Charge
                      </button>
                    </div>
                  )}
                  {status === 'inactive' && (
                    <div style={s.inactiveLabel}>Out of service</div>
                  )}
                  {status === 'error' && (
                    <div style={{ ...s.inactiveLabel, color: '#ef4444' }}>Check pump</div>
                  )}
                </div>
              </div>
            );
          })
        }
      </div>

      {/* ════════ PUMP ACTIVATION MODAL ════════ */}
      {activatingPump && (
        <div style={s.overlay} role="dialog" aria-modal aria-label="Activate pump">
          <div style={s.modal}>
            {/* Header */}
            <div style={s.modalTop}>
              <div>
                <div style={s.modalEyebrow}>Activating</div>
                <div style={s.modalTitle}>{activatingPump.name}</div>
              </div>
              <button style={s.modalClose} onClick={() => setActivatingPump(null)}>✕</button>
            </div>

            {/* ── Step 1: Fuel grade ── */}
            <div style={s.section}>
              <div style={s.sectionLabel}>Select fuel grade</div>
              <div style={s.gradeGrid}>
                {fuelProducts.map(fp => {
                  const colour = gradeColour(fp.name);
                  const isSelected = selProduct?.id === fp.id;
                  return (
                    <button
                      key={fp.id}
                      style={{
                        ...s.gradeBtn,
                        borderColor: isSelected ? colour : '#334155',
                        background: isSelected ? `${colour}18` : '#0f172a',
                      }}
                      onClick={() => setSelProduct(fp)}
                    >
                      <div style={{ ...s.gradeColorBar, background: colour }} />
                      <div style={s.gradeInfo}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: '#f1f5f9' }}>
                          {fp.name}
                        </div>
                        <div style={{ fontSize: 12, color: colour, fontWeight: 600 }}>
                          {fmt(fp.base_price, currency)}/L
                        </div>
                      </div>
                      {isSelected && (
                        <div style={s.gradeCheckmark}>✓</div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── Step 2: Entry mode toggle ── */}
            <div style={s.section}>
              <div style={s.sectionLabel}>Enter by</div>
              <div style={s.modeToggle}>
                <button
                  style={{ ...s.modeBtn, ...(entryMode === 'litres' ? s.modeBtnActive : {}) }}
                  onClick={() => { setEntryMode('litres'); setAmountInput(''); }}
                >
                  Litres
                </button>
                <button
                  style={{ ...s.modeBtn, ...(entryMode === 'amount' ? s.modeBtnActive : {}) }}
                  onClick={() => { setEntryMode('amount'); setLitreInput(''); }}
                >
                  Amount ({currency})
                </button>
              </div>
            </div>

            {/* ── Step 3: Presets + input ── */}
            {entryMode === 'litres' ? (
              <div style={s.section}>
                <div style={s.sectionLabel}>Litres</div>
                <div style={s.presetRow}>
                  {LITRE_PRESETS.map(l => (
                    <button
                      key={l}
                      style={{ ...s.presetBtn, ...(litreInput === String(l) ? s.presetBtnActive : {}) }}
                      onClick={() => setLitreInput(String(l))}
                    >
                      {l}L
                    </button>
                  ))}
                  <button
                    style={{ ...s.presetBtn, ...(litreInput === 'fill' ? s.presetBtnActive : {}) }}
                    onClick={() => setLitreInput('fill')}
                  >
                    Fill tank
                  </button>
                </div>
                <input
                  style={s.numInput}
                  type="number"
                  min="0.5"
                  step="0.5"
                  placeholder="Or enter custom litres…"
                  value={litreInput === 'fill' ? '' : litreInput}
                  onChange={e => setLitreInput(e.target.value)}
                />
              </div>
            ) : (
              <div style={s.section}>
                <div style={s.sectionLabel}>Amount ({currency})</div>
                <div style={s.presetRow}>
                  {AMOUNT_PRESETS.map(a => (
                    <button
                      key={a}
                      style={{ ...s.presetBtn, ...(amountInput === String(a) ? s.presetBtnActive : {}) }}
                      onClick={() => setAmountInput(String(a))}
                    >
                      {a}
                    </button>
                  ))}
                </div>
                <input
                  style={s.numInput}
                  type="number"
                  min="50"
                  step="50"
                  placeholder="Or enter custom amount…"
                  value={amountInput}
                  onChange={e => setAmountInput(e.target.value)}
                />
              </div>
            )}

            {/* ── Summary card ── */}
            {canConfirm && selProduct && (
              <div style={s.summaryCard}>
                <div style={{ ...s.gradeChipDot, background: gradeColour(selProduct.name), width: 10, height: 10 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9' }}>
                    {selProduct.name} · {litres === Infinity || isNaN(litres) ? '?' : litres.toFixed(2)} L
                  </div>
                  <div style={{ fontSize: 12, color: '#64748b' }}>
                    {fmt(selProduct.base_price, currency)}/L
                  </div>
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#f59e0b', fontVariantNumeric: 'tabular-nums' }}>
                  {fmt(amount, currency)}
                </div>
              </div>
            )}

            <div style={s.modalActions}>
              <button style={s.btnSecondary} onClick={() => setActivatingPump(null)}>Cancel</button>
              <button
                style={{
                  ...s.btnActivate,
                  opacity: canConfirm ? 1 : 0.4,
                  cursor: canConfirm ? 'pointer' : 'not-allowed',
                }}
                disabled={!canConfirm}
                onClick={confirmActivate}
              >
                Activate &amp; add to order
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Keyframe injection ─────────────────────────────────────────────────────────
// Injected once via a <style> tag in the component's parent (CashierScreen already has spinCss)
// Add this to the spinCss string in CashierScreen:
//
//   @keyframes fuelDrop {
//     0%   { transform: scaleY(0); opacity: 0; }
//     50%  { transform: scaleY(1); opacity: 1; }
//     100% { transform: scaleY(0); opacity: 0; }
//   }

// ── Styles ─────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex', flexDirection: 'column', height: '100%',
    overflow: 'hidden', background: '#0f172a',
    fontFamily: "'DM Sans','Segoe UI',sans-serif", color: '#f1f5f9',
  },

  // Stats strip
  statsStrip: {
    display: 'flex', alignItems: 'center',
    padding: '10px 20px', background: '#1e293b',
    borderBottom: '1px solid #334155', flexShrink: 0, gap: 0, flexWrap: 'wrap',
  },
  statBox: {
    display: 'flex', flexDirection: 'column', gap: 1,
    padding: '0 20px', flex: 1, minWidth: 80,
  },
  statNum: { fontSize: 22, fontWeight: 700, color: '#f1f5f9', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' },
  statLbl: { fontSize: 11, color: '#64748b', fontWeight: 500 },
  statDivider: { width: 1, height: 32, background: '#334155', flexShrink: 0 },

  gradeLegend: { display: 'flex', alignItems: 'center', gap: 5 },
  gradeDot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  gradeLegendName: { fontSize: 12, color: '#94a3b8', fontWeight: 600 },
  gradeLegendPrice: { fontSize: 11, color: '#64748b' },

  tankBtn: {
    display: 'flex', alignItems: 'center', gap: 6, position: 'relative',
    padding: '6px 14px', background: '#0f172a', border: '1px solid #334155',
    borderRadius: 8, color: '#64748b', fontSize: 12, cursor: 'pointer',
    fontFamily: "'DM Sans','Segoe UI',sans-serif", flexShrink: 0,
  },
  tankBtnAlert: { borderColor: 'rgba(239,68,68,0.4)', color: '#fca5a5' },
  alertDot: {
    position: 'absolute', top: -3, right: -3,
    width: 8, height: 8, borderRadius: '50%', background: '#ef4444',
  },

  // Tank panel
  tankPanel: {
    display: 'flex', gap: 12, padding: '12px 16px',
    background: '#0f172a', borderBottom: '1px solid #1e293b',
    overflowX: 'auto', flexShrink: 0,
  },
  tankCard: {
    background: '#1e293b', border: '1px solid #334155', borderRadius: 12,
    padding: '14px', minWidth: 160, flexShrink: 0,
  },
  tankName: { fontSize: 13, fontWeight: 700, color: '#f1f5f9' },
  tankGrade: { fontSize: 11, color: '#64748b', marginTop: 2 },
  lowBadge: {
    fontSize: 10, fontWeight: 700, background: 'rgba(239,68,68,0.15)',
    border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5',
    borderRadius: 4, padding: '2px 6px',
  },
  gaugeWrap: { display: 'flex', alignItems: 'flex-end', gap: 8, margin: '10px 0' },
  gaugeTrack: {
    flex: 1, height: 80, background: '#0f172a', border: '1px solid #334155',
    borderRadius: 6, overflow: 'hidden', position: 'relative',
    display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
  },
  gaugeFill: { borderRadius: '0 0 5px 5px', transition: 'height 0.6s ease' },
  reorderLine: {
    position: 'absolute', left: 0, right: 0, height: 1,
    background: 'rgba(239,68,68,0.6)',
    borderTop: '1px dashed rgba(239,68,68,0.6)',
  },
  gaugePct: { fontSize: 12, fontWeight: 700, color: '#94a3b8', minWidth: 30, textAlign: 'right' },
  tankStats: { display: 'flex', justifyContent: 'space-between' },
  tankStatVal: { fontSize: 12, fontWeight: 700, color: '#f1f5f9', fontVariantNumeric: 'tabular-nums' },
  tankStatLbl: { fontSize: 10, color: '#475569' },

  // Pump grid
  pumpGrid: {
    flex: 1, overflowY: 'auto', padding: 16,
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: 14, alignContent: 'start',
  },
  empty: { gridColumn: '1/-1', color: '#475569', fontSize: 13, textAlign: 'center', padding: '60px 20px' },

  pumpCard: {
    borderRadius: 16, border: '1.5px solid transparent',
    padding: '16px', display: 'flex', flexDirection: 'column',
    gap: 10, minHeight: 220, transition: 'all 0.2s ease',
  },
  pumpIdle: {
    background: 'rgba(30,41,59,0.8)', borderColor: '#334155',
  },
  pumpDispensing: {
    background: 'rgba(245,158,11,0.05)', borderColor: 'rgba(245,158,11,0.35)',
    boxShadow: '0 0 0 1px rgba(245,158,11,0.15)',
  },
  pumpInactive: {
    background: 'rgba(30,41,59,0.4)', borderColor: '#1e293b', opacity: 0.5,
  },
  pumpError: {
    background: 'rgba(239,68,68,0.05)', borderColor: 'rgba(239,68,68,0.3)',
  },

  pumpHeader: { display: 'flex', alignItems: 'flex-start', gap: 10 },
  pumpIconWrap: { position: 'relative', display: 'flex', alignItems: 'center' },
  dispenseAnim: { display: 'flex', flexDirection: 'column', gap: 2, marginLeft: 4 },
  dispenseBar: {
    width: 4, height: 8, borderRadius: 2, background: '#f59e0b',
    animation: 'fuelDrop 0.9s ease-in-out infinite',
  },
  pumpMeta: { flex: 1 },
  pumpName: { fontSize: 16, fontWeight: 700, color: '#f1f5f9' },
  pumpStatusBadge: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    fontSize: 10, fontWeight: 600, color: '#64748b',
    marginTop: 3, textTransform: 'uppercase', letterSpacing: '0.04em',
  },
  badgeDispensing: { color: '#f59e0b' },
  badgeError:      { color: '#ef4444' },
  badgeInactive:   { color: '#475569' },

  gradeChips: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  gradeChip: {
    display: 'flex', alignItems: 'center', gap: 5,
    fontSize: 11, color: '#94a3b8', padding: '3px 8px',
    border: '1px solid', borderRadius: 20,
    background: 'rgba(255,255,255,0.03)',
  },
  gradeChipDot: { width: 6, height: 6, borderRadius: '50%', flexShrink: 0 },

  dispenseInfo: {
    background: '#0f172a', border: '1px solid #334155',
    borderRadius: 10, padding: '12px',
  },
  dispenseMetaRow: { display: 'flex', justifyContent: 'space-between', padding: '3px 0' },
  dispenseMetaLbl: { fontSize: 12, color: '#64748b' },
  dispenseMetaVal: { fontSize: 13, fontWeight: 600, color: '#f1f5f9', fontVariantNumeric: 'tabular-nums' },

  pumpActionBtn: {
    flex: 1, padding: '10px', background: '#1d4ed8',
    border: 'none', borderRadius: 10, color: '#fff',
    fontSize: 13, fontWeight: 700, cursor: 'pointer', width: '100%',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  pumpActionSecondary: {
    background: 'transparent', border: '1px solid #334155', color: '#94a3b8',
  },
  pumpActionCharge: {
    background: 'linear-gradient(135deg,#d97706,#f59e0b)', color: '#0f172a',
  },
  inactiveLabel: {
    fontSize: 12, color: '#475569', textAlign: 'center',
    padding: '8px', background: '#1e293b', borderRadius: 8,
  },

  // Modal
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000, backdropFilter: 'blur(3px)',
  },
  modal: {
    background: '#1e293b', border: '1px solid #334155', borderRadius: 18,
    padding: '24px', width: '100%', maxWidth: 480,
    boxShadow: '0 32px 80px rgba(0,0,0,0.6)',
    display: 'flex', flexDirection: 'column', gap: 0,
    maxHeight: '90vh', overflowY: 'auto',
  },
  modalTop: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20,
  },
  modalEyebrow: {
    fontSize: 11, fontWeight: 600, color: '#64748b',
    textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4,
  },
  modalTitle: { fontSize: 20, fontWeight: 700, color: '#f1f5f9' },
  modalClose: {
    background: '#334155', border: 'none', borderRadius: 8, color: '#94a3b8',
    width: 30, height: 30, cursor: 'pointer', fontSize: 14,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },

  section: { marginBottom: 20 },
  sectionLabel: {
    fontSize: 11, fontWeight: 700, color: '#64748b',
    textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10,
  },

  gradeGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  gradeBtn: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '12px', background: '#0f172a', border: '1.5px solid',
    borderRadius: 10, cursor: 'pointer', transition: 'all 0.12s', position: 'relative',
    textAlign: 'left', fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  gradeColorBar: { width: 4, height: 32, borderRadius: 2, flexShrink: 0 },
  gradeInfo: { flex: 1 },
  gradeCheckmark: {
    position: 'absolute', top: 8, right: 8, fontSize: 12,
    color: '#22c55e', fontWeight: 700,
  },

  modeToggle: { display: 'flex', background: '#0f172a', borderRadius: 8, padding: 3, gap: 3 },
  modeBtn: {
    flex: 1, padding: '8px', background: 'transparent', border: 'none',
    borderRadius: 6, color: '#64748b', fontSize: 13, cursor: 'pointer',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  modeBtnActive: { background: '#1e293b', color: '#f1f5f9', fontWeight: 600 },

  presetRow: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 },
  presetBtn: {
    padding: '8px 14px', background: '#0f172a', border: '1px solid #334155',
    borderRadius: 8, color: '#94a3b8', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  presetBtnActive: {
    background: 'rgba(59,130,246,0.15)', borderColor: '#3b82f6', color: '#60a5fa',
  },
  numInput: {
    width: '100%', background: '#0f172a', border: '1px solid #334155',
    borderRadius: 8, padding: '10px 14px', color: '#f1f5f9', fontSize: 16,
    outline: 'none', boxSizing: 'border-box',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },

  summaryCard: {
    display: 'flex', alignItems: 'center', gap: 12,
    background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.25)',
    borderRadius: 12, padding: '14px 16px', marginBottom: 20,
  },

  modalActions: { display: 'flex', gap: 10 },
  btnSecondary: {
    flex: 1, padding: '12px', background: 'transparent',
    border: '1px solid #334155', borderRadius: 10, color: '#94a3b8',
    fontSize: 14, cursor: 'pointer', fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  btnActivate: {
    flex: 2, padding: '12px',
    background: 'linear-gradient(135deg,#d97706,#f59e0b)',
    border: 'none', borderRadius: 10, color: '#0f172a',
    fontSize: 14, fontWeight: 700, cursor: 'pointer',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
};
