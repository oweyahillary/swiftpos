/**
 * AttendancePage.tsx — A599 (Attendance, premium): who came in and when, from the ZKTeco attendance devices.
 *
 * Owner, 2026-10-27/28: punches come only from the device, for everyone; the report is colourful — summary cards in
 * different colours, a bar a day for a week, a calendar heat-map for a month, every person ranked, a staff × days grid.
 * Shown only with the business's 'attendance' flag (the menu item is not there without it) and attendance.view (the owner
 * and partners always). The cloud decides every request (routes/attendance.ts) — this page only shows what it answers:
 * pay figures only arrive for the owner or a holder of staff.pay. Lazy-loaded (App.tsx), recharts with it.
 *
 * Pickers: Who (All staff, or one person), Branch (several branches), Period (This week · Last week · This month · Last
 * month · Custom — one preset lit, lib/reportPeriods.ts activePreset). Export to Excel (lib/reportDownload.ts) and Print.
 * Below the report, for the people who hold the rights: "Not matched" punches (attendance.edit), "New on the device",
 * People and device numbers, and the devices (attendance.devices). The pairing rule is the cloud's (lib/attendanceRules.ts):
 * punches in time order, in / out alternately; an odd last punch is a missing punch-out, flagged and not counted.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, LabelList } from 'recharts';
import { api } from '../../lib/api';
import { useBranch } from '../../context/BranchContext';
import { useBusiness } from '../../context/BusinessContext';
import { useTheme } from '../../context/ThemeContext';
import { useBrandLook } from '../../components/ThemeLayer';
import { brandChartAccent } from '../../lib/themeVars';
import { downloadReport } from '../../lib/reportDownload';
import * as fmt from '../../lib/format';
import {
  attendancePresets, activePreset, attendancePalette, heatColour, heatInk, hoursWords, clockEAT, dayLabel, monthGrid,
  preferredView, attendanceSheets, type AttReport, type AttPerson, type AttDay, type AttendancePalette,
} from '../../lib/attendanceView';

interface Access { enabled: boolean; view: boolean; edit: boolean; devices: boolean; pay: boolean }
const card = 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-3 sm:p-4 min-w-0';
const inputCls = 'text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200';
const btn = 'text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800';
const btnMain = 'text-xs px-3 py-1.5 rounded-lg bg-swift-strong text-white hover:opacity-90 disabled:opacity-50';
const noAnim = { isAnimationActive: false } as const;

export default function AttendancePage() {
  const { branches, activeBranchId } = useBranch();
  const { business } = useBusiness();
  const { theme } = useTheme();
  const mode = theme === 'dark' ? 'dark' : 'light';
  const pal = attendancePalette(mode, brandChartAccent(useBrandLook(), mode));
  const presets = useMemo(() => attendancePresets(), []);
  const [range, setRange] = useState({ from: presets[0].from, to: presets[0].to });
  const [picked, setPicked] = useState<string | null>(presets[0].label);
  const [custom, setCustom] = useState(false);
  const lit = custom ? null : activePreset(presets, range, picked);
  const [branchId, setBranchId] = useState<string>(activeBranchId ?? '');
  const [who, setWho] = useState<string>('all');
  const [access, setAccess] = useState<Access | null>(null);
  const [report, setReport] = useState<AttReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [fixing, setFixing] = useState<{ person: AttPerson; date: string } | null>(null);

  useEffect(() => { api.get<Access>('/api/attendance/access').then(setAccess).catch((e) => setError(e?.message ?? 'Attendance is not available.')); }, []);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams({ from: range.from, to: range.to });
      if (branchId) p.set('branch_id', branchId);
      if (who !== 'all') p.set('person', who);
      setReport(await api.get<AttReport>(`/api/attendance/report?${p}`));
    } catch (e: any) { setError(e?.message ?? 'The attendance report could not be loaded.'); }
    finally { setLoading(false); }
  }, [range.from, range.to, branchId, who]);
  useEffect(() => { void load(); }, [load, tick]);

  const person = who !== 'all' ? report?.people.find((p) => p.key === who) ?? null : null;
  const branchName = branches.find((b) => b.id === branchId)?.name ?? null;
  const exportXlsx = () => report && downloadReport({
    report: person ? `Attendance ${person.name}` : 'Attendance', branchName, from: range.from, to: range.to,
    businessName: business?.name ?? null, sheets: attendanceSheets(report, person),
  });
  const refresh = () => setTick((t) => t + 1);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-4" data-testid="attendance-page">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Attendance</h1>
          <p className="text-sm text-gray-500">From the attendance device: first in, last out and the hours in between.</p>
        </div>
        <div className="flex gap-2 print:hidden">
          <button className={btn} onClick={exportXlsx} disabled={!report} data-testid="attendance-export">Download Excel</button>
          <button className={btn} onClick={() => window.print()}>Print</button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 print:hidden" data-testid="attendance-pickers">
        <select value={who} onChange={(e) => setWho(e.target.value)} className={inputCls} aria-label="Who">
          <option value="all">All staff</option>
          {(report?.people ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
        </select>
        {branches.length > 1 && (
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={inputCls} aria-label="Branch">
            <option value="">All branches</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
        <div className="flex items-center gap-1 max-w-full overflow-x-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-1" data-testid="attendance-presets">
          {presets.map((p) => (
            <button key={p.label} onClick={() => { setCustom(false); setPicked(p.label); setRange({ from: p.from, to: p.to }); }}
              className={`flex-shrink-0 whitespace-nowrap text-xs px-3 py-1.5 rounded-md ${lit === p.label ? 'bg-swift-strong text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
              {p.label}
            </button>
          ))}
          <button onClick={() => setCustom(true)}
            className={`flex-shrink-0 whitespace-nowrap text-xs px-3 py-1.5 rounded-md ${custom || !lit ? 'bg-swift-strong text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>Custom</button>
        </div>
        {(custom || !lit) && (
          <>
            <input type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} className={inputCls} />
            <span className="text-gray-400 text-sm">→</span>
            <input type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} className={inputCls} />
          </>
        )}
      </div>

      {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
      {loading && !report && <div className="text-sm text-gray-500">Loading…</div>}
      {report && (person
        ? <PersonView report={report} person={person} pal={pal} mode={mode} currency={business?.currency ?? 'KES'} canEdit={!!access?.edit}
            onBack={() => setWho('all')} onFix={(date) => setFixing({ person, date })} />
        : <TeamView report={report} pal={pal} mode={mode} currency={business?.currency ?? 'KES'} onPick={setWho} />)}

      {access?.edit && <NotMatchedPanel branchId={branchId} onChanged={refresh} />}
      {access?.devices && <NewOnDevicePanel branchId={branchId} onChanged={refresh} />}
      {access?.devices && <PeoplePanel branchId={branchId} branches={branches} onChanged={refresh} />}
      {access?.devices && <DevicesPanel branchId={branchId} branches={branches} />}
      {fixing && <FixDayDialog person={fixing.person} date={fixing.date} onClose={() => setFixing(null)} onChanged={refresh} />}
    </div>
  );
}

// ── All staff ──────────────────────────────────────────────────────────────────────────────────────────────────────
function SummaryCard({ label, value, sub, colour, testId }: { label: string; value: string; sub?: string; colour: string; testId?: string }) {
  return (
    <div className={`${card} relative overflow-hidden`} data-testid={testId}>
      <span aria-hidden className="absolute inset-x-0 top-0 h-1.5" style={{ background: colour }} />
      <p className="text-xs font-medium text-gray-500 mt-1">{label}</p>
      <p className="text-2xl font-semibold tabular-nums mt-0.5" style={{ color: colour }}>{value}</p>
      {sub && <p className="text-[11px] text-gray-500 mt-1">{sub}</p>}
    </div>
  );
}

function TeamView({ report, pal, mode, currency, onPick }: { report: AttReport; pal: AttendancePalette; mode: 'light' | 'dark'; currency: string; onPick: (k: string) => void }) {
  const ranked = report.people.filter((p) => p.totals.hours > 0);
  const height = Math.max(160, ranked.length * 30 + 40);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label="Team hours" value={hoursWords(report.team.hours)} colour={pal.cards.hours} testId="att-team-hours" />
        <SummaryCard label="People who worked" value={String(report.team.people)} colour={pal.cards.days} />
        <SummaryCard label="Missed punch-outs" value={String(report.team.missedOuts)} sub="Not counted until fixed" colour={pal.cards.missed} />
        {report.payVisible && report.team.pay !== undefined
          ? <SummaryCard label="Estimated pay" value={fmt.money(report.team.pay, currency)} sub="Hours × each person's hourly rate" colour={pal.cards.avg} testId="att-team-pay" />
          : <SummaryCard label="Corrections" value={String(report.team.corrections)} colour={pal.cards.corrections} />}
      </div>
      <section className={card}>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Hours by person</h3>
        <p className="text-xs text-gray-500 mb-2">Click a person to see their days.</p>
        {ranked.length === 0 ? <p className="text-sm text-gray-500">No hours recorded in this period.</p> : (
          <div style={{ height }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={ranked.map((p) => ({ key: p.key, name: p.name, hours: p.totals.hours }))} layout="vertical" margin={{ top: 4, right: 56, bottom: 4, left: 8 }}>
                <CartesianGrid horizontal={false} stroke={pal.grid} />
                <XAxis type="number" tick={{ fontSize: 11, fill: mode === 'dark' ? '#9ca3af' : '#64748b' }} />
                <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 12, fill: mode === 'dark' ? '#d1d5db' : '#334155' }} />
                <Tooltip formatter={(v: any) => hoursWords(Number(v))} cursor={{ fill: mode === 'dark' ? '#1f2937' : '#f1f5f9' }} />
                <Bar dataKey="hours" radius={[0, 4, 4, 0]} maxBarSize={22} onClick={(d: any) => onPick(d?.key ?? d?.payload?.key)} style={{ cursor: 'pointer' }} {...noAnim}>
                  {ranked.map((p, i) => <Cell key={p.key} fill={i === 0 ? pal.accent : pal.ramp[Math.max(1, 4 - Math.min(3, Math.floor(i / 3)))]} />)}
                  <LabelList dataKey="hours" position="right" formatter={(v: any) => `${Number(v).toFixed(1)} h`} style={{ fontSize: 11, fill: mode === 'dark' ? '#d1d5db' : '#334155' }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>
      <section className={card}>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Week grid</h3>
        <p className="text-xs text-gray-500 mb-2">Each cell is a day's hours — grey is a day off, a red outline a missing punch-out.</p>
        <div className="overflow-x-auto">
          <table className="text-xs border-separate" style={{ borderSpacing: 3 }} data-testid="att-week-grid">
            <thead><tr>
              <th className="text-left font-medium text-gray-500 pr-2">Person</th>
              {report.dates.map((d) => <th key={d} className="font-medium text-gray-500 whitespace-nowrap px-1">{dayLabel(d)}</th>)}
              <th className="font-medium text-gray-500 pl-2 text-right">Total</th>
            </tr></thead>
            <tbody>
              {report.people.map((p) => (
                <tr key={p.key}>
                  <td className="pr-2 whitespace-nowrap"><button className="text-left text-gray-800 dark:text-gray-100 hover:underline" onClick={() => onPick(p.key)}>{p.name}</button>
                    {p.attendance_only && <span className="ml-1 text-[10px] text-gray-500">(attendance only)</span>}</td>
                  {report.dates.map((d) => {
                    const h = p.daily[d] ?? 0; const miss = p.missing.includes(d);
                    return <td key={d} title={`${p.name} · ${d}: ${hoursWords(h)}${miss ? ' · missing punch-out' : ''}`}
                      className="text-center rounded tabular-nums" style={{ minWidth: 34, height: 26, background: heatColour(h, pal), color: heatInk(h, mode),
                        outline: miss ? `2px solid ${pal.missing}` : undefined, outlineOffset: -2 }}>{h ? h.toFixed(1) : ''}</td>;
                  })}
                  <td className="pl-2 text-right font-semibold tabular-nums text-gray-800 dark:text-gray-100">{p.totals.hours.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <HeatLegend pal={pal} />
      </section>
    </div>
  );
}

function HeatLegend({ pal }: { pal: AttendancePalette }) {
  const steps = ['Day off', 'Under 4 h', '4–6 h', '6–8 h', '8–10 h', '10 h +'];
  const colours = [pal.off, ...pal.ramp];
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-500 mt-2">
      {steps.map((s, i) => <li key={s} className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded" style={{ background: colours[i] }} />{s}</li>)}
      <li className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded" style={{ outline: `2px solid ${pal.missing}`, outlineOffset: -2 }} />Missing punch-out</li>
    </ul>
  );
}

// ── One person ─────────────────────────────────────────────────────────────────────────────────────────────────────
function PersonView({ report, person, pal, mode, currency, canEdit, onBack, onFix }: {
  report: AttReport; person: AttPerson; pal: AttendancePalette; mode: 'light' | 'dark'; currency: string; canEdit: boolean; onBack: () => void; onFix: (date: string) => void;
}) {
  const [view, setView] = useState<'week' | 'month'>(preferredView(report.dates));
  useEffect(() => setView(preferredView(report.dates)), [report.dates]);
  const days = person.days ?? [];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const t = person.totals;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button className={`${btn} print:hidden`} onClick={onBack}>← All staff</button>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{person.name}</h2>
        {person.attendance_no !== null && <span className="text-xs text-gray-500">Device number {person.attendance_no}</span>}
        {person.attendance_only && <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500">Attendance only</span>}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <SummaryCard label="Total hours" value={hoursWords(t.hours)} colour={pal.cards.hours} testId="att-hours"
          sub={report.payVisible && person.pay != null ? `Estimated pay ${fmt.money(person.pay, currency)}` : undefined} />
        <SummaryCard label="Days worked" value={String(t.daysWorked)} colour={pal.cards.days} />
        <SummaryCard label="Average a day" value={hoursWords(t.avgHours)} colour={pal.cards.avg} />
        <SummaryCard label="Missed punch-outs" value={String(t.missedOuts)} sub="Not counted until fixed" colour={pal.cards.missed} />
        <SummaryCard label="Corrections" value={String(t.corrections)} colour={pal.cards.corrections} />
      </div>
      <section className={card}>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{view === 'week' ? 'Hours a day' : 'The month'}</h3>
          <div className="flex gap-1 print:hidden">
            <button className={view === 'week' ? btnMain : btn} onClick={() => setView('week')}>Week</button>
            <button className={view === 'month' ? btnMain : btn} onClick={() => setView('month')}>Month</button>
          </div>
        </div>
        {view === 'week' ? <WeekBars dates={report.dates} byDate={byDate} pal={pal} mode={mode} /> : <MonthCalendar dates={report.dates} byDate={byDate} pal={pal} mode={mode} />}
      </section>
      <section className={card}>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">Day by day</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="att-day-list">
            <thead><tr className="text-left text-xs text-gray-500 border-b border-gray-200 dark:border-gray-800">
              <th className="py-1.5 pr-3">Day</th><th className="pr-3">First in</th><th className="pr-3">Last out</th><th className="pr-3 text-right">Hours</th><th className="pr-3">Check</th><th className="pr-3">Corrections</th>{canEdit && <th className="print:hidden" />}
            </tr></thead>
            <tbody>
              {days.length === 0 && <tr><td colSpan={7} className="py-3 text-gray-500">No punches in this period.</td></tr>}
              {days.map((d) => (
                <tr key={d.date} className="border-b border-gray-100 dark:border-gray-800 align-top">
                  <td className="py-1.5 pr-3 whitespace-nowrap text-gray-800 dark:text-gray-100">{dayLabel(d.date)} <span className="text-gray-400 text-xs">{d.date}</span></td>
                  <td className="pr-3 tabular-nums">{clockEAT(d.firstIn)}</td>
                  <td className="pr-3 tabular-nums">{clockEAT(d.lastOut)}</td>
                  <td className="pr-3 text-right tabular-nums font-medium">{hoursWords(d.hours)}</td>
                  <td className="pr-3 text-xs">
                    {d.missingOut && <span className="inline-block px-1.5 py-0.5 rounded bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300 mr-1">Missing punch-out</span>}
                    {d.long && <span className="inline-block px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300">Over 12 h</span>}
                  </td>
                  <td className="pr-3 text-xs text-gray-600 dark:text-gray-300">
                    {d.corrections.map((c) => (
                      <div key={c.id}>{c.kind === 'added' ? `Added ${clockEAT(c.at)}` : c.kind === 'moved' ? `Moved ${clockEAT(c.was)} → ${clockEAT(c.at)}` : `Removed ${clockEAT(c.was)}`}
                        {' — '}{c.reason}{c.byName ? ` (${c.byName}, ${fmt.dateShort(c.when)})` : ''}</div>
                    ))}
                  </td>
                  {canEdit && <td className="print:hidden"><button className={btn} onClick={() => onFix(d.date)}>Fix</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {canEdit && <button className={`${btn} mt-2 print:hidden`} onClick={() => onFix(report.to)}>Add a missed punch</button>}
      </section>
    </div>
  );
}

function WeekBars({ dates, byDate, pal, mode }: { dates: string[]; byDate: Map<string, AttDay>; pal: AttendancePalette; mode: 'light' | 'dark' }) {
  const data = dates.map((d) => { const x = byDate.get(d); return { date: d, label: dayLabel(d), hours: x?.hours ?? 0, inT: clockEAT(x?.firstIn), outT: clockEAT(x?.lastOut), missing: !!x?.missingOut }; });
  return (
    <div style={{ height: 240 }} data-testid="att-week-bars">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 22, right: 8, bottom: 4, left: -16 }}>
          <CartesianGrid vertical={false} stroke={pal.grid} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: mode === 'dark' ? '#9ca3af' : '#64748b' }} />
          <YAxis tick={{ fontSize: 11, fill: mode === 'dark' ? '#9ca3af' : '#64748b' }} />
          <Tooltip content={({ active, payload }: any) => {
            const p = active && payload?.[0]?.payload; if (!p) return null;
            return <div className="text-xs bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 shadow">
              <div className="font-semibold">{p.label}</div><div>{hoursWords(p.hours)}</div><div>In {p.inT} · Out {p.outT}</div>
              {p.missing && <div style={{ color: pal.missing }}>Missing punch-out</div>}</div>;
          }} />
          <Bar dataKey="hours" radius={[4, 4, 0, 0]} maxBarSize={36} {...noAnim}>
            {data.map((d) => <Cell key={d.date} fill={d.hours ? pal.accent : pal.off}
              stroke={d.missing ? pal.missing : undefined} strokeWidth={d.missing ? 2 : 0} />)}
            <LabelList dataKey="inT" position="top" formatter={(v: any) => (v === '—' ? '' : v)} style={{ fontSize: 10, fill: mode === 'dark' ? '#9ca3af' : '#64748b' }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function MonthCalendar({ dates, byDate, pal, mode }: { dates: string[]; byDate: Map<string, AttDay>; pal: AttendancePalette; mode: 'light' | 'dark' }) {
  const weeks = monthGrid(dates);
  return (
    <div data-testid="att-month">
      <div className="grid grid-cols-7 gap-1 text-[11px] text-gray-500 mb-1">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="text-center">{d}</div>)}</div>
      {weeks.map((w, i) => (
        <div key={i} className="grid grid-cols-7 gap-1 mb-1">
          {w.map((d, j) => {
            if (!d) return <div key={j} />;
            const x = byDate.get(d); const h = x?.hours ?? 0;
            return <div key={d} title={`${d}: ${hoursWords(h)}${x ? ` · in ${clockEAT(x.firstIn)} · out ${clockEAT(x.lastOut)}` : ''}`}
              className="rounded-md p-1 h-14 flex flex-col justify-between" style={{ background: heatColour(h, pal), color: heatInk(h, mode),
                outline: x?.missingOut ? `2px solid ${pal.missing}` : undefined, outlineOffset: -2 }}>
              <span className="text-[10px] opacity-80">{Number(d.slice(8))}</span>
              <span className="text-xs font-semibold tabular-nums text-right">{h ? `${h.toFixed(1)} h` : ''}</span>
            </div>;
          })}
        </div>
      ))}
      <HeatLegend pal={pal} />
    </div>
  );
}

// ── Fix a day (attendance.edit) ────────────────────────────────────────────────────────────────────────────────────
interface PunchRow { id: string; recorded_at: string; source: string; reason: string | null; voided_at: string | null; void_reason: string | null }
function FixDayDialog({ person, date, onClose, onChanged }: { person: AttPerson; date: string; onClose: () => void; onChanged: () => void }) {
  const [rows, setRows] = useState<PunchRow[]>([]);
  const [why, setWhy] = useState('');
  const [time, setTime] = useState('08:00');
  const [day, setDay] = useState(date);
  const [err, setErr] = useState('');
  const q = person.person_id ? `person=${person.person_id}` : `user=${person.user_id}`;
  const load = useCallback(() => { api.get<{ punches: PunchRow[] }>(`/api/attendance/punches?${q}&date=${day}`).then((r) => setRows(r.punches)).catch((e) => setErr(e?.message ?? '')); }, [q, day]);
  useEffect(load, [load]);
  const at = () => new Date(`${day}T${time}:00+03:00`).toISOString();
  const run = async (f: () => Promise<unknown>) => { setErr(''); try { await f(); setWhy(''); load(); onChanged(); } catch (e: any) { setErr(e?.message ?? 'Could not be saved.'); } };
  const target = person.person_id ? { person_id: person.person_id } : { user_id: person.user_id };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 print:hidden" role="dialog" aria-modal="true">
      <div className="bg-white dark:bg-gray-900 rounded-xl max-w-lg w-full p-4 space-y-3 border border-gray-200 dark:border-gray-800">
        <div className="flex items-center justify-between"><h3 className="font-semibold text-gray-900 dark:text-white">Fix {person.name}'s punches</h3><button className={btn} onClick={onClose}>Close</button></div>
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className={inputCls} />
        <ul className="text-sm space-y-1">
          {rows.length === 0 && <li className="text-gray-500">No punches that day.</li>}
          {rows.map((r) => (
            <li key={r.id} className={`flex items-center justify-between gap-2 ${r.voided_at ? 'line-through text-gray-400' : ''}`}>
              <span className="tabular-nums">{clockEAT(r.recorded_at)} <span className="text-xs text-gray-500">{r.source === 'device' ? 'device' : r.source === 'correction' ? `added: ${r.reason}` : 'PIN'}</span>
                {r.voided_at && <span className="text-xs"> — {r.void_reason}</span>}</span>
              {!r.voided_at && <span className="flex gap-1">
                <button className={btn} disabled={why.trim().length < 3} onClick={() => run(() => api.post(`/api/attendance/punches/${r.id}/move`, { at: at(), reason: why }))}>Move to {time}</button>
                <button className={btn} disabled={why.trim().length < 3} onClick={() => run(() => api.post(`/api/attendance/punches/${r.id}/remove`, { reason: why }))}>Remove</button>
              </span>}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={inputCls} />
          <input placeholder="Why (required)" value={why} onChange={(e) => setWhy(e.target.value)} className={`${inputCls} flex-1 min-w-[10rem]`} />
          <button className={btnMain} disabled={why.trim().length < 3} onClick={() => run(() => api.post('/api/attendance/punches', { ...target, at: at(), reason: why }))}>Add punch</button>
        </div>
        <p className="text-[11px] text-gray-500">The original punch is always kept; the report shows who changed what, when and why.</p>
        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
    </div>
  );
}

// ── Not matched (attendance.edit) ──────────────────────────────────────────────────────────────────────────────────
interface Unmatched { device_user_id: string; attendance_no: number | null; punches: number; first: string; last: string; devices: string[]; name_on_device: string | null }
interface PeopleAnswer { people: Array<{ id: string; name: string; attendance_no: number; branch_id: string | null; user_id: string | null; active: boolean; attendance_only: boolean }>; staff_without_number: Array<{ user_id: string; name: string; branch_id: string | null }>; next_number: number }
function usePeople(branchId: string, tick: number) {
  const [p, setP] = useState<PeopleAnswer | null>(null);
  useEffect(() => { api.get<PeopleAnswer>(`/api/attendance/people${branchId ? `?branch_id=${branchId}` : ''}`).then(setP).catch(() => setP(null)); }, [branchId, tick]);
  return p;
}
function LinkPicker({ people, onLink }: { people: PeopleAnswer | null; onLink: (body: Record<string, unknown>) => void }) {
  const [v, setV] = useState('');
  const [name, setName] = useState('');
  return (
    <span className="flex flex-wrap gap-1 items-center">
      <select value={v} onChange={(e) => setV(e.target.value)} className={inputCls} aria-label="Link to">
        <option value="">Link to…</option>
        <optgroup label="Staff without a number">{(people?.staff_without_number ?? []).map((s) => <option key={s.user_id} value={`u:${s.user_id}`}>{s.name}</option>)}</optgroup>
        <optgroup label="People on the devices">{(people?.people ?? []).filter((x) => x.active).map((x) => <option key={x.id} value={`p:${x.id}`}>{x.name} (now {x.attendance_no})</option>)}</optgroup>
        <option value="new">A new person without a sign-in…</option>
      </select>
      {v === 'new' && <input placeholder="Their name" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />}
      <button className={btnMain} disabled={!v || (v === 'new' && !name.trim())}
        onClick={() => onLink(v === 'new' ? { name } : v.startsWith('u:') ? { user_id: v.slice(2) } : { person_id: v.slice(2) })}>Link</button>
    </span>
  );
}
function NotMatchedPanel({ branchId, onChanged }: { branchId: string; onChanged: () => void }) {
  const [rows, setRows] = useState<Unmatched[]>([]);
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState('');
  const people = usePeople(branchId, tick);
  const { branches } = useBranch();
  useEffect(() => { api.get<{ unmatched: Unmatched[] }>(`/api/attendance/unmatched${branchId ? `?branch_id=${branchId}` : ''}`).then((r) => setRows(r.unmatched)).catch(() => setRows([])); }, [branchId, tick]);
  if (!rows.length) return null;
  return (
    <section className={`${card} print:hidden`} data-testid="att-not-matched">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Not matched</h3>
      <p className="text-xs text-gray-500 mb-2">Punches under a device number nobody has. Link the number to someone and every punch is theirs, back to the first.</p>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.device_user_id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span><b>{r.device_user_id}</b>{r.name_on_device ? ` · ${r.name_on_device}` : ''} <span className="text-xs text-gray-500">— {r.punches} punches, {fmt.dateShort(r.first)} to {fmt.dateShort(r.last)}{r.devices.length ? ` on ${r.devices.join(', ')}` : ''}</span></span>
            <LinkPicker people={people} onLink={async (b) => {
              setErr('');
              try { await api.post('/api/attendance/unmatched/link', { device_user_id: r.device_user_id, branch_id: branchId || branches[0]?.id, ...b }); setTick((t) => t + 1); onChanged(); }
              catch (e: any) { setErr(e?.message ?? 'Could not be linked.'); }
            }} />
          </li>
        ))}
      </ul>
      {err && <p className="text-sm text-red-600 mt-2">{err}</p>}
    </section>
  );
}

// ── New on the device (attendance.devices) ─────────────────────────────────────────────────────────────────────────
interface DeviceUserRow { device_user_id: string; name: string | null; device_id: string; device_name: string | null; admin: boolean; linkable: boolean }
/** A person's number that, on a device, belongs to someone else (a device bought before ZapTill keeps its own people). */
interface ClashRow { device_id: string; device_name: string | null; device_user_id: string; name_on_device: string | null; admin: boolean; person_id: string; person_name: string }
function NewOnDevicePanel({ branchId, onChanged }: { branchId: string; onChanged: () => void }) {
  const [rows, setRows] = useState<DeviceUserRow[]>([]);
  const [clashes, setClashes] = useState<ClashRow[]>([]);
  const [fixNo, setFixNo] = useState<Record<string, string>>({});
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState('');
  const people = usePeople(branchId, tick);
  const { branches } = useBranch();
  useEffect(() => {
    api.get<{ new_on_device: DeviceUserRow[]; clashes?: ClashRow[] }>(`/api/attendance/device-users${branchId ? `?branch_id=${branchId}` : ''}`)
      .then((r) => { setRows(r.new_on_device); setClashes(r.clashes ?? []); }).catch(() => { setRows([]); setClashes([]); });
  }, [branchId, tick]);
  if (!rows.length && !clashes.length) return null;
  return (
    <section className={`${card} print:hidden`} data-testid="att-new-on-device">
      {clashes.length > 0 && (
        <div className="mb-4" data-testid="att-clashes">
          <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-400">Number clash</h3>
          <p className="text-xs text-gray-500 mb-2">On the device, these numbers belong to someone else. Nothing is written to the device and their punches stay under "Not matched". Give the person the number they really have on the device, or a new one.</p>
          <ul className="space-y-2">
            {clashes.map((c) => {
              const k = `${c.device_id}|${c.device_user_id}`;
              return (
                <li key={k} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>Number <b>{c.device_user_id}</b> on {c.device_name ?? 'the device'} is <b>{c.name_on_device || 'someone with no name'}</b>{c.admin ? ' (a device admin)' : ''}, but <b>{c.person_name}</b> has it here.</span>
                  <span className="flex items-center gap-1">
                    <input className="w-24 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm" inputMode="numeric" placeholder="Their number"
                      value={fixNo[k] ?? ''} onChange={(e) => setFixNo({ ...fixNo, [k]: e.target.value.replace(/\D/g, '') })} aria-label={`${c.person_name}'s number on the device`} />
                    <button className={btn} disabled={!fixNo[k]} onClick={async () => {
                      setErr('');
                      try { await api.patch(`/api/attendance/people/${c.person_id}`, { attendance_no: Number(fixNo[k]) }); setTick((t) => t + 1); onChanged(); }
                      catch (e: any) { setErr(e?.message ?? 'Could not be saved.'); }
                    }}>Give {c.person_name} this number</button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {rows.length > 0 && <>
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white">New on the device</h3>
      <p className="text-xs text-gray-500 mb-2">Users set up on the device itself whom the system does not know yet. Nobody is added by themselves — link each one.</p>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={`${r.device_id}|${r.device_user_id}`} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>New on the device: <b>{r.device_user_id}</b>{r.name ? ` · ${r.name}` : ''} <span className="text-xs text-gray-500">({r.device_name ?? 'device'}{r.admin ? ', a device admin' : ''})</span></span>
            {r.linkable ? <LinkPicker people={people} onLink={async (b) => {
              setErr('');
              try { await api.post('/api/attendance/device-users/link', { device_user_id: r.device_user_id, branch_id: branchId || branches[0]?.id, ...b }); setTick((t) => t + 1); onChanged(); }
              catch (e: any) { setErr(e?.message ?? 'Could not be linked.'); }
            }} /> : <span className="text-xs text-gray-500">Only a numeric user can be linked</span>}
          </li>
        ))}
      </ul>
      </>}
      {err && <p className="text-sm text-red-600 mt-2">{err}</p>}
    </section>
  );
}

// ── People and device numbers (attendance.devices) ─────────────────────────────────────────────────────────────────
function PeoplePanel({ branchId, branches, onChanged }: { branchId: string; branches: Array<{ id: string; name: string }>; onChanged: () => void }) {
  const [tick, setTick] = useState(0);
  const people = usePeople(branchId, tick);
  const [name, setName] = useState('');
  const [br, setBr] = useState(branchId || branches[0]?.id || '');
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const act = async (f: () => Promise<unknown>) => { setErr(''); try { await f(); setTick((t) => t + 1); onChanged(); } catch (e: any) { setErr(e?.message ?? 'Could not be saved.'); } };
  const bn = (id: string | null) => branches.find((b) => b.id === id)?.name ?? '—';
  return (
    <section className={`${card} print:hidden`} data-testid="att-people">
      <button className="flex w-full items-center justify-between" onClick={() => setOpen(!open)} aria-expanded={open}>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">People and device numbers</h3>
        <span className="text-xs text-gray-500">{people ? `${people.people.filter((p) => p.active).length} on the devices · next free number ${people.next_number}` : ''} {open ? '▲' : '▼'}</span>
      </button>
      {open && people && (
        <div className="mt-3 space-y-3">
          {people.staff_without_number.length > 0 && (
            <div className="text-sm">
              <p className="text-xs text-gray-500 mb-1">Staff without a device number:</p>
              <div className="flex flex-wrap gap-1">{people.staff_without_number.map((s) => (
                <button key={s.user_id} className={btn} onClick={() => act(() => api.post('/api/attendance/people', { user_id: s.user_id, branch_id: s.branch_id ?? br }))}>Give {s.name} number {people.next_number}</button>
              ))}</div>
            </div>
          )}
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-gray-500"><th className="py-1">No.</th><th>Name</th><th>Branch</th><th>Kind</th><th /></tr></thead>
            <tbody>{people.people.map((p) => (
              <tr key={p.id} className={`border-t border-gray-100 dark:border-gray-800 ${p.active ? '' : 'text-gray-400'}`}>
                <td className="py-1 tabular-nums">{p.attendance_no}</td><td>{p.name}</td><td>{bn(p.branch_id)}</td>
                <td className="text-xs">{p.attendance_only ? 'Attendance only (no sign-in)' : 'Staff'}</td>
                <td className="text-right">{p.attendance_only && <button className={btn} onClick={() => act(() => api.patch(`/api/attendance/people/${p.id}`, { active: !p.active }))}>{p.active ? 'Deactivate' : 'Bring back'}</button>}</td>
              </tr>
            ))}</tbody>
          </table>
          <div className="flex flex-wrap items-center gap-2">
            <input placeholder="Name (a cook, a cleaner, a guard…)" value={name} onChange={(e) => setName(e.target.value)} className={`${inputCls} flex-1 min-w-[12rem]`} />
            {branches.length > 1 && <select value={br} onChange={(e) => setBr(e.target.value)} className={inputCls}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>}
            <button className={btnMain} disabled={!name.trim() || !br} onClick={() => act(async () => { await api.post('/api/attendance/people', { name, branch_id: br }); setName(''); })}>Add a person without a sign-in (number {people.next_number})</button>
          </div>
          <p className="text-[11px] text-gray-500">A person without a sign-in only punches on the device: no PIN, no rights, and they cannot open the POS or the dashboard.</p>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
      )}
    </section>
  );
}

// ── Devices (attendance.devices) ───────────────────────────────────────────────────────────────────────────────────
interface DeviceRow { id: string; branch_id: string; name: string; ip: string; port: number; serial: string | null; model: string | null; firmware: string | null; last_pull_at: string | null; last_error: string | null; clock_drift_s: number | null; users_on_device: number | null; pending_actions: number; failed_actions: number; comm_key_set: boolean }
function DevicesPanel({ branchId, branches }: { branchId: string; branches: Array<{ id: string; name: string }> }) {
  const [rows, setRows] = useState<DeviceRow[]>([]);
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', ip: '', port: '4370', comm_key: '', branch_id: branchId || branches[0]?.id || '' });
  const [err, setErr] = useState('');
  useEffect(() => { api.get<{ devices: DeviceRow[] }>(`/api/attendance/devices${branchId ? `?branch_id=${branchId}` : ''}`).then((r) => setRows(r.devices)).catch(() => setRows([])); }, [branchId, tick]);
  const act = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); setTick((t) => t + 1); } catch (e: any) { setErr(e?.message ?? 'Could not be saved.'); } };
  return (
    <section className={`${card} print:hidden`} data-testid="att-devices">
      <button className="flex w-full items-center justify-between" onClick={() => setOpen(!open)} aria-expanded={open}>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Attendance devices</h3>
        <span className="text-xs text-gray-500">{rows.length} set up {open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          {rows.map((d) => (
            <div key={d.id} className="flex flex-wrap items-start justify-between gap-2 text-sm border-t border-gray-100 dark:border-gray-800 pt-2">
              <div>
                <div className="font-medium text-gray-900 dark:text-white">{d.name} <span className="text-xs text-gray-500">{d.ip}:{d.port}{d.model ? ` · ${d.model}` : ''}{d.serial ? ` · ${d.serial}` : ''}</span></div>
                <div className="text-xs text-gray-500">
                  {d.last_pull_at ? `Last read ${fmt.relative(d.last_pull_at)}` : 'Not read yet — the branch server reads it once it is set up there'}
                  {d.users_on_device != null ? ` · ${d.users_on_device} users on it` : ''}
                  {d.clock_drift_s != null && Math.abs(d.clock_drift_s) >= 60 ? ` · its clock is ${Math.round(d.clock_drift_s / 60)} min off` : ''}
                  {d.pending_actions ? ` · ${d.pending_actions} waiting to be written` : ''}
                </div>
                {d.last_error && <div className="text-xs text-red-600">Last problem: {d.last_error}</div>}
                {d.failed_actions > 0 && <div className="text-xs text-red-600">{d.failed_actions} change(s) could not be written to the device</div>}
              </div>
              <button className={btn} onClick={() => act(() => api.delete(`/api/attendance/devices/${d.id}`))}>Remove</button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 dark:border-gray-800 pt-2">
            <input placeholder="Name (Front door)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inputCls} />
            <input placeholder="Address (192.168.1.201)" value={f.ip} onChange={(e) => setF({ ...f, ip: e.target.value })} className={inputCls} />
            <input placeholder="Port" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} className={`${inputCls} w-20`} />
            <input placeholder="Comm key (if set)" value={f.comm_key} onChange={(e) => setF({ ...f, comm_key: e.target.value })} className={`${inputCls} w-36`} />
            {branches.length > 1 && <select value={f.branch_id} onChange={(e) => setF({ ...f, branch_id: e.target.value })} className={inputCls}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>}
            <button className={btnMain} disabled={!f.name.trim() || !f.ip.trim() || !f.branch_id}
              onClick={() => act(async () => { await api.post('/api/attendance/devices', { ...f, port: Number(f.port) || 4370, comm_key: f.comm_key ? Number(f.comm_key) : 0 }); setF({ ...f, name: '', ip: '' }); })}>Add device</button>
          </div>
          <p className="text-[11px] text-gray-500">ZKTeco devices (K90 Pro). The branch server on the same network reads the punches and writes the people onto the device; fingerprints stay on the device.</p>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
      )}
    </section>
  );
}
