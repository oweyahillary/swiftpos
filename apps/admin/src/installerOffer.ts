/**
 * installerOffer.ts — A570: which installers the admin portal's "Download ZapTill" offers, in order. Pure (the test runs it).
 * The client's APPROVED version first (its Desktop updates — the default), then the latest release.
 */
export interface OfferFacts { approved: string | null; latest: string | null }

export function offeredVersions(o: OfferFacts | null): Array<{ version: string; label: string }> {
  if (!o) return [];
  const out: Array<{ version: string; label: string }> = [];
  if (o.approved) out.push({ version: o.approved, label: o.latest === o.approved ? "Approved for this client (latest)" : "Approved for this client" });
  if (o.latest && o.latest !== o.approved) out.push({ version: o.latest, label: "Latest release" });
  return out;
}

export const mb = (n: number | null | undefined) => (n ? `${(n / 1048576).toFixed(1)} MB` : "size unknown");
