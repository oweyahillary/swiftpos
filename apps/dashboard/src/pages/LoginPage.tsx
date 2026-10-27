import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { api, storeSwiftPOSToken, storeRefreshToken, clearAllTokens } from '../lib/api';
import { useTenant, tenantSignInFields } from '../lib/tenant';
import { TenantBrand, UnknownTenantAddress } from '../components/TenantBrand';
import { DEFAULT_SUPPORT_PHONES, whatsappNumber } from '@zaptill/core/support';   // 0.6.35 (A384)
import { readOtpTrust, saveOtpTrust, dropOtpTrust } from '../lib/otpTrust';   // A391
import ForgotPassword from '../components/ForgotPassword';   // A402
import OtpCodeStep, { type OtpPrompt } from '../components/OtpCodeStep';
import { loginBrand } from '../lib/loginBrand';   // A424
import { PAUSED_TITLE, PAUSED_BODY } from '../lib/cloudPaused';   // A584

// Error codes returned by POST /api/auth/login for specific access issues
const ACCESS_ERROR_CODES: Record<string, { title: string; body: string; icon: string }> = {
  // A378: signed in on a client's own address with an account of another business.
  NOT_THIS_BUSINESS: {
    icon:  '🏪',
    title: 'Not this business',
    body:  'This sign-in address belongs to another business. Use your own business\'s address, or the main ZapTill sign-in.',
  },
  WEB_HOSTING_REQUIRED: {
    icon:  '🔒',
    title: 'Web portal access not enabled',
    body:  'Your licence covers the desktop POS app only. To add the web dashboard and the cloud, call ZapTill on 0717 675 635.',
  },
  // A569: the 30-day cloud trial (started with the first desktop licence) ended, and its week of reports only too.
  CLOUD_TRIAL_ENDED: {
    icon:  '⏳',
    title: 'Your cloud trial has ended',
    body:  'Your one-month cloud trial is over. Contact ZapTill to keep the web dashboard. Your points of sale keep working as before.',
  },
  // A584: unpaid 7 days after the due date — the plain words, no blame, no dates (lib/cloudPaused.ts).
  CLOUD_ACCESS_PAUSED: {
    icon:  '⏸️',
    title: PAUSED_TITLE,
    body:  PAUSED_BODY,
  },
  WEB_ACCESS_EXPIRED: {
    icon:  '⏸️',
    title: PAUSED_TITLE,
    body:  PAUSED_BODY,
  },
  ACCOUNT_SUSPENDED: {
    icon:  '⛔',
    title: 'Account suspended',
    body:  'Your account has been suspended. Please contact ZapTill support to resolve this.',
  },
};

