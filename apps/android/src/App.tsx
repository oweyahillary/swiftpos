/**
 * App — the first-launch question until the device has a mode, then that mode's screen: a Shop POS joins and sells (Till
 * stage 1, docs/ANDROID-APP-DESIGN.md §11); an owner's phone shows Stage 0's placeholder (updates, Reset app) until Owner
 * stage A. docs/ANDROID-APP-DESIGN.md §2 and "Stage 0 — built".
 */
import { useEffect, useState } from 'react';
import { App as NativeApp } from '@capacitor/app';
import { readMode, saveMode, surfaceOf, type DeviceMode } from './device/mode';
import { resetApp } from './device/reset';
import { startReporting } from './errors/reporter';
import { forgetDownloads } from './updates/updater';
import ChooseMode from './screens/ChooseMode';
import ModeHome from './screens/ModeHome';
import ShopPos from './screens/shop/ShopPos';

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

  // Android hardware back: close the topmost open POS overlay (apps/dashboard hooks/useBackDismiss dispatches on this
  // event), else leave the tech page. On the PIN pad or the selling screen it does nothing — a stray press must never sign
  // a cashier out or exit the app; they lock deliberately with the in-app Lock button.
  const shopPosReady = state.kind === 'ready' && state.mode === 'shop-pos';
  useEffect(() => {
    if (!shopPosReady) return;
    let handle: { remove: () => void } | undefined;
    void NativeApp.addListener('backButton', () => {
      const ev = new CustomEvent('zaptill:back', { cancelable: true });
      window.dispatchEvent(ev);
      if (ev.defaultPrevented) return;   // an overlay consumed the press
      if (window.location.pathname === '/pos/device') { window.history.back(); return; }   // leave This device → PIN pad
    }).then((h) => { handle = h; });
    return () => { handle?.remove(); };
  }, [shopPosReady]);

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
  const onReset = async () => {
    await resetApp();
    window.history.replaceState(null, '', '/');
    setState({ kind: 'choose', version: state.version });
  };
  // Till stage 1: a Shop POS joins, takes PINs and sells (screens/shop); the owner's phone is still Stage 0's placeholder.
  if (state.mode === 'shop-pos') return <ShopPos version={state.version} onReset={onReset} />;
  return <ModeHome mode={state.mode} version={state.version} onReset={onReset} />;
}
