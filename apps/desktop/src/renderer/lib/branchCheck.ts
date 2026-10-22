/**
 * branchCheck.ts — A566: "Check other branches" from the till's selling screen (pure, so the tests run it).
 *
 * The till's own (lib/branchStock.ts is one text with the web's and stays so — A564).
 */
/** The selling screen offers it only with A564's two locks: `inventory.view` and the online licence (as the Manager tab). */
export function mayCheckOtherBranches(online: boolean, canViewStock: boolean): boolean {
  return online === true && canViewStock === true;
}

/** The items a search finds that are sold out or hidden HERE (A563) — the ones worth asking another branch about. */
export function outHereMatches<T extends { name?: string | null; status?: string | null }>(
  products: readonly T[], search: string, isOut: (p: T) => boolean, limit = 3,
): T[] {
  const q = String(search ?? '').trim().toLowerCase();
  if (q.length < 2) return [];
  const out: T[] = [];
  for (const p of products) {
    if (p?.status !== 'active' || !String(p.name ?? '').toLowerCase().includes(q) || !isOut(p)) continue;
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

/** What the offer under the search says: "Chips is out here." / "Chips, Soda are out here." */
export function outHereNote(items: readonly { name?: string | null }[]): string {
  const names = items.map((p) => String(p.name ?? '').trim()).filter(Boolean);
  if (names.length === 0) return '';
  return `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} out here.`;
}
