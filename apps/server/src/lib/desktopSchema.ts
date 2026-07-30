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

/** Schema 43 = business_days + shift attribution + orders.covers on the till. */
export const REQUIRED_DESKTOP_SCHEMA = 43;

/** 42 still sends valid rows; it just omits covers. Not worth blocking a till. */
export const HARD_MIN_DESKTOP_SCHEMA = 41;
