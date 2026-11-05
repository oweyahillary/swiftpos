/**
 * App — the first-launch question until the device has a mode, then that mode's screen (Stage 0: a placeholder that
 * says what comes next, updates, and Reset app). docs/ANDROID-APP-DESIGN.md §2 and "Stage 0 — built".
 */
import { useEffect, useState } from 'react';
import { App as NativeApp } from '@capacitor/app';
import { readMode, saveMode, surfaceOf, type DeviceMode } from './device/mode';
import { resetApp } from './device/reset';
import { startReporting } from './errors/reporter';
import { forgetDownloads } from './updates/updater';
import ChooseMode from './screens/ChooseMode';
import ModeHome from './screens/ModeHome';

/** The installed APK's version (its versionName); the build's own in a browser preview. */
async function installedVersion(): Promise<string> {
  try { return (await NativeApp.getInfo()).version; } catch { return __APP_VERSION__; }
}

type State = { kind: 'loading' } | { kind: 'choose'; version: string } | { kind: 'ready'; mode: DeviceMode; version: string } | { kind: 'failed'; message: string };

export default function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    (async () => {
      void forgetDownloads();
      const version = await installedVersion();
      const mode = await readMode();
      if (!mode) { setState({ kind: 'choose', version }); return; }
      setState({ kind: 'ready', mode, version });
      void startReporting(surfaceOf(mode), version);
    })().catch((e) => setState({ kind: 'failed', message: e instanceof Error ? e.message : String(e) }));
  }, []);

  if (state.kind === 'loading') return <main className="screen centre"><p className="note">Starting ZapTill…</p></main>;
  if (state.kind === 'failed') return <main className="screen"><h1>ZapTill could not start</h1><p className="problem">{state.message}</p></main>;
  if (state.kind === 'choose') {
    const version = state.version;
    return <ChooseMode onChosen={async (mode) => {
      await saveMode(mode);
      setState({ kind: 'ready', mode, version });
      void startReporting(surfaceOf(mode), version);
    }} />;
  }
  return <ModeHome mode={state.mode} version={state.version} onReset={async () => {
    await resetApp();
    setState({ kind: 'choose', version: state.version });
  }} />;
}
