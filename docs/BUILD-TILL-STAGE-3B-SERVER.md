# Till stage 3b — server slice: shared held orders (`/node/tabs…`)

Exposes the branch node's **already-built, unit-tested** tab store (`apps/desktop/src/main/nodeTabs.ts`) as `/node/tabs…`
routes on the branch server, so a held order opened on one till can be **seen, locked, edited and charged from another**.
This is the server half of Stage 3b; the **web/Android POS consumer is the next slice**. Nothing deploys.

## The decided model (owner, D9 brief 2026-09-10; UX confirmed 2026-11-14)
- Every till **SEES** every open tab.
- To **edit / charge / clear** a tab a till must hold its **LOCK** — a single atomic claim; two tills can never both hold it.
- The lock is a **90-second lease**, renewed on every edit. An abandoned tab frees itself in 90s.
- **"See it, then take over":** a **lapsed** lease is auto-taken by the next claimer (`stole:true`, audited). An **actively-held**
  lock is taken only by a **manager-approved force-claim** (audited). The client enforces the manager approval; the node records who took it from whom.
- **CLEAR** (discard) is audited; a **CHARGE** (tab → sale) is routine and not audited.

## Routes (in `nodeServer.ts`, after `/node/since`)
All are **branch-scoped + `X-Node-Secret` (central gate, line 384) + `requireProven`** (device proof) like every `/node/*`
route. **The lock holder is the proven DEVICE** (`who = me.device`) — never a value the caller supplies; the staff **display
name** rides in the body's `opened_by` for the floor ("Jane has this open").

| Route | Method | nodeTabs call | Notes |
|---|---|---|---|
| `/node/tabs?branch_id=` | GET | `listOpenTabs` | every open tab + `locked`/`locked_by` |
| `/node/tabs` | POST | `registerTab` | upsert an opened tab; `opened_by` = staff name |
| `/node/tabs/:id` | POST | `updateTab` | save edits, renews lease; **423** if not holder |
| `/node/tabs/:id/claim` | POST | `claimTab` | wins if unlocked/mine/**lapsed**; **409** on a live foreign lock; `stole`→audit |
| `/node/tabs/:id/force-claim` | POST | `forceClaim` *(new)* | manager-approved steal of a **live** lock; returns `previousHolder`→audit |
| `/node/tabs/:id/release` | POST | `releaseTab` | drop the lock |
| `/node/tabs/:id/delete` | POST | `deleteTab` | body `{reason:'charged'\|'cleared'}`; a clear → audit |

Result bodies (incl. `409`/`423` + `lockedBy`) are returned as-is so the client can drive the take-over UX.

## `forceClaim` (added to `nodeTabs.ts`)
`claimTab` only takes a **lapsed** lease. `forceClaim(db, id, who)` is one **unconditional** atomic `UPDATE … WHERE id=@id`
that overrides even a live holder, returning `previousHolder` for the audit (gone → 409). The node serves requests one at a
time, so simultaneous forces still leave exactly one holder. Mirrored into `apps/desktop/test/node-tabs-claim.test.mjs`
(the test copies the SQL verbatim by hand) with new assertions: a normal claim still 409s on a live foreign lock;
force-claim takes it + reports the previous holder; force-claim on my own tab → no previous holder; a gone tab → 409.

## Schema
`ensureNodeTabs(getLocalDb())` is called once in `startNodeServer()` (after `prepareDeviceEnrolment`) — idempotent
`CREATE TABLE IF NOT EXISTS node_tabs`.

## Audit / notify — and the deferral
There is **no node-side manager-alert relay** today. So steal + clear are **`logLine('node', …)`-logged AND the audit record
is returned in the route response** — the client surfaces the manager notification (it already owns the alert UI). A
**cloud-relayed manager alert is a follow-up** (so a manager not at a till still learns of a force-steal / clear).

## Files
- `apps/desktop/src/main/nodeTabs.ts` — `forceClaim` added.
- `apps/desktop/src/main/nodeServer.ts` — import, `ensureNodeTabs` in `startNodeServer`, the `/node/tabs…` routes.
- `apps/desktop/test/node-tabs-claim.test.mjs` — `forceClaim` helper + section 9.
- `.github/workflows/ci.yml` — runs the node-tab test.
- `docs/BUILD-TILL-STAGE-3B-SERVER.md` — this sheet.

## Two-till RIG TEST (required before any floor use — the whole point of D9)
The hermetic test proves the SQL/semantics only. On a real rig (desktop node + two tills/tablets):
1. **No tab sold twice:** two tills try to charge the same tab at once → exactly one succeeds, the other gets 409/423.
2. **Lapsed-lease auto-steal:** till-1 opens a tab and goes idle/offline > 90s → till-2 claims it (audited), no double-hold.
3. **Manager force-steal of a LIVE tab:** till-2 force-claims a tab till-1 is actively on → till-1 is bumped to read-only,
   the steal is logged + the audit surfaced.
4. **Lease renewal under active edit:** till-1 keeps editing → its lease never lapses → till-2 cannot claim.
5. **Clear audit:** a clear from the holder removes the tab everywhere and records who opened/changed/cleared it.
