/**
 * MigrationsPage — read-only "database migrations" panel for the admin portal.
 * A sketch: drop into apps/admin/src (or fold into AdminPortal.tsx as a page)
 * and pass the existing `req` helper. It renders with mock data if `req` is
 * omitted, so you can eyeball it before wiring the backend.
 *
 * ── BACKEND IT EXPECTS ───────────────────────────────────────────────────────
 * One route, mounted under the admin router so it inherits admin auth. It reads
 * the two meta tables with the service-role client (bypasses RLS):
 *
 *   // apps/server/src/routes/admin/migrations.ts   → GET /api/admin/migrations
 *   router.get('/', async (_req, res) => {
 *     const { data: runs } = await supabase
 *       .from('schema_migration_runs')
 *       .select('*')
 *       .order('started_at', { ascending: false })
 *       .limit(25);
 *     const { data: rows } = await supabase
 *       .from('schema_migrations')
 *       .select('version');
 *     const numeric = (rows ?? [])
 *       .map(r => r.version)
 *       .filter(v => /^\d+_/.test(v));
 *     const current = numeric
 *       .sort((a, b) => parseInt(a) - parseInt(b))
 *       .at(-1) ?? null;
 *     res.json({ current_version: current, total_applied: numeric.length, runs: runs ?? [] });
 *   });
 *
 * Remember to add schema_migration_runs to scripts/schema-index.json
 * (node scripts/build-schema-index.mjs --from-db …) so schema-audit is happy.
 */
import { useState, useEffect } from "react";

type RunStatus = "success" | "failed" | "running" | "noop";
interface MigrationRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  environment: string | null;
  git_sha: string | null;
  triggered_by: string | null;
  planned: number;
  applied: number;
  applied_versions: string[];
  failed_version: string | null;
  error: string | null;
}
interface MigrationStatus {
  current_version: string | null;
  total_applied: number;
  runs: MigrationRun[];
}

