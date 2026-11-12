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
import { readTill, tillToken, deviceId, type PosSession } from '../../shop/tillSession';
import { shopPosHostFor } from '../../shop/printing';
import { useOnline } from '../../shop/connection';
import { makeBuffer, sweepRetention } from '../../shop/buffer';
import { installOfflineWrites } from '../../shop/offlineWrites';
import { makeReadCache } from '../../shop/offlineReads';
import { refreshRoster } from '../../shop/roster';
import { attemptUpgrade } from '../../shop/offlineUpgrade';
import { OFFLINE_PENDING } from '../../shop/offlinePin';
import { runReplay, cloudSender } from '../../shop/replay';
import { gatewayFetch, checkServerHealth } from '../../shop/branchGateway';
import { readServerLink } from '../../shop/branchServer';
import { enqueueOrderFor, drainToNode, makeNodeOutbox, type NodeOutbox } from '../../shop/branchSync';
import { API_URL } from '../../config';
import JoinScreen from './JoinScreen';
import PinScreen from './PinScreen';
import ShopDevice from './ShopDevice';
import PrintNotice from './PrintNotice';
import SyncStatusBar from './SyncStatusBar';

const Selling = lazy(() => import('@zaptill/dashboard-pos').then((m) => ({ default: m.ShopPosSelling })));

/** Tell the web POS screens which POS they run on, before they open. */
async function startScreens(till: PosSession): Promise<void> {
  const pos = await import('@zaptill/dashboard-pos');
  pos.setShopPosHost(shopPosHostFor(till));
}

/**
 * Till stage 3 (docs/SCOPE-TILL-STAGE-3.md): the offline seam's branch-server adapter. When this POS has joined a branch
 * server, a cloud call is tried through it first (`<server>/node/cloud/api/…`, A410) over pinned TLS; a Response here = the
 * server forwarded the cloud's own answer. Any server problem returns null, so the seam falls back to the tablet's own
 * cloud (online) or the Till-stage-2 buffer (offline) — A410 as a preference, not a lock-in.
 */
async function branchGatewayAdapter(fullUrl: string, method: string, body: string | undefined, headers: Record<string, string>): Promise<Response | null> {
  try {
    const r = await gatewayFetch(fullUrl, method, body, headers);
    if (r.via !== 'gateway') return null;
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: { 'Content-Type': r.headers?.['content-type'] ?? 'application/json' } });
  } catch { return null; }
}

/**
 * Till stage 3 Slice B (docs/BUILD-TILL-STAGE-3B.md): push a completed sale to the joined branch server's outbox, then
 * drain it. Best-effort; a no-op when no branch server is joined. The captured order body carries branch_id and
 * idempotency_key (apps/dashboard PaymentModal buildOrderPayload), so branchSync needs nothing more than this device's id.
 */
async function pushOrderToBranch(outbox: NodeOutbox, body: string | undefined): Promise<void> {
  try {
    if (!body) return;
    const link = await readServerLink();
    if (!link) return;                       // no branch server — nothing to aggregate to
    const parsed = JSON.parse(body) as Record<string, any>;
    await enqueueOrderFor(outbox, parsed, {
      deviceId: await deviceId(),
      branchId: parsed.branch_id ?? null,
      createdAt: parsed.created_at ?? new Date().toISOString(),
    });
    void drainToNode(outbox, { link }).catch(() => {});
  } catch { /* best-effort */ }
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
  // Till stage 3 Slice B: a durable outbox of completed sales pushed to the branch server (branch reports + A19 relay),
  // separate from the cloud buffer — two destinations, each with its own state.
  const [nodeOutbox] = useState(makeNodeOutbox);
  const onlineRef = useRef(online);
  onlineRef.current = online;
  const replaying = useRef(false);

  // Install the seam ONCE (wraps window.fetch; online or non-cloud calls pass straight through, so Till stage 1 selling is
  // unchanged). cloudBase is this app's API_URL — the same base the web POS calls, because main.tsx sets the dashboard's
  // apiUrl to it, so the two cannot drift. The read cache serves the catalogue on a cold offline boot.
  useEffect(() => installOfflineWrites({ store: buffer, isOffline: () => !onlineRef.current, cloudBase: API_URL, reads,
    gateway: branchGatewayAdapter, onOrder: (_u, _m, b) => { void pushOrderToBranch(nodeOutbox, b); } }), [buffer, reads, nodeOutbox]);

  // Till stage 3: ask the joined branch server what protocol it speaks (over the LAN, whether or not the cloud is
  // reachable), on open and whenever the connection changes. No branch server joined → this is a quick no-op.
  useEffect(() => { void checkServerHealth().catch(() => {}); }, [online]);

  // Till stage 3 Slice B: drain the branch-sync outbox to the server on open and whenever the connection changes (it
  // runs over the LAN even when the cloud is unreachable but the server is up). A no-op when nothing is waiting.
  useEffect(() => { void drainToNode(nodeOutbox).catch(() => {}); }, [online, nodeOutbox]);

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

  // Cold start, the sign-in half: while online, keep the roster fresh (for an offline sign-in) and, if someone signed in
  // while offline, verify their HELD PIN with the cloud the moment the connection returns — upgrading the provisional
  // session to a real one with no second PIN entry, or signing the person out if their PIN changed on the web (A345).
  const upgrading = useRef(false);
  useEffect(() => {
    if (!online || upgrading.current) return;
    upgrading.current = true;
    void (async () => {
      await refreshRoster();
      const outcome = await attemptUpgrade(version);
      if (!outcome) return;
      if (outcome.state === 'upgraded') {
        const pos = await import('@zaptill/dashboard-pos');
        pos.storeCashierSession(outcome.session);   // the real token where api.ts reads it (localStorage)
        // Hand the LIVE POS context the real token + current permissions — the documented cross-component event the web
        // POS already uses for a token renewal (apps/dashboard lib/api.ts / POSAuthContext). renewedFrom is the provisional
        // session's chain id (OFFLINE_PENDING), so this session, and ONLY it, takes the upgrade — never another person who
        // signed in since.
        window.dispatchEvent(new CustomEvent('swiftpos:pos-token', { detail: {
          accessToken: outcome.session.token, refreshToken: outcome.session.refreshToken, permissions: outcome.session.permissions, renewedFrom: OFFLINE_PENDING,
        } }));
      } else if (outcome.state === 'rejected') {
        // A PIN changed or disabled on the web: sign the person out cleanly to the PIN pad (the event POSAuthContext hears).
        window.dispatchEvent(new CustomEvent('swiftpos:session-expired'));
      }
    })().catch(() => {}).finally(() => { upgrading.current = false; });
  }, [online, version]);

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
        <Route path="/pos" element={<PinScreen till={till} version={version} online={online} />} />
        <Route path="/pos/cashier" element={
          <Suspense fallback={<main className="screen centre"><p className="note">Opening the POS…</p></main>}><Selling /></Suspense>} />
        <Route path="/pos/device" element={<ShopDevice till={till} version={version} onReset={onReset}
          onJoinAgain={() => setState({ kind: 'join' })} />} />
        <Route path="*" element={<Navigate to="/pos" replace />} />
      </Routes>
      <PrintNotice />
      <SyncStatusBar store={buffer} />
    </BrowserRouter>
  );
}
