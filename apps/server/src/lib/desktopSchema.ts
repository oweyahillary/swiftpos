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
/**
 * Schema 52 = per-terminal `kitchen_exclusions_override` (A66). Local-only, but
 * REQUIRED moves with LOCAL_SCHEMA_VERSION by convention (the test enforces
 * equality) so the "behind" check stays meaningful; a till on 51 keeps trading
 * and syncing and is merely shown as behind until it takes the A66 build.
 */
/** Schema 53 = branding.receipt_logo_enabled (A311). Pulled only; same convention. */
/** Schema 54 = branding.theme_id (A325). Pulled only; same convention. */
/** Schema 55 = orders.origin (cross-sync stage 1: the web's sales downloaded onto a till). Pulled only; same convention. */
/** Schema 56 = device_config.web_pos_enabled (A346: the till shows Stock only with the web POS). Pulled only; same convention. */
/** Schema 57 = A365 shift confirmation (declared / confirmed methods on shifts). A till on 56 keeps trading and syncing;
 *  its closes simply carry no declaration, so nothing of its awaits a manager. */
/** Schema 58 = A367 order notes (orders.notes, order_items.notes, device_config.order_note_picks). A till on 57 keeps
 *  trading; its sales simply carry no notes. */
/** 59 = 0.6.27: POS switches, delivery fee, expense method, confirm reasons. Additive; a till on 58 keeps syncing. */
/** 60 = 0.6.28: kitchen_lines (local) and kitchen_voids (pushed, migration 112). A till on 59 keeps syncing; it simply
 *  sends no kitchen voids. */
/** 61 = 0.6.30: pending_reversals (offline voids/refunds, replayed to /api/orders/:id/void|refund) and
 *  device_config.reversal_rules (pulled). A till on 60 keeps syncing; it simply cannot void or refund offline. */
/** 62 = 0.6.31: products.show_days (pulled; migration 113). A till on 61 keeps syncing; it shows every product every day. */
/** 63 = 0.6.33: orders.delivery_free (free delivery; migration 115). A till on 62 keeps syncing; its deliveries are paid. */
export const REQUIRED_DESKTOP_SCHEMA = 63;

/** 42 still sends valid rows; it just omits covers. Not worth blocking a till. */
export const HARD_MIN_DESKTOP_SCHEMA = 41;
