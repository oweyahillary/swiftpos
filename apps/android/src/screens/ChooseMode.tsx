/**
 * ChooseMode — the first-launch question: "What is this device?" (docs/ANDROID-APP-DESIGN.md §2). Two steps: pick, then
 * confirm, because changing it later means Reset app (everything on the device is cleared).
 */
import { useState } from 'react';
import type { DeviceMode } from '../device/mode';

const CHOICES: Array<{ mode: DeviceMode; title: string; detail: string }> = [
  { mode: 'shop-pos', title: 'Shop POS', detail: 'A tablet at the counter that sells. Staff use their PINs.' },
  { mode: 'owner-phone', title: 'Owner / manager phone', detail: 'Your own phone or tablet, for reports and quick tasks. You sign in as yourself.' },
];

export default function ChooseMode({ onChosen }: { onChosen: (mode: DeviceMode) => Promise<void> }) {
  const [picked, setPicked] = useState<DeviceMode | null>(null);
  const [saving, setSaving] = useState(false);
  const choice = CHOICES.find((c) => c.mode === picked);

  if (choice) {
    return (
      <main className="screen middle">
        <h1>{choice.title}</h1>
        <p className="lead">{choice.detail}</p>
        <p className="note">To change this later, use <strong>Reset app</strong>. It clears everything ZapTill keeps on this device.</p>
        <div className="actions">
          <button className="primary" disabled={saving} onClick={async () => { setSaving(true); try { await onChosen(choice.mode); } finally { setSaving(false); } }}>
            {saving ? 'Saving…' : `Use as ${choice.title}`}
          </button>
          <button className="ghost" disabled={saving} onClick={() => setPicked(null)}>Back</button>
        </div>
      </main>
    );
  }

  return (
    <main className="screen">
      <h1>What is this device?</h1>
      <p className="lead">ZapTill sets itself up for how this device will be used.</p>
      <div className="choices">
        {CHOICES.map((c) => (
          <button key={c.mode} className="choice" onClick={() => setPicked(c.mode)}>
            <span className="choice-title">{c.title}</span>
            <span className="choice-detail">{c.detail}</span>
          </button>
        ))}
      </div>
    </main>
  );
}
