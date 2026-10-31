/**
 * AttendanceDevicesPanel — A599: on the Tech page of the BRANCH SERVER, the attendance devices (ZKTeco) it pulls punches
 * from. Shown ONLY when this PC is the branch server and the business's 'attendance' flag is on — main answers
 * { visible: false } otherwise and nothing at all is drawn (not greyed out).
 *
 * Per device (the list the cloud keeps — devices are added on the web portal, Attendance → Devices): the last contact,
 * the serial, the last error, the clock against this PC's (a warning past 60 s, with "Set device time"), "Test connection".
 * "Pull now" runs the job at once (main/attendanceSync.ts). The comm key never reaches this screen.
 */
import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import type { AttendanceDevicesStatus, AttendanceDeviceCheck } from '../lib/posApi';
import { ago } from './BranchSyncPanel';

export default function AttendanceDevicesPanel() {
  const [s, setS] = useState<AttendanceDevicesStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, AttendanceDeviceCheck>>({});
  const [note, setNote] = useState<string | null>(null);

  const load = () => posApi.attendance.status().then(setS).catch(() => setS(null));
  useEffect(() => {
    let alive = true;
    const go = () => posApi.attendance.status().then((x) => { if (alive) setS(x); }).catch(() => { if (alive) setS(null); });
    void go();
    const t = setInterval(go, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!s || !s.visible) return null;
  const st = s.status;

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setNote(null);
    try { await fn(); } catch (e: any) { setNote(e?.message ?? String(e)); } finally { setBusy(null); void load(); }
  };
  const test = (id: string) => run(`test:${id}`, async () => { const r = await posApi.attendance.test(id); setChecks((c) => ({ ...c, [id]: r })); });
  const setTime = (id: string) => run(`time:${id}`, async () => { const r = await posApi.attendance.setTime(id); setChecks((c) => ({ ...c, [id]: r })); });
  const pull = () => run('pull', async () => {
    const r = await posApi.attendance.pullNow();
    if (!r.ran) setNote(r.error ?? (r.skipped === 'offline' ? 'The cloud cannot be reached right now.' : r.skipped === 'cloud_off' ? 'The cloud says attendance is off for this business.' : 'Nothing was pulled.'));
    else {
      const sent = r.devices.reduce((n, d) => n + d.sent, 0);
      const bad = r.devices.filter((d) => !d.ok).length;
      setNote(`${r.devices.length} device(s) asked, ${sent} new punch(es) sent${bad ? `, ${bad} with a problem (see below)` : ''}.`);
    }
  });

  return (
    <div className="mt-3 text-[11px]" data-testid="attendance-devices">
      <div className="flex items-center justify-between mb-1">
        <div className="text-gray-300 font-semibold">Attendance device</div>
        <button onClick={pull} disabled={!!busy} data-testid="attendance-pull"
          className="px-2 py-1 rounded bg-[#1e293b] text-gray-200 disabled:opacity-50">{busy === 'pull' ? 'Pulling…' : 'Pull now'}</button>
      </div>
      <p className="text-gray-400" data-testid="attendance-last-run">
        Last pull: {st.lastRunAt ? `${new Date(st.lastRunAt).toLocaleString()} (${ago(st.lastRunAt)})${st.lastRunOk === false && st.lastError ? ` — ${st.lastError}` : ''}` : 'not yet'}
        {` · every ${Math.round(st.everyS / 60)} min`}
        {st.waitUntil ? ` · asked again at ${new Date(st.waitUntil).toLocaleTimeString()}` : ''}
      </p>
      {note && <p className="text-amber-300 mt-0.5" data-testid="attendance-note">{note}</p>}
      {st.devices.length === 0 && (
        <p className="text-gray-500 mt-1" data-testid="attendance-none">
          No devices for this branch yet. Add devices on the web portal, Attendance → Devices.
        </p>
      )}
      {st.devices.map((d) => {
        const c = checks[d.id];
        const drift = c?.ok && typeof c.driftS === 'number' ? c.driftS : d.driftS;
        const driftBad = typeof drift === 'number' && Math.abs(drift) > st.driftWarnS;
        return (
          <div key={d.id} className="mt-2 border border-[#1e293b] rounded p-2" data-testid={`attendance-device-${d.id}`}>
            <div className="flex items-center justify-between">
              <div className="text-gray-200">{d.name} <span className="text-gray-500 font-mono">{d.ip}:{d.port}</span></div>
              <div className="flex gap-1">
                <button onClick={() => test(d.id)} disabled={!!busy} className="px-2 py-0.5 rounded bg-[#1e293b] text-gray-200 disabled:opacity-50">
                  {busy === `test:${d.id}` ? 'Testing…' : 'Test connection'}
                </button>
              </div>
            </div>
            <p className="text-gray-400 mt-0.5">
              Serial: <span className="font-mono">{d.serial ?? 'not read yet'}</span>
              {d.model ? ` · ${d.model}` : ''}{d.firmware ? ` · ${d.firmware}` : ''}
              {` · last contact: ${d.lastContactAt ? `${new Date(d.lastContactAt).toLocaleString()} (${ago(d.lastContactAt)})` : 'never'}`}
            </p>
            <p className="text-gray-500 mt-0.5">
              {d.usersOnDevice !== null ? `${d.usersOnDevice} user(s) on the device · ` : ''}
              {d.punchesOnDevice !== null ? `${d.punchesOnDevice} punch(es) on the device · ` : ''}
              {d.lastSentAt ? `last punches sent ${ago(d.lastSentAt)}` : 'no punches sent yet'}
            </p>
            {d.lastError && <p className="text-amber-300 mt-0.5" data-testid="attendance-device-error">{d.lastError}</p>}
            {c && !c.ok && c.error && <p className="text-amber-300 mt-0.5">Test failed: {c.error}</p>}
            {c && c.ok && (
              <p className="text-action-300 mt-0.5">
                Connected · serial {c.serial} · device clock {c.deviceTime?.replace('T', ' ')} (this PC {c.pcTime?.replace('T', ' ')})
              </p>
            )}
            {driftBad && (
              <div className="mt-1 flex items-center justify-between text-amber-300" data-testid="attendance-drift">
                <span>The device clock is {Math.abs(drift!)} s {drift! > 0 ? 'ahead of' : 'behind'} this PC — punch times will be wrong.</span>
                <button onClick={() => setTime(d.id)} disabled={!!busy} data-testid="attendance-set-time"
                  className="px-2 py-0.5 rounded bg-amber-600 text-white disabled:opacity-50">{busy === `time:${d.id}` ? 'Setting…' : 'Set device time'}</button>
              </div>
            )}
          </div>
        );
      })}
      <p className="text-gray-500 mt-2">A branch has one attendance device. It is added and removed on the web portal, Attendance → Devices.</p>
    </div>
  );
}
