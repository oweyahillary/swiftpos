/**
 * SystemPage — A525: what the production server runs, whether the last deploy reached it, what the dependencies carry.
 *
 * Production silently failed every deploy from 1.0.16 to 1.0.18 (Render kept the old 1.0.15 running) and npm audit
 * showed 7 vulnerabilities nobody was told about. Owner, 2026-10-17: "maybe can we have a UI for all that in the app,
 * these results are written to the db and I can read through".
 *
 * Three cards — Production server (the commit it runs, since when, its last recorded start), Last deploy check (GitHub's
 * verify-prod-deploy.yml: expected against running, what to do when it failed, the run), Dependencies (the latest
 * security-scan.yml: counts per app) — and below them every event, newest first, a page at a time, filtered by kind;
 * a row opens to its details (for a scan: each vulnerable package, its fix and its advisories).
 * A528: a fourth card, Traffic since start — requests per route family, and how often the tills' polled answers came from
 * memory (Render suspended production over bandwidth, 2026-10-19).
 * A591: a fifth, Supabase pulled (24 h) — what the server read from Supabase per route and job, and how many calls.
 * Super admins only (the menu hides it from agents; the cloud refuses them). Cloud: routes/opsAdmin.ts.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { C, S } from "./theme";
import AdminPager, { usePageSize } from "./AdminPager";
import { pageCount, type Paged } from "./lib/paginate";
import { ago } from "./AlertsPage";

type Req = (method: string, path: string, body?: unknown) => Promise<any>;

type Kind = "boot" | "deploy_check" | "vuln_scan" | "backup" | "uptime";   // A589: backup, uptime
type Status = "ok" | "warn" | "fail";
interface OpsEvent {
  id: string; kind: Kind; status: Status; commit: string | null; title: string;
  details: Record<string, any>; source: string; created_at: string;
}
/** A528: what the server has answered since it started (routes/opsAdmin.ts summary, lib/trafficStats.ts). */
interface Traffic {
  started_at: string;
  routes: Array<{ family: string; requests: number; bytes: number }>;
  catalogue_version: { answered: number; from_memory: number; db_reads: number; fallback_computed: number; fallback_cached: number; hit_rate: number | null };
  branch_staff: { full: number; unchanged_from_memory: number; unchanged_after_read: number };
  auth_cache: { hits: number; misses: number; hit_rate: number | null };
  db_queries_polled: number;
  supabase?: SupabaseMeter;   // A591
}
/** A591: what the server pulled from Supabase in the last 24 h, by route and job (lib/supabaseMeter.ts). */
interface SupabaseMeter {
  started_at: string; window_hours: number; covered_hours: number; enabled: boolean;
  totals: { calls: number; bytes: number; wire: number };
  per_day: { calls: number; bytes: number; wire: number };
  rows: Array<{ label: string; calls: number; bytes: number; wire: number; api: number }>;
}
interface Summary {
  live: { commit: string | null; started_at: string };
  boot: OpsEvent | null; deploy_check: OpsEvent | null; vuln_scan: OpsEvent | null;
  backup?: OpsEvent | null; uptime?: OpsEvent | null;   // A589
  traffic?: Traffic;
}
interface Fix { name: string; version: string; isSemVerMajor: boolean }
interface Pkg {
  name: string; severity: string; isDirect: boolean; range: string | null; fixAvailable: Fix | boolean;
  advisories: Array<{ title: string | null; url: string | null; severity: string | null }>; through?: string[];
}
interface AppScan { error?: string; counts?: Record<string, number>; total?: number; packages?: Pkg[]; truncated?: boolean }

