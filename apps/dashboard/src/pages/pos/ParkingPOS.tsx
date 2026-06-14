/**
 * ParkingPOS.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * World-class parking terminal for SwiftPOS.
 * Inspired by: ParkWhiz, Flowbird, T2 Systems, Skidata, HUB Parking.
 *
 * FEATURES
 * ────────
 *  • Visual bay map — colour-coded status (free / occupied / reserved / blocked)
 *  • Live elapsed timer per bay, auto-refreshes every 30 s
 *  • Vehicle entry modal — plate (auto-uppercase), vehicle type picker, rate input
 *  • Checkout flow — duration, billed hours (ceil), amount due, charge button
 *  • Overstay highlight — bays open > 8 hours shown in amber warning
 *  • Multi-rate support — per-bay override or global default rate
 *  • Search / filter — find a bay by number or plate
 *  • List ↔ Grid view toggle
 *  • Persistent session state passed up to CashierScreen via callbacks
 *
 * INTEGRATION IN CashierScreen.tsx
 * ─────────────────────────────────
 * Replace the existing bay-grid block:
 *
 *   {isParking && view === 'bays' && (
 *     <ParkingPOS
 *       bays={tables}
 *       activeSessions={activeParkingSessions}
 *       openOrders={openOrders}
 *       currency={currency}
 *       defaultRate={200}
 *       onStartSession={(bay, plate, type, rate) => {
 *         // replaces confirmParking()
 *         confirmParking(bay, plate, type, rate);
 *       }}
 *       onCheckout={(bayId) => {
 *         // select the bay and show PaymentModal
 *         setActiveKey(bayId);
 *         setCart(openOrders[bayId]?.cart ?? []);
 *         setShowPayment(true);
 *       }}
 *       now={now}
 *     />
 *   )}
 */

import { useState, useMemo, useRef, useEffect } from 'react';

// ── Types (mirror CashierScreen) ──────────────────────────────────────────────

export interface Bay {
  id: string;
  name: string;
  capacity: number;
  sort_order: number;
  slot_type?: string;
  /** Optional: per-bay rate override */
  rate_per_hour?: number;
  /** Optional: reserved / blocked status */
  bay_status?: 'active' | 'reserved' | 'blocked';
}

export interface ParkingSession {
  id: string;
  bay_id: string;
  vehicle_plate?: string;
  vehicle_type: string;
  rate_per_hour: number;
  started_at: string;
  status: 'open' | 'completed' | 'voided';
}

interface OpenOrder {
  tableId: string | null;
  tableName: string;
  cart: unknown[];
  covers: number;
  openedAt: number;
  parkingSessionId?: string;
  vehiclePlate?: string;
  ratePerHour?: number;
}

