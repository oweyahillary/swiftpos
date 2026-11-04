/**
 * onlineLicence.ts — owner, 2026-11-04: "desktop pos should sell basically but advanced features are bundled to the web
 * just like stock management etc". A desktop POS reaches a premium cloud feature (activating a pump, a customer's loyalty
 * points) only when the business has the online licence — lib/webAccess fullAccess, the same answer the desktop gets as
 * webPosEnabled with every catalogue pull and shows or hides those features by.
 *
 * The web needs no check here: signing in to the web is the licence (webAccess refuses a business without it).
 */
import type { Request } from 'express';
import { getWebAccess } from './webAccess';

export const ONLINE_LICENCE_REFUSAL = {
  error: 'This is part of the ZapTill online licence — contact ZapTill to enable it.',
  code: 'ONLINE_LICENCE_REQUIRED',
} as const;

/** True when the request comes from a desktop POS of a business without the online licence (refuse it). */
export async function desktopWithoutLicence(req: Request): Promise<boolean> {
  if (req.surface !== 'desktop') return false;
  try { return (await getWebAccess(req.businessId)).fullAccess !== true; } catch { return true; }
}
