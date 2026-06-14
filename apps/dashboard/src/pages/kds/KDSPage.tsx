import { useEffect, useState, useRef, useCallback } from 'react';
import { supabase } from '../../lib/supabase';

import { API_URL } from '../../lib/config';
const API_BASE = API_URL;

// Status config — maps DB values to display labels and actions
const STATUS_CONFIG = {
  new:        { label: 'Pending',     color: 'border-yellow-500 bg-yellow-500/10', badge: 'bg-yellow-500 text-gray-950',  next: 'preparing', nextLabel: 'Start →'    },
  preparing:  { label: 'In Progress', color: 'border-blue-500 bg-blue-500/10',    badge: 'bg-blue-500 text-white',       next: 'ready',     nextLabel: 'Ready →'    },
  ready:      { label: 'Ready',       color: 'border-green-500 bg-green-500/10',  badge: 'bg-green-500 text-gray-950',   next: 'collected', nextLabel: 'Picked Up ✓' },
  collected:  { label: 'Picked Up',   color: 'border-gray-700 bg-gray-800',       badge: 'bg-gray-600 text-white',       next: null,        nextLabel: null          },
} as const;

type TicketStatus = keyof typeof STATUS_CONFIG;

interface OrderItem {
  product_name: string; quantity: number; notes: string | null;
  order_item_variants: { variant_group_name: string; variant_option_name: string }[];
  order_item_modifiers: { modifier_group_name: string; modifier_option_name: string }[];
}
interface Ticket {
  id: string;
  order_id: string;
  status: TicketStatus;
  created_at: string;
  preparing_at: string | null;
  ready_at: string | null;
  orders: {
    order_number: string;
    order_type: string;
    order_items: OrderItem[];
  };
}

function ElapsedTimer({ since }: { since: string }) {
  const [secs, setSecs] = useState(() => Math.floor((Date.now() - new Date(since).getTime()) / 1000));
  useEffect(() => {
    const t = setInterval(() => setSecs(Math.floor((Date.now() - new Date(since).getTime()) / 1000)), 1000);
    return () => clearInterval(t);
  }, [since]);
  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  const isLate = secs > 600; // 10 min
  return (
    <span className={`text-xs font-mono ${isLate ? 'text-red-400' : 'text-gray-400'}`}>
      {mins}:{String(s).padStart(2, '0')}
    </span>
  );
}

