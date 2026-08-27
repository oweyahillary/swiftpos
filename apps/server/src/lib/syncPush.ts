// syncPush.ts — A180. Keep one malformed row from sinking a whole /api/sync/push
// batch. A non-UUID id (register A179: a till minting `exp_<ts>_<rand>`) fails a
// `uuid` column with Postgres 22P02; when it rode in a batch upsert (or a batch
// `.in('id', ids)` pre-check), the ENTIRE push 500'd and every shift/day/float
// behind it stayed pending. These rows are rejected individually instead, so the
// good rows in the same push still land — the same contract shifts/days/floats
// already use.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): boolean {
  return typeof v === 'string' && UUID_RE.test(v);
}

export interface RejectedRow { id: string; code: string; table: string; error: string }

/**
 * Split rows into those safe to send to a `uuid` id column and those that must be
 * rejected up front (a non-UUID id can never match, and used to 500 the batch).
 * Pure so the guard is unit-tested directly.
 */
export function partitionByValidId<T extends { id: unknown }>(
  rows: T[], table: string,
): { valid: T[]; rejected: RejectedRow[] } {
  const valid: T[] = [];
  const rejected: RejectedRow[] = [];
  for (const r of rows) {
    if (isUuid(r.id)) valid.push(r);
    else rejected.push({ id: String(r.id), code: 'invalid_id', table, error: 'id is not a UUID' });
  }
  return { valid, rejected };
}
