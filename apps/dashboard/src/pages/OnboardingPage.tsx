import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { api } from '../lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface FormState {
  // Step 1 — Business profile
  businessName: string;
  businessType: string;
  ownerName: string;
  phone: string;
  email: string;
  taxPin: string;
  vatRate: string;
  currency: string;
  logo: File | null;
  logoPreview: string;
  // Step 2 — Branch
  branchName: string;
  branchAddress: string;
  branchCity: string;
  branchPhone: string;
  // Step 3 — Owner credentials
  ownerEmail: string;
  ownerPassword: string;
  ownerPasswordConfirm: string;
  ownerPin: string;
  ownerPinConfirm: string;
}

const BUSINESS_TYPES = [
  { value: 'restaurant',    label: 'Restaurant',      icon: '🍽️', desc: 'Tables, KOT, dine-in' },
  { value: 'cafe',          label: 'Café',            icon: '☕',  desc: 'Counter service, takeaway' },
  { value: 'retail',        label: 'Retail',          icon: '🛍️', desc: 'General retail store' },
  { value: 'minimart',      label: 'Minimart',        icon: '🏪', desc: 'Grocery & convenience' },
  { value: 'parking',       label: 'Parking Lot',     icon: '🅿️', desc: 'Bays, hourly billing' },
  { value: 'petrol_station',label: 'Petrol Station',  icon: '⛽', desc: 'Pumps, fuel grades' },
  { value: 'other',         label: 'Other',           icon: '🏢', desc: 'Other business type' },
];

const CURRENCIES = [
  { value: 'KES', label: 'KES — Kenyan Shilling' },
  { value: 'UGX', label: 'UGX — Ugandan Shilling' },
  { value: 'TZS', label: 'TZS — Tanzanian Shilling' },
  { value: 'USD', label: 'USD — US Dollar' },
  { value: 'GBP', label: 'GBP — British Pound' },
];

