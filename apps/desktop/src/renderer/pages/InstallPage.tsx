import { useState } from 'react';
import { posApi } from '../lib/posApi';
import type { DeployMode, DeviceRole } from '../lib/posApi';

interface Props {
  // Called once the device config has been written. App.tsx then re-runs its
  // normal boot path (owner session check -> login).
  onComplete: () => void;
}

// Mirrors the web onboarding selector exactly — same values, labels and order.
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

type Step = 'connection' | 'activate' | 'bind';
interface Branch { id: string; name: string }

export default function InstallPage({ onComplete }: Props) {
  const [step, setStep] = useState<Step>('connection');

  // ── Step 1: connection ──
  const [mode, setMode] = useState<DeployMode>('cloud');
  const [serverUrl, setServerUrl] = useState('');
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);

  // ── Step 2: activation (owner sign-in confirms the business online) ──
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [activating, setActivating] = useState(false);
  const [businessName, setBusinessName] = useState('');
  const [branches, setBranches] = useState<Branch[]>([]);

  // ── Step 3: bind branch + role ──
  const [branchId, setBranchId] = useState('');
  const [role, setRole] = useState<DeviceRole>('till');
  const [nodeUrl, setNodeUrl] = useState('');
  const [businessType, setBusinessType] = useState('retail');
  const [deviceName, setDeviceName] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const cleanUrl = serverUrl.trim().replace(/\/+$/, '');
  const urlValid = /^https?:\/\//i.test(cleanUrl);
  const urlPlaceholder = mode === 'local' ? LOCAL_URL_HINT : CLOUD_URL_HINT;

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
    setTesting(true); setTestMsg(null);
    try {
      const r = await posApi.config.testConnection(cleanUrl);
      if (r.ok || r.reachable) {
        setTestMsg({ kind: 'ok', text: `Server reachable${r.status ? ` (HTTP ${r.status})` : ''}.` });
      } else {
        setTestMsg({ kind: 'warn', text: `Couldn't reach server${r.error ? `: ${r.error}` : ''}.` });
      }
    } catch (err: any) {
      setTestMsg({ kind: 'warn', text: `Couldn't reach server: ${err?.message ?? 'unknown error'}.` });
    } finally {
      setTesting(false);
    }
  };

  // Step 1 → 2: persist the URL/mode (NOT configured yet) so owner login can
  // reach the server, then move to activation.
  const goToActivate = async () => {
    if (!urlValid) { setError('Server URL must start with http:// or https://'); return; }
    setError('');
    try {
      await posApi.config.save({ deploy_mode: mode, server_url: cleanUrl, configured: false });
      setStep('activate');
    } catch (err: any) {
      setError(err?.message ?? 'Could not save server settings');
    }
  };

  // Step 2: owner signs in ONLINE — confirms the business is real before we bind
  // the install to one of its branches. Uses desktop-login (no web-access gate),
  // so offline-only businesses activate too.
  const activate = async () => {
    if (!email.trim() || !password) { setError('Enter the owner email and password'); return; }
    setActivating(true); setError('');
    try {
      const { business } = await posApi.auth.login(email.trim(), password);
      setBusinessName(business?.name ?? '');
      const list = await posApi.auth.listBranches();
      setBranches(list.map(b => ({ id: b.id, name: b.name })));
      if (list.length) setBranchId(list[0].id);
      if (business?.type) setBusinessType(business.type);
      setStep('bind');
    } catch (err: any) {
      setError(err?.message ?? 'Activation failed — check the owner credentials and connection.');
    } finally {
      setActivating(false);
    }
  };

  // Step 3: write the final config, binding this install to a branch + role.
  const complete = async () => {
    if (!branchId) { setError('Select the branch this device belongs to'); return; }
    if (role === 'till' && nodeUrl.trim() && !/^https?:\/\//i.test(nodeUrl.trim())) {
      setError('Aggregation node address must start with http:// or https://'); return;
    }
    setSaving(true); setError('');
    try {
      await posApi.config.save({
        deploy_mode: mode,
        server_url: cleanUrl,
        branch_id: branchId,
        device_role: role,
        node_url: role === 'till' ? (nodeUrl.trim().replace(/\/+$/, '') || null) : null,
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
    <button onClick={() => switchMode(m)}
      className={`flex-1 text-left rounded-xl border px-4 py-3 transition-colors ${
        mode === m ? 'border-green-500 bg-green-500/10' : 'border-gray-700 bg-gray-800 hover:border-gray-600'
      }`}>
      <div className={`font-semibold ${mode === m ? 'text-green-400' : 'text-white'}`}>{title}</div>
      <div className="text-xs text-gray-500 mt-0.5">{sub}</div>
    </button>
  );

  const roleBtn = (r: DeviceRole, title: string, sub: string) => (
    <button onClick={() => setRole(r)}
      className={`flex-1 text-left rounded-xl border px-4 py-3 transition-colors ${
        role === r ? 'border-green-500 bg-green-500/10' : 'border-gray-700 bg-gray-800 hover:border-gray-600'
      }`}>
      <div className={`font-semibold ${role === r ? 'text-green-400' : 'text-white'}`}>{title}</div>
      <div className="text-xs text-gray-500 mt-0.5">{sub}</div>
    </button>
  );

  const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-green-500 transition-colors';
  const stepNum = step === 'connection' ? 1 : step === 'activate' ? 2 : 3;

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">

        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold text-green-400">SwiftPOS</h1>
          <p className="text-gray-500 text-sm mt-1">Device setup · step {stepNum} of 3</p>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 space-y-5">

          {/* ── STEP 1: connection ── */}
          {step === 'connection' && (
            <>
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
                <input type="text" value={serverUrl} autoFocus
                  onChange={e => { setServerUrl(e.target.value); setTestMsg(null); }}
                  placeholder={urlPlaceholder} className={`${inputCls} font-mono text-sm`} />
                <button onClick={testConnection} disabled={testing || !urlValid}
                  className="mt-2 text-xs text-green-400 hover:text-green-300 disabled:opacity-40 disabled:cursor-not-allowed">
                  {testing ? 'Testing…' : 'Test connection'}
                </button>
                {testMsg && (
                  <p className={`text-xs mt-2 rounded-lg px-3 py-2 border ${
                    testMsg.kind === 'ok' ? 'text-green-400 bg-green-400/10 border-green-400/20'
                                          : 'text-amber-400 bg-amber-400/10 border-amber-400/20'}`}>
                    {testMsg.text}
                  </p>
                )}
              </div>
              <button onClick={goToActivate} disabled={!urlValid}
                className="w-full bg-green-500 hover:bg-green-400 disabled:opacity-40 disabled:cursor-not-allowed text-gray-950 font-bold rounded-xl py-3 transition-colors">
                Continue
              </button>
            </>
          )}

          {/* ── STEP 2: activation (confirm business online) ── */}
          {step === 'activate' && (
            <>
              <div>
                <p className="text-sm text-gray-300 font-medium">Activate this device</p>
                <p className="text-xs text-gray-500 mt-1">
                  Sign in once with the owner account to confirm the business and load its branches.
                  Requires internet for this step only.
                </p>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Owner email</label>
                <input type="email" value={email} autoFocus onChange={e => setEmail(e.target.value)}
                  placeholder="owner@business.com" className={inputCls} />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Owner password</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && activate()} placeholder="••••••••" className={inputCls} />
              </div>
              {error && <p className="text-red-400 text-sm bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-2.5">{error}</p>}
              <div className="flex gap-3">
                <button onClick={() => { setStep('connection'); setError(''); }}
                  className="px-4 bg-gray-800 hover:bg-gray-700 text-white rounded-xl py-3 text-sm transition-colors">Back</button>
                <button onClick={activate} disabled={activating}
                  className="flex-1 bg-green-500 hover:bg-green-400 disabled:opacity-40 text-gray-950 font-bold rounded-xl py-3 transition-colors">
                  {activating ? 'Activating…' : 'Activate'}
                </button>
              </div>
            </>
          )}

          {/* ── STEP 3: bind branch + role ── */}
          {step === 'bind' && (
            <>
              {businessName && (
                <p className="text-xs text-green-400 bg-green-400/10 border border-green-400/20 rounded-lg px-3 py-2">
                  Activated for <span className="font-semibold">{businessName}</span>
                </p>
              )}
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Branch</label>
                <select value={branchId} onChange={e => setBranchId(e.target.value)} className={inputCls}>
                  {branches.length === 0 && <option value="">No branches found</option>}
                  {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                <p className="text-xs text-gray-600 mt-1.5">This device is bound to one branch. All its sales belong here.</p>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Device role</label>
                <div className="flex gap-3">
                  {roleBtn('till', 'Till', 'A point of sale terminal')}
                  {roleBtn('node', 'Branch server', 'Other tills sync to this one')}
                </div>
              </div>
              {role === 'till' && (
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">
                    Branch server address <span className="text-gray-600">(optional)</span>
                  </label>
                  <input type="text" value={nodeUrl} onChange={e => setNodeUrl(e.target.value)}
                    placeholder="http://192.168.1.100:4000" className={`${inputCls} font-mono text-sm`} />
                  <p className="text-xs text-gray-600 mt-1.5">
                    The branch server till this one pushes to for combined manager reports. Leave blank for a single-till branch.
                  </p>
                </div>
              )}
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Business type</label>
                <select value={businessType} onChange={e => setBusinessType(e.target.value)} className={inputCls}>
                  {BUSINESS_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Device name <span className="text-gray-600">(optional)</span></label>
                <input type="text" value={deviceName} onChange={e => setDeviceName(e.target.value)}
                  placeholder="Front till 1" className={inputCls} />
              </div>
              {error && <p className="text-red-400 text-sm bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-2.5">{error}</p>}
              <button onClick={complete} disabled={saving || !branchId}
                className="w-full bg-green-500 hover:bg-green-400 disabled:opacity-40 disabled:cursor-not-allowed text-gray-950 font-bold rounded-xl py-3 transition-colors">
                {saving ? 'Saving…' : 'Complete setup'}
              </button>
              <p className="text-xs text-gray-600 text-center">
                After setup this screen locks. Changing it again requires a technician.
              </p>
            </>
          )}
        </div>

        <p className="text-center text-gray-700 text-xs mt-6">
          SwiftPOS v{posApi.version} · {posApi.platform}
        </p>
      </div>
    </div>
  );
}
