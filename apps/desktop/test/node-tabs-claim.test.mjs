/**
 * node-tabs-claim.test.mjs — D9: the node-authoritative tab store's atomic claim,
 * lease, and clear-audit. Proves the SEMANTICS (SQL + concurrency logic) under a
 * SQLite stand-in; the LIVE cross-till behaviour (poll lag, offline mid-charge,
 * two real tills racing) is not here — that needs a two-till rig (rule 16, and
 * the whole point of D9).
 *
 *   node apps/desktop/test/node-tabs-claim.test.mjs
 *
 * A .mjs test can't import the .ts module, so the ATOMIC SQL under test is copied
 * here verbatim from nodeTabs.ts and kept in sync by hand (same convention as
 * ipc-validate / heldOrders). If nodeTabs.ts's claim/update/delete SQL changes,
 * change it here too — the guard in the register delivery checks they match.
 */
import assert from 'assert';
import { createRequire } from 'module';

let db;
try {
  const require = createRequire(import.meta.url);
  db = new (require('better-sqlite3'))(':memory:');
} catch {
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(':memory:');
}

const LEASE_MS = 90_000;
const now = () => new Date().toISOString();
const leaseUntil = (ms = LEASE_MS) => new Date(Date.now() + ms).toISOString();

db.exec(`
CREATE TABLE node_tabs (
  id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, order_number TEXT NOT NULL,
  label TEXT NOT NULL, order_type TEXT NOT NULL, table_number TEXT NOT NULL DEFAULT '',
  delivery_person TEXT, cart TEXT NOT NULL, opened_by TEXT NOT NULL, opened_at TEXT NOT NULL,
  last_changed_by TEXT, last_changed_at TEXT, locked_by TEXT, lock_expires TEXT
);`);

const getTab = (id) => db.prepare(`SELECT * FROM node_tabs WHERE id = ?`).get(id);
const isLocked = (t, at = now()) => !!t.locked_by && !!t.lock_expires && t.lock_expires > at;

function registerTab(t) {
  db.prepare(`INSERT INTO node_tabs (id,branch_id,order_number,label,order_type,table_number,delivery_person,cart,opened_by,opened_at)
              VALUES (@id,@branch_id,@order_number,@label,@order_type,@table_number,@delivery_person,@cart,@opened_by,@opened_at)`)
    .run({ id: t.id, branch_id: t.branch_id, order_number: t.order_number, label: t.label, order_type: t.order_type,
           table_number: t.table_number ?? '', delivery_person: t.delivery_person ?? null,
           cart: JSON.stringify(t.cart ?? []), opened_by: t.opened_by, opened_at: now() });
  return getTab(t.id);
}
// claim: the exact atomic UPDATE from nodeTabs.ts (with an injectable lock_expires for the lease-expiry test)
function claim(id, who, expOverride) {
  const before = getTab(id);
  if (!before) return { ok: false, code: 409, lockedBy: '(gone)' };
  const at = now();
  const stole = !!before.locked_by && before.locked_by !== who && !isLocked(before, at);
  const changes = db.prepare(`
    UPDATE node_tabs SET locked_by=@who, lock_expires=@exp, last_changed_by=COALESCE(last_changed_by,@who)
     WHERE id=@id AND (locked_by IS NULL OR locked_by=@who OR lock_expires IS NULL OR lock_expires<=@at)`)
    .run({ who, exp: expOverride ?? leaseUntil(), id, at }).changes;
  if (changes === 1) return { ok: true, tab: getTab(id), stole };
  return { ok: false, code: 409, lockedBy: getTab(id)?.locked_by ?? '?' };
}
function updateTab(id, who, cart) {
  const t = getTab(id);
  if (!t) return { ok: false, code: 409 };
  if (!t.locked_by || t.locked_by !== who || !isLocked(t)) return { ok: false, code: 423 };
  db.prepare(`UPDATE node_tabs SET cart=@cart, last_changed_by=@who, last_changed_at=@at, lock_expires=@exp WHERE id=@id AND locked_by=@who`)
    .run({ cart: JSON.stringify(cart), who, at: now(), exp: leaseUntil(), id });
  return { ok: true, tab: getTab(id) };
}
function deleteTab(id, who, reason) {
  const t = getTab(id);
  if (!t) return { ok: false, code: 409 };
  if (!t.locked_by || t.locked_by !== who || !isLocked(t)) return { ok: false, code: 423 };
  const audit = reason === 'cleared'
    ? { tab_id: t.id, opened_by: t.opened_by, last_changed_by: t.last_changed_by, cleared_by: who }
    : null;
  db.prepare(`DELETE FROM node_tabs WHERE id=? AND locked_by=?`).run(id, who);
  return { ok: true, audit };
}

