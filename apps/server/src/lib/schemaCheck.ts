/**
 * schemaCheck — does the database actually have the columns this build writes?
 *
 * Why this exists: three migrations (33/34/35) were never applied to Supabase.
 * Nothing complained. The server started, `/health` reported `db: "up"`, Render
 * showed green, and the desktop tills sold happily — every order failing on push
 * with a generic "Failed to create order" and the real cause visible only in a
 * server log line nobody was reading:
 *
 *     Could not find the 'delivery_person' column of 'orders' in the schema cache
 *
 * That went unnoticed for most of a day. A reachable database is not the same as
 * a correct one, and "did the migrations run" is exactly the question a health
 * endpoint should be able to answer.
 *
 * Columns are probed by asking PostgREST for them. A missing column comes back
 * as an error (42703, or PGRST204 when its schema cache is stale) rather than
 * empty data, which is precisely the signal wanted. `head: true` means no rows
 * are transferred — this is a metadata question.
 */

import { supabase } from './supabase';

/**
 * Columns this build writes that were added by a migration. Add to this list
 * whenever a migration adds a column the transaction path depends on — the cost
 * of forgetting is a silent failure at the till, not a build error.
 */
const REQUIRED: Record<string, string[]> = {
  orders:     ['ctl_amount', 'delivery_person', 'refunded_at'],  // migrations 33, 35, 37
  businesses: ['ctl_rate'],                        // migration 33
  categories: ['is_kitchen'],                      // migration 34
  products:   ['is_kitchen'],                      // migration 38
  user_devices: ['app_version'],                   // migration 36
};

export interface SchemaStatus {
  ok: boolean;
  /** e.g. ['orders.delivery_person'] — empty when everything is present. */
  missing: string[];
  /** Set when the check itself could not run (network, permissions). */
  error?: string;
}

// Probing on every health ping would add database round trips to Render's
// liveness check. A good result is cached; a BAD one is not, so a fix shows up
// on the next call rather than up to a minute later.
const CACHE_MS = 60_000;
let cached: { at: number; value: SchemaStatus } | null = null;

async function columnExists(table: string, column: string): Promise<boolean> {
  const { error } = await supabase.from(table).select(column, { head: true }).limit(0);
  if (!error) return true;
  const text = `${error.message ?? ''} ${(error as any).code ?? ''}`;
  // 42703 = undefined_column; PGRST204 = not in PostgREST's schema cache.
  if (/42703|PGRST204|does not exist|could not find/i.test(text)) return false;
  // Anything else is a different problem — don't report a column as missing
  // because the network blipped.
  throw error;
}

export async function checkSchema(): Promise<SchemaStatus> {
  if (cached && cached.value.ok && Date.now() - cached.at < CACHE_MS) return cached.value;

  const missing: string[] = [];
  try {
    for (const [table, columns] of Object.entries(REQUIRED)) {
      // One request for the whole table first — the common case is that
      // everything is present, and that costs a single round trip.
      const { error } = await supabase.from(table).select(columns.join(','), { head: true }).limit(0);
      if (!error) continue;

      // Something is missing. Now find out precisely what, so the message names
      // the migration to run rather than just the table.
      for (const column of columns) {
        if (!(await columnExists(table, column))) missing.push(`${table}.${column}`);
      }
    }
  } catch (err: any) {
    const value: SchemaStatus = { ok: false, missing, error: err?.message ?? 'schema check failed' };
    cached = { at: Date.now(), value };
    return value;
  }

  const value: SchemaStatus = { ok: missing.length === 0, missing };
  cached = { at: Date.now(), value };
  return value;
}

/** Human-readable next step, for the log line and the endpoint body. */
export function schemaAdvice(status: SchemaStatus): string | undefined {
  if (status.ok) return undefined;
  if (status.error) return `Could not verify the schema: ${status.error}`;
  return `Missing columns: ${status.missing.join(', ')}. `
       + 'Run the outstanding migrations in migrations/ against Supabase, then '
       + "NOTIFY pgrst, 'reload schema';";
}
