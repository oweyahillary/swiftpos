/**
 * labelsWords.ts — A574: the Labels tab (Manager › Stock › Labels) in each business type's words. The tab and its
 * barcodes work the same for every type (restaurant, cafe, retail, minimart, parking, petrol_station, other); only what
 * labels are for is said differently. Owner, 2026-10-23: "let us not forget other business in the tills all this changes
 * should also be taking shape on them based on how they operate".
 * Imports nothing, so a test loads it on its own; the type is read as shared/businessTerms.ts businessTypeOf reads it.
 */
/** A574: what labels are for, in each business type's words (the tab is the same for every type). */
export function labelsIntro(type: string | null | undefined): string {
  const t = String(type ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (t === 'restaurant' || t === 'cafe') return 'Barcode labels for grab-and-go and packaged items (bottled drinks, take-away packs, cakes), so they scan at the till.';
  if (t === 'petrol_station') return 'Barcode labels for the shop: lubricants, gas, snacks and drinks. Pump fuel is sold at the pump and needs no label.';
  if (t === 'parking') return 'Barcode labels for what you sell besides parking (car wash cards, permits, items at the booth).';
  return 'Barcode labels for the shelf or the item.';
}
