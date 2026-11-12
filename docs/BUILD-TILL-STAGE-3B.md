# BUILD SHEET — Till Stage 3, Slice B: sell & sync through the branch server

Parent scope: `docs/SCOPE-TILL-STAGE-3.md` (owner-approved). Slice A (the gateway) is committed. This sheet is **Slice B** — a **minimal tablet replication client**: a completed sale reaches the branch server's own store so the branch aggregates it and the server relays it to the cloud (A19).

**STATUS 2026-11-12 — BUILT (push), verified headless, on branch `android-till-3` (uncommitted).** Android `tsc` + `vite build` clean; `android-till-stage3b` 27/27 (hermetic), `android-till-stage3` 40/40, `android-till-stage2` unchanged, `android-till-stage1`, `pos-wording-a586` all green; full offline sweep green (bar the known Windows UV noise). **Pull (`/node/since`) deferred by design — see §5.** APK/Java build runs in CI; device-test on the rig.

## Goal

When a tablet has **joined a branch server**, each completed sale is pushed to the server (`POST /node/sync`) so:
- the **branch server aggregates it** — a desktop POS at the branch shows this tablet's sales in the branch report, over the LAN, with no cloud round-trip;
- the **server relays it to the cloud (A19)** — the sale reaches the cloud *through the server* even when the tablet itself never regains internet.

Reuses the server's existing idempotent ingest (`apps/desktop/src/main/nodeIngest.ts` `applyPeerRows`). It does **not** port the desktop's SQLite seq/cursor/outbox/quarantine machinery onto the tablet.

## The wire contract (matched exactly)

`POST /node/sync` (`apps/desktop/src/main/nodeServer.ts:539`, client `nodeClient.ts:249`):
- Headers: `X-Node-Secret` (branch access code), `X-Device-Id`, `X-Device-Token` (the key the server issued at join — in the saved `ServerLink`). The device key makes the tablet a *proven* till, so the server **relays** its sales (A19).
- Body: `{ device_id, branch_id, tables: { orders: [ row, … ] } }`.
- Each **orders row** is the replicated-column shape (`nodeIngest.ts` `COLUMNS.orders`) and must carry a **positive per-device `seq`** (the server refuses a row with none) and the peer's **own `device_id`**.
- Lines and payments ride **inside** the order as `_items` / `_payments` (they are not their own tables).
- For the A19 relay, the order row carries **`_relayPayload`** — the *verbatim* cloud `/api/orders` body (never reconstructed — `peerRelay.ts`): `buildPeerRelay` requires it to have `branch_id`, `order_number`, non-empty `items` and `payments`, and `idempotency_key === order id`.
- Response: `{ ok, results: { orders: { applied, duplicate, cursor, rejected[], applied_ids[] } } }`. `applied_ids` = the ids the server now **holds**; the tablet removes exactly those.

**The key insight that makes this cheap:** the tablet's captured `POST /api/orders` body (`apps/dashboard` `PaymentModal.buildOrderPayload`) already carries `idempotency_key`, `branch_id`, `order_number`, the money fields, `items` and `payments`. So the body **is** the faithful `_relayPayload`, and the branch-report figures come straight from it — the reshape only has to add `status`, `device_id`, `seq`, `created_at` and synthesise stable line/payment ids.

## What was built

- **`apps/android/src/shop/branchServer.ts`** — added a shared `nodeRequest(link, method, path, body, headers, timeoutMs)` over the pinned TLS (so `branchGateway` and `branchSync` share one transport), returning raw `{status, body, headers}`.
- **`apps/android/src/shop/branchSync.ts`** (new):
  - `nextNodeSeq()` — a persisted per-tablet monotonic sequence (Preferences; the tablet is the only device under its id, so one integer, no SQLite `device_seq`).
  - `orderRowFromBody(body, ctx)` — **pure**: the captured order body → the replicated orders row + `_items` + `_payments` + `_relayPayload`.
  - `pushOrdersToNode(rows, deps)` — the `/node/sync` client; parses `applied_ids` / `rejected`; `ok:false` on any transport problem.
  - A durable **outbox** (`NodeOutbox`: IndexedDB `zaptill-node-outbox`, in-memory fallback) — *separate from the cloud buffer* ("two destinations, their own state", `nodeClient.ts`). `enqueueOrderFor` reshapes+stores; `drainToNode` pushes oldest-first, removes what the server holds, retries the rest, drops a row after `OUTBOX_MAX_TRIES` (8) so a bad row can't grow it unbounded.
- **`apps/android/src/shop/offlineWrites.ts`** — a new optional `onOrder` dep: the seam calls it on a **successful** `POST /api/orders` (online, via the gateway, or buffered — never a cloud-rejected one), so every completed sale is offered to the branch.
- **`apps/android/src/screens/shop/ShopPos.tsx`** — creates the outbox, wires `onOrder` → enqueue + prompt drain, and drains on open / reconnect (runs over the LAN even when the cloud is unreachable). All a no-op when no branch server is joined.

## §5 — Why `/node/since` (pull) is deferred

The tablet has **no local orders store**. The web POS reads the branch's orders from `GET /api/orders` (the cloud), and when the cloud is reachable — directly or via the Slice-A gateway — that already returns the **whole branch's** orders. A LAN pull would only add value in the fully-offline-branch case, and there is nowhere on the tablet to merge peers' rows into for the existing screens to read. A real branch-wide offline view is therefore a **screen of its own** (a "branch orders / report" view fed from a node pull), not a thin addition to this slice. Per the owner-approved direction, Slice B ships a solid push; the pull is written up here for a later decision. **Open owner question:** is an offline branch-wide orders view on the tablet wanted, or is the cloud view (when online) enough?

## Known limitations (documented, acceptable for the minimal slice)

- **`business_id` / `covers` / `cashier_id`** are not in the order body: the row sets them null (single-business branch server; the branch report is scoped by `branch_id`). The **A19 relay** is credited to the right cashier only when a `cashierId` is supplied to the reshape — today the shell enqueues without it, so a *relayed* tablet sale is credited per the relaying token (the pre-A169 behaviour for relays). The tablet's **own online push already credits the cashier** by its token. A later refinement can thread the signed-in cashier id into the reshape.
- Synthesised line/payment ids (`<orderId>-i<n>` / `-p<n>`) are stable, so a re-push de-dupes (`INSERT OR IGNORE`).

## Tests / verification

- `tests/android-till-stage3b.test.mjs` — **hermetic** (native leaves stubbed exactly like `android-till-stage3`): the reshape, the `/node/sync` call and header contract, and the outbox enqueue/drain/cap. Named CI step added after the Slice A step; the offline-suites loop runs it too.
- Verified: `apps/android` tsc + vite build; stage3b 27/27, stage3 40/40, stage2 unchanged, stage1, pos-wording-a586; full offline sweep green (bar the two known Windows `UV_HANDLE_CLOSING` crashes).

## Out of scope (later)

- `/node/verify-pin` (Slice C), `/node/refresh` (Slice D), shared tables (Stage 3b), and the native-client routing folded into C/D.
- Nothing deploys — lands on `dev`, app on dev-api.
