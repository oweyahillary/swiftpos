/**
 * SignInCodeCard — A391: my sign-in code, on My account. Every admin enters one at sign-in (mandatory).
 *
 * Owner, 2026-10-04: "OTP enabling both admin portal and dashboard" — by email or an authenticator app, "Both, user
 * picks". Email is the default (nothing to set up). An authenticator app is set up here: scan the QR code, type the code
 * it shows. Switching method makes every remembered browser ask for a code again.
 */
import { useState, useEffect } from "react";
import { C, S } from "./theme";

type Req = (method: string, path: string, body?: unknown) => Promise<any>;

export default function SignInCodeCard({ req }: { req: Req }) {
  const [info, setInfo] = useState<{ method: "email" | "totp"; email: string } | null>(null);
  const [setup, setSetup] = useState<{ qr_svg: string; secret: string; uri: string; setup_token: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const load = () => req("GET", "/auth/otp").then(setInfo).catch((e) => setError(e?.message || "Couldn't load."));
  useEffect(() => { load(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setBusy(true); setError(""); setDone(""); setCode("");
    try { setSetup(await req("POST", "/auth/otp/totp/start")); }
    catch (e: any) { setError(e?.message || "Could not start."); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    setBusy(true); setError("");
    try {
      await req("POST", "/auth/otp/totp/confirm", { setup_token: setup!.setup_token, code });
      setSetup(null); setCode(""); setDone("Authenticator app is on. Use its code next time you sign in."); await load();
    } catch (e: any) { setError(e?.message || "That code is not right."); }
    finally { setBusy(false); }
  };
  const useEmail = async () => {
    if (!window.confirm("Use emailed codes instead of your authenticator app?")) return;
    setBusy(true); setError("");
    try { await req("POST", "/auth/otp/email"); setDone("You will get your sign-in code by email."); await load(); }
    catch (e: any) { setError(e?.message || "Could not save."); }
    finally { setBusy(false); }
  };

  return (
    <div style={S.card} data-testid="signin-code-card">
      <div style={{ fontSize: 13, fontWeight: 600 }}>Sign-in code</div>
      <p style={{ fontSize: 12, color: C.muted, margin: "4px 0 14px", lineHeight: 1.5 }}>
        Every sign-in asks for a 6-digit code as well as your password.
      </p>
      {info && (
        <div style={{ display: "grid", gap: 8, marginBottom: 14 }}>
          {([
            ["email", "Email", `A code is emailed to ${info.email} each time you sign in.`],
            ["totp", "Authenticator app", "Google or Microsoft Authenticator on your phone — works even when email is slow."],
          ] as const).map(([k, title, text]) => (
            <div key={k} style={{ display: "flex", gap: 10, padding: "10px 12px", borderRadius: 10,
              border: `1px solid ${info.method === k ? C.accent : C.border}`, background: info.method === k ? "rgba(56,225,255,0.06)" : "transparent" }}>
              <span style={{ width: 14, height: 14, borderRadius: 7, marginTop: 2, flexShrink: 0, border: `2px solid ${info.method === k ? C.accent : C.muted}`,
                background: info.method === k ? C.accent : "transparent" }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{title}{info.method === k ? " — in use" : ""}</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{text}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {setup ? (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div style={{ width: 170, borderRadius: 10, overflow: "hidden", flexShrink: 0 }} data-testid="otp-qr"
            dangerouslySetInnerHTML={{ __html: setup.qr_svg }} />
          <div style={{ flex: 1, minWidth: 220, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.6 }}>
              1. In the authenticator app tap <b style={{ color: C.text }}>+</b> and scan this code.<br />
              Can't scan? Enter this key: <code style={{ color: C.text, wordBreak: "break-all" }}>{setup.secret}</code><br />
              2. Type the 6-digit code the app shows for ZapTill.
            </div>
            <input style={{ ...S.input, fontSize: 18, letterSpacing: 6, maxWidth: 180 }} inputMode="numeric" autoComplete="one-time-code"
              maxLength={7} value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, ""))} placeholder="123456" />
            <div style={{ display: "flex", gap: 8 }}>
              <button disabled={busy || code.length !== 6} onClick={confirm} style={{ ...S.btn, ...S.btnPrimary, opacity: busy || code.length !== 6 ? 0.5 : 1 }}>
                {busy ? "Checking…" : "Turn on"}
              </button>
              <button disabled={busy} onClick={() => { setSetup(null); setError(""); }} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
            </div>
          </div>
        </div>
      ) : info && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button disabled={busy} onClick={start} style={{ ...S.btn, ...(info.method === "totp" ? S.btnGhost : S.btnPrimary) }}>
            {info.method === "totp" ? "Set up a new phone" : "Use an authenticator app"}
          </button>
          {info.method === "totp" && <button disabled={busy} onClick={useEmail} style={{ ...S.btn, ...S.btnGhost }}>Use email instead</button>}
        </div>
      )}
      {done && <div style={{ fontSize: 12, color: "#34e5a0", marginTop: 10 }}>{done}</div>}
      {error && <div style={{ fontSize: 12, color: C.danger, marginTop: 10 }}>{error}</div>}
    </div>
  );
}