const STEPS = [
  { num: 1, label: 'Business profile' },
  { num: 2, label: 'First branch' },
  { num: 3, label: 'Owner access' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashPin(pin: string): string {
  // Simple deterministic hash for demo — in production use bcrypt on the server
  return btoa(`pin:${pin}:swiftpos`);
}

function validateEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePin(pin: string) {
  return /^\d{4}$/.test(pin);
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const [pinEntry, setPinEntry] = useState<'pin' | 'confirm'>('pin');

  const [form, setForm] = useState<FormState>({
    businessName: '',
    businessType: 'restaurant',
    ownerName: '',
    phone: '',
    email: '',
    taxPin: '',
    vatRate: '16',
    currency: 'KES',
    logo: null,
    logoPreview: '',
    branchName: 'Main Branch',
    branchAddress: '',
    branchCity: 'Nairobi',
    branchPhone: '',
    ownerEmail: '',
    ownerPassword: '',
    ownerPasswordConfirm: '',
    ownerPin: '',
    ownerPinConfirm: '',
  });

  const set = (field: keyof FormState, value: string) =>
    setForm(prev => ({ ...prev, [field]: value }));

  // ── Logo upload ─────────────────────────────────────────────────────────────
  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      setForm(prev => ({
        ...prev,
        logo: file,
        logoPreview: ev.target?.result as string,
      }));
    };
    reader.readAsDataURL(file);
  }

  // ── PIN pad input ───────────────────────────────────────────────────────────
  function handlePinKey(key: string, field: 'ownerPin' | 'ownerPinConfirm') {
    const current = form[field];
    if (key === '⌫') {
      set(field, current.slice(0, -1));
    } else if (current.length < 4 && /\d/.test(key)) {
      set(field, current + key);
    }
  }

  // ── Step validation ─────────────────────────────────────────────────────────
  function step1Valid() {
    return (
      form.businessName.trim().length >= 2 &&
      form.ownerName.trim().length >= 2 &&
      form.businessType !== ''
    );
  }

  function step2Valid() {
    return form.branchName.trim().length >= 2;
  }

  function step3Valid() {
    return (
      validateEmail(form.ownerEmail) &&
      form.ownerPassword.length >= 8 &&
      form.ownerPassword === form.ownerPasswordConfirm &&
      validatePin(form.ownerPin) &&
      form.ownerPin === form.ownerPinConfirm
    );
  }

  // ── Submit ──────────────────────────────────────────────────────────────────
  async function handleSubmit() {
    if (!step3Valid()) return;
    setError('');
    setLoading(true);

    try {
      // 1. Sign up the owner in Supabase auth
      const { data: authData, error: signUpError } = await supabase.auth.signUp({
        email: form.ownerEmail,
        password: form.ownerPassword,
      });

      if (signUpError) throw new Error(signUpError.message);
      if (!authData.session) throw new Error('Sign up succeeded but no session returned.');

      // 2. Build logo URL if provided (upload to Supabase storage)
      let logoUrl: string | undefined;
      if (form.logo) {
        const ext = form.logo.name.split('.').pop();
        const path = `logos/${authData.user!.id}.${ext}`;
        const { error: uploadErr } = await supabase.storage
          .from('business-assets')
          .upload(path, form.logo, { upsert: true });
        if (!uploadErr) {
          const { data: urlData } = supabase.storage
            .from('business-assets')
            .getPublicUrl(path);
          logoUrl = urlData.publicUrl;
        }
      }

      // 3. Call onboarding API route — creates business, branch, roles, user
      await api.post('/api/onboarding', {
        businessName:    form.businessName.trim(),
        businessType:    form.businessType,
        ownerName:       form.ownerName.trim(),
        phone:           form.phone.trim(),
        email:           form.email.trim() || form.ownerEmail,
        taxPin:          form.taxPin.trim(),
        vatRate:         parseFloat(form.vatRate) || 16,
        currency:        form.currency,
        logoUrl,
        branchName:      form.branchName.trim(),
        branchAddress:   form.branchAddress.trim(),
        branchCity:      form.branchCity.trim(),
        branchPhone:     form.branchPhone.trim(),
        ownerEmail:      form.ownerEmail,
        ownerPinHash:    hashPin(form.ownerPin),
        mustChangePassword: true,
      });

      navigate('/dashboard');
    } catch (err: any) {
      setError(err.message ?? 'Setup failed — please try again.');
    } finally {
      setLoading(false);
    }
  }

  // ── Shared input styles ─────────────────────────────────────────────────────
  const inputCls =
    'w-full bg-[#0f172a] border border-[#1e293b] rounded-xl px-4 py-3 text-white placeholder-[#334155] ' +
    'focus:outline-none focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]/30 transition-all text-sm';

  const labelCls = 'block text-xs font-medium text-[#64748b] mb-1.5 tracking-wide uppercase';

  return (
    <div className="min-h-screen bg-[#080c14] flex items-center justify-center px-4 py-8">

      {/* Background grid */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          backgroundImage: `linear-gradient(rgba(59,130,246,0.03) 1px, transparent 1px),
                            linear-gradient(90deg, rgba(59,130,246,0.03) 1px, transparent 1px)`,
          backgroundSize: '48px 48px',
        }}
      />

      <div className="w-full max-w-lg relative">

        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-lg bg-[#22c55e] flex items-center justify-center text-[#0f172a] font-black text-sm">S</div>
            <span className="text-xl font-bold text-white tracking-tight">SwiftPOS</span>
          </div>
          <p className="text-[#334155] text-sm">New business setup — agent onboarding</p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-0 mb-8">
          {STEPS.map((s, i) => (
            <div key={s.num} className="flex items-center">
              <div className="flex flex-col items-center">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-300 ${
                    step > s.num
                      ? 'bg-[#22c55e] text-[#0f172a]'
                      : step === s.num
                      ? 'bg-[#3b82f6] text-white ring-4 ring-[#3b82f6]/20'
                      : 'bg-[#0f172a] border border-[#1e293b] text-[#334155]'
                  }`}
                >
                  {step > s.num ? '✓' : s.num}
                </div>
                <span
                  className={`text-[10px] mt-1.5 font-medium whitespace-nowrap ${
                    step === s.num ? 'text-[#93c5fd]' : step > s.num ? 'text-[#22c55e]' : 'text-[#334155]'
                  }`}
                >
                  {s.label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div
                  className={`w-16 h-px mx-2 mb-5 transition-all duration-500 ${
                    step > s.num ? 'bg-[#22c55e]' : 'bg-[#1e293b]'
                  }`}
                />
              )}
            </div>
          ))}
        </div>

        {/* Card */}
        <div className="bg-[#0d1424] border border-[#1e293b] rounded-2xl overflow-hidden shadow-2xl">

          {/* ── STEP 1: Business profile ──────────────────────────────────── */}
          {step === 1 && (
            <div className="p-8 space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-white">Business profile</h2>
                <p className="text-[#475569] text-xs mt-1">Core details about the business you're setting up.</p>
              </div>

              {/* Logo upload */}
              <div>
                <label className={labelCls}>Logo <span className="normal-case text-[#334155]">(optional)</span></label>
                <div
                  className="flex items-center gap-4 p-4 border border-dashed border-[#1e293b] rounded-xl cursor-pointer hover:border-[#334155] transition-colors"
                  onClick={() => fileRef.current?.click()}
                >
                  {form.logoPreview ? (
                    <img src={form.logoPreview} alt="logo" className="w-12 h-12 rounded-lg object-cover" />
                  ) : (
                    <div className="w-12 h-12 rounded-lg bg-[#0f172a] border border-[#1e293b] flex items-center justify-center text-[#334155] text-xl">
                      🏢
                    </div>
                  )}
                  <div>
                    <p className="text-sm text-[#64748b]">{form.logoPreview ? 'Change logo' : 'Upload logo'}</p>
                    <p className="text-xs text-[#334155] mt-0.5">PNG, JPG up to 2MB</p>
                  </div>
                </div>
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleLogoChange} />
              </div>

              {/* Business name + Owner name side by side */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Business name <span className="text-red-400">*</span></label>
                  <input
                    className={inputCls}
                    placeholder="e.g. Mama Oliech's"
                    value={form.businessName}
                    onChange={e => set('businessName', e.target.value)}
                    autoFocus
                  />
                </div>
                <div>
                  <label className={labelCls}>Owner name <span className="text-red-400">*</span></label>
                  <input
                    className={inputCls}
                    placeholder="e.g. John Kamau"
                    value={form.ownerName}
                    onChange={e => set('ownerName', e.target.value)}
                  />
                </div>
              </div>

              {/* Business type */}
              <div>
                <label className={labelCls}>Business type <span className="text-red-400">*</span></label>
                <div className="grid grid-cols-2 gap-2">
                  {BUSINESS_TYPES.map(t => (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => set('businessType', t.value)}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-all ${
                        form.businessType === t.value
                          ? 'bg-[#3b82f6]/10 border-[#3b82f6]/50 text-white'
                          : 'bg-[#0f172a] border-[#1e293b] text-[#64748b] hover:border-[#334155]'
                      }`}
                    >
                      <span className="text-lg flex-shrink-0">{t.icon}</span>
                      <div className="min-w-0">
                        <div className={`text-xs font-semibold truncate ${form.businessType === t.value ? 'text-[#93c5fd]' : 'text-[#94a3b8]'}`}>
                          {t.label}
                        </div>
                        <div className="text-[10px] text-[#334155] truncate">{t.desc}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Phone + Email */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Business phone</label>
                  <input
                    className={inputCls}
                    placeholder="07XX XXX XXX"
                    value={form.phone}
                    onChange={e => set('phone', e.target.value)}
                  />
                </div>
                <div>
                  <label className={labelCls}>Business email</label>
                  <input
                    className={inputCls}
                    placeholder="info@business.com"
                    value={form.email}
                    onChange={e => set('email', e.target.value)}
                    type="email"
                  />
                </div>
              </div>

              {/* Tax PIN + VAT + Currency */}
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className={labelCls}>KRA PIN</label>
                  <input
                    className={inputCls}
                    placeholder="P0512345678A"
                    value={form.taxPin}
                    onChange={e => set('taxPin', e.target.value.toUpperCase())}
                  />
                </div>
                <div>
                  <label className={labelCls}>VAT rate %</label>
                  <input
                    className={inputCls}
                    type="number"
                    min="0"
                    max="30"
                    value={form.vatRate}
                    onChange={e => set('vatRate', e.target.value)}
                  />
                </div>
                <div>
                  <label className={labelCls}>Currency</label>
                  <select
                    className={inputCls + ' cursor-pointer'}
                    value={form.currency}
                    onChange={e => set('currency', e.target.value)}
                  >
                    {CURRENCIES.map(c => (
                      <option key={c.value} value={c.value}>{c.value}</option>
                    ))}
                  </select>
                </div>
              </div>

              <button
                disabled={!step1Valid()}
                onClick={() => setStep(2)}
                className="w-full py-3 rounded-xl font-semibold text-sm transition-all bg-[#3b82f6] hover:bg-[#2563eb] text-white disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Continue to branch setup →
              </button>
            </div>
          )}

          {/* ── STEP 2: First branch ──────────────────────────────────────── */}
          {step === 2 && (
            <div className="p-8 space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-white">First branch</h2>
                <p className="text-[#475569] text-xs mt-1">Most businesses start with one location. More can be added in Settings.</p>
              </div>

              {/* Business type reminder */}
              <div className="flex items-center gap-3 px-4 py-3 bg-[#0f172a] border border-[#1e293b] rounded-xl">
                <span className="text-xl">{BUSINESS_TYPES.find(t => t.value === form.businessType)?.icon}</span>
                <div>
                  <p className="text-sm font-medium text-white">{form.businessName}</p>
                  <p className="text-xs text-[#475569]">{BUSINESS_TYPES.find(t => t.value === form.businessType)?.label}</p>
                </div>
                <button
                  onClick={() => setStep(1)}
                  className="ml-auto text-xs text-[#334155] hover:text-[#64748b] transition-colors"
                >
                  Edit
                </button>
              </div>

              <div>
                <label className={labelCls}>Branch name <span className="text-red-400">*</span></label>
                <input
                  className={inputCls}
                  placeholder="e.g. Main Branch, Westlands"
                  value={form.branchName}
                  onChange={e => set('branchName', e.target.value)}
                  autoFocus
                />
                <p className="text-[10px] text-[#334155] mt-1.5">This will be marked as your main branch.</p>
              </div>

              <div>
                <label className={labelCls}>Street address</label>
                <input
                  className={inputCls}
                  placeholder="e.g. 123 Moi Avenue"
                  value={form.branchAddress}
                  onChange={e => set('branchAddress', e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>City / Town</label>
                  <input
                    className={inputCls}
                    placeholder="e.g. Nairobi"
                    value={form.branchCity}
                    onChange={e => set('branchCity', e.target.value)}
                  />
                </div>
                <div>
                  <label className={labelCls}>Branch phone</label>
                  <input
                    className={inputCls}
                    placeholder="07XX XXX XXX"
                    value={form.branchPhone}
                    onChange={e => set('branchPhone', e.target.value)}
                  />
                </div>
              </div>

              {/* What gets auto-created */}
              <div className="bg-[#0f172a] border border-[#1e293b] rounded-xl p-4 space-y-1.5">
                <p className="text-[10px] font-semibold text-[#475569] uppercase tracking-wide mb-2">Auto-created on save</p>
                {['Admin, Manager & Cashier roles', 'Default permissions per role', 'Branch linked to business'].map(item => (
                  <div key={item} className="flex items-center gap-2">
                    <span className="text-[#22c55e] text-xs">✓</span>
                    <span className="text-xs text-[#475569]">{item}</span>
                  </div>
                ))}
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setStep(1)}
                  className="flex-1 py-3 rounded-xl font-medium text-sm bg-[#0f172a] border border-[#1e293b] text-[#64748b] hover:border-[#334155] transition-all"
                >
                  ← Back
                </button>
                <button
                  disabled={!step2Valid()}
                  onClick={() => setStep(3)}
                  className="flex-[2] py-3 rounded-xl font-semibold text-sm bg-[#3b82f6] hover:bg-[#2563eb] text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                >
                  Continue to owner access →
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 3: Owner credentials ─────────────────────────────────── */}
          {step === 3 && (
            <div className="p-8 space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-white">Owner access</h2>
                <p className="text-[#475569] text-xs mt-1">
                  These credentials get handed to <strong className="text-[#94a3b8] font-medium">{form.ownerName}</strong>.
                  They'll be prompted to change their password on first login.
                </p>
              </div>

              {/* Dashboard login */}
              <div className="space-y-4 pb-5 border-b border-[#1e293b]">
                <p className="text-xs font-semibold text-[#475569] uppercase tracking-wide">Dashboard login (email + password)</p>

                <div>
                  <label className={labelCls}>Owner email <span className="text-red-400">*</span></label>
                  <input
                    className={inputCls + (form.ownerEmail && !validateEmail(form.ownerEmail) ? ' border-red-500/50' : '')}
                    type="email"
                    placeholder="owner@business.com"
                    value={form.ownerEmail}
                    onChange={e => set('ownerEmail', e.target.value)}
                    autoFocus
                  />
                  {form.ownerEmail && !validateEmail(form.ownerEmail) && (
                    <p className="text-[10px] text-red-400 mt-1">Enter a valid email address</p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelCls}>Password <span className="text-red-400">*</span></label>
                    <div className="relative">
                      <input
                        className={inputCls + ' pr-10'}
                        type={showPassword ? 'text' : 'password'}
                        placeholder="Min. 8 characters"
                        value={form.ownerPassword}
                        onChange={e => set('ownerPassword', e.target.value)}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(p => !p)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-[#334155] hover:text-[#64748b] text-xs"
                      >
                        {showPassword ? 'hide' : 'show'}
                      </button>
                    </div>
                    {form.ownerPassword && form.ownerPassword.length < 8 && (
                      <p className="text-[10px] text-red-400 mt-1">At least 8 characters</p>
                    )}
                  </div>
                  <div>
                    <label className={labelCls}>Confirm password <span className="text-red-400">*</span></label>
                    <input
                      className={inputCls + (form.ownerPasswordConfirm && form.ownerPassword !== form.ownerPasswordConfirm ? ' border-red-500/50' : '')}
                      type={showPassword ? 'text' : 'password'}
                      placeholder="Repeat password"
                      value={form.ownerPasswordConfirm}
                      onChange={e => set('ownerPasswordConfirm', e.target.value)}
                    />
                    {form.ownerPasswordConfirm && form.ownerPassword !== form.ownerPasswordConfirm && (
                      <p className="text-[10px] text-red-400 mt-1">Passwords don't match</p>
                    )}
                  </div>
                </div>

                {/* Password strength */}
                {form.ownerPassword.length > 0 && (
                  <div className="space-y-1">
                    <div className="flex gap-1">
                      {[1,2,3,4].map(i => (
                        <div
                          key={i}
                          className={`h-1 flex-1 rounded-full transition-all ${
                            form.ownerPassword.length >= i * 3
                              ? form.ownerPassword.length >= 12 ? 'bg-[#22c55e]'
                              : form.ownerPassword.length >= 8 ? 'bg-[#f59e0b]'
                              : 'bg-[#ef4444]'
                              : 'bg-[#1e293b]'
                          }`}
                        />
                      ))}
                    </div>
                    <p className="text-[10px] text-[#475569]">
                      {form.ownerPassword.length < 8 ? 'Too short'
                        : form.ownerPassword.length < 12 ? 'Acceptable'
                        : 'Strong'}
                    </p>
                  </div>
                )}
              </div>

              {/* POS PIN */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-[#475569] uppercase tracking-wide">POS terminal PIN (4 digits)</p>
                  <button
                    type="button"
                    onClick={() => setShowPin(p => !p)}
                    className="text-[10px] text-[#334155] hover:text-[#64748b] transition-colors"
                  >
                    {showPin ? 'hide digits' : 'show digits'}
                  </button>
                </div>

                <p className="text-xs text-[#334155] -mt-2">
                  Used to unlock the cashier screen — separate from the dashboard password.
                </p>

                {/* PIN entry toggle */}
                <div className="flex gap-2 mb-3">
                  {(['pin', 'confirm'] as const).map(p => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPinEntry(p)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                        pinEntry === p
                          ? 'bg-[#3b82f6]/10 border-[#3b82f6]/40 text-[#93c5fd]'
                          : 'bg-[#0f172a] border-[#1e293b] text-[#334155]'
                      }`}
                    >
                      {p === 'pin' ? 'Set PIN' : 'Confirm PIN'}
                      {p === 'pin' && form.ownerPin.length === 4 && (
                        <span className="ml-1.5 text-[#22c55e]">✓</span>
                      )}
                      {p === 'confirm' && form.ownerPinConfirm.length === 4 && form.ownerPin === form.ownerPinConfirm && (
                        <span className="ml-1.5 text-[#22c55e]">✓</span>
                      )}
                    </button>
                  ))}
                </div>

                {/* PIN dot display */}
                <div className="flex items-center justify-center gap-4 mb-4">
                  {[0,1,2,3].map(i => {
                    const currentPin = pinEntry === 'pin' ? form.ownerPin : form.ownerPinConfirm;
                    const filled = i < currentPin.length;
                    const mismatch = pinEntry === 'confirm' && form.ownerPinConfirm.length === 4 && form.ownerPin !== form.ownerPinConfirm;
                    return (
                      <div
                        key={i}
                        className={`w-4 h-4 rounded-full border-2 transition-all duration-150 ${
                          mismatch ? 'bg-red-500 border-red-500'
                          : filled ? 'bg-[#3b82f6] border-[#3b82f6] scale-110'
                          : 'bg-transparent border-[#334155]'
                        }`}
                      >
                        {showPin && filled && (
                          <span className="absolute text-[8px] font-bold text-white" style={{marginLeft:3,marginTop:-1}}>
                            {(pinEntry === 'pin' ? form.ownerPin : form.ownerPinConfirm)[i]}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* PIN pad */}
                <div className="grid grid-cols-3 gap-2 max-w-[220px] mx-auto">
                  {['7','8','9','4','5','6','1','2','3','','0','⌫'].map((key, i) => (
                    key === '' ? (
                      <div key={i} />
                    ) : (
                      <button
                        key={i}
                        type="button"
                        onClick={() => handlePinKey(key, pinEntry === 'pin' ? 'ownerPin' : 'ownerPinConfirm')}
                        className={`py-2.5 rounded-xl border text-sm font-semibold transition-all active:scale-95 ${
                          key === '⌫'
                            ? 'bg-[#0f172a] border-[#1e293b] text-[#475569] hover:border-[#334155]'
                            : 'bg-[#0f172a] border-[#1e293b] text-white hover:bg-[#1e293b] hover:border-[#334155]'
                        }`}
                      >
                        {key}
                      </button>
                    )
                  ))}
                </div>

                {form.ownerPin.length === 4 && form.ownerPinConfirm.length === 4 && form.ownerPin !== form.ownerPinConfirm && (
                  <p className="text-[10px] text-red-400 text-center">PINs don't match — please re-enter</p>
                )}
              </div>

              {error && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
                  <p className="text-red-400 text-sm">{error}</p>
                </div>
              )}

              {/* Force change notice */}
              <div className="flex items-start gap-2.5 px-3 py-2.5 bg-[#0f172a] border border-[#1e293b] rounded-xl">
                <span className="text-yellow-400 text-sm mt-0.5 flex-shrink-0">⚠</span>
                <p className="text-xs text-[#475569] leading-relaxed">
                  Owner will be asked to <strong className="text-[#64748b] font-medium">change their password</strong> on first login. Their PIN can be updated anytime in Settings.
                </p>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setStep(2)}
                  className="flex-1 py-3 rounded-xl font-medium text-sm bg-[#0f172a] border border-[#1e293b] text-[#64748b] hover:border-[#334155] transition-all"
                >
                  ← Back
                </button>
                <button
                  disabled={loading || !step3Valid()}
                  onClick={handleSubmit}
                  className="flex-[2] py-3 rounded-xl font-bold text-sm bg-[#22c55e] hover:bg-[#16a34a] text-[#0f172a] disabled:opacity-30 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <>
                      <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                      </svg>
                      Creating business…
                    </>
                  ) : (
                    '🚀 Complete setup'
                  )}
                </button>
              </div>
            </div>
          )}

        </div>

        {/* Footer */}
        <p className="text-center text-[#1e293b] text-xs mt-6">
          SwiftPOS · Credentials will be shared with the business owner after setup
        </p>

      </div>
    </div>
  );
}
