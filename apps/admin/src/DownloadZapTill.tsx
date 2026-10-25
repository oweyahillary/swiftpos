/**
 * DownloadZapTill — A570 (2026-10-22): download the ZapTill installer from the admin portal, through our own server.
 *
 * Owner: "yes this is something i have wanted since in future we will get a vps which will hold our apps and move away
 * from github and make the repo private".
 *
 * Shown on a client's Desktop updates tab (the version APPROVED for that client first) and as its own page in the menu
 * (no client: the latest release). A super admin also gets a picker of every downloadable version. The cloud streams the
 * file from its source (GitHub releases today, our own server later — apps/server/src/lib/installerSource.ts); the
 * browser never sees the source or a token. "Download" asks the cloud for a one-use link valid 2 minutes, so the
 * browser saves the file itself (its own progress, straight to disk). Every download is in the audit log.
 * Beside the button: the file's size and checksums when the release has them, for the technician to check the file.
 */
import { useEffect, useState } from "react";
import { C, S } from "./theme";
import { offeredVersions, mb } from "./installerOffer";

type Req = (method: string, path: string, body?: unknown) => Promise<any>;

interface Offer { source: "vps" | "github" | null; problem: string | null; warning: string | null; latest: string | null; approved: string | null; versions: string[]; can_pick: boolean }
interface Info { version: string; fileName: string; source: string; size: number | null; sha256: string | null; sha512: string | null }

export default function DownloadZapTill({ req, apiUrl, clientId = null }: { req: Req; apiUrl: string; clientId?: string | null }) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [error, setError] = useState("");
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [info, setInfo] = useState<Record<string, Info | { error: string }>>({});

  useEffect(() => {
    setOffer(null); setError("");
    req("GET", `/desktop/installer${clientId ? `?client=${encodeURIComponent(clientId)}` : ""}`)
      .then(setOffer).catch((e) => setError(e?.message ?? "Could not read the releases."));
  }, [clientId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const showInfo = async (version: string) => {
    if (info[version]) return;
    try { const d = await req("GET", `/desktop/installer/${version}/info`); setInfo((m) => ({ ...m, [version]: d })); }
    catch (e: any) { setInfo((m) => ({ ...m, [version]: { error: e?.message ?? "No details" } })); }
  };
  useEffect(() => { for (const v of offeredVersions(offer)) void showInfo(v.version); }, [offer]);   // eslint-disable-line react-hooks/exhaustive-deps

  const download = async (version: string) => {
    setBusy(version); setError("");
    try {
      const t = await req("POST", `/desktop/installer/${version}/ticket`, clientId ? { client: clientId } : {});
      // The browser fetches the file itself (a plain link) — streamed to disk with its own progress bar.
      const a = document.createElement("a");
      a.href = `${apiUrl.replace(/\/+$/, "")}${t.url}`;
      a.rel = "noopener";
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e: any) { setError(e?.message ?? "Could not start the download."); }
    finally { setBusy(null); }
  };

  const row = (version: string, label: string) => {
    const i = info[version];
    return (
      <div key={version} data-testid="installer-row" style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 0", borderTop: `1px solid ${C.border}`, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>ZapTill {version} <span style={{ fontWeight: 400, color: C.muted }}>· {label}</span></div>
          {i && "error" in i && <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>{i.error}</div>}
          {i && !("error" in i) && (
            <div style={{ fontSize: 11, color: C.muted, marginTop: 3, lineHeight: 1.5, wordBreak: "break-all" }}>
              {i.fileName} · {mb(i.size)}
              {i.sha256 && <div>SHA-256: <code style={{ fontFamily: "monospace" }}>{i.sha256}</code></div>}
              {i.sha512 && <div>SHA-512: <code style={{ fontFamily: "monospace" }}>{i.sha512}</code></div>}
              {(i.sha256 || i.sha512) && <div>Check on the PC: <code style={{ fontFamily: "monospace" }}>Get-FileHash .\{i.fileName} -Algorithm {i.sha256 ? "SHA256" : "SHA512"}</code></div>}
            </div>
          )}
        </div>
        <button disabled={!!busy} onClick={() => download(version)} style={{ ...S.btn, ...S.btnPrimary, fontSize: 12, opacity: busy ? 0.5 : 1 }}>
          {busy === version ? "Starting…" : "Download"}
        </button>
      </div>
    );
  };

  const offered = offeredVersions(offer);
  return (
    <div style={S.card} data-testid="download-zaptill">
      <div style={{ fontSize: 13, fontWeight: 600 }}>Download ZapTill</div>
      <div style={{ fontSize: 12, color: C.muted, marginTop: 4, lineHeight: 1.5 }}>
        The Windows installer for a new POS, through the ZapTill cloud. Every download is recorded in the audit log.
      </div>
      {error && <div style={{ fontSize: 12, color: C.danger, marginTop: 8 }}>{error}</div>}
      {offer?.problem && <div style={{ fontSize: 12, color: "#f59e0b", marginTop: 8 }}>{offer.problem}</div>}
      {offer?.warning && <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>{offer.warning}</div>}
      {offer === null && !error && <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>Loading…</div>}
      {offer && !offer.problem && (
        <div style={{ marginTop: 10 }}>
          {offered.length === 0 && <div style={{ fontSize: 12, color: C.muted }}>No release to download yet.</div>}
          {offered.map((o) => row(o.version, o.label))}
          {offer.can_pick && offer.versions.length > 0 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
              <span style={{ fontSize: 12, color: C.muted }}>Another version:</span>
              <select value={pick} onChange={(e) => { setPick(e.target.value); if (e.target.value) void showInfo(e.target.value); }} style={{ ...S.input, width: "auto" }}>
                <option value="">Choose…</option>
                {offer.versions.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
          )}
          {pick && !offered.some((o) => o.version === pick) && row(pick, "Picked by a super admin")}
        </div>
      )}
    </div>
  );
}
