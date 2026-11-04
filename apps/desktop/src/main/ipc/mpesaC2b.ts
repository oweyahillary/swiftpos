// IPC: A621 — M-Pesa payment notifications on the payment screen (main/mpesaC2b.ts). Registered from ipcHandlers.ts.
//
//   mpesa:receivedList        the payment screen: the branch's untaken M-Pesa payments, the best fit for the bill first
//   mpesa:receivedClaim       the cashier tapped one: it is this sale's (another POS tapping it is refused)
//   mpesa:receivedRelease     the cashier took it off, or closed the payment screen without a sale
//   'mpesa:receivedArrived'   (main → every window) the cloud rang: a payment reached the branch's number — the notice, and an
//                             open payment screen asks for its list at once. Only with the online licence.
import { net, BrowserWindow } from 'electron';
import { liveCloudGet, liveCloudPost } from '../syncEngine';
import { setMpesaPaymentBell } from '../liveSync';
import { logLine } from '../logFile';
import { licensed } from '../customerDisplayWire';
import { createC2bClient, arrivedFromRing, type C2bClient } from '../mpesaC2b';
import { type IpcShared } from './shared';

let client: C2bClient | null = null;
function c2b(): C2bClient {
  if (client) return client;
  const asAnswer = (r: Response) => ({ status: r.status, json: () => r.json() });
  client = createC2bClient({
    online: () => { try { return net.isOnline(); } catch { return false; } },
    licensed,
    get: async (p) => asAnswer(await liveCloudGet(p)),
    post: async (p, b) => asAnswer(await liveCloudPost(p, b)),
    log: (l) => logLine('mpesa', l),
  });
  return client;
}

function tellWindows(payment: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) { if (!w.isDestroyed()) w.webContents.send('mpesa:receivedArrived', payment); }
}

export function registerMpesaC2bHandlers(ctx: IpcShared) {
  const { handle } = ctx;
  handle('mpesa:receivedList', async (_e, p) => c2b().list(p as { amount?: unknown; ref?: unknown }));
  handle('mpesa:receivedClaim', async (_e, p) => c2b().claim(p as { trans_id: unknown; sale_ref: unknown }));
  handle('mpesa:receivedRelease', async (_e, p) => c2b().release(p as { trans_id: unknown; sale_ref: unknown }));
  setMpesaPaymentBell((ring) => {
    const payment = arrivedFromRing(ring);
    if (!payment || !licensed()) return;
    logLine('mpesa', `c2b: ${payment.trans_id} received`);
    tellWindows(payment);
  });
}
