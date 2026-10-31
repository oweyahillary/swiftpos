// IPC: A607 — customer details at the counter, on both screens, and the M-Pesa prompt. Registered from ipcHandlers.ts.
//
//   customer:saleInfo            the POS: is KRA eTIMS on (ask for the buyer's KRA PIN)? may this person see customers'
//                                phone numbers in full (customers.contacts — lib/personalData.ts masking)?
//   customerDisplay:askable      the POS: may the customer type on the customer screen now? (premium — the online licence;
//                                the PC's "touch screen" setting; the screen showing — customerDetails.ts secondScreenAsk)
//   customerDisplay:ask          the POS: show "Add your details" (or the M-Pesa number) on the customer screen
//   customerDisplay:cancelAsk    the POS: take it off again
//   customerDisplay:answer       the CUSTOMER SCREEN's page only: what the customer typed — checked here (cleanAnswer),
//                                then sent to the cashier ('customerDisplay:answered') to accept or correct
//   customerDisplay:setTouch     a technician, or someone who manages the business settings: "The customer screen is a
//                                touch screen" on this PC
//   mpesa:stkOffered             the POS: is the M-Pesa prompt offered (the business's integration set up, online)?
//   mpesa:stkStart / stkReset / stkState   the prompt (main/mpesaStk.ts); its progress goes to both screens
import { net, BrowserWindow } from 'electron';
import { getActiveSession } from '../techService';
import { signedInCan } from '../tillAccess';
import { getEtimsFlag } from '../deviceConfig';
import { liveCloudGet, liveCloudPost } from '../syncEngine';
import { logLine } from '../logFile';
import { customerDisplay, customerScreenTouch, setCustomerScreenTouch, licensed } from '../customerDisplayWire';
import { secondScreenAsk } from '@zaptill/core/customerDetails';
import { createStkPrompt, type StkPrompt } from '../mpesaStk';
import { DISPLAY_SETUP_REFUSED } from './customerDisplay';
import { type IpcShared } from './shared';

let prompt: StkPrompt | null = null;
function stk(): StkPrompt {
  if (prompt) return prompt;
  const asAnswer = (r: Response) => ({ status: r.status, json: () => r.json() });
  prompt = createStkPrompt({
    online: () => { try { return net.isOnline(); } catch { return false; } },
    get: async (p) => asAnswer(await liveCloudGet(p)),
    post: async (p, b) => asAnswer(await liveCloudPost(p, b)),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
    onState: (s) => {
      // Both screens: the customer screen (cleaned there — no phone, no receipt) and the cashier's windows.
      try { customerDisplay().setStk(s); } catch { /* no customer screen */ }
      for (const w of BrowserWindow.getAllWindows()) { if (!w.isDestroyed()) w.webContents.send('mpesa:stk', s); }
    },
    log: (l) => logLine('mpesa', l),
  });
  return prompt;
}

export function registerCustomerDetailsHandlers(ctx: IpcShared) {
  const { handle } = ctx;
  const maySetUp = () => { if (!getActiveSession() && !signedInCan('settings.business')) throw new Error(DISPLAY_SETUP_REFUSED); };
  const gate = () => ({ touch: customerScreenTouch(), licensed: licensed() });

  handle('customer:saleInfo', async () => ({ etimsEnabled: getEtimsFlag(), seesContacts: signedInCan('customers.contacts') }));
  handle('customerDisplay:askable', async () => {
    const g = gate();
    return { ...secondScreenAsk({ ...g, open: customerDisplay().isOpen() }), touch: g.touch, licensed: g.licensed };
  });
  handle('customerDisplay:ask', async (_e, raw) => customerDisplay().askCustomer(raw, gate()));
  handle('customerDisplay:cancelAsk', async (_e, p) => { customerDisplay().cancelAsk((p as { id?: unknown } | undefined)?.id); return { ok: true }; });
  handle('customerDisplay:answer', async (e, raw) => customerDisplay().answer(raw, (e as { sender?: unknown } | null)?.sender));
  handle('customerDisplay:setTouch', async (_e, p) => {
    maySetUp();
    setCustomerScreenTouch((p as { on?: unknown })?.on === true);
    logLine('display', `customer screen touch ${(p as { on?: unknown })?.on === true ? 'on' : 'off'}`);
    return { touch: customerScreenTouch() };
  });
  handle('mpesa:stkOffered', async () => ({ offered: await stk().offered() }));
  handle('mpesa:stkStart', async (_e, p) => stk().start(p as { phone: unknown; amount: unknown; ref: unknown; currency?: unknown }));
  handle('mpesa:stkReset', async () => stk().reset());
  handle('mpesa:stkState', async () => stk().current());
}
