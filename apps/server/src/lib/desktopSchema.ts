/**
 * desktopSchema.ts — the desktop schema generation this server expects.
 *
 * Single source of truth, because two routes need it and they must never
 * disagree: /api/sync/push decides whether to warn a till that it is behind, and
 * /api/devices/fleet shows an operator which tills those are. Duplicating the
 * number would let the warning and the screen diverge on the next deploy, and the
 * screen would say every till was current while the push said otherwise.
 *
 * WHEN TO MOVE THESE
 *   REQUIRED — raise whenever a till needs a newer local schema to send everything
 *              the server now stores. A till below this keeps trading and syncing
 *              and is merely reported as behind. Raising it is cheap and honest.
 *
 *   HARD_MIN — raise ONLY when older payloads are genuinely incompatible, because
 *              a till below this is refused outright. Raising it for tidiness
 *              turns a deploy into a fleet-wide outage in the middle of service.
 *
 * Pairs with LOCAL_SCHEMA_VERSION in apps/desktop/src/main/localDb.ts. Both move
 * together, or the check means nothing.
 */

/**
 * Schema 45 = branch replication: per-device `seq` on the five replicated
 * tables, node_queue, peer_cursors, outbox_cursors — plus orders.pump_id.
 *
 * Moved 43 → 45 in one step. 44 (device_id on expenses and float_transactions)
 * was written but no till was ever built from it, so it never existed in the
 * field and there is nothing to be compatible with.
 *
 * This one has to move with the till release rather than after it. A till on 44
 * acting as the branch NODE would ingest peer rows with no seq, and every one of
 * them would be invisible to the cursor that decides what still needs
 * replicating — so the peer would re-offer its whole history every pass and the
 * node would refuse it every pass.
 */
export const REQUIRED_DESKTOP_SCHEMA = 49;

/** 42 still sends valid rows; it just omits covers. Not worth blocking a till. */
export const HARD_MIN_DESKTOP_SCHEMA = 41;