const KIND_LABEL: Record<Kind, string> = { boot: "Server start", deploy_check: "Deploy check", vuln_scan: "Dependency scan", backup: "Nightly backup", uptime: "Outage" };
const mb = (b: unknown) => (typeof b === "number" && Number.isFinite(b) ? `${(b / 1048576).toFixed(1)} MB` : "—");
const STATUS_COLOUR: Record<Status, string> = { ok: C.green, warn: "#f59e0b", fail: C.danger };
const SEV_COLOUR: Record<string, string> = { critical: C.danger, high: "#ff8a5c", moderate: "#f59e0b", low: C.muted, info: C.muted };
const SEVS = ["critical", "high", "moderate", "low"];
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" }) : "—");
const short = (c?: string | null) => (c ? c.slice(0, 12) : null);
const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 } as const;

function StatusBadge({ status }: { status: Status }) {
  const col = STATUS_COLOUR[status] ?? C.muted;
  return <span style={{ ...S.badge, color: col, background: "rgba(255,255,255,0.06)", border: `1px solid ${col}55`, textTransform: "uppercase" }}>{status}</span>;
}

function Line({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10, fontSize: 12, padding: "3px 0" }}>
      <span style={{ color: C.muted, width: 112, flexShrink: 0 }}>{k}</span>
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{v}</span>
    </div>
  );
}

