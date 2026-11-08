/**
 * AndroidAppCard — "ZapTill for Android" on a client's Updates tab (docs/ANDROID-APP-DESIGN.md, Stage 0).
 *
 * The desktop's Desktop updates card (A348) and Download ZapTill (A570), for the Android app's two surfaces:
 *   - Shop POS (a shop tablet that sells) and Owner / manager phone, each approved or held on its own. Nothing is
 *     approved by default; only a super admin approves (A495), and every change is in the audit log.
 *   - Download: the APK's short-lived link and its SHA-256, for installing a new device (any admin: the newest release
 *     or one approved for this client; a super admin any).
 * The cloud: apps/server/src/routes/adminAndroid.ts. The words: androidVersions.ts.
 */
import { useEffect, useState } from "react";
import { ANDROID_SURFACES, ANDROID_SURFACE_LABELS, type AndroidSurface } from "@zaptill/core/androidApp";
import { C, S } from "./theme";
import { mb } from "./installerOffer";
import { approvable, releaseOption, surfaceLine, type AndroidReleaseView } from "./androidVersions";

type Req = (method: string, path: string, body?: unknown) => Promise<any>;

interface Answer {
  releases: AndroidReleaseView[];
  latest: string | null;
  warning: string | null;
  approvals: Record<AndroidSurface, string | null> | null;
  approvalsMissing: boolean;
}
interface Link { url: string; fileName: string; sha256: string; size: number | null }

export default function AndroidAppCard({ req, clientId, clientName, isSuper, askConfirm }: {
  req: Req; clientId: string; clientName: string; isSuper: boolean; askConfirm: (message: string) => Promise<unknown>;
}) {
  const [data, setData] = useState<Answer | null>(null);
  const [error, setError] = useState("");
  const [pick, setPick] = useState<Record<AndroidSurface, string>>({ "android-till": "", mobile: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [link, setLink] = useState<Link | null>(null);

  const load = (fresh = false) => {
    setError("");
    req("GET", `/android/releases?client=${encodeURIComponent(clientId)}${fresh ? "&fresh=1" : ""}`)
      .then(setData).catch((e) => setError(e?.message ?? "Could not read the Android releases."));
  };
  useEffect(() => { setData(null); setLink(null); load(); }, [clientId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const setVersion = async (surface: AndroidSurface, version: string | null) => {
    const who = ANDROID_SURFACE_LABELS[surface];
    const msg = version
      ? `Approve ZapTill for Android ${version} for ${clientName}'s ${who} devices? Each one offers the update; a Shop POS installs it between shifts.`
      : `Hold ZapTill for Android for ${clientName}'s ${who} devices? They stay on the version they run now.`;
    if (!(await askConfirm(msg))) return;
    setBusy(surface); setError("");
    try {
      const r = await req("PATCH", `/android/clients/${clientId}/version`, { surface, version });
      setData((d) => d ? { ...d, approvals: r.approvals } : d);
      setPick((p) => ({ ...p, [surface]: "" }));
    } catch (e: any) { setError(e?.message ?? "Could not save."); }
    finally { setBusy(null); }
  };

  const download = async (version: string) => {
    setBusy(`dl:${version}`); setError(""); setLink(null);
    try { setLink(await req("POST", `/android/releases/${version}/link`, { client: clientId })); }
    catch (e: any) { setError(e?.message ?? "Could not get the download link."); }
    finally { setBusy(null); }
  };

  const approvals = data?.approvals ?? { "android-till": null, mobile: null };
  const choosable = (data?.releases ?? []).filter(approvable);
  // The version to download for a new device: the one approved for its Shop POS, else the owner's phone, else the newest.
  const toDownload = approvals["android-till"] ?? approvals.mobile ?? data?.latest ?? null;

  return (
    <div style={S.card} data-testid="android-app">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>ZapTill for Android</div>
        <button type="button" onClick={() => load(true)} style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "4px 8px" }}>Refresh</button>
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginTop: 4, lineHeight: 1.5 }}>
        The Android app (a direct APK, not the Play Store). Each mode is approved on its own; nothing updates until it is approved here.
      </div>
      {error && <div style={{ fontSize: 12, color: C.danger, marginTop: 8 }}>{error}</div>}
      {data?.warning && <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>{data.warning}</div>}
      {data?.approvalsMissing && <div style={{ fontSize: 12, color: "#f59e0b", marginTop: 8 }}>Approvals are not set up on this cloud yet (migration 189).</div>}
      {data === null && !error && <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>Loading…</div>}

      {data && ANDROID_SURFACES.map((surface) => (
        <div key={surface} data-testid={`android-${surface}`} style={{ padding: "10px 0", borderTop: `1px solid ${C.border}`, marginTop: 10 }}>
          <div style={{ fontSize: 12, lineHeight: 1.5 }}>{surfaceLine(surface, approvals[surface], data.latest)}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
            <select value={pick[surface]} disabled={!!busy || !isSuper} onChange={(e) => setPick((p) => ({ ...p, [surface]: e.target.value }))}
              style={{ ...S.input, width: "auto" }}>
              <option value="">{data.releases.length ? "Choose a version…" : "No release yet"}</option>
              {data.releases.map((r) => <option key={r.version} value={r.version} disabled={!approvable(r)}>{releaseOption(r)}</option>)}
            </select>
            {!isSuper && <span style={{ fontSize: 11, color: C.muted }}>Only a super admin approves or holds a version.</span>}
            {isSuper && <button disabled={!!busy || !pick[surface]} onClick={() => setVersion(surface, pick[surface])}
              style={{ ...S.btn, ...S.btnPrimary, fontSize: 12, opacity: (busy || !pick[surface]) ? 0.4 : 1 }}>
              {busy === surface ? "Saving…" : "Approve"}
            </button>}
            {isSuper && approvals[surface] && (
              <button disabled={!!busy} onClick={() => setVersion(surface, null)} style={{ ...S.btn, ...S.btnGhost, fontSize: 12, opacity: busy ? 0.4 : 1 }}>Hold</button>
            )}
          </div>
        </div>
      ))}

      {data && (
        <div style={{ paddingTop: 10, borderTop: `1px solid ${C.border}`, marginTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>Install on a new device</div>
          {!toDownload || !choosable.some((r) => r.version === toDownload)
            ? <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>No release to download yet.</div>
            : (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
                <span style={{ fontSize: 12, flex: 1, minWidth: 200 }}>ZapTill for Android {toDownload}</span>
                <button disabled={!!busy} onClick={() => download(toDownload)} style={{ ...S.btn, ...S.btnPrimary, fontSize: 12, opacity: busy ? 0.5 : 1 }}>
                  {busy === `dl:${toDownload}` ? "Getting the link…" : "Get download link"}
                </button>
              </div>
            )}
          {link && (
            <div data-testid="android-link" style={{ fontSize: 11, color: C.muted, marginTop: 8, lineHeight: 1.6, wordBreak: "break-all" }}>
              <a href={link.url} rel="noopener" style={{ color: C.text, fontWeight: 600 }}>Download {link.fileName}</a> · {mb(link.size)} · the link works for a few minutes.
              <div>SHA-256: <code style={{ fontFamily: "monospace" }}>{link.sha256}</code></div>
              <div>Check on a PC before copying it to the device: <code style={{ fontFamily: "monospace" }}>Get-FileHash .\{link.fileName} -Algorithm SHA256</code></div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
