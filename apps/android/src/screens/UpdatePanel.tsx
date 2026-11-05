/**
 * UpdatePanel — "Check for updates" and, when the cloud offers the approved version, "Update" (updates/updater.ts).
 * Checked once when the screen opens; again on the button.
 */
import { useEffect, useState } from 'react';
import type { DeviceMode } from '../device/mode';
import { checkForUpdate, installUpdate, type InstallStep, type UpdateCheck } from '../updates/updater';
import { sizeLabel, updateSummary } from '../updates/words';

const STEP_WORDS: Record<InstallStep, string> = {
  permission: 'Allow "Install unknown apps" for ZapTill, then come back and tap Update again.',
  downloading: 'Downloading and checking the update…',
  installing: 'Android asks you to confirm the update.',
};

export default function UpdatePanel({ mode, version }: { mode: DeviceMode; version: string }) {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<InstallStep | null>(null);

  const run = async () => {
    setBusy(true); setProblem(''); setStep(null);
    try { setCheck(await checkForUpdate(mode, version)); }
    catch (e) { setCheck(null); setProblem(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void run(); }, [mode, version]);   // eslint-disable-line react-hooks/exhaustive-deps

  const update = async () => {
    if (check?.verdict.kind !== 'ready') return;
    setBusy(true); setProblem('');
    try { await installUpdate(check.verdict.offer, setStep); }
    catch (e) { setStep(null); setProblem(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const ready = check?.verdict.kind === 'ready' ? check.verdict.offer : null;
  return (
    <section className="card">
      <h2>Updates</h2>
      {busy && !step && <p className="note">Asking ZapTill…</p>}
      {check && <p>{updateSummary(check.verdict, check.status)}</p>}
      {check?.status.warning && <p className="note">{check.status.warning}</p>}
      {problem && <p className="problem">{problem}</p>}
      {step && <p className="note">{STEP_WORDS[step]}</p>}
      <div className="actions">
        {ready && <button className="primary" disabled={busy} onClick={update}>Update to {ready.version} {sizeLabel(ready.size) && `(${sizeLabel(ready.size)})`}</button>}
        <button className="ghost" disabled={busy} onClick={run}>Check for updates</button>
      </div>
    </section>
  );
}