let pass = 0, fail = 0;
const ok = (label, cond, d = '') => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}  ${d}`); } };

const base = { branch_id: 'b1', order_number: 'T1-01', label: 'Table 1', order_type: 'dine_in', opened_by: 'till-1', cart: [{ x: 1 }] };

// 1. open + claim
registerTab({ ...base, id: 'tab1' });
const c1 = claim('tab1', 'till-1');
ok('first claim wins', c1.ok === true && c1.stole === false);
ok('claim sets the lock holder', getTab('tab1').locked_by === 'till-1');

// 2. a second till cannot claim a live lock → 409
const c2 = claim('tab1', 'till-2');
ok('a second till is refused while the lock is live (409)', c2.ok === false && c2.code === 409 && c2.lockedBy === 'till-1');

// 3. the holder re-claiming is idempotent (not a steal)
const c1again = claim('tab1', 'till-1');
ok('the holder re-claiming still wins, not a steal', c1again.ok === true && c1again.stole === false);

// 4. edit renews the lease AND is holder-gated
const beforeExp = getTab('tab1').lock_expires;
const u = updateTab('tab1', 'till-1', [{ x: 2 }]);
ok('the holder can edit', u.ok === true);
ok('editing renews the lease', getTab('tab1').lock_expires >= beforeExp);
ok('editing records last_changed_by', getTab('tab1').last_changed_by === 'till-1');
const uDenied = updateTab('tab1', 'till-2', [{ x: 9 }]);
ok('a non-holder cannot edit (423 Locked)', uDenied.ok === false && uDenied.code === 423);

// 5. lease EXPIRY lets another till steal — and it is flagged as a steal
registerTab({ ...base, id: 'tab2', opened_by: 'till-1' });
claim('tab2', 'till-1', new Date(Date.now() - 1000).toISOString()); // claim with an already-expired lease
const c3 = claim('tab2', 'till-2');
ok('an EXPIRED lease can be stolen by another till', c3.ok === true);
ok('a forced steal is flagged (stole=true) for the audit', c3.stole === true);
ok('the stealer now holds the lock', getTab('tab2').locked_by === 'till-2');

// 6. release makes it claimable again
registerTab({ ...base, id: 'tab3' });
claim('tab3', 'till-1');
db.prepare(`UPDATE node_tabs SET locked_by=NULL, lock_expires=NULL WHERE id=? AND locked_by=?`).run('tab3', 'till-1');
const c4 = claim('tab3', 'till-2');
ok('after release, another till can claim (no steal)', c4.ok === true && c4.stole === false);

// 7. CLEAR is audited; CHARGE is not; both are holder-gated
registerTab({ ...base, id: 'tab4', opened_by: 'till-1' });
claim('tab4', 'till-1');
updateTab('tab4', 'till-1', [{ x: 3 }]);
const clr = deleteTab('tab4', 'till-1', 'cleared');
ok('clear succeeds for the holder', clr.ok === true);
ok('clear produces an audit record (who opened / changed / cleared)',
   clr.audit && clr.audit.opened_by === 'till-1' && clr.audit.cleared_by === 'till-1');
ok('the cleared tab is gone', getTab('tab4') === undefined);

registerTab({ ...base, id: 'tab5' });
claim('tab5', 'till-1');
const chg = deleteTab('tab5', 'till-1', 'charged');
ok('charge succeeds and is NOT audited (routine sale)', chg.ok === true && chg.audit === null);

// 8. a non-holder cannot clear (so the who-cleared audit is meaningful)
registerTab({ ...base, id: 'tab6' });
claim('tab6', 'till-1');
const clrDenied = deleteTab('tab6', 'till-2', 'cleared');
ok('a non-holder cannot clear a tab (423)', clrDenied.ok === false && clrDenied.code === 423);

console.log(`\n${fail === 0 ? `All ${pass} checks passed. The atomic claim/lease/audit semantics hold.` : `${fail} FAILED (${pass} passed)`}`);
console.log('NOTE: live cross-till behaviour (poll lag, offline mid-charge, real race) needs a two-till rig — not covered here.');
process.exit(fail === 0 ? 0 : 1);