interface Props {
  bays: Bay[];
  activeSessions: Record<string, ParkingSession>;
  openOrders: Record<string, OpenOrder>;
  currency: string;
  defaultRate?: number;
  now: number;
  onStartSession: (
    bay: Bay,
    plate: string,
    vehicleType: string,
    rate: number,
  ) => void;
  onCheckout: (bayId: string) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(amount: number, currency: string) {
  return `${currency} ${amount.toLocaleString('en-KE', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
}

function elapsed(startedAt: string, now: number): { h: number; m: number; totalMins: number } {
  const ms = now - new Date(startedAt).getTime();
  const totalMins = Math.floor(ms / 60000);
  return { h: Math.floor(totalMins / 60), m: totalMins % 60, totalMins };
}

function billedHours(startedAt: string, now: number): number {
  const ms = now - new Date(startedAt).getTime();
  return Math.max(1, Math.ceil(ms / 3600000));
}

const VEHICLE_TYPES = [
  { key: 'car',       icon: '🚗', label: 'Car' },
  { key: 'suv',       icon: '🚙', label: 'SUV' },
  { key: 'truck',     icon: '🚛', label: 'Truck' },
  { key: 'motorbike', icon: '🏍', label: 'Moto' },
  { key: 'minibus',   icon: '🚐', label: 'Minibus' },
];

const VEHICLE_ICON: Record<string, string> = {
  car: '🚗', suv: '🚙', truck: '🚛', motorbike: '🏍', minibus: '🚐', other: '🚘',
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function ParkingPOS({
  bays, activeSessions, openOrders, currency,
  defaultRate = 200, now,
  onStartSession, onCheckout,
}: Props) {

  // ── Local state ────────────────────────────────────────────────────────────
  const [viewMode, setViewMode]         = useState<'grid' | 'list'>('grid');
  const [filter, setFilter]             = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'free' | 'occupied'>('all');

  // Entry modal
  const [entryBay, setEntryBay]         = useState<Bay | null>(null);
  const [plate, setPlate]               = useState('');
  const [vType, setVType]               = useState('car');
  const [rate, setRate]                 = useState(defaultRate);
  const plateRef                        = useRef<HTMLInputElement>(null);

  // Checkout modal
  const [checkoutBay, setCheckoutBay]   = useState<Bay | null>(null);

  // ── Auto-focus plate on entry modal open ───────────────────────────────────
  useEffect(() => {
    if (entryBay) {
      setPlate(''); setVType('car');
      setRate(entryBay.rate_per_hour ?? defaultRate);
      setTimeout(() => plateRef.current?.focus(), 50);
    }
  }, [entryBay, defaultRate]);

  // ── Derived data ───────────────────────────────────────────────────────────
  type BayStatus = 'free' | 'occupied' | 'reserved' | 'blocked';

  function getBayStatus(bay: Bay): BayStatus {
    if (bay.bay_status === 'reserved') return 'reserved';
    if (bay.bay_status === 'blocked')  return 'blocked';
    const s = activeSessions[bay.id];
    if (s?.status === 'open') return 'occupied';
    return 'free';
  }

  const stats = useMemo(() => {
    const total    = bays.length;
    const occupied = bays.filter(b => getBayStatus(b) === 'occupied').length;
    const free     = bays.filter(b => getBayStatus(b) === 'free').length;
    const occupancy = total > 0 ? Math.round((occupied / total) * 100) : 0;
    return { total, occupied, free, occupancy };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bays, activeSessions]);

  const filteredBays = useMemo(() => {
    const q = filter.toLowerCase().trim();
    return bays
      .filter(bay => {
        const status = getBayStatus(bay);
        if (statusFilter !== 'all' && status !== statusFilter) return false;
        if (!q) return true;
        const session = activeSessions[bay.id];
        return (
          bay.name.toLowerCase().includes(q) ||
          (session?.vehicle_plate ?? '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => a.sort_order - b.sort_order);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bays, activeSessions, filter, statusFilter]);

  // ── Actions ────────────────────────────────────────────────────────────────
  function handleBayClick(bay: Bay) {
    const status = getBayStatus(bay);
    if (status === 'blocked') return;
    if (status === 'occupied' || status === 'reserved') {
      setCheckoutBay(bay);
    } else {
      setEntryBay(bay);
    }
  }

  function confirmEntry() {
    if (!entryBay || !plate.trim()) return;
    onStartSession(entryBay, plate.trim().toUpperCase(), vType, rate);
    setEntryBay(null);
  }

  function confirmCheckout() {
    if (!checkoutBay) return;
    onCheckout(checkoutBay.id);
    setCheckoutBay(null);
  }

  // Checkout modal data
  const checkoutSession = checkoutBay ? activeSessions[checkoutBay.id] : null;
  const checkoutElapsed = checkoutSession
    ? elapsed(checkoutSession.started_at, now) : null;
  const checkoutHours   = checkoutSession
    ? billedHours(checkoutSession.started_at, now) : 0;
  const checkoutAmount  = checkoutSession
    ? checkoutHours * checkoutSession.rate_per_hour : 0;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={s.root}>

      {/* ── Stats strip ─────────────────────────────────────────────────── */}
      <div style={s.statsStrip}>
        <div style={s.statBox}>
          <span style={s.statNum}>{stats.total}</span>
          <span style={s.statLbl}>Total bays</span>
        </div>
        <div style={s.statDivider} />
        <div style={s.statBox}>
          <span style={{ ...s.statNum, color: '#22c55e' }}>{stats.free}</span>
          <span style={s.statLbl}>Available</span>
        </div>
        <div style={s.statDivider} />
        <div style={s.statBox}>
          <span style={{ ...s.statNum, color: '#f59e0b' }}>{stats.occupied}</span>
          <span style={s.statLbl}>Occupied</span>
        </div>
        <div style={s.statDivider} />
        {/* Occupancy bar */}
        <div style={{ ...s.statBox, flex: 2, alignItems: 'flex-start', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
            <span style={s.statLbl}>Occupancy</span>
            <span style={{ ...s.statLbl, color: stats.occupancy > 80 ? '#ef4444' : '#94a3b8' }}>
              {stats.occupancy}%
            </span>
          </div>
          <div style={s.occBar}>
            <div style={{
              ...s.occFill,
              width: `${stats.occupancy}%`,
              background: stats.occupancy > 80 ? '#ef4444' : stats.occupancy > 50 ? '#f59e0b' : '#22c55e',
            }} />
          </div>
        </div>
      </div>

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div style={s.toolbar}>
        {/* Search */}
        <div style={s.searchWrap}>
          <svg style={s.searchIcon} width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="#64748b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            style={s.searchInput}
            placeholder="Bay number or plate…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
          {filter && (
            <button style={s.clearSearch} onClick={() => setFilter('')}>✕</button>
          )}
        </div>

        {/* Status filter pills */}
        <div style={s.filterPills}>
          {(['all', 'free', 'occupied'] as const).map(f => (
            <button
              key={f}
              style={{ ...s.pill, ...(statusFilter === f ? s.pillActive : {}) }}
              onClick={() => setStatusFilter(f)}
            >
              {f === 'all' ? 'All' : f === 'free' ? '🟢 Free' : '🟡 Occupied'}
            </button>
          ))}
        </div>

        {/* View toggle */}
        <div style={s.viewToggle}>
          <button
            style={{ ...s.viewBtn, ...(viewMode === 'grid' ? s.viewBtnActive : {}) }}
            onClick={() => setViewMode('grid')}
            title="Grid view"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
              <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
            </svg>
          </button>
          <button
            style={{ ...s.viewBtn, ...(viewMode === 'list' ? s.viewBtnActive : {}) }}
            onClick={() => setViewMode('list')}
            title="List view"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>
              <line x1="8" y1="18" x2="21" y2="18"/>
              <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/>
              <line x1="3" y1="18" x2="3.01" y2="18"/>
            </svg>
          </button>
        </div>
      </div>

      {/* ── Bay map ──────────────────────────────────────────────────────── */}
      <div style={s.mapArea}>
        {filteredBays.length === 0 ? (
          <div style={s.empty}>
            {bays.length === 0
              ? 'No bays configured — add bays in Settings → Parking Bays'
              : 'No bays match your filter'}
          </div>
        ) : viewMode === 'grid' ? (
          <div style={s.grid}>
            {filteredBays.map(bay => {
              const status   = getBayStatus(bay);
              const session  = activeSessions[bay.id];
              const el       = session ? elapsed(session.started_at, now) : null;
              const overstay = el && el.totalMins > 480; // > 8 hours

              return (
                <button
                  key={bay.id}
                  style={{
                    ...s.bayCard,
                    ...(status === 'free'     ? s.bayFree     : {}),
                    ...(status === 'occupied' ? s.bayOccupied : {}),
                    ...(status === 'reserved' ? s.bayReserved : {}),
                    ...(status === 'blocked'  ? s.bayBlocked  : {}),
                    ...(overstay ? s.bayOverstay : {}),
                    cursor: status === 'blocked' ? 'not-allowed' : 'pointer',
                  }}
                  onClick={() => handleBayClick(bay)}
                  disabled={status === 'blocked'}
                >
                  {/* Status dot */}
                  <div style={{
                    ...s.statusDot,
                    background:
                      status === 'free'     ? '#22c55e' :
                      status === 'occupied' ? (overstay ? '#f97316' : '#f59e0b') :
                      status === 'reserved' ? '#818cf8' : '#475569',
                  }} />

                  {/* Bay name */}
                  <div style={s.bayName}>{bay.name}</div>

                  {/* Content by status */}
                  {status === 'free' && (
                    <div style={s.bayFreeLabel}>Available</div>
                  )}
                  {status === 'reserved' && (
                    <div style={{ ...s.bayFreeLabel, color: '#818cf8' }}>Reserved</div>
                  )}
                  {status === 'blocked' && (
                    <div style={{ ...s.bayFreeLabel, color: '#475569' }}>Blocked</div>
                  )}
                  {status === 'occupied' && session && el && (
                    <>
                      <div style={s.vehicleIcon}>
                        {VEHICLE_ICON[session.vehicle_type] ?? '🚘'}
                      </div>
                      {session.vehicle_plate && (
                        <div style={s.platePill}>{session.vehicle_plate}</div>
                      )}
                      <div style={{ ...s.elapsedTime, color: overstay ? '#f97316' : '#94a3b8' }}>
                        {el.h > 0 ? `${el.h}h ` : ''}{el.m}m
                        {overstay && ' ⚠'}
                      </div>
                      <div style={s.billedAmount}>
                        {fmt(billedHours(session.started_at, now) * session.rate_per_hour, currency)}
                      </div>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          /* ── LIST VIEW ── */
          <div style={s.list}>
            {/* Header */}
            <div style={s.listHeader}>
              <span style={{ width: 80 }}>Bay</span>
              <span style={{ flex: 1 }}>Vehicle</span>
              <span style={{ width: 90 }}>Duration</span>
              <span style={{ width: 110, textAlign: 'right' }}>Amount due</span>
              <span style={{ width: 90 }} />
            </div>
            {filteredBays.map(bay => {
              const status  = getBayStatus(bay);
              const session = activeSessions[bay.id];
              const el      = session ? elapsed(session.started_at, now) : null;
              const overstay = el && el.totalMins > 480;

              return (
                <div
                  key={bay.id}
                  style={{
                    ...s.listRow,
                    ...(overstay ? { borderLeft: '3px solid #f97316' } : {}),
                  }}
                >
                  <div style={{ width: 80, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{
                      ...s.statusDot,
                      background:
                        status === 'free' ? '#22c55e' :
                        status === 'occupied' ? (overstay ? '#f97316' : '#f59e0b') :
                        status === 'reserved' ? '#818cf8' : '#475569',
                    }} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#f1f5f9' }}>{bay.name}</span>
                  </div>

                  <div style={{ flex: 1 }}>
                    {status === 'occupied' && session ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span>{VEHICLE_ICON[session.vehicle_type] ?? '🚘'}</span>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#f1f5f9' }}>
                            {session.vehicle_plate || '—'}
                          </div>
                          <div style={{ fontSize: 11, color: '#64748b' }}>
                            {session.vehicle_type} · {fmt(session.rate_per_hour, currency)}/hr
                          </div>
                        </div>
                      </div>
                    ) : (
                      <span style={{ fontSize: 13, color: '#475569' }}>
                        {status === 'reserved' ? 'Reserved' : status === 'blocked' ? 'Out of service' : 'Available'}
                      </span>
                    )}
                  </div>

                  <div style={{ width: 90 }}>
                    {el && (
                      <span style={{ fontSize: 13, color: overstay ? '#f97316' : '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                        {el.h > 0 ? `${el.h}h ` : ''}{el.m}m{overstay ? ' ⚠' : ''}
                      </span>
                    )}
                  </div>

                  <div style={{ width: 110, textAlign: 'right' }}>
                    {session && (
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9', fontVariantNumeric: 'tabular-nums' }}>
                        {fmt(billedHours(session.started_at, now) * session.rate_per_hour, currency)}
                      </span>
                    )}
                  </div>

                  <div style={{ width: 90, display: 'flex', justifyContent: 'flex-end' }}>
                    {status === 'free' ? (
                      <button style={s.listActionBtn} onClick={() => handleBayClick(bay)}>
                        Open
                      </button>
                    ) : status === 'occupied' ? (
                      <button style={{ ...s.listActionBtn, ...s.listCheckoutBtn }} onClick={() => handleBayClick(bay)}>
                        Checkout
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ════════ VEHICLE ENTRY MODAL ════════ */}
      {entryBay && (
        <div style={s.overlay} role="dialog" aria-modal aria-label="Vehicle entry">
          <div style={s.modal}>
            {/* Header */}
            <div style={s.modalTop}>
              <div>
                <div style={s.modalEyebrow}>Opening bay</div>
                <div style={s.modalTitle}>{entryBay.name}</div>
              </div>
              <button style={s.modalClose} onClick={() => setEntryBay(null)}>✕</button>
            </div>

            {/* Vehicle type picker */}
            <div style={s.fieldGroup}>
              <label style={s.fieldLabel}>Vehicle type</label>
              <div style={s.vehicleTypePicker}>
                {VEHICLE_TYPES.map(vt => (
                  <button
                    key={vt.key}
                    style={{ ...s.vehicleTypeBtn, ...(vType === vt.key ? s.vehicleTypeBtnActive : {}) }}
                    onClick={() => setVType(vt.key)}
                  >
                    <span style={{ fontSize: 20 }}>{vt.icon}</span>
                    <span style={{ fontSize: 11 }}>{vt.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Plate */}
            <div style={s.fieldGroup}>
              <label style={s.fieldLabel}>Number plate</label>
              <input
                ref={plateRef}
                style={s.fieldInput}
                placeholder="e.g. KCA 123A"
                value={plate}
                onChange={e => setPlate(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && confirmEntry()}
                maxLength={10}
              />
              <div style={s.fieldHint}>Leave blank if plate not visible</div>
            </div>

            {/* Rate */}
            <div style={s.fieldGroup}>
              <label style={s.fieldLabel}>Rate per hour ({currency})</label>
              <div style={s.rateRow}>
                {[100, 150, 200, 300, 500].map(r => (
                  <button
                    key={r}
                    style={{ ...s.ratePreset, ...(rate === r ? s.ratePresetActive : {}) }}
                    onClick={() => setRate(r)}
                  >
                    {r}
                  </button>
                ))}
                <input
                  style={{ ...s.fieldInput, flex: 1, marginTop: 0 }}
                  type="number"
                  min={0}
                  step={50}
                  value={rate}
                  onChange={e => setRate(Number(e.target.value))}
                />
              </div>
            </div>

            {/* Summary */}
            <div style={s.entrySummary}>
              <span style={s.entrySummaryIcon}>{VEHICLE_ICON[vType] ?? '🚘'}</span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#f1f5f9' }}>
                  {plate || 'No plate'} · {VEHICLE_TYPES.find(v => v.key === vType)?.label ?? vType}
                </div>
                <div style={{ fontSize: 12, color: '#64748b' }}>
                  {fmt(rate, currency)}/hr · {entryBay.name}
                </div>
              </div>
            </div>

            <div style={s.modalActions}>
              <button style={s.btnSecondary} onClick={() => setEntryBay(null)}>Cancel</button>
              <button
                style={{ ...s.btnPrimary, opacity: 1 }}
                onClick={confirmEntry}
              >
                Open bay
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ════════ CHECKOUT MODAL ════════ */}
      {checkoutBay && checkoutSession && checkoutElapsed && (
        <div style={s.overlay} role="dialog" aria-modal aria-label="Parking checkout">
          <div style={s.modal}>
            <div style={s.modalTop}>
              <div>
                <div style={s.modalEyebrow}>Checkout</div>
                <div style={s.modalTitle}>{checkoutBay.name}</div>
              </div>
              <button style={s.modalClose} onClick={() => setCheckoutBay(null)}>✕</button>
            </div>

            {/* Vehicle info */}
            <div style={s.checkoutVehicle}>
              <span style={{ fontSize: 32 }}>{VEHICLE_ICON[checkoutSession.vehicle_type] ?? '🚘'}</span>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#f1f5f9' }}>
                  {checkoutSession.vehicle_plate || 'No plate'}
                </div>
                <div style={{ fontSize: 12, color: '#64748b' }}>
                  {VEHICLE_TYPES.find(v => v.key === checkoutSession.vehicle_type)?.label ?? checkoutSession.vehicle_type}
                </div>
              </div>
            </div>

            {/* Bill breakdown */}
            <div style={s.billBreakdown}>
              <div style={s.billRow}>
                <span style={s.billLabel}>Arrived</span>
                <span style={s.billValue}>
                  {new Date(checkoutSession.started_at).toLocaleTimeString('en-KE', {
                    hour: '2-digit', minute: '2-digit',
                  })}
                </span>
              </div>
              <div style={s.billRow}>
                <span style={s.billLabel}>Duration</span>
                <span style={s.billValue}>
                  {checkoutElapsed.h > 0 ? `${checkoutElapsed.h}h ` : ''}{checkoutElapsed.m}m
                </span>
              </div>
              <div style={s.billRow}>
                <span style={s.billLabel}>Billed hours</span>
                <span style={s.billValue}>{checkoutHours} hr{checkoutHours !== 1 ? 's' : ''}</span>
              </div>
              <div style={s.billRow}>
                <span style={s.billLabel}>Rate</span>
                <span style={s.billValue}>{fmt(checkoutSession.rate_per_hour, currency)}/hr</span>
              </div>
              <div style={{ ...s.billRow, ...s.billTotal }}>
                <span style={s.billTotalLabel}>Total due</span>
                <span style={s.billTotalValue}>{fmt(checkoutAmount, currency)}</span>
              </div>
            </div>

            {checkoutElapsed.totalMins > 480 && (
              <div style={s.overstayBanner}>
                ⚠ Overstay — vehicle has been parked for over 8 hours
              </div>
            )}

            <div style={s.modalActions}>
              <button style={s.btnSecondary} onClick={() => setCheckoutBay(null)}>Cancel</button>
              <button style={s.btnCheckout} onClick={confirmCheckout}>
                Collect {fmt(checkoutAmount, currency)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex', flexDirection: 'column', height: '100%',
    overflow: 'hidden', background: '#0f172a',
    fontFamily: "'DM Sans','Segoe UI',sans-serif", color: '#f1f5f9',
  },

  // Stats strip
  statsStrip: {
    display: 'flex', alignItems: 'center', gap: 0,
    padding: '10px 20px', background: '#1e293b',
    borderBottom: '1px solid #334155', flexShrink: 0,
  },
  statBox: {
    display: 'flex', flexDirection: 'column', gap: 1,
    padding: '0 20px', flex: 1,
  },
  statNum: { fontSize: 22, fontWeight: 700, color: '#f1f5f9', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' },
  statLbl: { fontSize: 11, color: '#64748b', fontWeight: 500 },
  statDivider: { width: 1, height: 32, background: '#334155', flexShrink: 0 },
  occBar: { height: 4, background: '#334155', borderRadius: 2, width: '100%' },
  occFill: { height: '100%', borderRadius: 2, transition: 'width 0.4s ease' },

  // Toolbar
  toolbar: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '10px 16px', borderBottom: '1px solid #1e293b', flexShrink: 0,
  },
  searchWrap: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: '#1e293b', border: '1px solid #334155', borderRadius: 8,
    padding: '0 10px', flex: 1,
  },
  searchIcon: { flexShrink: 0 },
  searchInput: {
    flex: 1, background: 'transparent', border: 'none', outline: 'none',
    color: '#f1f5f9', fontSize: 13, padding: '8px 0',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  clearSearch: {
    background: 'transparent', border: 'none', color: '#475569',
    cursor: 'pointer', fontSize: 12, padding: '2px 4px',
  },
  filterPills: { display: 'flex', gap: 6 },
  pill: {
    padding: '5px 12px', background: '#1e293b', border: '1px solid #334155',
    borderRadius: 20, color: '#64748b', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  pillActive: { background: 'rgba(59,130,246,0.15)', borderColor: 'rgba(59,130,246,0.4)', color: '#60a5fa' },
  viewToggle: { display: 'flex', border: '1px solid #334155', borderRadius: 8, overflow: 'hidden' },
  viewBtn: {
    padding: '7px 10px', background: 'transparent', border: 'none',
    color: '#64748b', cursor: 'pointer', display: 'flex', alignItems: 'center',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  viewBtnActive: { background: '#1e293b', color: '#f1f5f9' },

  // Map area
  mapArea: { flex: 1, overflowY: 'auto', padding: 16 },
  empty: { color: '#475569', fontSize: 13, textAlign: 'center', padding: '60px 20px' },

  // Grid
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
    gap: 12,
  },
  bayCard: {
    position: 'relative', borderRadius: 14, padding: '14px 10px',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
    border: '1.5px solid transparent', transition: 'all 0.15s ease',
    textAlign: 'center', minHeight: 120,
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  bayFree:     { background: 'rgba(34,197,94,0.06)',  borderColor: 'rgba(34,197,94,0.2)' },
  bayOccupied: { background: 'rgba(245,158,11,0.07)', borderColor: 'rgba(245,158,11,0.25)' },
  bayReserved: { background: 'rgba(129,140,248,0.07)', borderColor: 'rgba(129,140,248,0.25)' },
  bayBlocked:  { background: 'rgba(71,85,105,0.08)',  borderColor: 'rgba(71,85,105,0.2)', opacity: 0.5 },
  bayOverstay: { borderColor: 'rgba(249,115,22,0.5)', background: 'rgba(249,115,22,0.07)' },

  statusDot: { position: 'absolute', top: 10, right: 10, width: 8, height: 8, borderRadius: '50%' },
  bayName: { fontSize: 15, fontWeight: 700, color: '#f1f5f9' },
  bayFreeLabel: { fontSize: 11, color: '#22c55e', marginTop: 2 },
  vehicleIcon: { fontSize: 22 },
  platePill: {
    fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
    background: '#334155', border: '1px solid #475569',
    borderRadius: 4, padding: '2px 6px', color: '#cbd5e1',
  },
  elapsedTime: { fontSize: 12, fontVariantNumeric: 'tabular-nums' },
  billedAmount: { fontSize: 12, fontWeight: 700, color: '#f59e0b', fontVariantNumeric: 'tabular-nums' },

  // List
  list: { display: 'flex', flexDirection: 'column', gap: 0 },
  listHeader: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '8px 16px', fontSize: 11, fontWeight: 600,
    color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em',
    borderBottom: '1px solid #1e293b',
  },
  listRow: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '12px 16px', borderBottom: '1px solid #1e293b',
    background: '#0f172a', transition: 'background 0.1s',
  },
  listActionBtn: {
    padding: '5px 14px', background: 'rgba(34,197,94,0.1)',
    border: '1px solid rgba(34,197,94,0.3)', borderRadius: 6,
    color: '#22c55e', fontSize: 12, fontWeight: 600, cursor: 'pointer',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  listCheckoutBtn: {
    background: 'rgba(245,158,11,0.1)', borderColor: 'rgba(245,158,11,0.3)', color: '#f59e0b',
  },

  // Modals
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000, backdropFilter: 'blur(3px)',
  },
  modal: {
    background: '#1e293b', border: '1px solid #334155', borderRadius: 18,
    padding: '24px', width: '100%', maxWidth: 420,
    boxShadow: '0 32px 80px rgba(0,0,0,0.6)',
    display: 'flex', flexDirection: 'column', gap: 0,
  },
  modalTop: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20,
  },
  modalEyebrow: { fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 },
  modalTitle: { fontSize: 20, fontWeight: 700, color: '#f1f5f9' },
  modalClose: {
    background: '#334155', border: 'none', borderRadius: 8, color: '#94a3b8',
    width: 30, height: 30, cursor: 'pointer', fontSize: 14,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },

  fieldGroup: { marginBottom: 16 },
  fieldLabel: { display: 'block', fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' },
  fieldInput: {
    width: '100%', background: '#0f172a', border: '1px solid #334155',
    borderRadius: 8, padding: '10px 14px', color: '#f1f5f9', fontSize: 15,
    outline: 'none', boxSizing: 'border-box',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  fieldHint: { fontSize: 11, color: '#475569', marginTop: 4 },

  vehicleTypePicker: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  vehicleTypeBtn: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    padding: '10px 12px', background: '#0f172a', border: '1.5px solid #334155',
    borderRadius: 10, cursor: 'pointer', minWidth: 60,
    color: '#94a3b8', fontSize: 11, fontFamily: "'DM Sans','Segoe UI',sans-serif",
    transition: 'all 0.12s',
  },
  vehicleTypeBtnActive: {
    borderColor: '#3b82f6', background: 'rgba(59,130,246,0.1)', color: '#60a5fa',
  },

  rateRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  ratePreset: {
    padding: '8px 12px', background: '#0f172a', border: '1px solid #334155',
    borderRadius: 8, color: '#94a3b8', fontSize: 13, fontWeight: 600, cursor: 'pointer',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  ratePresetActive: {
    background: 'rgba(59,130,246,0.15)', borderColor: '#3b82f6', color: '#60a5fa',
  },

  entrySummary: {
    display: 'flex', alignItems: 'center', gap: 12,
    background: '#0f172a', border: '1px solid #334155', borderRadius: 10,
    padding: '12px 16px', marginBottom: 20,
  },
  entrySummaryIcon: { fontSize: 28 },

  // Checkout modal
  checkoutVehicle: {
    display: 'flex', alignItems: 'center', gap: 14,
    background: '#0f172a', border: '1px solid #334155',
    borderRadius: 12, padding: '14px 16px', marginBottom: 16,
  },
  billBreakdown: {
    background: '#0f172a', border: '1px solid #334155',
    borderRadius: 12, overflow: 'hidden', marginBottom: 16,
  },
  billRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '10px 16px', borderBottom: '1px solid #1e293b',
  },
  billLabel: { fontSize: 13, color: '#64748b' },
  billValue: { fontSize: 13, color: '#f1f5f9', fontWeight: 500, fontVariantNumeric: 'tabular-nums' },
  billTotal: { borderBottom: 'none', background: 'rgba(245,158,11,0.06)', padding: '14px 16px' },
  billTotalLabel: { fontSize: 15, fontWeight: 700, color: '#f1f5f9' },
  billTotalValue: { fontSize: 20, fontWeight: 700, color: '#f59e0b', fontVariantNumeric: 'tabular-nums' },

  overstayBanner: {
    background: 'rgba(249,115,22,0.1)', border: '1px solid rgba(249,115,22,0.3)',
    borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#fb923c',
    marginBottom: 16, textAlign: 'center',
  },

  modalActions: { display: 'flex', gap: 10, marginTop: 4 },
  btnSecondary: {
    flex: 1, padding: '12px', background: 'transparent',
    border: '1px solid #334155', borderRadius: 10, color: '#94a3b8',
    fontSize: 14, cursor: 'pointer', fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  btnPrimary: {
    flex: 2, padding: '12px', background: '#1d4ed8',
    border: 'none', borderRadius: 10, color: '#fff',
    fontSize: 14, fontWeight: 700, cursor: 'pointer',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  btnCheckout: {
    flex: 2, padding: '12px',
    background: 'linear-gradient(135deg,#d97706,#f59e0b)',
    border: 'none', borderRadius: 10, color: '#0f172a',
    fontSize: 14, fontWeight: 700, cursor: 'pointer',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
};