function RunLink({ url }: { url?: unknown }) {
  if (typeof url !== "string" || !/^https:\/\//.test(url)) return null;
  return <a href={url} target="_blank" rel="noreferrer" style={{ color: C.accent, fontSize: 12 }}>Open the GitHub run →</a>;
}

function Counts({ counts }: { counts?: Record<string, number> }) {
  if (!counts) return null;
  return (
    <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
      {SEVS.map((s) => (
        <span key={s} style={{ fontVariantNumeric: "tabular-nums", color: (counts[s] ?? 0) > 0 ? SEV_COLOUR[s] : C.muted }}>
          {counts[s] ?? 0} {s}
        </span>
      ))}
    </span>
  );
}

/** A failed deploy check's "what to do", and the commits. */
function DeployDetails({ ev }: { ev: OpsEvent }) {
  const d = ev.details ?? {};
  return (
    <div>
      <Line k="Expected" v={<span style={mono}>{d.expected ?? short(ev.commit) ?? "—"}</span>} />
      <Line k="Running" v={<span style={mono}>{d.running ?? "unknown (no commit on /health)"}</span>} />
      {ev.status === "fail" && typeof d.what_to_do === "string" && (
        <div data-testid="what-to-do" style={{ marginTop: 8, padding: "10px 12px", borderRadius: 10, background: "rgba(255,92,108,0.08)", border: "1px solid rgba(255,92,108,0.25)", fontSize: 12, lineHeight: 1.5 }}>
          <b style={{ color: C.danger }}>What to do: </b>{d.what_to_do}
        </div>
      )}
      <div style={{ marginTop: 6 }}><RunLink url={d.run_url} /></div>
    </div>
  );
}

function fixText(f: Fix | boolean): ReactNode {
  if (f && typeof f === "object") {
    return <span>upgrade <span style={mono}>{f.name}@{f.version}</span>{f.isSemVerMajor && <b style={{ color: "#f59e0b" }}> — a major upgrade, test before release</b>}</span>;
  }
  return f ? <span>npm audit fix</span> : <span style={{ color: C.danger }}>no fix yet</span>;
}

/** A scan: per app, each vulnerable package — what it is, how bad, which versions, the fix, the advisories. */
function ScanDetails({ ev }: { ev: OpsEvent }) {
  const apps = (ev.details?.apps ?? {}) as Record<string, AppScan>;
  return (
    <div>
      {Object.entries(apps).map(([app, s]) => (
        <div key={app} style={{ marginTop: 10 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", fontSize: 12 }}>
            <b style={{ fontSize: 13 }}>{app}</b>
            {s.error ? <span style={{ color: C.danger }}>not scanned: {s.error}</span> : <Counts counts={s.counts} />}
          </div>
          {(s.packages ?? []).map((p) => (
            <div key={`${app}-${p.name}`} data-testid="vuln-package" style={{ padding: "8px 0 8px 12px", borderLeft: `2px solid ${SEV_COLOUR[p.severity] ?? C.border}`, margin: "6px 0" }}>
              <div style={{ fontSize: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
                <span style={{ ...mono, fontWeight: 600 }}>{p.name}</span>
                <span style={{ color: SEV_COLOUR[p.severity] ?? C.muted, textTransform: "uppercase", fontSize: 10, fontWeight: 700 }}>{p.severity}</span>
                {p.isDirect && <span style={{ color: C.muted, fontSize: 11 }}>direct dependency</span>}
                {p.range && <span style={{ color: C.muted, fontSize: 11 }}>affected: <span style={mono}>{p.range}</span></span>}
              </div>
              <div style={{ fontSize: 12, marginTop: 3 }}>Fix: {fixText(p.fixAvailable)}</div>
              {!!p.through?.length && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>through {p.through.join(", ")}</div>}
              {p.advisories.map((a, i) => (
                <div key={i} style={{ fontSize: 11, marginTop: 2 }}>
                  {a.url && /^https:\/\//.test(a.url)
                    ? <a href={a.url} target="_blank" rel="noreferrer" style={{ color: C.accent }}>{a.title ?? a.url}</a>
                    : <span style={{ color: C.muted }}>{a.title}</span>}
                </div>
              ))}
            </div>
          ))}
          {s.truncated && <div style={{ fontSize: 11, color: C.muted }}>… and more (the run on GitHub has the full report).</div>}
        </div>
      ))}
      <div style={{ marginTop: 8 }}><RunLink url={ev.details?.run_url} /></div>
    </div>
  );
}

const kb = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
const pct = (r: number | null) => (r === null ? "—" : `${r}%`);

/** A528: Render suspended production over bandwidth (2026-10-19) — the requests per route family and how often the polled
 *  answers (catalogue version, staff list, the sign-in check) came from memory instead of the database. */
function TrafficCard({ t }: { t?: Traffic }) {
  return (
    <div style={{ ...S.card, marginBottom: 0 }} data-testid="card-traffic">
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Traffic since start</div>
      {!t ? <div style={{ fontSize: 12, color: C.muted }}>Not reported by this server yet.</div> : (
        <>
          <Line k="Since" v={`${when(t.started_at)} · ${ago(t.started_at)}`} />
          {t.routes.slice(0, 6).map((r) => (
            <Line key={r.family} k={r.family} v={<span style={{ fontVariantNumeric: "tabular-nums" }}>{r.requests.toLocaleString()} · {kb(r.bytes)}</span>} />
          ))}
          <Line k="Catalogue check" v={`${pct(t.catalogue_version.hit_rate)} from memory · ${t.catalogue_version.answered.toLocaleString()} asked`} />
          <Line k="Staff list" v={`${(t.branch_staff.unchanged_from_memory).toLocaleString()} unchanged from memory · ${t.branch_staff.full.toLocaleString()} sent`} />
          <Line k="Sign-in check" v={`${pct(t.auth_cache.hit_rate)} from memory`} />
          <Line k="DB queries" v={<span style={{ fontVariantNumeric: "tabular-nums" }}>{t.db_queries_polled.toLocaleString()} (polled paths)</span>} />
        </>
      )}
    </div>
  );
}

/** A591 (owner, 2026-10-26: Supabase's Free plan 5 GB egress went over; projects restricted from 20 Nov): what this server
 *  pulled from Supabase in the last 24 h — by route (ids folded) and by job — so the biggest share is seen without the
 *  database. Calls are what fill Supabase's log quota; "a day" is the window scaled to 24 h (an estimate after a restart). */
function SupabaseCard({ m }: { m?: SupabaseMeter }) {
  const [all, setAll] = useState(false);
  return (
    <div style={{ ...S.card, marginBottom: 0 }} data-testid="card-supabase">
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Supabase pulled (24 h)</div>
      {!m ? <div style={{ fontSize: 12, color: C.muted }}>Not reported by this server yet.</div> : !m.enabled ? (
        <div style={{ fontSize: 12, color: C.muted }}>Counting is off on this server (SUPABASE_METER=off).</div>
      ) : (
        <>
          <Line k="Covers" v={`the last ${m.covered_hours} h · since ${ago(m.started_at)}`} />
          <Line k="So far" v={<span style={{ fontVariantNumeric: "tabular-nums" }}>{kb(m.totals.bytes)} · {m.totals.calls.toLocaleString()} calls</span>} />
          <Line k="A day at this rate" v={<span style={{ fontVariantNumeric: "tabular-nums" }} data-testid="supabase-per-day">{kb(m.per_day.bytes)} ({kb(m.per_day.wire)} sent compressed) · {m.per_day.calls.toLocaleString()} calls</span>} />
          {(all ? m.rows : m.rows.slice(0, 8)).map((r) => (
            <Line key={r.label} k={r.label} v={<span style={{ fontVariantNumeric: "tabular-nums" }}>{kb(r.bytes)} · {r.calls.toLocaleString()} calls · {r.api.toLocaleString()} {r.label.startsWith("job:") ? "runs" : "asked"}</span>} />
          ))}
          {m.rows.length > 8 && (
            <button onClick={() => setAll(!all)} style={{ ...S.btn, ...S.btnGhost, fontSize: 12, padding: "5px 10px", marginTop: 6 }}>
              {all ? "Fewer" : `All ${m.rows.length}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** A589: what the nightly backup recorded — size, how long, where it is, the check it passed. */
function BackupDetails({ ev }: { ev: OpsEvent }) {
  const d = ev.details ?? {};
  return (
    <div>
      {d.size_bytes != null && <Line k="Size" v={`${mb(d.size_bytes)} (encrypted)`} />}
      {d.seconds != null && <Line k="Took" v={`${d.seconds} s`} />}
      {d.object && <Line k="Stored as" v={<span style={mono}>{String(d.object)}</span>} />}
      {d.tables != null && <Line k="Checked" v={`${d.tables} tables readable (pg_restore --list)`} />}
      {d.error && <Line k="Error" v={<span style={{ color: C.danger }}>{String(d.error)}</span>} />}
      {d.run_url && <Line k="GitHub run" v={<a href={String(d.run_url)} target="_blank" rel="noreferrer" style={{ color: C.accent }}>open</a>} />}
    </div>
  );
}

function Details({ ev }: { ev: OpsEvent }) {
  if (ev.kind === "deploy_check") return <DeployDetails ev={ev} />;
  if (ev.kind === "vuln_scan") return <ScanDetails ev={ev} />;
  if (ev.kind === "backup") return <BackupDetails ev={ev} />;
  const d = ev.details ?? {};
  if (ev.kind === "uptime") return (
    <div>
      {d.down_since && <Line k="Down since" v={when(d.down_since)} />}
      {d.minutes != null && <Line k="Lasted" v={`about ${d.minutes} min`} />}
      {d.targets && <Line k="Checked" v={String(d.targets)} />}
      {d.run_url && <Line k="GitHub run" v={<a href={String(d.run_url)} target="_blank" rel="noreferrer" style={{ color: C.accent }}>open</a>} />}
    </div>
  );
  return (
    <div>
      <Line k="Commit" v={<span style={mono}>{ev.commit ?? "unknown"}</span>} />
      {d.node && <Line k="Node" v={String(d.node)} />}
      {d.env && <Line k="Environment" v={String(d.env)} />}
      {d.started_at && <Line k="Started" v={when(d.started_at)} />}
    </div>
  );
}

export default function SystemPage({ req }: { req: Req }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryError, setSummaryError] = useState("");
  const [kind, setKind] = useState<"" | Kind>("");
  const [page, setPage] = useState(1);
  const [size, setSize] = usePageSize("swiftpos.admin.pageSize.ops");
  const [list, setList] = useState<{ events: OpsEvent[]; total: number } | null>(null);
  const [listError, setListError] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const loadSummary = useCallback(() => {
    setSummaryError("");
    req("GET", "/ops/summary").then(setSummary).catch((e: any) => {
      if (e?.data?.live) setSummary({ live: e.data.live, boot: null, deploy_check: null, vuln_scan: null, traffic: e.data.traffic });
      setSummaryError(e?.message || "Couldn't load the summary.");
    });
  }, [req]);
  const loadList = useCallback(() => {
    setListError("");
    const q = new URLSearchParams({ page: String(page), size: String(size), ...(kind ? { kind } : {}) });
    req("GET", `/ops/events?${q}`).then((d) => setList({ events: d?.events ?? [], total: Number(d?.total ?? 0) }))
      .catch((e: any) => setListError(e?.message || "Couldn't load the events."));
  }, [req, page, size, kind]);
  useEffect(() => { loadSummary(); }, [loadSummary]);
  useEffect(() => { loadList(); }, [loadList]);

  const total = list?.total ?? 0;
  const items = list?.events ?? [];
  const from = items.length ? (page - 1) * size + 1 : 0;
  const paged: Paged<OpsEvent> = { items, page, pages: pageCount(total, size), size, total, from, to: from ? from + items.length - 1 : 0 };

  const live = summary?.live;
  const boot = summary?.boot;
  const dc = summary?.deploy_check;
  const scan = summary?.vuln_scan;
  const scanApps = (scan?.details?.apps ?? {}) as Record<string, AppScan>;
  const cardTitle = (t: string, status?: Status) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{t}</div>
      {status && <StatusBadge status={status} />}
    </div>
  );

  return (
    <div style={S.content}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>System</h1>
          <p style={{ fontSize: 13, color: C.muted, margin: "4px 0 0", maxWidth: 680, lineHeight: 1.5 }}>
            What the production server runs, whether the last deploy reached it, and what the dependencies carry. GitHub
            checks every push to main and scans the dependencies every morning; a failure is also e-mailed.
          </p>
        </div>
        <button onClick={() => { loadSummary(); loadList(); }} style={{ ...S.btn, ...S.btnGhost }}>Refresh</button>
      </div>
      {summaryError && <div style={{ fontSize: 13, color: C.danger, marginBottom: 12 }}>{summaryError}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, marginBottom: 16 }}>
        <div style={{ ...S.card, marginBottom: 0 }} data-testid="card-server">
          {cardTitle("Production server")}
          <Line k="Runs" v={<span style={mono}>{live?.commit ?? "unknown (RENDER_GIT_COMMIT not set)"}</span>} />
          <Line k="Started" v={live ? `${when(live.started_at)} · ${ago(live.started_at)}` : "—"} />
          <Line k="Last start" v={boot ? <>{when(boot.created_at)} · <span style={mono}>{short(boot.commit) ?? "?"}</span></> : "none recorded yet"} />
        </div>

        <div style={{ ...S.card, marginBottom: 0 }} data-testid="card-deploy">
          {cardTitle("Last deploy check", dc?.status)}
          {!dc ? <div style={{ fontSize: 12, color: C.muted }}>None yet — GitHub records one after each push to main (OPS_INGEST_TOKEN).</div> : (
            <>
              <div style={{ fontSize: 12, marginBottom: 4 }}>{dc.title}</div>
              <Line k="When" v={`${when(dc.created_at)} · ${ago(dc.created_at)}`} />
              <DeployDetails ev={dc} />
            </>
          )}
        </div>

        <div style={{ ...S.card, marginBottom: 0 }} data-testid="card-deps">
          {cardTitle("Dependencies", scan?.status)}
          {!scan ? <div style={{ fontSize: 12, color: C.muted }}>No scan yet — GitHub scans every morning at 08:00 (OPS_INGEST_TOKEN).</div> : (
            <>
              <div style={{ fontSize: 12, marginBottom: 4 }}>{scan.title}</div>
              {Object.entries(scanApps).map(([app, s]) => (
                <Line key={app} k={app} v={s.error ? <span style={{ color: C.danger }}>not scanned</span> : <Counts counts={s.counts} />} />
              ))}
              <Line k="When" v={`${when(scan.created_at)} · ${ago(scan.created_at)}`} />
              <button onClick={() => { setKind("vuln_scan"); setPage(1); setOpen(scan.id); }} style={{ ...S.btn, ...S.btnGhost, fontSize: 12, padding: "5px 10px", marginTop: 6 }}>
                What needs fixing →
              </button>
            </>
          )}
        </div>

        <div style={{ ...S.card, marginBottom: 0 }} data-testid="card-backup">
          {cardTitle("Last nightly backup", summary?.backup?.status)}
          {!summary?.backup ? <div style={{ fontSize: 12, color: C.muted }}>None recorded yet — GitHub backs the database up every night at 00:00 Nairobi (docs/BACKUPS.md: the secrets, then OPS_INGEST_TOKEN to record it here).</div> : (
            <>
              <div style={{ fontSize: 12, marginBottom: 4 }}>{summary.backup.title}</div>
              <Line k="When" v={`${when(summary.backup.created_at)} · ${ago(summary.backup.created_at)}`} />
              <BackupDetails ev={summary.backup} />
            </>
          )}
          {summary?.uptime && <Line k="Last outage" v={`${summary.uptime.title} · ${ago(summary.uptime.created_at)}`} />}
        </div>

        <TrafficCard t={summary?.traffic} />
        <SupabaseCard m={summary?.traffic?.supabase} />
      </div>

      <div style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>History</div>
          <div className="sp-tab-bar" style={{ marginBottom: 0 }}>
            {([["", "All"], ["deploy_check", "Deploy checks"], ["vuln_scan", "Dependency scans"], ["backup", "Backups"], ["uptime", "Outages"], ["boot", "Server starts"]] as const).map(([k, l]) => (
              <button key={k || "all"} data-testid={`ops-filter-${k || "all"}`} onClick={() => { setKind(k); setPage(1); }}
                style={{ ...S.tab, ...(kind === k ? S.tabActive : {}) }}>{l}</button>
            ))}
          </div>
        </div>
        {listError && <div style={{ fontSize: 13, color: C.danger, marginTop: 10 }}>{listError}</div>}
        {!list && !listError && <div style={{ color: C.muted, fontSize: 13, marginTop: 10 }}>Loading…</div>}
        {list && !items.length && <div style={{ color: C.muted, fontSize: 13, marginTop: 10 }}>Nothing recorded yet.</div>}
        {items.map((ev) => (
          <div key={ev.id} data-testid="ops-event" style={{ borderTop: `1px solid ${C.border}`, padding: "10px 0" }}>
            <button onClick={() => setOpen(open === ev.id ? null : ev.id)} aria-expanded={open === ev.id}
              style={{ display: "flex", gap: 12, alignItems: "center", width: "100%", background: "transparent", border: "none", color: C.text, cursor: "pointer", textAlign: "left", fontFamily: "inherit", padding: 0 }}>
              <StatusBadge status={ev.status} />
              <span style={{ fontSize: 11, color: C.muted, width: 110, flexShrink: 0 }}>{KIND_LABEL[ev.kind] ?? ev.kind}</span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{ev.title}</span>
              <span style={{ fontSize: 11, color: C.muted, whiteSpace: "nowrap" }} title={when(ev.created_at)}>{ago(ev.created_at)}</span>
              <span style={{ color: C.muted, fontSize: 11 }}>{open === ev.id ? "▲" : "▼"}</span>
            </button>
            {open === ev.id && (
              <div style={{ padding: "8px 0 4px 4px" }}>
                <Line k="When" v={when(ev.created_at)} />
                <Line k="From" v={ev.source} />
                {ev.commit && ev.kind !== "boot" && <Line k="Commit" v={<span style={mono}>{ev.commit}</span>} />}
                <Details ev={ev} />
              </div>
            )}
          </div>
        ))}
        <AdminPager paged={paged} onPage={setPage} onSize={(n) => { setSize(n); setPage(1); }} />
      </div>
    </div>
  );
}
