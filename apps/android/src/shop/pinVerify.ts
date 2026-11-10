/**
 * pinVerify.ts — Till stage 2: verify an offline PIN LOCALLY against the cached bcrypt verifier (the branch roster's
 * pin_hash, shop/offlinePin.ts). It makes the offline sign-in a REAL check at the till — a wrong PIN is refused HERE, the
 * moment it is typed, not only when the POS reconnects. The reconnect upgrade (shop/offlineUpgrade.ts) still runs, to turn
 * the provisional session into a real cloud one and to catch a PIN changed or disabled on the web.
 *
 * bcryptjs is pure JavaScript (no native module), so it runs in the Capacitor WebView. It verifies the server's $2b
 * hashes (and $2a/$2y) — the roster is already filtered to bcrypt hashes server-side (apps/server routes/pos.ts).
 */
import { compareSync } from 'bcryptjs';
import type { VerifyLocally } from './offlinePin';

/** 'ok' / 'no' from the cached bcrypt hash; 'deferred' when there is no usable verifier, so the sign-in falls back to the
 *  reconnect gate instead of wrongly refusing a valid person (a legacy/absent hash the server never sent for offline use). */
export const bcryptVerify: VerifyLocally = (pinHash, pin) => {
  if (!pinHash || !pinHash.startsWith('$2')) return 'deferred';
  try { return compareSync(pin, pinHash) ? 'ok' : 'no'; }
  catch { return 'deferred'; }
};
