// Which default-grant tier a role name falls into (register A63/A61).
//
// The name is normalised — lower-cased AND spaces mapped to underscores, the
// SAME `lower(replace(name,' ','_'))` the grant migrations 24/49/75/76 use.
// Without it, a business that typed "Branch Manager" with a space fell through
// every tier to 'none' and its role was seeded with ZERO permissions — no error,
// no access, exactly A61's signature one layer up. Matching the migrations
// exactly means the seeder and the backfills can never disagree about who is a
// manager.
//
// Kept free of any supabase / IO import so it is a pure, testable decision.

export type RoleTier = 'full' | 'manager' | 'cashier' | 'none';

export function roleTier(name: string): RoleTier {
  const nm = (name || '').toLowerCase().replace(/ /g, '_');
  if (nm === 'admin' || nm === 'owner') return 'full';
  if (nm === 'manager' || nm === 'supervisor' || nm === 'branch_manager') return 'manager';
  if (nm === 'cashier') return 'cashier';
  return 'none';
}