export default function KDSPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const [branchId, setBranchId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<TicketStatus | 'all'>('all');
  const audioCtx = useRef<AudioContext | null>(null);
  const knownIds = useRef<Set<string>>(new Set());

  // Get branch_id from URL ?branch_id=xxx
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const bid = params.get('branch_id');
    if (bid) setBranchId(bid);
  }, []);

  // Play a short beep using Web Audio API (no file needed)
  const playBeep = useCallback(() => {
    try {
      if (!audioCtx.current) audioCtx.current = new AudioContext();
      const ctx = audioCtx.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.4, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.4);
    } catch { /* ignore if audio blocked */ }
  }, []);

  const flashTicket = useCallback((id: string) => {
    setFlashIds(prev => new Set(prev).add(id));
    setTimeout(() => setFlashIds(prev => { const n = new Set(prev); n.delete(id); return n; }), 2000);
  }, []);

  // Initial fetch
  const fetchTickets = useCallback(async (bid: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/kitchen/tickets?branch_id=${bid}`);
      const data: Ticket[] = await res.json();
      setTickets(data);
      data.forEach(t => knownIds.current.add(t.id));
    } catch (err) {
      console.error('KDS fetch failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!branchId) return;
    fetchTickets(branchId);

    // Auto-refresh every 30s as fallback alongside realtime
    const interval = setInterval(() => fetchTickets(branchId), 30000);
    return () => clearInterval(interval);
  }, [branchId]);

  // Supabase realtime subscription
  useEffect(() => {
    if (!branchId) return;

    const channel = supabase
      .channel(`kds-${branchId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'kitchen_tickets',
          filter: `branch_id=eq.${branchId}`,
        },
        async (payload) => {
          if (payload.eventType === 'INSERT') {
            // Fetch full ticket with order details
            const res = await fetch(`${API_BASE}/api/kitchen/tickets?branch_id=${branchId}`);
            const all: Ticket[] = await res.json();
            const newTicket = all.find(t => t.id === payload.new.id);
            if (newTicket && !knownIds.current.has(newTicket.id)) {
              knownIds.current.add(newTicket.id);
              setTickets(prev => [newTicket, ...prev]);
              playBeep();
              flashTicket(newTicket.id);
            }
          } else if (payload.eventType === 'UPDATE') {
            const updated = payload.new as Ticket;
            setTickets(prev =>
              updated.status === 'collected'
                ? prev.filter(t => t.id !== updated.id)
                : prev.map(t => t.id === updated.id ? { ...t, ...updated } : t)
            );
          } else if (payload.eventType === 'DELETE') {
            setTickets(prev => prev.filter(t => t.id !== payload.old.id));
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [branchId, playBeep, flashTicket]);

  const advanceStatus = async (ticket: Ticket) => {
    const cfg = STATUS_CONFIG[ticket.status];
    if (!cfg.next) return;

    // Optimistic update immediately
    if (cfg.next === 'collected') {
      setTickets(prev => prev.filter(t => t.id !== ticket.id));
    } else {
      setTickets(prev => prev.map(t =>
        t.id === ticket.id ? { ...t, status: cfg.next as TicketStatus } : t
      ));
    }

    try {
      await fetch(`${API_BASE}/api/kitchen/tickets/${ticket.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: cfg.next }),
      });
    } catch (err) {
      console.error('Failed to advance ticket:', err);
      // Revert on failure
      fetchTickets(branchId!);
    }
  };

  const filtered = statusFilter === 'all'
    ? tickets
    : tickets.filter(t => t.status === statusFilter);

  const counts = {
    new:       tickets.filter(t => t.status === 'new').length,
    preparing: tickets.filter(t => t.status === 'preparing').length,
    ready:     tickets.filter(t => t.status === 'ready').length,
  };

  if (!branchId) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center space-y-3">
          <p className="text-white text-xl font-semibold">Missing branch ID</p>
          <p className="text-gray-400 text-sm">Open this page as: <code className="text-green-400">/kds?branch_id=YOUR_BRANCH_ID</code></p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col select-none">

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 bg-gray-900 border-b border-gray-800 flex-shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-white font-bold text-xl tracking-tight">Kitchen Display</span>
          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" title="Live" />
        </div>

        {/* Status counts */}
        <div className="flex items-center gap-4">
          {([['new', 'Pending'], ['preparing', 'In Progress'], ['ready', 'Ready']] as const).map(([s, label]) => (
            <div key={s} className="text-center">
              <div className={`text-2xl font-bold ${STATUS_CONFIG[s].badge.includes('yellow') ? 'text-yellow-400' : s === 'preparing' ? 'text-blue-400' : 'text-green-400'}`}>
                {counts[s]}
              </div>
              <div className="text-gray-500 text-xs">{label}</div>
            </div>
          ))}
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1 bg-gray-800 rounded-lg p-1">
          {(['all', 'new', 'preparing', 'ready'] as const).map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors capitalize ${
                statusFilter === s ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {s === 'all' ? 'All' : STATUS_CONFIG[s].label}
            </button>
          ))}
        </div>

        {/* Clock */}
        <Clock />
      </div>

      {/* Ticket grid */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center h-64 text-gray-500">Loading tickets…</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 gap-3 text-gray-600">
            <span className="text-5xl">🍳</span>
            <span className="text-lg">All clear — no pending tickets</span>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 auto-rows-max">
            {filtered.map(ticket => {
              const cfg = STATUS_CONFIG[ticket.status];
              const isFlashing = flashIds.has(ticket.id);
              return (
                <div
                  key={ticket.id}
                  className={`rounded-2xl border-2 p-4 flex flex-col gap-3 transition-all duration-300 ${cfg.color} ${isFlashing ? 'ring-4 ring-yellow-400 ring-opacity-80 scale-105' : ''}`}
                >
                  {/* Ticket header */}
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-white font-bold text-lg leading-tight">
                        {ticket.orders?.order_number ?? '—'}
                      </p>
                      <p className="text-gray-400 text-xs capitalize">{ticket.orders?.order_type ?? ''}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-semibold whitespace-nowrap ${cfg.badge}`}>
                        {cfg.label}
                      </span>
                      <ElapsedTimer since={ticket.created_at} />
                    </div>
                  </div>

                  {/* Items */}
                  <div className="flex-1 space-y-2">
                    {(ticket.orders?.order_items ?? []).map((item, i) => (
                      <div key={i} className="space-y-0.5">
                        <div className="flex items-baseline gap-2">
                          <span className="text-white font-semibold text-sm">×{item.quantity}</span>
                          <span className="text-white text-sm">{item.product_name}</span>
                        </div>
                        {item.order_item_variants.map((v, vi) => (
                          <p key={vi} className="text-gray-400 text-xs pl-5">
                            {v.variant_group_name}: {v.variant_option_name}
                          </p>
                        ))}
                        {item.order_item_modifiers.map((m, mi) => (
                          <p key={mi} className="text-purple-400 text-xs pl-5">+{m.modifier_option_name}</p>
                        ))}
                        {item.notes && (
                          <p className="text-yellow-400 text-xs pl-5 italic">⚠ {item.notes}</p>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Action button */}
                  {cfg.next && (
                    <button
                      onClick={() => advanceStatus(ticket)}
                      className={`w-full py-2.5 rounded-xl text-sm font-bold transition-all active:scale-95 ${cfg.badge} hover:opacity-90`}
                    >
                      {cfg.nextLabel}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Clock() {
  const [time, setTime] = useState(() => new Date().toLocaleTimeString());
  useEffect(() => {
    const t = setInterval(() => setTime(new Date().toLocaleTimeString()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="text-gray-400 font-mono text-sm">{time}</span>;
}
