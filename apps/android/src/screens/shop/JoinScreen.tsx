/**
 * JoinScreen — the technician joins this tablet to a business and branch (Till stage 1, docs/ANDROID-APP-DESIGN.md §4.3).
 * Owner, 2026-11-05: "joining should be done by a tech"; ZapTill recommends a dedicated branch server, but most clients
 * have none — so both ways, the server first when one answers:
 *
 *   1. a branch server heard on the shop network → "Join the <name> server at <address>?", the security code to compare
 *      with the server's screen, then someone at the server presses Allow (the desktop's A427 flow, unchanged);
 *   2. none (or the technician prefers) → "Enter the enrolment code from ZapTill": the business ID and the one-time code
 *      issued in the admin portal for this branch (A69).
 * Either way the tablet gets its OWN session (A415) and takes a POS seat (role 'till', Q2).
 */
import { useEffect, useRef, useState } from 'react';
import { CloudError } from '../../cloud/client';
import { joinWithCode, type PosSession } from '../../shop/tillSession';
import { findServers, joinThroughServer, serverIdentity } from '../../shop/branchServer';
import { joinFormProblem, joinQuestion, joinRefusal, type FoundServer } from '../../shop/rules';

type ServerStep =
  | { kind: 'searching' }
  | { kind: 'found'; servers: FoundServer[] }
  | { kind: 'checking'; server: FoundServer }
  | { kind: 'compare'; server: FoundServer; cert: string; code: string }
  | { kind: 'waiting'; server: FoundServer; code: string };

const why = (e: unknown) => (e instanceof CloudError ? joinRefusal(e.code, e.message) : e instanceof Error ? e.message : String(e));

export default function JoinScreen({ version, online, onJoined, onReset }: {
  version: string; online: boolean; onJoined: (till: PosSession) => void; onReset: () => Promise<void>;
}) {
  const [posName, setPosName] = useState('');
  const [step, setStep] = useState<ServerStep>({ kind: 'searching' });
  const [businessId, setBusinessId] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const wanted = useRef(true);
  useEffect(() => () => { wanted.current = false; }, []);

  const search = async () => {
    setProblem(''); setStep({ kind: 'searching' });
    setStep({ kind: 'found', servers: await findServers() });
  };
  useEffect(() => { void search(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const needName = () => { if (posName.trim()) return false; setProblem('Give this POS a name first, for example "Front counter".'); return true; };

  const pickServer = async (server: FoundServer) => {
    if (needName()) return;
    setProblem(''); setStep({ kind: 'checking', server });
    try { setStep({ kind: 'compare', server, ...(await serverIdentity(server)) }); }
    catch (e) { setProblem(why(e)); void search(); }
  };

  const askServer = async (s: Extract<ServerStep, { kind: 'compare' }>) => {
    setBusy(true); setProblem('');
    try {
      wanted.current = true;
      const till = await joinThroughServer(s.server, { cert: s.cert, code: s.code }, posName, version,
        () => setStep({ kind: 'waiting', server: s.server, code: s.code }), () => wanted.current);
      onJoined(till);
    } catch (e) {
      setProblem(why(e));
      void search();
    } finally { setBusy(false); }
  };

  const joinByCode = async () => {
    const p = joinFormProblem(businessId, code, posName);
    if (p) { setProblem(p); return; }
    setBusy(true); setProblem('');
    try { onJoined(await joinWithCode({ businessId, code, posName, appVersion: version })); }
    catch (e) { setProblem(why(e)); }
    finally { setBusy(false); }
  };

  return (
    <main className="screen">
      <header className="brand"><span className="mark" aria-hidden="true">Z</span><span>ZapTill · Shop POS</span></header>
      <h1>Join this POS to the business</h1>
      <p className="note">For the ZapTill technician. This is done once; staff then sign in with their PINs.</p>
      {!online && <p className="problem">No internet. Connect this tablet to the shop Wi-Fi first.</p>}

      <section className="card">
        <label className="field">
          <span>Name this POS</span>
          <input value={posName} maxLength={60} placeholder="Front counter" onChange={(e) => setPosName(e.target.value)} />
        </label>
      </section>

      <section className="card" data-testid="join-server">
        <h2>Branch server on this network</h2>
        {step.kind === 'searching' && <p className="note">Searching the shop network…</p>}
        {step.kind === 'found' && step.servers.length === 0 && (
          <p className="note">No branch server answered. Enter the enrolment code from ZapTill below — or switch the server on and search again.</p>
        )}
        {step.kind === 'found' && step.servers.map((s) => (
          <button key={s.url} className="choice" disabled={busy} onClick={() => void pickServer(s)}>
            <span className="choice-title">{joinQuestion(s)}</span>
            {s.business && <span className="choice-detail">{s.business}</span>}
          </button>
        ))}
        {step.kind === 'checking' && <p className="note">Asking the server at {step.server.ip} who it is…</p>}
        {step.kind === 'compare' && (
          <>
            <p className="lead">Security code <strong className="code">{step.code}</strong></p>
            <p>Check the branch server's screen shows the same code, then ask to join. Someone at the server presses <strong>Allow</strong>.</p>
            <div className="actions">
              <button className="primary" disabled={busy} onClick={() => void askServer(step)}>Ask to join</button>
              <button className="ghost" disabled={busy} onClick={() => void search()}>Back</button>
            </div>
          </>
        )}
        {step.kind === 'waiting' && (
          <>
            <p className="lead">Waiting for <strong>Allow</strong> at the branch server…</p>
            <p className="note">Security code {step.code}. The request stays open for 10 minutes.</p>
            <button className="ghost" onClick={() => { wanted.current = false; }}>Cancel</button>
          </>
        )}
        {step.kind === 'found' && <button className="ghost" disabled={busy} onClick={() => void search()}>Search again</button>}
      </section>

      <section className="card" data-testid="join-code">
        <h2>Enter the enrolment code from ZapTill</h2>
        <p className="note">From the admin portal: the client's branch › Enrolment code. Read out both the business ID and the code.</p>
        <label className="field"><span>Business ID</span>
          <input value={businessId} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setBusinessId(e.target.value)} />
        </label>
        <label className="field"><span>Enrolment code</span>
          <input value={code} autoCapitalize="characters" autoCorrect="off" spellCheck={false} onChange={(e) => setCode(e.target.value)} />
        </label>
        <div className="actions">
          <button className="primary" disabled={busy || !online} onClick={() => void joinByCode()}>{busy ? 'Joining…' : 'Join'}</button>
        </div>
      </section>

      {problem && <p className="problem" role="alert">{problem}</p>}

      <section className="card">
        <p className="note">ZapTill {version} for Android · Wrong device type? <button className="text-button" onClick={() => void onReset()}>Reset app</button></p>
      </section>
    </main>
  );
}
