/**
 * DevicesTab — Owner interface for managing registered cashier devices.
 *
 * Shows pending approval requests prominently at the top, then approved
 * and rejected devices below. Owner can approve, reject, or revoke any device.
 *
 * Access: Settings → Devices (owner only)
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/api';
import ConfirmModal, { useConfirm } from '../../components/ConfirmModal';
import Toast from '../../components/Toast';
import { useToast } from '../../hooks/useToast';

interface DeviceUser {
  id:    string;
  name:  string;
  email: string;
  roles: { name: string } | null;
}

interface Device {
  id:           string;
  fingerprint:  string;
  device_label: string | null;
  ip_address:   string | null;
  status:       'pending' | 'approved' | 'rejected';
  requested_at: string;
  reviewed_at:  string | null;
  last_seen_at: string | null;
  users:        DeviceUser | null;
}

function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

const STATUS_BADGE: Record<Device['status'], string> = {
  pending:  'bg-amber-500/15 text-amber-400 border-amber-500/30',
  approved: 'bg-green-500/15  text-green-400  border-green-500/30',
  rejected: 'bg-red-500/15   text-red-400   border-red-500/30',
};

export default function DevicesTab() {
  const [devices, setDevices]       = useState<Device[]>([]);
  const [loading, setLoading]       = useState(true);
  const [filter, setFilter]         = useState<'all' | Device['status']>('all');
  const [registrationOn, setRegistrationOn] = useState(false);
  const [toggling, setToggling]     = useState(false);

  const { toast, showToast }        = useToast();
  const [confirmState, showConfirm, closeConfirm] = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [devData, settings] = await Promise.all([
        api.get<Device[]>('/api/devices'),
        api.get<{ key: string; value: string }[]>('/api/business/settings'),
      ]);
      setDevices(devData ?? []);
      const setting = (settings ?? []).find(s => s.key === 'require_device_registration');
      setRegistrationOn(setting?.value === 'true');
    } catch (e: any) {
      showToast(e.message ?? 'Failed to load devices', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggleRegistration() {
    setToggling(true);
    try {
      const newVal = !registrationOn;
      await api.post('/api/business/settings', {
        key:   'require_device_registration',
        value: String(newVal),
      });
      setRegistrationOn(newVal);
      showToast(newVal ? 'Device registration enabled' : 'Device registration disabled', 'success');
    } catch (e: any) {
      showToast(e.message ?? 'Failed to update setting', 'error');
    } finally {
      setToggling(false);
    }
  }

  async function approve(device: Device) {
    try {
      await api.patch(`/api/devices/${device.id}/approve`, {});
      showToast(`Approved ${device.users?.name ?? 'device'}`, 'success');
      load();
    } catch (e: any) {
      showToast(e.message ?? 'Failed to approve', 'error');
    }
  }

  async function reject(device: Device) {
    showConfirm({
      title:        `Reject this device?`,
      message:      `${device.users?.name ?? 'This staff member'} will not be able to log in from this device.`,
      intent:       'warning',
      confirmLabel: 'Reject',
      onConfirm:    async () => {
        await api.patch(`/api/devices/${device.id}/reject`, {});
        showToast('Device rejected', 'success');
        load();
      },
    });
  }

  async function revoke(device: Device) {
    showConfirm({
      title:        'Revoke device access?',
      message:      `${device.users?.name ?? 'This staff member'} will be blocked from logging in on this device until re-approved.`,
      intent:       'destructive',
      confirmLabel: 'Revoke',
      onConfirm:    async () => {
        await api.delete(`/api/devices/${device.id}`);
        showToast('Device revoked', 'success');
        load();
      },
    });
  }

  const pending  = devices.filter(d => d.status === 'pending');
  const filtered = filter === 'all' ? devices : devices.filter(d => d.status === filter);

  return (
    <div className="space-y-6 max-w-3xl">
      <Toast toast={toast} />
      <ConfirmModal state={confirmState} onClose={closeConfirm} />

      {/* ── Toggle ─────────────────────────────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-white font-semibold text-sm">Require device registration</h3>
          <p className="text-gray-500 text-xs mt-1 max-w-sm">
            When enabled, cashiers logging in from a new device will be blocked until you
            approve the device here. Managers, supervisors, and the owner are never
            restricted — only cashier-level roles require approval.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={registrationOn}
          disabled={toggling}
          onClick={toggleRegistration}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 ${
            registrationOn ? 'bg-green-500' : 'bg-gray-700'
          }`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ease-in-out ${
              registrationOn ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {/* ── Pending banner ─────────────────────────────────────────────────── */}
      {pending.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-amber-400 text-sm font-semibold">
              {pending.length} device{pending.length > 1 ? 's' : ''} waiting for approval
            </span>
          </div>
          {pending.map(d => (
            <div key={d.id} className="flex items-center justify-between gap-4 py-2 border-t border-amber-500/20">
              <div className="min-w-0">
                <p className="text-white text-sm font-medium truncate">
                  {d.users?.name ?? 'Unknown staff'} · {d.device_label ?? 'Unknown device'}
                </p>
                <p className="text-amber-400/70 text-xs mt-0.5">
                  {d.users?.roles?.name} · {d.ip_address ?? 'Unknown IP'} · {timeAgo(d.requested_at)}
                </p>
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <button
                  onClick={() => reject(d)}
                  className="px-3 py-1.5 text-xs font-medium text-gray-400 hover:text-white border border-gray-700 hover:border-gray-600 rounded-lg transition-colors"
                >
                  Reject
                </button>
                <button
                  onClick={() => approve(d)}
                  className="px-3 py-1.5 text-xs font-semibold text-gray-950 bg-green-400 hover:bg-green-300 rounded-lg transition-colors"
                >
                  Approve
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Filter tabs ─────────────────────────────────────────────────────── */}
      <div className="flex gap-2 border-b border-gray-800 pb-px">
        {(['all', 'approved', 'pending', 'rejected'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
              filter === f
                ? 'text-white border-green-400'
                : 'text-gray-500 border-transparent hover:text-gray-300'
            }`}
          >
            {f}
            {f !== 'all' && (
              <span className="ml-1.5 text-xs text-gray-600">
                ({devices.filter(d => d.status === f).length})
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Device list ─────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-4 animate-pulse">
              <div className="h-4 bg-gray-800 rounded w-48 mb-2" />
              <div className="h-3 bg-gray-800 rounded w-32" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-600 text-sm">
          {filter === 'all' ? 'No devices registered yet' : `No ${filter} devices`}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(d => (
            <div
              key={d.id}
              className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center gap-4"
            >
              {/* Device icon */}
              <div className="w-9 h-9 rounded-lg bg-gray-800 flex items-center justify-center flex-shrink-0 text-gray-500 text-base">
                {(d.device_label ?? '').includes('iPhone') || (d.device_label ?? '').includes('iPad')
                  ? '📱' : (d.device_label ?? '').includes('Android') ? '📱' : '💻'}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-white text-sm font-medium">
                    {d.users?.name ?? 'Unknown'}
                  </span>
                  <span className="text-gray-600 text-xs">·</span>
                  <span className="text-gray-400 text-xs">{d.device_label ?? 'Unknown device'}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full border font-medium capitalize ${STATUS_BADGE[d.status]}`}>
                    {d.status}
                  </span>
                </div>
                <p className="text-gray-600 text-xs mt-0.5">
                  {d.users?.roles?.name ?? 'Staff'}
                  {d.ip_address && ` · ${d.ip_address}`}
                  {d.status === 'pending'  && ` · Requested ${timeAgo(d.requested_at)}`}
                  {d.status === 'approved' && ` · Last seen ${timeAgo(d.last_seen_at)}`}
                  {d.status === 'rejected' && ` · Rejected ${timeAgo(d.reviewed_at)}`}
                </p>
              </div>

              {/* Actions */}
              <div className="flex gap-2 flex-shrink-0">
                {d.status === 'pending' && (
                  <>
                    <button onClick={() => reject(d)}
                      className="px-3 py-1.5 text-xs font-medium text-gray-400 hover:text-white border border-gray-700 hover:border-gray-600 rounded-lg transition-colors">
                      Reject
                    </button>
                    <button onClick={() => approve(d)}
                      className="px-3 py-1.5 text-xs font-semibold text-gray-950 bg-green-400 hover:bg-green-300 rounded-lg transition-colors">
                      Approve
                    </button>
                  </>
                )}
                {d.status === 'approved' && (
                  <button onClick={() => revoke(d)}
                    className="px-3 py-1.5 text-xs font-medium text-red-400 hover:text-red-300 border border-red-500/30 hover:border-red-500/50 rounded-lg transition-colors">
                    Revoke
                  </button>
                )}
                {d.status === 'rejected' && (
                  <button onClick={() => approve(d)}
                    className="px-3 py-1.5 text-xs font-medium text-gray-400 hover:text-white border border-gray-700 hover:border-gray-600 rounded-lg transition-colors">
                    Approve
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
