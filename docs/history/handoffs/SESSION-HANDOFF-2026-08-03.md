# SwiftPOS — session handoff, 3 August 2026

Supersedes SESSION-HANDOFF-2026-08-02.md. Read §1 and §4 before doing anything.

---

## 1. STATE

### Deployed / installed

- Tills rebuilt at **0.4.7** (both), **0.4.8 pending** (business-type restart fix).
- Server unchanged this session — every change was desktop `main`/`renderer` or `scripts/`.
- Phase 1 (node protocol) **live and proven on real hardware**: orders + shifts +
  floats + expenses + business_days replicate T2 → T1; the conflict Retry was
  exercised against production and cleared a real parked shift.

### Fixed this session, verified on hardware

| Bug | Fix |
|---|---|
| Sell gate / float modal / day close all broken on 0.4.5 build | `getOpenShift()` had a scope placeholder with **zero binds** — the sell gate itself threw on every call. One line. Guard blind spots closed (comments before SQL, `?? null` after call): 158 → 165 statements scanned. |
| Day gate failed **open** on error | `day:gate` IPC now fails closed into the red hard-block with the reason. |
| Peer orders reached the node without payments | Payments ride inside the order (both directions, same transaction, stamped `'peer'`). Branch method split now sums to branch revenue. Duplicate re-offer back-fills holes. |
| Conflicted shifts were parked forever | `retryConflictedShift()` + **Retry sync** button on the Close Day conflict card. Re-arms the shift + floats + expenses + trading day as one family; refuses peer drawers. Card now shows the server's real refusal reason (was hardcoded). |
| Restart silently downgraded restaurant → retail in manager UI | `auth:getSession` now returns `business.type` from device_config. This is the 0.4.8 build. |

Test suite: `test-node-ingest` **50** assertions (was 41), rejection-routing 18,
both on better-sqlite3. All guards green, tsc clean both projects.

### Decisions made (do not relitigate)

- **Licensing: Model B.** Per-branch licence; activation codes are quota'd
  (`max_devices: N`), branch-locked, minted in the **admin portal** (vendor
  side), never by the owner. `device_activation_uses` doubles as the billing
  ledger. Reinstall of a known device_id re-auths free; a wiped config consumes
  a visible new seat.
- **Central day close = Phase 4 as designed.** Per-till day ownership stays;
  blind count stays at the till; unreachable till is listed, never pretended.

## 2. QUEUE

1. **Tonight's gate** — full close on both tills; web Open Drawers empty; commit + push.
2. **0.4.8** — build + install (business-type fix). Extract order matters: 047 zip → businesstype zip.
3. **Phase 4 — central day close** (~4 days). Needs only Phase 1, which is live.
4. **Activation codes** (~1 day). Jumps the queue if a client install is booked.
5. **Phase 2 — mesh replication** (~1 week). Three decisions required first (§3).

## 3. BEFORE PHASE 2 STARTS — owner decisions

1. Confirm every till holding branch-wide data (disk, theft exposure, DPA answer).
2. Office PC as node vs T1-as-node with PC as viewer — may differ per client; installer supports both.
3. Promotion fallback when a peer is missing data: rebuild from cloud, peers re-push, or a report that states "consolidated from <date>". Visibly partial is safe; invisibly partial is not.

## 4. WATCH FOR

- **Version strings are load-bearing.** Three binaries said 0.4.5 in one week and it cost a day of diagnosis. Bump before every build, read the sidebar footer when a till misbehaves.
- **Uncommitted tree + stacked zips** is the July failure mode. Everything extracts, commits, pushes tonight.
- `clearDeviceConfig()` still ungated — half-closed by activation-code seat visibility, code gate still pending.
- Old peer orders ingested before the payments fix keep Payment "—" locally; server data is complete. Cosmetic, self-resolves as days roll.

## 5. UNRESOLVED, NOT BLOCKING

Carried from 02-08: Render SMTP test, swiftpos.co.ke purchase, schema-index
`--from-db` run, `pump_id` on the till (ride with next rebuild), branch
protection on `main` honoured or removed, C0 packaging (`git archive`).
