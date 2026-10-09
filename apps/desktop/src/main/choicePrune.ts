/**
 * choicePrune.ts — A425: the till drops the choices the cloud no longer has.
 *
 * Owner, 2026-10-09: "why does this menu keep duplicating its variants? when i upload it clients cant sell". The pizza
 * menu was clean (one Size group per pizza: Medium, Large). The cloud's menu upload replaces a group's options with new
 * rows on every upload, and removes copies of a group an earlier upload left (A389) — but the till's catalogue pull only
 * ever ADDED and UPDATED variant and add-on rows, never removed one. So after three uploads a till held three "Size"
 * groups, each marked Required, and Medium / Large three times in each: the pizza could not be rung until every one of
 * them was picked ("Please select a Size"), and a peer took the same stale rows from its branch server.
 *
 * Now, after a pull, for every product whose choices the till actually received, its groups and options are exactly the
 * pulled ones. A product whose fetch failed (`scope` leaves it out) keeps what it has — a network blink never strips a
 * menu. Options of a group that no longer exists go too. Sales, held orders and anything else are not touched: a sale
 * carries the chosen names itself.
 */
import type Database from 'better-sqlite3';

export interface ChoiceTables {
  groups: 'variant_groups' | 'modifier_groups';
  options: 'variant_options' | 'modifier_options';
  groupKey: 'variant_group_id' | 'modifier_group_id';
}
export const VARIANT_TABLES: ChoiceTables = { groups: 'variant_groups', options: 'variant_options', groupKey: 'variant_group_id' };
export const MODIFIER_TABLES: ChoiceTables = { groups: 'modifier_groups', options: 'modifier_options', groupKey: 'modifier_group_id' };

/**
 * Removes the local groups and options of the products in `scope` that the pull did not return. Call inside the pull's
 * transaction, after the upserts. Returns how many groups and options were removed.
 */
export function pruneChoices(
  db: Database.Database, t: ChoiceTables, scope: Iterable<string>,
  pulledGroups: Array<{ id: string }>, pulledOptions: Array<{ id: string }>,
): { groups: number; options: number } {
  const keepGroups = new Set(pulledGroups.map((g) => String(g.id)));
  const keepOptions = new Set(pulledOptions.map((o) => String(o.id)));
  const groupsOf = db.prepare(`SELECT id FROM ${t.groups} WHERE product_id = ?`);
  const optionsOf = db.prepare(`SELECT id FROM ${t.options} WHERE ${t.groupKey} = ?`);
  const delGroup = db.prepare(`DELETE FROM ${t.groups} WHERE id = ?`);
  const delGroupOptions = db.prepare(`DELETE FROM ${t.options} WHERE ${t.groupKey} = ?`);
  const delOption = db.prepare(`DELETE FROM ${t.options} WHERE id = ?`);
  let groups = 0, options = 0;
  for (const pid of scope) {
    for (const { id } of groupsOf.all(pid) as Array<{ id: string }>) {
      if (!keepGroups.has(String(id))) {
        options += delGroupOptions.run(id).changes;
        groups += delGroup.run(id).changes;
        continue;
      }
      for (const o of optionsOf.all(id) as Array<{ id: string }>) {
        if (!keepOptions.has(String(o.id))) options += delOption.run(o.id).changes;
      }
    }
  }
  // options whose group is gone altogether (a product deleted upstream, an old build's leftovers)
  options += db.prepare(`DELETE FROM ${t.options} WHERE ${t.groupKey} NOT IN (SELECT id FROM ${t.groups})`).run().changes;
  return { groups, options };
}
