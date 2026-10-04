import { cleanOtpInput } from '../lib/otpTrust';

/**
 * OtpCodeStep — A391: the second step of a web sign-in (owner dashboard, web POS for managers): the 6-digit code that was
 * emailed, or the one the authenticator app shows.
 */
export interface OtpPrompt { method?: 'email' | 'totp'; sentTo?: string; note?: string }

interface Props {
  prompt: OtpPrompt;
  code: string;
  setCode: (v: string) => void;
  remember: boolean;
  setRemember: (v: boolean) => void;
  loading: boolean;
  error?: string;
  onSubmit: () => void;
  onResend: () => void;
  onBack: () => void;
}

export default function OtpCodeStep({ prompt, code, setCode, remember, setRemember, loading, error, onSubmit, onResend, onBack }: Props) {
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (code.length === 6) onSubmit(); }} className="space-y-4" data-testid="otp-step">
      <div>
        <h2 className="text-white font-semibold text-lg">Enter your sign-in code</h2>
        <p className="text-[#64748b] text-sm mt-1 leading-relaxed">
          {prompt.method === 'totp'
            ? 'Open your authenticator app and type the 6-digit code for ZapTill.'
            : `We emailed a 6-digit code to ${prompt.sentTo || 'your email'}. It works for 10 minutes.`}
          {prompt.note ? ` ${prompt.note}` : ''}
        </p>
      </div>
      <input
        value={code} onChange={(e) => setCode(cleanOtpInput(e.target.value))}
        inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="••••••"
        className="w-full bg-[#0f172a] border border-[#1e293b] rounded-xl px-4 py-3 text-white text-center text-2xl tracking-[0.5em] placeholder-[#334155] focus:outline-none focus:border-swift"
      />
      <label className="flex items-center gap-2 text-xs text-[#94a3b8] cursor-pointer">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Remember this browser for 30 days
      </label>
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}
      <button type="submit" disabled={loading || code.length !== 6}
        className="w-full py-3 rounded-xl font-bold text-sm bg-swift-strong hover:bg-swift-deep text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all">
        {loading ? 'Checking…' : 'Verify and sign in'}
      </button>
      <div className="flex justify-between">
        <button type="button" onClick={onBack} className="text-[#64748b] text-sm hover:text-white transition-colors">← Back</button>
        {prompt.method !== 'totp' && (
          <button type="button" disabled={loading} onClick={onResend} className="text-[#64748b] text-sm hover:text-white transition-colors">Send a new code</button>
        )}
      </div>
    </form>
  );
}
