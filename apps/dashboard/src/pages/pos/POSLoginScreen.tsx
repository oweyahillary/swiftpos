/**
 * POSLoginScreen — Unified POS entry point
 *
 * One URL for everyone: owner, manager, cashier.
 * After login the server returns role + permissions.
 * resolveRoute() decides where to send them — one consistent decision tree.
 */

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePOSAuth } from '../../context/POSAuthContext';
import { useBusiness } from '../../context/BusinessContext';
import { resolveRoute } from '../../lib/posRouting';

import { API_URL } from '../../lib/config';
import { getDeviceHint } from '../../lib/deviceFingerprint';
const BASE_URL = API_URL;
const PIN_MIN = 4;
const PIN_MAX = 6;

interface Branch { id: string; name: string; licensed: boolean; }
type Step = 'login' | 'branch';

export default function POSLoginScreen() {
  const navigate = useNavigate();
  const { setCashierSession, session } = usePOSAuth();
  const { business } = useBusiness();

  const [step, setStep]               = useState<Step>('login');
  const [email, setEmail]             = useState('');
  const [pin, setPin]                 = useState('');
  const [error, setError]             = useState('');
  const [loading, setLoading]         = useState(false);
  const [shake, setShake]             = useState(false);
  const [successName, setSuccessName] = useState('');
  const [branches, setBranches]       = useState<Branch[]>([]);
  const [pendingData, setPendingData] = useState<any>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  // ── If already logged in, route immediately based on role ─────────────────
  useEffect(() => {
    if (!session) return;
    const dest = resolveRoute(session.permissions, session.role);
    if (dest === '/') {
      // Owner needs Supabase — clear POS session and go to dashboard login
      // Don't clearCashierSession here; they may want POS later
      navigate('/', { replace: true });
    } else {
      navigate(dest, { replace: true });
    }
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-submit at PIN_MIN digits when email is filled ───────────────────
  useEffect(() => {
    if (pin.length === PIN_MIN && email.trim()) {
      handleLogin(email, pin);
    }
  }, [pin]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Core login ────────────────────────────────────────────────────────────
  async function handleLogin(emailVal: string, pinVal: string) {
    if (!emailVal.trim() || !pinVal) return;
    setLoading(true); setError('');

    try {
      const res = await fetch(`${BASE_URL}/api/auth/pos-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email:       emailVal.trim().toLowerCase(),
          pin:         pinVal,
          surface:     'web',
          device_hint: await getDeviceHint(),
        }),
      });
      const data = await res.json();

      if (!res.ok) { triggerError(data.error ?? 'Login failed'); return; }

      // Store tokens for api.ts (business data fetch etc.)
      localStorage.setItem('swiftpos_pos_token', data.accessToken ?? data.token);
      if (data.refreshToken) localStorage.setItem('swiftpos_pos_refresh_token', data.refreshToken);

      setSuccessName(data.staff.name);

      if (data.needsBranchSelection) {
        // Multiple branches — show picker
        setPendingData(data);
        setBranches(data.branches ?? []);
        setTimeout(() => setStep('branch'), 500);
      } else {
        // Single branch auto-resolved — open immediately
        const branchId   = data.branchId;
        const branchName = data.branches?.find((b: Branch) => b.id === branchId)?.name
          ?? data.branches?.[0]?.name ?? '';
        setTimeout(() => finishLogin(data, branchId, branchName), 600);
      }
    } catch {
      triggerError('Network error — please try again.');
    } finally {
      setLoading(false);
    }
  }

  // ── After branch is known — set session and navigate ─────────────────────
  function finishLogin(data: any, branchId: string, branchName: string) {
    const dest = resolveRoute(data.permissions, data.staff.role);

    // Owner goes to full dashboard — no POS session needed
    if (dest === '/') {
      navigate('/');
      return;
    }

    // Manager or cashier — set POS session then navigate
    setCashierSession({
      token:        data.accessToken ?? data.token,
      refreshToken: data.refreshToken ?? '',
      staffId:      data.staff.id,
      staffName:    data.staff.name,
      role:         data.staff.role,
      branchId:     branchId ?? '',
      branchName:   branchName ?? '',
      businessType: (business?.type as any) ?? 'retail',
      currency:     business?.currency ?? 'KES',
      permissions:  data.permissions,
    });

    navigate(dest, { replace: true });
  }

  // ── Branch selection (multi-branch users) ─────────────────────────────────
  async function selectBranch(branch: Branch) {
    if (!branch.licensed) {
      setError(`${branch.name} doesn't have a desktop licence.`);
      return;
    }
    setLoading(true); setError('');
    try {
      const res = await fetch(`${BASE_URL}/api/auth/pos-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email:     email.trim().toLowerCase(),
          pin,
          branch_id: branch.id,
          surface:   'web',
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Failed'); return; }
      localStorage.setItem('swiftpos_pos_token', data.accessToken ?? data.token);
      if (data.refreshToken) localStorage.setItem('swiftpos_pos_refresh_token', data.refreshToken);
      finishLogin(data, branch.id, branch.name);
    } catch {
      setError('Network error — please try again.');
    } finally {
      setLoading(false);
    }
  }

  function triggerError(msg: string) {
    setError(msg); setShake(true); setPin('');
    setTimeout(() => setShake(false), 500);
  }

  function pressDigit(d: string) {
    if (loading || pin.length >= PIN_MAX || !email.trim()) return;
    setError(''); setPin(p => p + d);
  }

  function pressBackspace() {
    if (loading) return;
    setError(''); setPin(p => p.slice(0, -1));
  }

  function pressConfirm() {
    if (loading || pin.length < PIN_MIN || !email.trim()) return;
    handleLogin(email, pin);
  }

  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫'];
  const pinReady = email.trim().length > 0;

  // ── Branch picker ──────────────────────────────────────────────────────────
  if (step === 'branch') {
    return (
      <div style={st.root}>
        <div style={st.header}>
          <div style={st.logo}><span>⚡</span><span style={st.logoText}>SwiftPOS</span></div>
        </div>
        <div style={st.main}>
          <div style={{ ...st.card, maxWidth: 420 }}>
            <div style={{ fontSize: 32, marginBottom: 6 }}>👋</div>
            <h2 style={st.title}>Welcome, {successName}!</h2>
            <p style={st.subtitle}>Which branch are you opening today?</p>
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
              {branches.map(b => (
                <button key={b.id} onClick={() => selectBranch(b)} disabled={loading}
                  style={{
                    width: '100%', padding: '14px 18px',
                    background: b.licensed ? '#1e3a5f' : '#1e293b',
                    border: `1px solid ${b.licensed ? 'rgba(59,130,246,0.4)' : '#334155'}`,
                    borderRadius: 12, cursor: b.licensed ? 'pointer' : 'not-allowed',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    opacity: loading ? 0.6 : 1, fontFamily: "'DM Sans','Segoe UI',sans-serif",
                  }}>
                  <div style={{ textAlign: 'left' }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: b.licensed ? '#f1f5f9' : '#64748b' }}>{b.name}</div>
                    {!b.licensed && <div style={{ fontSize: 11, color: '#475569', marginTop: 2 }}>No desktop licence</div>}
                  </div>
                  {b.licensed && <span style={{ color: '#60a5fa' }}>→</span>}
                </button>
              ))}
            </div>
            {error && <p style={{ ...st.errorText, opacity: 1, marginTop: 14 }}>{error}</p>}
            <button style={{ marginTop: 20, background: 'transparent', border: 'none', color: '#475569', fontSize: 13, cursor: 'pointer', fontFamily: "'DM Sans','Segoe UI',sans-serif" }}
              onClick={() => { setStep('login'); setSuccessName(''); setPin(''); setError(''); }}>
              ← Back to login
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Login form ─────────────────────────────────────────────────────────────

  // ── Device pending / rejected screens ─────────────────────────────────────
  if (deviceRejected) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
        <div className="bg-gray-900 border border-red-500/40 rounded-2xl p-8 max-w-sm w-full text-center space-y-4">
          <div className="w-12 h-12 rounded-xl bg-red-500/15 text-red-400 text-2xl flex items-center justify-center mx-auto">✕</div>
          <h2 className="text-white font-bold text-lg">Device blocked</h2>
          <p className="text-gray-400 text-sm">This device has been blocked by your manager. Please contact them to resolve this.</p>
        </div>
      </div>
    );
  }

  if (devicePending) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
        <div className="bg-gray-900 border border-amber-500/40 rounded-2xl p-8 max-w-sm w-full text-center space-y-4">
          <div className="w-12 h-12 rounded-xl bg-amber-500/15 text-amber-400 text-2xl flex items-center justify-center mx-auto animate-pulse">⏳</div>
          <h2 className="text-white font-bold text-lg">Waiting for approval</h2>
          <p className="text-gray-400 text-sm">
            Your manager has been notified. Once they approve this device in
            <span className="text-white font-medium"> Settings → Devices</span>, you can log in.
          </p>
          <button
            onClick={() => { setDevicePending(false); setError(''); }}
            className="text-sm text-gray-500 hover:text-gray-300 transition-colors mt-2"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={st.root}>
      <div style={st.header}>
        <div style={st.logo}><span>⚡</span><span style={st.logoText}>SwiftPOS</span></div>
      </div>
      <div style={st.main}>
        <div style={st.card}>
          {business?.name && <div style={st.bizPill}>{business.name}</div>}
          <h2 style={st.title}>Staff Login</h2>
          <p style={st.subtitle}>Enter your email and PIN</p>

          <div style={st.emailWrap}>
            <input ref={emailRef} type="email" placeholder="your@email.com" value={email}
              onChange={e => { setEmail(e.target.value); setError(''); setPin(''); }}
              disabled={loading} style={st.emailInput} autoComplete="email" autoFocus />
          </div>

          <div style={{ ...st.dotsRow, ...(shake ? st.shake : {}), opacity: pinReady ? 1 : 0.3 }}>
            {Array.from({ length: Math.max(PIN_MIN, pin.length) }).map((_, i) => (
              <div key={i} style={{
                ...st.dot,
                ...(i < pin.length ? (successName ? st.dotSuccess : st.dotFilled) : {}),
              }} />
            ))}
          </div>

          {pin.length > PIN_MIN && !successName && (
            <button style={st.confirmBtn} onClick={pressConfirm} disabled={loading || !pinReady}>
              ✓ Confirm PIN
            </button>
          )}

          <div style={{ ...st.errorText, opacity: error ? 1 : 0 }}>{error || ' '}</div>
          {successName && <div style={st.successText}>✓ {successName}</div>}

          <div style={{ ...st.keypad, opacity: pinReady ? 1 : 0.3, pointerEvents: pinReady ? 'auto' : 'none' }}>
            {keys.map((k, i) => {
              if (k === '') return <div key={i} />;
              const isBack = k === '⌫';
              return (
                <button key={i} disabled={loading}
                  style={{ ...st.key, ...(isBack ? st.keyBack : {}), ...(loading ? { opacity: 0.4, cursor: 'not-allowed' } : {}) }}
                  onClick={() => isBack ? pressBackspace() : pressDigit(k)}
                  onMouseEnter={e => { if (!loading) (e.currentTarget as HTMLButtonElement).style.background = isBack ? 'rgba(255,255,255,0.05)' : '#334155'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = isBack ? 'transparent' : '#1e293b'; }}>
                  {loading && !isBack ? '' : k}
                </button>
              );
            })}
          </div>

          {!pinReady && <p style={{ fontSize: 11, color: '#475569', marginTop: 10, textAlign: 'center' }}>Enter your email to enable the keypad</p>}

          {loading && (
            <div style={st.loadingRow}>
              <div style={st.spinner} />
              <span style={{ fontSize: 13, color: '#64748b' }}>Verifying…</span>
            </div>
          )}
        </div>
      </div>
      <style>{`
        @keyframes shake { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-8px)} 40%{transform:translateX(8px)} 60%{transform:translateX(-6px)} 80%{transform:translateX(6px)} }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

const st: Record<string, React.CSSProperties> = {
  root: { minHeight: '100vh', background: 'linear-gradient(135deg,#0f172a 0%,#1e293b 60%,#0f172a 100%)', display: 'flex', flexDirection: 'column', fontFamily: "'DM Sans','Segoe UI',sans-serif", color: '#f1f5f9' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 40px', borderBottom: '1px solid rgba(255,255,255,0.06)' },
  logo: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 18 },
  logoText: { fontWeight: 700, letterSpacing: '-0.5px' },
  main: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 24px' },
  card: { background: '#1e293b', border: '1px solid #334155', borderRadius: 20, padding: '36px 32px', width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', alignItems: 'center', boxShadow: '0 24px 64px rgba(0,0,0,0.4)' },
  bizPill: { background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 20, padding: '4px 14px', fontSize: 12, color: '#93c5fd', fontWeight: 600, marginBottom: 20 },
  title: { fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px', margin: '0 0 6px', color: '#f1f5f9', textAlign: 'center' },
  subtitle: { fontSize: 13, color: '#64748b', margin: '0 0 22px', textAlign: 'center' },
  emailWrap: { width: '100%', marginBottom: 20 },
  emailInput: { width: '100%', background: '#0f172a', border: '1px solid #334155', borderRadius: 10, padding: '11px 14px', color: '#f1f5f9', fontSize: 14, outline: 'none', boxSizing: 'border-box', fontFamily: "'DM Sans','Segoe UI',sans-serif" } as React.CSSProperties,
  dotsRow: { display: 'flex', gap: 12, marginBottom: 10, transition: 'opacity 0.2s' },
  shake: { animation: 'shake 0.5s ease' },
  dot: { width: 14, height: 14, borderRadius: '50%', border: '2px solid #334155', background: 'transparent', transition: 'all 0.15s ease' },
  dotFilled: { background: '#3b82f6', borderColor: '#3b82f6', boxShadow: '0 0 8px rgba(59,130,246,0.5)' },
  dotSuccess: { background: '#22c55e', borderColor: '#22c55e', boxShadow: '0 0 8px rgba(34,197,94,0.5)' },
  confirmBtn: { marginBottom: 8, padding: '8px 24px', background: '#1d4ed8', border: 'none', borderRadius: 10, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: "'DM Sans','Segoe UI',sans-serif" },
  errorText: { fontSize: 12, color: '#f87171', marginBottom: 4, height: 16, transition: 'opacity 0.2s', textAlign: 'center' },
  successText: { fontSize: 14, color: '#4ade80', marginBottom: 8, fontWeight: 600, textAlign: 'center' },
  keypad: { display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginTop: 12, width: '100%', transition: 'opacity 0.2s' },
  key: { background: '#1e293b', border: '1px solid #334155', borderRadius: 10, color: '#f1f5f9', fontSize: 20, fontWeight: 600, height: 56, cursor: 'pointer', transition: 'background 0.12s ease', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  keyBack: { background: 'transparent', border: '1px solid transparent', color: '#94a3b8', fontSize: 18 },
  loadingRow: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 },
  spinner: { width: 16, height: 16, border: '2px solid #334155', borderTopColor: '#3b82f6', borderRadius: '50%', animation: 'spin 0.8s linear infinite' },
};
