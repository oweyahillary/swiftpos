/**
 * c2bAccess.ts — A621: is M-Pesa payment notifications part of this business's plan? It is part of the online licence
 * (premium), like the M-Pesa prompt and the customer screen's slideshow (A606): lib/webAccess fullAccess, the same answer
 * the desktop POS gets as webPosEnabled.
 *
 * Reading the licence is six queries (lib/cloudPlan.ts readCloudFacts), and the POS asks for its list every few seconds
 * while a payment screen is open — so the answer is remembered for 5 minutes per business. A licence that lapses stops the
 * list within those 5 minutes; nothing is lost (the payments keep arriving and show on the dashboard's day list).
 */
import { getWebAccess } from './webAccess';

export const LICENCE_MEMO_MS = 5 * 60_000;
const memo = new Map<string, { at: number; licensed: boolean }>();

export async function c2bLicensed(businessId: string, now = Date.now()): Promise<boolean> {
  const held = memo.get(businessId);
  if (held && now - held.at < LICENCE_MEMO_MS) return held.licensed;
  let licensed = false;
  try { licensed = (await getWebAccess(businessId)).fullAccess === true; } catch { licensed = false; }
  memo.set(businessId, { at: now, licensed });
  return licensed;
}

export const NOT_LICENSED = { error: 'M-Pesa payment notifications are part of the ZapTill online licence — contact ZapTill to enable it.', code: 'C2B_NOT_LICENSED' } as const;

/** Test seam: forget what was remembered. */
export function _resetC2bLicence(): void {
  memo.clear();
}