export default function LoginPage() {
  const navigate = useNavigate();
  const tenant = useTenant();   // A378: on a client's own address — their logo, and sign-in locked to them
  // A550: the web dashboard access invitation links here with #set_password=1&email=… — "Forgot password?" opens with the
  // address filled in, so the person sets their password with the emailed code (the link carries no secret). The email
  // rides in the fragment, which the browser never sends to a server, and is wiped from the address bar once read.
  const [invite] = useState(() => {
    try {
      const q = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const found = { email: (q.get('email') ?? '').slice(0, 200), setPassword: q.get('set_password') === '1' };
      if (found.email || found.setPassword) window.history.replaceState(null, '', window.location.pathname + window.location.search);
      return found;
    } catch { return { email: '', setPassword: false }; }
  });
  const [email, setEmail]       = useState(invite.email);
  const [password, setPassword] = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [error, setError]       = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [loading, setLoading]   = useState(false);
  /**
   * Set when the server answers 409 MULTIPLE_BUSINESSES (audit BUG-18).
   *
   * An owner of two businesses used to be told "No business found for this
   * account" and could not log in to EITHER — `.single()` raised PGRST116 on
   * two rows and the handler's error message was written for the zero-row case.
   * The server now names both and lets the owner choose; this is that choice.
   */
  const [businessChoices, setBusinessChoices] =
    useState<{ id: string; name?: string }[] | null>(null);
  // A391: an owner always enters a one-time code after the password (emailed, or from an authenticator app). A550: so does
  // a partner — someone on the staff the owner gave web dashboard access (same form, same steps).
  const [otp, setOtp]           = useState<OtpPrompt | null>(null);
  const [otpCode, setOtpCode]   = useState('');
  const [remember, setRemember] = useState(true);
  const [pickedBusiness, setPickedBusiness] = useState<string | undefined>(undefined);
  // A402: "Forgot password?" — the reset steps replace the sign-in form; `info` is what it says when done.
  const [forgot, setForgot] = useState(invite.setPassword);
  const [info, setInfo] = useState('');

  const inputCls =
    'w-full bg-[#0f172a] border border-[#1e293b] rounded-xl px-4 py-3 text-white placeholder-[#334155] ' +
    'focus:outline-none focus:border-[color:var(--brand)] focus:ring-1 focus:ring-[color:var(--brand)] transition-all text-sm';

  const handleLogin = async (e: React.FormEvent | null, chosenBusinessId?: string,
    otpExtra?: { otp_code?: string; otp_remember?: boolean; otp_resend?: boolean; otp_use_email?: boolean }) => {
    e?.preventDefault();
    setError('');
    setErrorCode('');
    setBusinessChoices(null);
    setLoading(true);
    if (chosenBusinessId !== undefined) setPickedBusiness(chosenBusinessId);
    const businessId = chosenBusinessId ?? pickedBusiness;

    // ── Clear any stale SwiftPOS / POS / cashier tokens BEFORE authenticating ──
    // The access token is a single shared localStorage key, written by both the
    // dashboard owner login and the (web) POS staff logins, and getAuthHeader()
    // prefers it over the Supabase session. Wiping first guarantees no previous
    // user's token leaks into the fetches the new session will trigger.
    clearAllTokens();

    try {
      // ── Step 1: Server login FIRST — validates credentials server-side and
      //   returns the SwiftPOS JWT pair, while enforcing the web_hosting gate +
      //   suspension check. This endpoint does its own password verification, so
      //   it does NOT require a pre-existing Supabase session on the client.
      //
      //   Order matters: we must STORE the SwiftPOS token before establishing the
      //   Supabase session (step 3). signInWithPassword() fires onAuthStateChange,
      //   which makes BusinessContext / BranchContext / PermissionsContext refetch
      //   immediately. Those API routes verify the SwiftPOS JWT — if the token
      //   isn't in localStorage yet, every fetch 401s and the contexts stay empty
      //   until a manual page reload. Storing first means the very first
      //   session-triggered fetch already carries a valid token.
      let loginResponse: { mustChangePassword?: boolean; accessToken?: string; refreshToken?: string; otp_trust?: string } = {};
      try {
        const trust = readOtpTrust(email);
        loginResponse = await api.post<{ mustChangePassword?: boolean }>(
          '/api/auth/login',
          // business_id is only present on the second attempt, after the owner
          // has picked one from the 409 below.
          { email, password, ...(businessId ? { business_id: businessId } : {}), ...tenantSignInFields(),
            ...(trust ? { otp_trust: trust } : {}), ...(otpExtra ?? {}) },
        );
        saveOtpTrust(email, loginResponse.otp_trust);
      } catch (serverErr: any) {
        // api.ts preserves the `code` field from the server JSON response
        const code = serverErr?.code;
        // A391: the password was right — now the code.
        if (code === 'OTP_REQUIRED') {
          dropOtpTrust(email);
          setOtp({ method: serverErr?.method, sentTo: serverErr?.sent_to, note: otpExtra?.otp_resend ? 'A new code is on its way.' : '' });
          setOtpCode('');
          setLoading(false);
          return;
        }
        if (otp && (code === 'OTP_INVALID' || code === 'OTP_EXPIRED' || code === 'OTP_EMAIL_FAILED')) {
          setError(serverErr.message); setOtpCode(''); setLoading(false);
          return;
        }
        if (code === 'MULTIPLE_BUSINESSES') {
          // Not an error the owner can do anything about by retrying — it is a
          // question. Show the list and re-submit with their answer.
          setBusinessChoices(serverErr?.businesses ?? []);
          setLoading(false);
          return;
        }
        if (code && ACCESS_ERROR_CODES[code]) {
          setErrorCode(code);
        } else {
          // Invalid email/password (server 401) and any other access error land here.
          setError(serverErr.message ?? 'Sign in failed — please check your credentials.');
        }
        setLoading(false);
        return;
      }

      // ── Step 2: Store the SwiftPOS JWT so api.ts uses it for every subsequent
      //   request (including the context fetches triggered by step 3).
      if (loginResponse.accessToken)  storeSwiftPOSToken(loginResponse.accessToken);
      if (loginResponse.refreshToken) storeRefreshToken(loginResponse.refreshToken);

      // ── Step 3: Establish the Supabase session. ProtectedRoute and the data
      //   contexts gate on this session. It now fires with the SwiftPOS token
      //   already in place, so the contexts load correctly on first paint.
      const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
      if (signInErr) {
        // Token was stored but the session couldn't be created — don't leave a
        // half-authenticated state (token present, no session → bounce loop).
        clearAllTokens();
        throw new Error(signInErr.message);
      }

      // ── Step 4: Route to password change or dashboard ───────────────────────
      if (loginResponse.mustChangePassword) { navigate('/change-password'); return; }

      navigate('/dashboard');
    } catch (err: any) {
      setError(err.message ?? 'Sign in failed — please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  // A378: an address no business has — say so instead of a form that could not sign anyone in.
  if (tenant.status === 'unknown') return <UnknownTenantAddress subdomain={tenant.subdomain} />;

  // ── Render access-blocked screen ────────────────────────────────────────────
  const accessError = errorCode ? ACCESS_ERROR_CODES[errorCode] : null;
  if (accessError) {
    return (
      <div data-theme-lock="dark" className="min-h-screen bg-[#080c14] flex items-center justify-center px-4">
        <div className="w-full max-w-md">
          <div className="bg-[#0f172a] border border-[#1e2d45] rounded-2xl p-8 text-center space-y-5">
            <div className="text-5xl">{accessError.icon}</div>
            <div>
              <h2 className="text-white font-bold text-xl mb-2">{accessError.title}</h2>
              <p className="text-[#64748b] text-sm leading-relaxed">{accessError.body}</p>
            </div>
            {(errorCode === 'WEB_HOSTING_REQUIRED' || errorCode === 'CLOUD_TRIAL_ENDED') && (
              <div className="bg-[#0a1628] border border-[#1e2d45] rounded-xl p-4 text-left space-y-1">
                <p className="text-xs text-[#64748b] font-semibold uppercase tracking-wider">What you get with web hosting</p>
                <ul className="text-sm text-[#94a3b8] space-y-1 mt-2">
                  <li>✓ Cloud dashboard from any browser</li>
                  <li>✓ Multi-device POS access</li>
                  <li>✓ Real-time reports & analytics</li>
                  <li>✓ KDS on any screen</li>
                </ul>
              </div>
            )}
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => { setErrorCode(''); setError(''); }}
                className="flex-1 bg-[#1e293b] hover:bg-[#334155] text-white text-sm font-medium rounded-xl py-2.5 transition-colors"
              >
                ← Back to login
              </button>
              <a
                href={`https://wa.me/${import.meta.env.VITE_SUPPORT_WHATSAPP || whatsappNumber(DEFAULT_SUPPORT_PHONES[0])}?text=Hi, I'd like to upgrade my ZapTill account to include web hosting access.`}
                target="_blank"
                rel="noreferrer"
                className="flex-1 bg-swift-strong hover:bg-swift-deep text-white text-sm font-medium rounded-xl py-2.5 transition-colors text-center"
              >
                Contact ZapTill
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // A424 (owner, 2026-10-10: "use the client's branding colour … the content overflows, can we find a better way,
  // something classy and presentable"): a wide screen splits — the client's colour, logo and name on the left, the
  // form on the right; a phone gets a compact brand header over the form. The form side scrolls on its own and is
  // centred with auto margins, so a tall step (the code, a business choice, an error) is never cut off at the top or
  // bottom, at any window size. The client's colour fills the button and the focus ring (loginBrand: readable on dark).
  const brandName = tenant.status === 'found' ? tenant.tenant.name : 'ZapTill';
  const brand = loginBrand(tenant.status === 'found' ? tenant.tenant.accent : null);
  const brandVars = { '--brand': brand.accent, '--brand-text': brand.text } as React.CSSProperties;
  const panel = (
    forgot ? (
            <ForgotPassword initialEmail={email} inputCls={inputCls}
              onDone={(m) => { setForgot(false); setPassword(''); setError(''); setInfo(m); }}
              onBack={() => { setForgot(false); setError(''); }} />
          ) : otp ? (
            <OtpCodeStep
              prompt={otp} code={otpCode} setCode={setOtpCode} remember={remember} setRemember={setRemember}
              loading={loading} error={error}
              onSubmit={() => { void handleLogin(null, undefined, { otp_code: otpCode, otp_remember: remember, otp_use_email: otp?.method === 'email' }); }}
              onResend={() => { void handleLogin(null, undefined, { otp_resend: true, otp_use_email: true }); }}   /* A403: for an authenticator user, the code by email */
              onBack={() => { setOtp(null); setOtpCode(''); setError(''); }}
            />
          ) : businessChoices ? (
            /* Owner of more than one business (audit BUG-18). Credentials are
               already verified at this point — the server refused only because
               it did not know WHICH business to open, and guessing would drop
               someone into the wrong shop's dashboard. */
            <div className="space-y-4">
              <div>
                <h2 className="text-white font-semibold text-lg">Choose a business</h2>
                <p className="text-[#64748b] text-sm mt-1">
                  This account owns more than one. Pick the one you want to open.
                </p>
              </div>
              <div className="space-y-2">
                {businessChoices.map(b => (
                  <button
                    key={b.id}
                    type="button"
                    disabled={loading}
                    onClick={() => { void handleLogin(null, b.id); }}
                    className="w-full text-left bg-[#0f172a] border border-[#1e293b] hover:border-[color:var(--brand)]
                               rounded-xl px-4 py-3 text-white transition-colors disabled:opacity-50"
                  >
                    {b.name ?? b.id}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => { setBusinessChoices(null); setError(''); }}
                className="text-[#64748b] text-sm hover:text-white transition-colors"
              >
                ← Back to sign in
              </button>
            </div>
          ) : (
          <form onSubmit={handleLogin} className="space-y-5">

            <div>
              <label className="block text-xs font-medium text-[#64748b] mb-1.5 tracking-wide uppercase">Email</label>
              <input
                className={inputCls}
                type="email"
                required
                placeholder="you@business.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                autoFocus
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-[#64748b] tracking-wide uppercase">Password</label>
                <button
                  type="button"
                  onClick={() => setShowPw(p => !p)}
                  className="text-[10px] text-[#334155] hover:text-[#64748b] transition-colors"
                >
                  {showPw ? 'hide' : 'show'}
                </button>
              </div>
              <input
                className={inputCls}
                type={showPw ? 'text' : 'password'}
                required
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
            </div>

            {/* A402 */}
            <div className="-mt-2 text-right">
              <button type="button" onClick={() => { setForgot(true); setError(''); setInfo(''); }} data-testid="forgot-link"
                className="text-xs text-[#64748b] hover:text-white transition-colors">Forgot password?</button>
            </div>
            {info && <p className="text-sm text-[#94a3b8]" data-testid="login-info">{info}</p>}

            {error && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
                <p className="text-red-400 text-sm">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              data-testid="login-submit" style={{ background: 'var(--brand)', color: 'var(--brand-text)' }}
              className="w-full py-3 rounded-xl font-bold text-sm hover:brightness-110 shadow-lg shadow-black/30 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                  </svg>
                  Signing in…
                </>
              ) : 'Sign in'}
            </button>

          </form>
          )
  );

  return (
    <div data-theme-lock="dark" className="min-h-screen bg-[#080c14] lg:h-screen flex flex-col lg:flex-row" style={brandVars} data-testid="login-page">

      {/* ── The brand panel (wide screens) ── */}
      <aside className="hidden lg:flex relative overflow-hidden lg:w-[44%] xl:w-1/2 shrink-0 flex-col justify-between p-12 xl:p-16 border-r border-white/5"
        data-testid="login-brand-panel"
        style={{ background: `radial-gradient(120% 90% at 0% 0%, ${brand.raw}66 0%, transparent 55%), radial-gradient(90% 70% at 100% 100%, ${brand.raw}33 0%, transparent 60%), linear-gradient(160deg, ${brand.raw}22, #080c14 70%)` }}>
        <div className="absolute inset-0 pointer-events-none opacity-[0.07]"
          style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,0.9) 1px, transparent 1px)', backgroundSize: '22px 22px' }} />
        <div className="relative">
          {tenant.status === 'found' ? (
            tenant.tenant.logo
              ? <img src={tenant.tenant.logo} alt={tenant.tenant.name} className="max-h-24 max-w-[260px] object-contain rounded-xl bg-white/10 p-2 shadow-xl" />
              : <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-2xl font-black shadow-xl" style={{ background: brand.accent, color: brand.text }}>{brandName.trim().charAt(0).toUpperCase()}</div>
          ) : tenant.status === 'loading' ? (
            <div className="h-24" aria-hidden />
          ) : (
            <div className="inline-flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-swift-logo flex items-center justify-center text-[#0f172a] font-black text-lg">Z</div>
              <span className="text-2xl font-bold text-white tracking-tight">ZapTill</span>
            </div>
          )}
        </div>
        <div className="relative max-w-md">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-white/60">Welcome back</p>
          {tenant.status !== 'loading' && (
            <h1 className="mt-3 text-4xl xl:text-5xl font-bold text-white leading-tight break-words" data-testid="login-brand-name">{brandName}</h1>
          )}
          <div className="mt-5 h-1 w-16 rounded-full" style={{ background: brand.accent }} />
          <p className="mt-5 text-base text-white/70 leading-relaxed">Sales, stock, staff and every branch — sign in to your dashboard.</p>
        </div>
        <p className="relative text-xs text-white/40">{tenant.status === 'found' ? 'on ZapTill' : 'ZapTill point of sale'}</p>
      </aside>

      {/* ── The form side: scrolls on its own; auto margins centre it without ever cutting it off ── */}
      <main className="flex-1 min-h-0 overflow-y-auto flex flex-col px-5 py-8 sm:px-10">
        <div className="w-full max-w-sm m-auto">

          {/* Phones and narrow windows: the brand, compact, over the form */}
          <div className="lg:hidden text-center mb-6">
            {tenant.status === 'found' ? (
              <div className="mb-1"><TenantBrand tenant={tenant.tenant} /></div>
            ) : tenant.status === 'loading' ? (
              // 0.6.36: on a client's address, no brand at all until the cloud says whose it is (no flash of ZapTill).
              <div className="mb-3 h-[60px]" aria-hidden data-testid="tenant-loading" />
            ) : (
            <div className="inline-flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-swift-logo flex items-center justify-center text-[#0f172a] font-black text-sm">Z</div>
              <span className="text-xl font-bold text-white tracking-tight">ZapTill</span>
            </div>
            )}
          </div>

          <div className="mb-6">
            <h2 className="text-2xl font-bold text-white tracking-tight">Sign in</h2>
            <p className="text-sm text-[#64748b] mt-1">to your {tenant.status === 'found' ? `${brandName} ` : ''}dashboard</p>
          </div>

          <div className="sm:bg-[#0d1424] sm:border sm:border-[#1e293b] sm:rounded-2xl sm:p-7 sm:shadow-2xl">
            {panel}
          </div>

          <div className="mt-6 flex flex-col items-center gap-2 text-xs">
            <p className="text-[#475569] text-center">No account? Contact your ZapTill agent to get set up.</p>
            {/* 0.6.35 (A384): forgot the password, locked out — what to do and who to call. */}
            <a href="/help" className="text-gray-400 hover:text-white underline" data-testid="login-help">Need help?</a>
          </div>
          {/* 0.6.36 (owner): no version on the sign-in page — it shows in the menu once signed in (ReleaseBadge). */}
        </div>
      </main>
    </div>
  );
}
