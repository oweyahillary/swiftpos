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

// Mirrors generateNodeSecret() in src/main/deviceConfig.ts — same alphabet and
// grouping, because the branch server displays one and the tills have it typed
// in by hand. No 0/O, no 1/I/L, no U.
const SECRET_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

function makeNodeSecret(): string {
  const buf = new Uint32Array(16);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += SECRET_ALPHABET[buf[i] % SECRET_ALPHABET.length];
    if (i % 4 === 3 && i < 15) out += '-';
  }
  return out;
}

const CLOUD_URL_HINT = 'https://api.your-swiftpos-domain.com';

type Step = 'connection' | 'activate' | 'bind';
interface Branch { id: string; name: string }

export default function InstallPage({ onComplete }: Props) {
  const [step, setStep] = useState<Step>('connection');

  // ── Step 1: connection ──
  // Always 'cloud'. The picker was removed (see step 1) but the value is still
  // written to device_config, where the tech screen reads it back.
  const [mode] = useState<DeployMode>('cloud');
  const [serverUrl, setServerUrl] = useState('');
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);

  // ── Step 2: activation (a single-use enrolment code provisions the till) ──
  // D4/D1: the business is chosen by its ID and authorised by a one-time code the
  // owner issues in the portal — no owner login on the terminal, and a
  // two-business owner is no longer a dead end.
  const [businessIdInput, setBusinessIdInput] = useState('');
  const [enrolCode, setEnrolCode] = useState('');
  const [activating, setActivating] = useState(false);
  const [businessName, setBusinessName] = useState('');
  const [branches, setBranches] = useState<Branch[]>([]);

  // ── Step 3: bind branch + role ──
  const [branchId, setBranchId] = useState('');
  // A69: admin-issued codes are branch-bound. When the code carried a branch, we
  // LOCK it here — the installer confirms placement, they don't get to change it.
  const [branchLocked, setBranchLocked] = useState(false);
  const [role, setRole] = useState<DeviceRole>('till');
  // is typed in from the branch server's screen.
  const [nodeSecret, setNodeSecret] = useState('');
  // Prefixes every bill number. Must differ on each till at a branch.
  const [terminalCode, setTerminalCode] = useState('T1');

  // ── Branch server address: IP typed, port implied ──────────────────────────
  // The port is a constant (nodeServer.ts NODE_PORT = 4100), so asking every
  // installer to type it only creates a chance to type it wrong — and the
  // placeholder here used to read :4000, which is the API port and precisely
  // the "specific, costly mistake" the step 1 comment warns about. A till
  // pointed at the API port gets a 401 from the node relay and appears broken
  // for reasons nothing on screen explains.
  //
  // So: the IP is the only thing typed. The port is shown, fixed, and only
  // becomes editable when someone says the branch server is on a different one
  // — which happens only when 4100 was taken and the node walked to 4101+.
  const NODE_DEFAULT_PORT = 4100;
  const [nodeIp, setNodeIp] = useState('');
  const [nodePort, setNodePort] = useState(String(NODE_DEFAULT_PORT));
  const [customPort, setCustomPort] = useState(false);

  // Derived, never stored as free text. Keeping node_url in device_config as a
  // full URL means nodeClient.ts and every existing consumer are untouched —
  // only what the human types changes.
  const nodeIpTrim = nodeIp.trim();
  const nodePortNum = Number(nodePort);
  const nodeIpValid = /^(\d{1,3}\.){3}\d{1,3}$/.test(nodeIpTrim)
    && nodeIpTrim.split('.').every(o => Number(o) <= 255);
  const nodePortValid = Number.isInteger(nodePortNum) && nodePortNum > 0 && nodePortNum < 65536;
  const composedNodeUrl = nodeIpTrim && nodeIpValid && nodePortValid
    ? `http://${nodeIpTrim}:${nodePortNum}` : null;
  // A branch server is on the shop LAN by definition. A public or loopback
  // address here is always a mistake, and catching it now is cheaper than a
  // till that silently never reaches its node.
  const nodeIpSuspect = nodeIpValid && !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(nodeIpTrim);
  // On a 'node' this is minted here and shown to the technician. On a 'till' it

  // Set by the server at activation (see ipcHandlers desktop-login) and
  // refreshed on every catalogue pull. Read here only so the value already
  // on the device is not overwritten when the rest of the config is saved.
  const [businessType, setBusinessType] = useState<string>('');
  const [deviceName, setDeviceName] = useState('');

  // Set only by a 2xx response from the health check. Gates Continue so a wrong
  // URL cannot be saved silently — the previous flow let you straight through
  // and the failure surfaced two screens later as a JSON parse error.
  const [verified, setVerified] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const cleanUrl = serverUrl.trim().replace(/\/+$/, '');
  const urlValid = /^https?:\/\//i.test(cleanUrl);
  const urlPlaceholder = CLOUD_URL_HINT;


  const testConnection = async () => {
    if (!urlValid) { setTestMsg({ kind: 'warn', text: 'Enter a valid URL first (http:// or https://).' }); return; }
    setTesting(true); setTestMsg(null);
    try {
      const r = await posApi.config.testConnection(cleanUrl);
      if (r.ok) {
        setVerified(true);
        setTestMsg({ kind: 'ok', text: 'Connected — SwiftPOS server responded.' });
      } else if (r.reachable) {
        // Something answered, but it is not our /health endpoint. By far the
        // most common cause is a URL carrying an extra path, e.g. pasting the
        // /health URL itself, or a LAN address where some other device replies.
        setVerified(false);
        setTestMsg({
          kind: 'warn',
          text: r.status === 404
            ? `Something answered but it is not the SwiftPOS server (HTTP 404). Check the address is the base URL only — no /health or other path on the end.`
            : `Reachable but unhealthy (HTTP ${r.status}). The server is up but not responding correctly.`,
        });
      } else {
        setVerified(false);
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

  // Step 2: redeem a single-use enrolment code ONLINE — confirms the business is
  // real and provisions a device session before we bind the install to a branch.
  // Uses /enrol/redeem (no owner credentials, no web-access gate), so an
  // offline-only business activates too.
  const activate = async () => {
    if (!businessIdInput.trim() || !enrolCode.trim()) { setError('Enter the business ID and the enrolment code'); return; }
    setActivating(true); setError('');
    try {
      const { business, branchId: boundBranch } =
        await posApi.auth.redeemEnrolment(businessIdInput.trim(), enrolCode.trim());
      setBusinessName(business?.name ?? '');
      const list = await posApi.auth.listBranches();
      setBranches(list.map(b => ({ id: b.id, name: b.name })));
      // If the code was issued bound to a branch, pre-select AND lock it (A69);
      // else fall back to a picker (legacy/unbound codes).
      if (boundBranch && list.some(b => b.id === boundBranch)) { setBranchId(boundBranch); setBranchLocked(true); }
      else if (list.length) { setBranchId(list[0].id); setBranchLocked(false); }
      if (business?.type) setBusinessType(business.type);
      setStep('bind');
    } catch (err: any) {
      setError(err?.message ?? 'Enrolment failed — check the business ID, the code, and the connection.');
    } finally {
      setActivating(false);
    }
  };

  // Step 3: write the final config, binding this install to a branch + role.
  const complete = async () => {
    if (!branchId) { setError('Select the branch this device belongs to'); return; }
    if (role === 'till' && nodeIpTrim && !composedNodeUrl) {
      setError('Enter the branch server as an IP address, for example 192.168.1.100'); return;
    }
    // A till pointed at a branch server without the access code would be refused
    // on every push and silently stop aggregating, so block it at install time.
    if (!/^[A-Z0-9]{1,4}$/.test(terminalCode.trim().toUpperCase())) {
      setError('Terminal code must be 1–4 letters or digits, e.g. T1'); return;
    }
    if (role === 'till' && nodeIpTrim && !nodeSecret.trim()) {
      setError('Enter the branch server access code — it is shown on that machine\u2019s setup screen'); return;
    }
    setSaving(true); setError('');
    try {
      await posApi.config.save({
        deploy_mode: mode,
        server_url: cleanUrl,
        branch_id: branchId,
        device_role: role,
        node_url: role === 'till' ? composedNodeUrl : null,
        node_secret: nodeSecret.trim().toUpperCase() || null,
        terminal_code: terminalCode.trim().toUpperCase(),
        // Only send it if activation somehow did not — never blank an
        // existing value.
        ...(businessType ? { business_type: businessType } : {}),
        device_name: deviceName.trim() || null,
        configured: true,
      });
      onComplete();
    } catch (err: any) {
      setError(err?.message ?? 'Failed to save configuration');
      setSaving(false);
    }
  };


  const selectRole = (r: DeviceRole) => {
    setRole(r);
    // Mint once, on first selection, so re-clicking Branch server doesn't hand
    // the technician a different code than the one already written down.
    if (r === 'node' && !nodeSecret) setNodeSecret(makeNodeSecret());
  };

  const roleBtn = (r: DeviceRole, title: string, sub: string) => (
    <button onClick={() => selectRole(r)}
      className={`flex-1 text-left rounded-xl border px-4 py-3 transition-colors ${
        role === r ? 'border-green-500 bg-green-500/10' : 'border-gray-700 bg-gray-800 hover:border-gray-600'
      }`}>
      <div className={`font-semibold ${role === r ? 'text-green-400' : 'text-white'}`}>{title}</div>
      <div className="text-xs text-gray-300 mt-0.5">{sub}</div>
    </button>
  );

  const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-400 focus:outline-none focus:border-green-500 transition-colors';
  const stepNum = step === 'connection' ? 1 : step === 'activate' ? 2 : 3;

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">

        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold text-green-400">SwiftPOS</h1>
          <p className="text-gray-300 text-sm mt-1">Device setup · step {stepNum} of 3</p>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 space-y-5">

          {/* ── STEP 1: connection ── */}
          {step === 'connection' && (
            <>
              {/* Deployment mode picker removed.
                  'Local' means the whole API runs on a branch PC — a different
                  architecture that this product does not ship. Offering it here
                  invited a specific, costly mistake: entering the BRANCH SERVER
                  address (port 4100) as the API. The branch server is a relay
                  with three endpoints and no auth routes, so activation got a
                  401 and the till appeared broken for reasons nothing on screen
                  explained.
                  Every till is 'cloud'. The branch server is a separate field at
                  step 3, and only tills 2 and 3 fill it in. */}
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Server address</label>
                <input type="text" value={serverUrl} autoFocus
                  onChange={e => { setServerUrl(e.target.value); setTestMsg(null); setVerified(false); }}
                  placeholder={urlPlaceholder} className={`${inputCls} font-mono text-sm`} />
                {/* Catch the branch-server address before Test connection does,
                    because a 401 from the node server reads as a credentials
                    problem and sends people looking in the wrong place. */}
                {/:4100(\/|$)/.test(serverUrl.trim()) && (
                  <p className="text-xs mt-2 rounded-lg px-3 py-2 border text-amber-400 bg-amber-400/10 border-amber-400/20">
                    That looks like a <span className="font-semibold">branch server</span> address.
                    Port 4100 relays sales between tills — it cannot sign anyone in.
                    Put the hosted server URL here (https://…), and the branch server
                    address at step 3.
                  </p>
                )}
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
              <button onClick={goToActivate} disabled={!urlValid || (!verified && !testMsg)}
                className={`w-full font-bold rounded-xl py-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  verified ? 'bg-green-500 hover:bg-green-400 text-gray-950'
                           : 'bg-amber-500/80 hover:bg-amber-500 text-gray-950'}`}>
                {verified ? 'Continue' : testMsg ? 'Continue anyway' : 'Test connection first'}
              </button>
              {!verified && testMsg && (
                <p className="text-xs text-gray-300 -mt-2">
                  The server did not respond correctly. Fix the address before continuing —
                  a wrong one here means this till cannot sign in, load the menu, or sync.
                </p>
              )}
            </>
          )}

          {/* ── STEP 2: activation (confirm business online) ── */}
          {step === 'activate' && (
            <>
              <div>
                <p className="text-sm text-gray-300 font-medium">Activate this device</p>
                <p className="text-xs text-gray-300 mt-1">
                  Enter the business ID and the one-time enrolment code from the owner portal.
                  Requires internet for this step only.
                </p>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Business ID</label>
                <input type="text" value={businessIdInput} autoFocus onChange={e => setBusinessIdInput(e.target.value)}
                  placeholder="e.g. 3f9a…" className={inputCls} />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Enrolment code</label>
                <input type="text" value={enrolCode} onChange={e => setEnrolCode(e.target.value.toUpperCase())}
                  onKeyDown={e => e.key === 'Enter' && activate()} placeholder="ABCD23WXYZ"
                  autoCapitalize="characters" className={inputCls} />
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
                <select value={branchId} onChange={e => setBranchId(e.target.value)} disabled={branchLocked}
                  className={`${inputCls}${branchLocked ? ' opacity-70 cursor-not-allowed' : ''}`}>
                  {branches.length === 0 && <option value="">No branches found</option>}
                  {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                <p className="text-xs text-gray-400 mt-1.5">
                  {branchLocked
                    ? 'Set by the enrolment code — this device belongs to this branch. All its sales belong here.'
                    : 'This device is bound to one branch. All its sales belong here.'}
                </p>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Device role</label>
                <div className="flex gap-3">
                  {roleBtn('till', 'Till', 'A point of sale terminal')}
                  {roleBtn('node', 'Branch server', 'Other tills sync to this one')}
                  {roleBtn('office', 'Office', 'Branch server that cannot sell — reports and day close only')}
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Terminal code</label>
                <input type="text" value={terminalCode} maxLength={4}
                  onChange={e => setTerminalCode(e.target.value.toUpperCase())}
                  placeholder="T1"
                  className={`${inputCls} font-mono text-sm tracking-widest`} />
                <p className="text-xs text-gray-400 mt-1.5">
                  Prefixes every bill number from this till, e.g. <span className="font-mono">T1--1042</span>.
                  <span className="text-amber-400/80"> Each till at this branch must have a different code</span> — T1, T2, T3 — or their bill numbers will collide.
                </p>
              </div>

              {role === 'node' && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
                  <label className="block text-sm text-amber-300 mb-1.5">Branch access code</label>
                  <div className="font-mono text-lg tracking-widest text-white select-all break-all">{nodeSecret}</div>
                  <p className="text-xs text-amber-200/70 mt-2">
                    Write this down now. Every other till at this branch must be given the same code
                    during its setup, or it will not be able to sync to this machine.
                  </p>
                </div>
              )}
              {role === 'till' && (
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">
                    Branch server address <span className="text-gray-400">(optional)</span>
                  </label>
                  <div className="flex gap-2 items-start">
                    <input type="text" value={nodeIp} inputMode="decimal"
                      onChange={e => setNodeIp(e.target.value)}
                      placeholder="192.168.1.100"
                      className={`${inputCls} font-mono text-sm flex-1`} />
                    <div className="flex items-center gap-1.5 pt-2.5 text-gray-400 font-mono text-sm">
                      <span>:</span>
                      {customPort ? (
                        <input type="text" value={nodePort} inputMode="numeric" maxLength={5}
                          onChange={e => setNodePort(e.target.value.replace(/\D/g, ''))}
                          className={`${inputCls} font-mono text-sm w-20 py-2`} />
                      ) : (
                        <span className="px-2 py-2 rounded-lg bg-gray-800 text-gray-500 select-none">
                          {NODE_DEFAULT_PORT}
                        </span>
                      )}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 mt-2 text-xs text-gray-400 cursor-pointer">
                    <input type="checkbox" checked={customPort}
                      onChange={e => {
                        setCustomPort(e.target.checked);
                        if (!e.target.checked) setNodePort(String(NODE_DEFAULT_PORT));
                      }}
                      className="accent-green-500" />
                    The branch server is on a different port
                  </label>
                  <p className="text-xs text-gray-400 mt-1.5">
                    The branch server till this one pushes to for combined manager reports. Enter its
                    IP address only &mdash; the port is fixed. Leave blank for a single-till branch.
                  </p>
                  {nodeIpTrim !== '' && !nodeIpValid && (
                    <p className="text-xs text-amber-300 mt-1.5">
                      That is not a valid IP address. It should look like 192.168.1.100.
                    </p>
                  )}
                  {nodeIpSuspect && (
                    <p className="text-xs text-amber-300 mt-1.5">
                      {nodeIpTrim.startsWith('127.') || nodeIpTrim === '0.0.0.0'
                        ? 'That address points at this machine, not another till.'
                        : 'That does not look like a local network address. The branch server is on the shop LAN — usually 192.168.x.x or 10.x.x.x.'}
                    </p>
                  )}
                  {composedNodeUrl && !nodeIpSuspect && (
                    <p className="text-xs text-gray-500 mt-1.5 font-mono">
                      Will connect to {composedNodeUrl}
                    </p>
                  )}
                </div>
              )}
              {role === 'till' && nodeIpTrim !== '' && (
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Branch access code</label>
                  <input type="text" value={nodeSecret}
                    onChange={e => setNodeSecret(e.target.value.toUpperCase())}
                    placeholder="XXXX-XXXX-XXXX-XXXX"
                    className={`${inputCls} font-mono text-sm tracking-widest`} />
                  <p className="text-xs text-gray-400 mt-1.5">
                    Shown on the branch server during its setup. Without it this till cannot push to that machine.
                  </p>
                </div>
              )}
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Business type</label>
                <div className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-gray-200 text-sm">
                  {businessType
                    ? BUSINESS_TYPES.find(t => t.value === businessType)?.label ?? businessType
                    : 'from the server'}
                </div>
                <p className="text-xs text-gray-400 mt-1.5">
                  Set when the business was created. Changing it is a server-side decision,
                  not a per-till one.
                </p>
              </div>

              {/* Business type picker removed.
                  It is decided when the business is created and the server
                  returns it at activation, so asking again could only introduce
                  a disagreement — and the failure was silent: a restaurant set
                  to "retail" loses tables, dine-in and the kitchen flow, with
                  nothing on screen to explain why. */}
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Device name <span className="text-gray-400">(optional)</span></label>
                <input type="text" value={deviceName} onChange={e => setDeviceName(e.target.value)}
                  placeholder="Front till 1" className={inputCls} />
              </div>
              {error && <p className="text-red-400 text-sm bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-2.5">{error}</p>}
              <button onClick={complete} disabled={saving || !branchId}
                className="w-full bg-green-500 hover:bg-green-400 disabled:opacity-40 disabled:cursor-not-allowed text-gray-950 font-bold rounded-xl py-3 transition-colors">
                {saving ? 'Saving…' : 'Complete setup'}
              </button>
              <p className="text-xs text-gray-400 text-center">
                After setup this screen locks. Changing it again requires a technician.
              </p>
            </>
          )}
        </div>

        <p className="text-center text-gray-400 text-xs mt-6">
          SwiftPOS v{posApi.version} · {posApi.platform}
        </p>
      </div>
    </div>
  );
}
