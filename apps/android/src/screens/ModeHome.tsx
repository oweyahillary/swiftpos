/**
 * ModeHome — Stage 0's screen for each mode: what this device is, what comes in the next stage, updates, and Reset app.
 * Owner stage A replaces the owner's placeholder with the dashboard's owner screens; Till stage 1 the Shop POS's with
 * the web POS screens (loaded, not copied).
 */
import { useState } from 'react';
import type { DeviceMode } from '../device/mode';
import UpdatePanel from './UpdatePanel';

const WORDS: Record<DeviceMode, { title: string; now: string; next: string }> = {
  'shop-pos': {
    title: 'Shop POS',
    now: 'This tablet is set up as a Shop POS.',
    next: 'Coming in the next update: join this tablet to your branch, then sell with your staff PINs.',
  },
  'owner-phone': {
    title: 'Owner / manager phone',
    now: 'This device is set up for an owner or manager.',
    next: "Coming in the next update: sign in and see today's sales, by branch, from anywhere.",
  },
};

export default function ModeHome({ mode, version, onReset }: { mode: DeviceMode; version: string; onReset: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [problem, setProblem] = useState('');
  const w = WORDS[mode];

  const reset = async () => {
    setResetting(true); setProblem('');
    try { await onReset(); }
    catch (e) { setProblem(e instanceof Error ? e.message : String(e)); setResetting(false); }
  };

  return (
    <main className="screen">
      <header className="brand">
        <span className="mark" aria-hidden="true">Z</span>
        <span>ZapTill · {w.title}</span>
      </header>
      <section className="card">
        <p className="lead">{w.now}</p>
        <p>{w.next}</p>
      </section>
      <UpdatePanel mode={mode} version={version} />
      <section className="card">
        <h2>This device</h2>
        <p className="note">ZapTill {version} for Android</p>
        {!confirming && <button className="ghost danger" onClick={() => setConfirming(true)}>Reset app</button>}
        {confirming && (
          <>
            <p>Reset app? This clears the device type and everything ZapTill keeps on this device. You will be asked “What is this device?” again.</p>
            {problem && <p className="problem">{problem}</p>}
            <div className="actions">
              <button className="primary danger" disabled={resetting} onClick={reset}>{resetting ? 'Resetting…' : 'Reset app'}</button>
              <button className="ghost" disabled={resetting} onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