// ── small local helpers (mirrors AdminPortal's timeAgo/fmtDate) ───────────────
function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function duration(a: string, b: string | null): string {
  if (!b) return "…";
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const STATUS: Record<RunStatus, { bg: string; fg: string; label: string }> = {
  success: { bg: "#ecfdf3", fg: "#067647", label: "Success" },
  failed:  { bg: "#fef3f2", fg: "#b42318", label: "Failed" },
  running: { bg: "#eff8ff", fg: "#175cd3", label: "Running" },
  noop:    { bg: "#f2f4f7", fg: "#475467", label: "Up to date" },
};

const S: Record<string, React.CSSProperties> = {
  wrap:   { padding: "24px 28px", maxWidth: 960, margin: "0 auto" },
  h1:     { fontSize: 22, fontWeight: 800, margin: "0 0 2px", color: "#101828" },
  sub:    { color: "#667085", fontSize: 14, margin: "0 0 22px" },
  tiles:  { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 14, marginBottom: 26 },
  tile:   { border: "1px solid #eaecf0", borderRadius: 12, padding: "16px 18px", background: "#fff" },
  tk:     { fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", color: "#98a2b3", fontWeight: 700 },
  tv:     { fontSize: 22, fontWeight: 800, color: "#101828", marginTop: 6, fontFamily: "ui-monospace,Menlo,monospace" },
  card:   { border: "1px solid #eaecf0", borderRadius: 12, overflow: "hidden", background: "#fff" },
  th:     { textAlign: "left", fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase", color: "#98a2b3", fontWeight: 700, padding: "11px 14px", borderBottom: "1px solid #eaecf0", background: "#fcfcfd" },
  td:     { padding: "12px 14px", borderBottom: "1px solid #f2f4f7", fontSize: 13.5, color: "#344054", verticalAlign: "top" },
  badge:  { display: "inline-block", padding: "2px 9px", borderRadius: 999, fontSize: 12, fontWeight: 700 },
  mono:   { fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12.5 },
  err:    { marginTop: 6, fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, color: "#b42318", whiteSpace: "pre-wrap", background: "#fef3f2", border: "1px solid #fecdca", borderRadius: 6, padding: "6px 8px" },
};

function Badge({ status }: { status: RunStatus }) {
  const s = STATUS[status] ?? STATUS.noop;
  return <span style={{ ...S.badge, background: s.bg, color: s.fg }}>{s.label}</span>;
}

const MOCK: MigrationStatus = {
  current_version: "78_receipt_manage_grant",
  total_applied: 71,
  runs: [
    { id: "1", started_at: new Date(Date.now() - 3.6e6).toISOString(), finished_at: new Date(Date.now() - 3.6e6 + 4200).toISOString(),
      status: "success", environment: "production", git_sha: "a1b2c3d4", triggered_by: "oweyahillary",
      planned: 1, applied: 1, applied_versions: ["78_receipt_manage_grant"], failed_version: null, error: null },
    { id: "2", started_at: new Date(Date.now() - 8.7e7).toISOString(), finished_at: new Date(Date.now() - 8.7e7 + 900).toISOString(),
      status: "noop", environment: "production", git_sha: "9f8e7d6c", triggered_by: "oweyahillary",
      planned: 0, applied: 0, applied_versions: [], failed_version: null, error: null },
    { id: "3", started_at: new Date(Date.now() - 1.7e8).toISOString(), finished_at: new Date(Date.now() - 1.7e8 + 2100).toISOString(),
      status: "failed", environment: "production", git_sha: "55aa22bb", triggered_by: "ci",
      planned: 2, applied: 1, applied_versions: ["76_role_name_grant_backfill"], failed_version: "77_increment_customer_spend",
      error: 'ERROR: function "increment_customer_spend" already exists with same argument types' },
  ],
};

export default function MigrationsPage({ req }: { req?: (path: string) => Promise<any> }) {
  const [data, setData] = useState<MigrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const d = req ? await req("/migrations") : MOCK;
        if (live) setData(d);
      } catch (e: any) {
        if (live) setError(e?.message || "Failed to load migration status");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [req]);

  if (loading) return <div style={S.wrap}><p style={{ color: "#667085" }}>Loading migration status…</p></div>;
  if (error)   return <div style={S.wrap}><div style={S.err}>{error}</div></div>;
  if (!data)   return null;

  const last = data.runs[0];

  return (
    <div style={S.wrap}>
      <h1 style={S.h1}>Database migrations</h1>
      <p style={S.sub}>Read-only. Schema version and recent runs of the migration pipeline.</p>

      <div style={S.tiles}>
        <div style={S.tile}>
          <div style={S.tk}>Current version</div>
          <div style={{ ...S.tv, fontSize: 15 }}>{data.current_version ?? "—"}</div>
        </div>
        <div style={S.tile}>
          <div style={S.tk}>Migrations applied</div>
          <div style={S.tv}>{data.total_applied}</div>
        </div>
        <div style={S.tile}>
          <div style={S.tk}>Last run</div>
          <div style={{ marginTop: 8 }}>{last ? <Badge status={last.status} /> : "—"}</div>
          <div style={{ fontSize: 12, color: "#98a2b3", marginTop: 6 }}>{last ? timeAgo(last.started_at) : ""}</div>
        </div>
        <div style={S.tile}>
          <div style={S.tk}>Environment</div>
          <div style={{ ...S.tv, fontSize: 15 }}>{last?.environment ?? "—"}</div>
        </div>
      </div>

      <div style={S.card}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={S.th}>Status</th>
              <th style={S.th}>Env</th>
              <th style={S.th}>Applied</th>
              <th style={S.th}>Commit</th>
              <th style={S.th}>By</th>
              <th style={S.th}>When</th>
              <th style={S.th}>Took</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.map((r) => (
              <tr key={r.id}>
                <td style={S.td}><Badge status={r.status} /></td>
                <td style={S.td}>{r.environment ?? "—"}</td>
                <td style={S.td}>
                  {r.applied}{r.planned !== r.applied ? ` / ${r.planned}` : ""}
                  {r.applied_versions.length > 0 && (
                    <div style={{ ...S.mono, color: "#667085", marginTop: 3 }}>
                      {r.applied_versions.slice(0, 2).join(", ")}
                      {r.applied_versions.length > 2 ? ` +${r.applied_versions.length - 2}` : ""}
                    </div>
                  )}
                  {r.status === "failed" && r.error && (
                    <div style={S.err}>
                      {r.failed_version ? `${r.failed_version}\n` : ""}{r.error}
                    </div>
                  )}
                </td>
                <td style={{ ...S.td, ...S.mono }}>{r.git_sha ? r.git_sha.slice(0, 8) : "—"}</td>
                <td style={S.td}>{r.triggered_by ?? "—"}</td>
                <td style={S.td}>{timeAgo(r.started_at)}</td>
                <td style={{ ...S.td, ...S.mono, color: "#667085" }}>{duration(r.started_at, r.finished_at)}</td>
              </tr>
            ))}
            {data.runs.length === 0 && (
              <tr><td style={{ ...S.td, color: "#98a2b3" }} colSpan={7}>No migration runs recorded yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
