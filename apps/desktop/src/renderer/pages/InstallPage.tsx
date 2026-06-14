import { useState } from 'react';
import { posApi } from '../lib/posApi';
import type { DeployMode } from '../lib/posApi';

interface Props {
  // Called once the device config has been written. App.tsx then re-runs its
  // normal boot path (owner session check -> login).
  onComplete: () => void;
}

// Mirrors the web onboarding selector (OnboardingPage.tsx) exactly — same values,
// labels and order — so the desktop offers the full platform range. NOTE: the
// till renders the flat retail grid for ALL of these today; Phase 1 ports the
// web's deriveMode branching (CashierScreen.tsx) so each type gets its own
// interface (restaurant tables/KOT, petrol pumps, parking bays, etc.). The
// default stays 'retail' below — the one mode whose screen renders correctly now.
const BUSINESS_TYPES: { value: string; label: string }[] = [
  { value: 'restaurant',     label: 'Restaurant' },
  { value: 'cafe',           label: 'Café' },
  { value: 'retail',         label: 'Retail' },
  { value: 'minimart',       label: 'Minimart' },
  { value: 'parking',        label: 'Parking Lot' },
  { value: 'petrol_station', label: 'Petrol Station' },
  { value: 'other',          label: 'Other' },
];

const LOCAL_URL_HINT = 'http://192.168.1.100:4000';
const CLOUD_URL_HINT = 'https://api.your-swiftpos-domain.com';

export default function InstallPage({ onComplete }: Props) {
  const [mode, setMode] = useState<DeployMode>('cloud');
  const [serverUrl, setServerUrl] = useState('');
  const [businessType, setBusinessType] = useState('retail');
  const [deviceName, setDeviceName] = useState('');

  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const urlPlaceholder = mode === 'local' ? LOCAL_URL_HINT : CLOUD_URL_HINT;
  const urlValid = /^https?:\/\//i.test(serverUrl.trim());

  // Switching mode pre-fills a sensible default only if the field is empty or
  // still holds the other mode's hint — never clobbers something the tech typed.
  const switchMode = (next: DeployMode) => {
    setMode(next);
    setTestMsg(null);
    setServerUrl(prev => {
      const t = prev.trim();
      if (t === '' || t === LOCAL_URL_HINT || t === CLOUD_URL_HINT) {
        return next === 'local' ? LOCAL_URL_HINT : '';
      }
      return prev;
    });
  };

  const testConnection = async () => {
    if (!urlValid) { setTestMsg({ kind: 'warn', text: 'Enter a valid URL first (http:// or https://).' }); return; }
    setTesting(true);
    setTestMsg(null);
    try {
      const r = await posApi.config.testConnection(serverUrl.trim());
      if (r.ok || r.reachable) {
        setTestMsg({ kind: 'ok', text: `Server reachable${r.status ? ` (HTTP ${r.status})` : ''}.` });
      } else {
        setTestMsg({ kind: 'warn', text: `Couldn't reach server${r.error ? `: ${r.error}` : ''}. You can still continue if the server PC isn't running yet.` });
      }
    } catch (err: any) {
      setTestMsg({ kind: 'warn', text: `Couldn't reach server: ${err?.message ?? 'unknown error'}. You can still continue.` });
    } finally {
      setTesting(false);
    }
  };

  const complete = async () => {
    if (!urlValid) { setError('Server URL must start with http:// or https://'); return; }
    setSaving(true);
    setError('');
    try {
      await posApi.config.save({
        deploy_mode: mode,
        server_url: serverUrl.trim().replace(/\/+$/, ''),
        business_type: businessType,
        device_name: deviceName.trim() || null,
        configured: true,
      });
      onComplete();
    } catch (err: any) {
      setError(err?.message ?? 'Failed to save configuration');
      setSaving(false);
    }
  };

  const modeBtn = (m: DeployMode, title: string, sub: string) => (
    <button
      onClick={() => switchMode(m)}
      className={`flex-1 text-left rounded-xl border px-4 py-3 transition-colors ${
        mode === m
          ? 'border-green-500 bg-green-500/10'
          : 'border-gray-700 bg-gray-800 hover:border-gray-600'
      }`}
    >
      <div className={`font-semibold ${mode === m ? 'text-green-400' : 'text-white'}`}>{title}</div>
      <div className="text-xs text-gray-500 mt-0.5">{sub}</div>
    </button>
  );

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">

        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-green-400">SwiftPOS</h1>
          <p className="text-gray-500 text-sm mt-1">Device setup — first-run install</p>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 space-y-5">

          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Deployment mode</label>
            <div className="flex gap-3">
              {modeBtn('cloud', 'Cloud', 'Sells against the hosted server')}
              {modeBtn('local', 'Local', 'Server PC on the branch LAN')}
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1.5">
              {mode === 'local' ? 'Local server address' : 'Cloud server URL'}
            </label>
            <input
              type="text"
              value={serverUrl}
              onChange={e => { setServerUrl(e.target.value); setTestMsg(null); }}
              placeholder={urlPlaceholder}
              autoFocus
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-green-500 transition-colors font-mono text-sm"
            />
            <button
              onClick={testConnection}
              disabled={testing || !urlValid}
              className="mt-2 text-xs text-green-400 hover:text-green-300 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            {testMsg && (
              <p className={`text-xs mt-2 rounded-lg px-3 py-2 border ${
                testMsg.kind === 'ok'
                  ? 'text-green-400 bg-green-400/10 border-green-400/20'
                  : 'text-amber-400 bg-amber-400/10 border-amber-400/20'
              }`}>
                {testMsg.text}
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Business type</label>
            <select
              value={businessType}
              onChange={e => setBusinessType(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-green-500 transition-colors"
            >
              {BUSINESS_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            <p className="text-xs text-gray-600 mt-1.5">Determines which till interface this device uses.</p>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Device name <span className="text-gray-600">(optional)</span></label>
            <input
              type="text"
              value={deviceName}
              onChange={e => setDeviceName(e.target.value)}
              placeholder="Front till 1"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-green-500 transition-colors"
            />
          </div>

          {error && (
            <p className="text-red-400 text-sm bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-2.5">
              {error}
            </p>
          )}

          <button
            onClick={complete}
            disabled={saving || !urlValid}
            className="w-full bg-green-500 hover:bg-green-400 disabled:opacity-40 disabled:cursor-not-allowed text-gray-950 font-bold rounded-xl py-3 transition-colors"
          >
            {saving ? 'Saving…' : 'Complete setup'}
          </button>

          <p className="text-xs text-gray-600 text-center">
            After setup this screen locks. Changing it again requires a technician.
          </p>
        </div>

        <p className="text-center text-gray-700 text-xs mt-6">
          SwiftPOS v{posApi.version} · {posApi.platform}
        </p>
      </div>
    </div>
  );
}
