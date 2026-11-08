/**
 * ShopPos — the Shop POS (Till stage 1, docs/ANDROID-APP-DESIGN.md §11): not joined → the technician's joining screen;
 * joined → the PIN pad, and after a PIN the web POS screens themselves (loaded, not copied).
 *
 * The paths are the web POS's own (/pos the PIN pad, /pos/cashier the selling screen), so the screens behave as they do
 * on the web (locking returns to /pos; the POS's requests use the POS's sign-in, apps/dashboard lib/api.ts). /pos/device
 * is this tablet's page: updates, printers, Reset app. Without a connection "No connection — can't sell" covers the PIN
 * pad and the selling screen — covers, never closes: an order on the screen is still there when the connection is back.
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { readTill, type PosSession } from '../../shop/tillSession';
import { shopPosHostFor } from '../../shop/printing';
import { useOnline } from '../../shop/connection';
import JoinScreen from './JoinScreen';
import PinScreen from './PinScreen';
import ShopDevice from './ShopDevice';
import NoConnection from './NoConnection';
import PrintNotice from './PrintNotice';

const Selling = lazy(() => import('@zaptill/dashboard-pos').then((m) => ({ default: m.ShopPosSelling })));

/** Tell the web POS screens which POS they run on, before they open. */
async function startScreens(till: PosSession): Promise<void> {
  const pos = await import('@zaptill/dashboard-pos');
  pos.setShopPosHost(shopPosHostFor(till));
}

type State = { kind: 'loading' } | { kind: 'join' } | { kind: 'ready'; till: PosSession } | { kind: 'failed'; message: string };

export default function ShopPos({ version, onReset }: { version: string; onReset: () => Promise<void> }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const online = useOnline();

  const open = async (till: PosSession | null) => {
    if (!till) { setState({ kind: 'join' }); return; }
    await startScreens(till);
    setState({ kind: 'ready', till });
  };
  useEffect(() => {
    readTill().then(open).catch((e) => setState({ kind: 'failed', message: e instanceof Error ? e.message : String(e) }));
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  if (state.kind === 'loading') return <main className="screen centre"><p className="note">Starting the POS…</p></main>;
  if (state.kind === 'failed') return <main className="screen"><h1>The POS could not start</h1><p className="problem">{state.message}</p></main>;
  if (state.kind === 'join') {
    return <JoinScreen version={version} online={online} onJoined={(till) => { window.history.replaceState(null, '', '/pos'); void open(till); }} onReset={onReset} />;
  }
  const till = state.till;
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/pos" element={<PinScreen till={till} version={version} />} />
        <Route path="/pos/cashier" element={
          <Suspense fallback={<main className="screen centre"><p className="note">Opening the POS…</p></main>}><Selling /></Suspense>} />
        <Route path="/pos/device" element={<ShopDevice till={till} version={version} onReset={onReset}
          onJoinAgain={() => setState({ kind: 'join' })} />} />
        <Route path="*" element={<Navigate to="/pos" replace />} />
      </Routes>
      <PrintNotice />
      <NoConnection online={online} />
    </BrowserRouter>
  );
}
