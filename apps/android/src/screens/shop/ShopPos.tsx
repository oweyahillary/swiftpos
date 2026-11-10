/**
 * ShopPos — the Shop POS (Till stage 1, docs/ANDROID-APP-DESIGN.md §11): not joined → the technician's joining screen;
 * joined → the PIN pad, and after a PIN the web POS screens themselves (loaded, not copied).
 *
 * The paths are the web POS's own (/pos the PIN pad, /pos/cashier the selling screen), so the screens behave as they do
 * on the web (locking returns to /pos; the POS's requests use the POS's sign-in, apps/dashboard lib/api.ts). /pos/device
 * is this tablet's page: updates, printers, Reset app. Without a connection "No connection — can't sell" covers the PIN
 * pad and the selling screen — covers, never closes: an order on the screen is still there when the connection is back.
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { readTill, tillToken, type PosSession } from '../../shop/tillSession';
import { shopPosHostFor } from '../../shop/printing';
import { useOnline } from '../../shop/connection';
import { makeBuffer, sweepRetention } from '../../shop/buffer';
import { installOfflineWrites } from '../../shop/offlineWrites';
import { makeReadCache } from '../../shop/offlineReads';
import { runReplay, cloudSender } from '../../shop/replay';
import { API_URL } from '../../config';
import JoinScreen from './JoinScreen';
import PinScreen from './PinScreen';
import ShopDevice from './ShopDevice';
import NoConnection from './NoConnection';
import PrintNotice from './PrintNotice';
import SyncStatusBar from './SyncStatusBar';

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

  // Till stage 2 (docs/ANDROID-APP-DESIGN.md §4.7/§4.8): the Shop POS keeps selling offline. One durable buffer for the
  // tablet; the offline-writes seam queues a sale when there is no connection and hands the screen a provisional answer so
  // it completes and prints; replay drains the queue when the connection returns; a slow sweep drops long-synced rows.
  const [buffer] = useState(makeBuffer);
  // Cold start: the read cache keeps the selling screen's catalogue (pos/init, tables, pumps, printers, order mode) from
  // the last online load, so the POS opens offline from a cold boot (shop/offlineReads.ts).
  const [reads] = useState(makeReadCache);
  const onlineRef = useRef(online);
  onlineRef.current = online;
  const replaying = useRef(false);

  // Install the seam ONCE (wraps window.fetch; online or non-cloud calls pass straight through, so Till stage 1 selling is
  // unchanged). cloudBase is this app's API_URL — the same base the web POS calls, because main.tsx sets the dashboard's
  // apiUrl to it, so the two cannot drift. The read cache serves the catalogue on a cold offline boot.
  useEffect(() => installOfflineWrites({ store: buffer, isOffline: () => !onlineRef.current, cloudBase: API_URL, reads }), [buffer, reads]);

  // Drain the queue to the cloud on open and whenever the connection returns; never two drains at once.
  useEffect(() => {
    if (!online || replaying.current) return;
    replaying.current = true;
    void runReplay(buffer, cloudSender(async () => { const { token, till } = await tillToken(); return { token, deviceId: till.deviceId }; }))
      .catch(() => {})
      .finally(() => { replaying.current = false; });
  }, [online, buffer]);

  // §4.8 retention: sweep sent rows older than the window, hourly.
  useEffect(() => {
    const t = setInterval(() => { void sweepRetention(buffer); }, 60 * 60_000);
    return () => clearInterval(t);
  }, [buffer]);

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
      <SyncStatusBar store={buffer} />
      <NoConnection online={online} />
    </BrowserRouter>
  );
}
