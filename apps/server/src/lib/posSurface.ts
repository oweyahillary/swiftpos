/**
 * posSurface.ts — which sessions are a POS DEVICE's (Till stage 1, docs/ANDROID-APP-DESIGN.md §11).
 *
 * A POS device signs in as itself (A415) and takes a POS seat: the desktop POS (surface 'desktop') and, from Till stage 1,
 * the Android Shop POS (surface 'android-till'). Decision taken for stage 1 (§10.8, 2026-11-05): the cloud's GATES treat
 * the two alike — the A159 terminal-write guard, the A581 / A601 / A612 plan gates, the online licence (A604 follow-up),
 * the branch's POS licence at PIN sign-in and /api/pos/init, and what a session is when an owner revokes sessions.
 *
 * What stays the desktop's alone is its PROTOCOL: offline replays with their own times (created_at, closed_at), the sync
 * push, the PIN hash for offline sign-in, the whole-menu pull, the branch server's routes. The Shop POS sells with the
 * web POS screens, online (stage 1), so where a route tells a desktop replay from a live web request it keeps answering
 * a Shop POS as it answers the web POS. Each such place is listed in §11.2.
 *
 * Pure (no env, no database), so the tests run this exact rule.
 */

/** The surfaces of a POS device's sessions (its own, and a person's PIN sign-in on it). */
export const POS_DEVICE_SURFACES = ['desktop', 'android-till'] as const;
export type PosDeviceSurface = (typeof POS_DEVICE_SURFACES)[number];

/** Is this a POS device's session (desktop POS or Android Shop POS)? The cloud's gates key on this. */
export function isPosDeviceSurface(surface: unknown): surface is PosDeviceSurface {
  return typeof surface === 'string' && (POS_DEVICE_SURFACES as readonly string[]).includes(surface);
}

/**
 * The surface a POS device's own session is minted with. A joining device names it (`surface` in the enrolment body);
 * anything but 'android-till' is the desktop, as before — so every desktop build, which sends none, is unchanged.
 */
export function deviceSurfaceOf(claimed: unknown): PosDeviceSurface {
  return claimed === 'android-till' ? 'android-till' : 'desktop';
}
