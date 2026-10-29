// IPC: A606 — the customer screen (a dual-screen POS's second monitor). Registered from ipcHandlers.ts.
//
//   customerDisplay:update    the cashier's POS page → its sale as the customer sees it (cleaned in main, customerScreen.ts
//                             sanitiseDisplayState), pushed to the customer screen ('customerDisplay:state')
//   customerDisplay:current   the customer screen page, as it opens: the state now
//   customerDisplay:content   the customer screen page: the name, and the premium parts the gate lets through
//   customerDisplay:slide     the customer screen page: one slideshow image this PC holds (a data URL), by its key
//   customerDisplay:status    the setup panel: on / off, which screen, the screens connected, why it is not showing
//   customerDisplay:set       a technician, or someone who manages the business settings: on / off and the screen
//   customerDisplay:test      the same people: a sample sale on the customer screen for a few seconds
//   customerDisplay:identify  the same people: a big number on each screen for a few seconds
import { getActiveSession } from '../techService';
import { signedInCan } from '../tillAccess';
import { getDeviceConfig } from '../deviceConfig';
import { customerDisplay, customerDisplayContent, slideCache } from '../customerDisplayWire';
import { type IpcShared } from './shared';

export const DISPLAY_SETUP_REFUSED = 'Only a technician or someone who manages the business settings can set up the customer screen.';

export function registerCustomerDisplayHandlers(ctx: IpcShared) {
  const { handle } = ctx;
  const maySetUp = () => { if (!getActiveSession() && !signedInCan('settings.business')) throw new Error(DISPLAY_SETUP_REFUSED); };

  handle('customerDisplay:update', async (_e, raw) => { customerDisplay().update(raw); return { ok: true }; });
  handle('customerDisplay:current', async () => customerDisplay().current());
  handle('customerDisplay:content', async () => customerDisplayContent());
  handle('customerDisplay:slide', async (_e, p) => slideCache().image(String((p as { key?: unknown })?.key ?? '')));
  handle('customerDisplay:status', async () => customerDisplay().status());
  handle('customerDisplay:set', async (_e, p) => { maySetUp(); return customerDisplay().setChoice(p); });
  handle('customerDisplay:test', async () => {
    maySetUp();
    const cfg = getDeviceConfig() as { business_type?: string | null } | null;
    const mode = String(cfg?.business_type ?? 'retail').toLowerCase().replace(/\s+/g, '_') as any;
    return customerDisplay().test(mode, customerDisplayContent().currency);
  });
  handle('customerDisplay:identify', async () => { maySetUp(); return { screens: customerDisplay().identify() }; });
}
