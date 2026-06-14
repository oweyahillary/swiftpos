/**
 * PinPadScreen — POS Staff Login
 *
 * Staff log in with their email + PIN.
 * Calls POST /api/auth/pos-login — a public endpoint, no owner session needed.
 * Works on any fresh device with no prior dashboard login.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePOSAuth } from '../../context/POSAuthContext';
import { useBusiness } from '../../context/BusinessContext';
import { SELECTED_BRANCH_KEY } from './BranchSelectScreen';

import { API_URL } from '../../lib/config';
import { getDeviceHint } from '../../lib/deviceFingerprint';
const BASE_URL = API_URL;
const PIN_MIN = 4;
const PIN_MAX = 6;

interface SelectedBranch { id: string; name: string; }

export default function PinPadScreen() {
  const navigate           = useNavigate();
  const { setCashierSession } = usePOSAuth();
  const { business }       = useBusiness();

  const [branch, setBranch]         = useState<SelectedBranch | null>(null);
  const [email, setEmail]           = useState('');
  const [pin, setPin]               = useState('');
  const [error, setError]           = useState('');
  const [loading, setLoading]       = useState(false);
  const [shake, setShake]           = useState(false);
  const [successName, setSuccessName] = useState('');
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const raw = sessionStorage.getItem(SELECTED_BRANCH_KEY);
    if (!raw) { navigate('/pos'); return; }
    try { setBranch(JSON.parse(raw)); }
    catch { navigate('/pos'); }
  }, [navigate]);

  // Auto-submit at exactly 4 digits (4-digit PINs)
  useEffect(() => {
    if (pin.length === PIN_MIN && email.trim()) submitLogin(email, pin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  const submitLogin = useCallback(async (emailVal: string, pinVal: string) => {
    if (!branch || !emailVal.trim() || !pinVal) return;
    if (!/^\d{4,6}$/.test(pinVal)) { triggerError('PIN must be 4–6 digits'); return; }

    setLoading(true); setError('');
    try {
      const res = await fetch(`${BASE_URL}/api/auth/pos-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailVal.trim().toLowerCase(), pin: pinVal, branch_id: branch.id, surface: 'web', device_hint: await getDeviceHint() }),
      });

      const data = await res.json();

      if (!res.ok) { triggerError(data.error ?? 'Login failed'); return; }

      setSuccessName(data.staff.name);

      // Store tokens for any dashboard API calls
      localStorage.setItem('swiftpos_pos_token', data.accessToken ?? data.token);
      if (data.refreshToken) localStorage.setItem('swiftpos_pos_refresh_token', data.refreshToken);

      setTimeout(() => {
        setCashierSession({
          token:        data.accessToken ?? data.token,
          refreshToken: data.refreshToken ?? '',
          staffId:      data.staff.id,
          staffName:    data.staff.name,
          role:         data.staff.role,
          branchId:     branch.id,
          branchName:   branch.name,
          businessType: business?.type ?? 'retail',
          currency:     business?.currency ?? 'KES',
          permissions:  data.permissions,
        });
        navigate('/pos/cashier');
      }, 700);
    } catch {
      triggerError('Network error — please try again.');
    } finally {
      setLoading(false);
    }
  }, [branch, business, setCashierSession, navigate]);

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
    submitLogin(email, pin);
  }

  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫'];
  const pinReady = email.trim().length > 0;

  return (
    <div style={st.root}>
      {/* Header */}
      <div style={st.header}>
        <button style={st.backBtn} onClick={() => navigate('/pos')}>← Branches</button>
        <div style={st.logo}><span>⚡</span><span style={st.logoText}>SwiftPOS</span></div>
        <div style={{ width: 90 }} />
      </div>

      <div style={st.main}>
        <div style={st.card}>
          {/* Branch pill */}
          {branch && (
            <div style={st.branchPill}>
              <span style={st.branchDot} />{branch.name}
            </div>
          )}

          <h2 style={st.title}>Staff Login</h2>
          <p style={st.subtitle}>Enter your email, then your PIN</p>

          {/* Email input */}
          <div style={st.emailWrap}>
            <input
              ref={emailRef}
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={e => { setEmail(e.target.value); setError(''); setPin(''); }}
              disabled={loading}
              style={st.emailInput}
              autoComplete="email"
              autoFocus
            />
          </div>

          {/* PIN dots */}
          <div style={{ ...st.dotsRow, ...(shake ? st.shake : {}), opacity: pinReady ? 1 : 0.35 }}>
            {Array.from({ length: Math.max(PIN_MIN, pin.length) }).map((_, i) => (
              <div key={i} style={{
                ...st.dot,
                ...(i < pin.length ? (successName ? st.dotSuccess : st.dotFilled) : {}),
              }} />
            ))}
          </div>

          {/* Confirm for 5-6 digit PINs */}
          {pin.length > PIN_MIN && !successName && (
            <button style={st.confirmBtn} onClick={pressConfirm} disabled={loading || !pinReady}>
              ✓ Confirm PIN
            </button>
          )}

          {/* Error / success */}
          <div style={{ ...st.errorText, opacity: error ? 1 : 0 }}>{error || ' '}</div>
          {successName && <div style={st.successText}>✓ Welcome, {successName}!</div>}

          {/* Keypad */}
          <div style={{ ...st.keypad, opacity: pinReady ? 1 : 0.4, pointerEvents: pinReady ? 'auto' : 'none' }}>
            {keys.map((k, i) => {
              if (k === '') return <div key={i} />;
              const isBack = k === '⌫';
              return (
                <button
                  key={i}
                  style={{ ...st.key, ...(isBack ? st.keyBack : {}), ...(loading ? st.keyDisabled : {}) }}
                  onClick={() => isBack ? pressBackspace() : pressDigit(k)}
                  disabled={loading}
                  onMouseEnter={e => { if (!loading) (e.currentTarget as HTMLButtonElement).style.background = '#334155'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = isBack ? 'transparent' : '#1e293b'; }}
                >
                  {loading && !isBack ? '' : k}
                </button>
              );
            })}
          </div>

          {!pinReady && (
            <p style={{ fontSize: 11, color: '#475569', marginTop: 8, textAlign: 'center' }}>
              Enter your email to enable the keypad
            </p>
          )}

          {loading && (
            <div style={st.loadingRow}>
              <div style={st.spinner} />
              <span style={st.loadingText}>Verifying…</span>
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes shake {
          0%,100%{transform:translateX(0)} 20%{transform:translateX(-8px)}
          40%{transform:translateX(8px)} 60%{transform:translateX(-6px)} 80%{transform:translateX(6px)}
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

const st: Record<string, React.CSSProperties> = {
  root: {
    minHeight: '100vh',
    background: 'linear-gradient(135deg,#0f172a 0%,#1e293b 60%,#0f172a 100%)',
    display: 'flex', flexDirection: 'column',
    fontFamily: "'DM Sans','Segoe UI',sans-serif", color: '#f1f5f9',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '20px 40px', borderBottom: '1px solid rgba(255,255,255,0.06)',
  },
  backBtn: {
    background: 'transparent', border: 'none', color: '#64748b',
    fontSize: 14, cursor: 'pointer', padding: '6px 0', width: 90, textAlign: 'left',
  },
  logo: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 16 },
  logoText: { fontWeight: 700, letterSpacing: '-0.5px' },
  main: {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '40px 24px',
  },
  card: {
    background: '#1e293b', border: '1px solid #334155', borderRadius: 20,
    padding: '36px 32px', width: '100%', maxWidth: 380,
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
  },
  branchPill: {
    display: 'flex', alignItems: 'center', gap: 7,
    background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)',
    borderRadius: 20, padding: '5px 14px', fontSize: 12, color: '#93c5fd',
    fontWeight: 500, marginBottom: 20,
  },
  branchDot: { width: 7, height: 7, borderRadius: '50%', background: '#3b82f6', display: 'inline-block' },
  title: { fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px', margin: '0 0 6px', color: '#f1f5f9' },
  subtitle: { fontSize: 13, color: '#64748b', margin: '0 0 22px' },
  emailWrap: { width: '100%', marginBottom: 20 },
  emailInput: {
    width: '100%', background: '#0f172a', border: '1px solid #334155',
    borderRadius: 10, padding: '11px 14px', color: '#f1f5f9', fontSize: 14,
    outline: 'none', boxSizing: 'border-box',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  } as React.CSSProperties,
  dotsRow: { display: 'flex', gap: 12, marginBottom: 10, transition: 'opacity 0.2s' },
  shake: { animation: 'shake 0.5s ease' },
  dot: {
    width: 14, height: 14, borderRadius: '50%',
    border: '2px solid #334155', background: 'transparent', transition: 'all 0.15s ease',
  },
  dotFilled: { background: '#3b82f6', borderColor: '#3b82f6', boxShadow: '0 0 8px rgba(59,130,246,0.5)' },
  dotSuccess: { background: '#22c55e', borderColor: '#22c55e', boxShadow: '0 0 8px rgba(34,197,94,0.5)' },
  confirmBtn: {
    marginBottom: 8, padding: '8px 24px', background: '#1d4ed8', border: 'none',
    borderRadius: 10, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer',
    fontFamily: "'DM Sans','Segoe UI',sans-serif",
  },
  errorText: { fontSize: 12, color: '#f87171', marginBottom: 4, height: 16, transition: 'opacity 0.2s', textAlign: 'center' },
  successText: { fontSize: 13, color: '#4ade80', marginBottom: 8, fontWeight: 600, textAlign: 'center' },
  keypad: { display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginTop: 12, width: '100%', transition: 'opacity 0.2s' },
  key: {
    background: '#1e293b', border: '1px solid #334155', borderRadius: 10,
    color: '#f1f5f9', fontSize: 20, fontWeight: 600, height: 56, cursor: 'pointer',
    transition: 'background 0.12s ease', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  keyBack: { background: 'transparent', border: '1px solid transparent', color: '#94a3b8', fontSize: 18 },
  keyDisabled: { opacity: 0.4, cursor: 'not-allowed' },
  loadingRow: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, color: '#64748b', fontSize: 13 },
  spinner: {
    width: 16, height: 16, border: '2px solid #334155',
    borderTopColor: '#3b82f6', borderRadius: '50%', animation: 'spin 0.8s linear infinite',
  },
  loadingText: { fontSize: 13, color: '#64748b' },
};
