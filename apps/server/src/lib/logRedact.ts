/**
 * logRedact.ts — A519: what a till's log may NOT carry when it leaves the till ("Send logs to support").
 *
 * The till's log (swiftpos.log, auth.log) is written never to hold a secret (logFile.ts: "Callers pass messages; tokens
 * must never be among them") — but a log is written by a hundred call sites over a year, an error message can quote a
 * request, and a log sent to support is read by people outside the business. So everything that looks like a secret is
 * removed before the file is sent or saved, on the till, AND again by the cloud before it is stored (a till on an older
 * build, or a pattern added later). Copies: shared/logRedact.ts (canonical), apps/desktop/src/main/logRedact.ts,
 * apps/server/src/lib/logRedact.ts — scripts/check-shared-sync.mjs keeps them identical.
 *
 * Removed: bearer / Authorization values; JWTs (eyJ…); technician tokens (st2.…); bcrypt hashes; long hex and base64url
 * runs (keys, hashes, device secrets); the values of named secret fields in JSON, query strings and "key=value" /
 * "key: value" text (token, refresh_token, password, pin, override_pin, approver_pin, access_code, node_secret,
 * device_secret, secret, api_key, authorization, x-tech-token, x-join-proof, enrolment code, otp, mpesa passkey and
 * consumer secret); a PIN written as words ("PIN 1234"). Names, amounts, bill numbers and times stay — they are what
 * support needs.
 *
 * Pure (no imports), so every copy and its tests run it as it is.
 */

export const REDACTED = '[redacted]';

/** The field names whose values never leave the till (matched case-insensitively, `-` and `_` alike). */
export const SECRET_FIELDS: readonly string[] = [
  'token', 'access_token', 'accesstoken', 'refresh_token', 'refreshtoken', 'id_token', 'device_token', 'devicetoken',
  'password', 'passwd', 'pwd', 'pin', 'pin_hash', 'override_pin', 'approver_pin', 'supervisor_pin', 'new_pin', 'old_pin',
  'access_code', 'accesscode', 'node_secret', 'nodesecret', 'device_secret', 'devicesecret', 'secret', 'client_secret',
  'consumer_secret', 'consumer_key', 'passkey', 'api_key', 'apikey', 'authorization', 'x_tech_token', 'x_join_proof',
  'tech_token', 'techtoken', 'enrol_code', 'enrolment_code', 'code_hash', 'otp', 'otp_code', 'totp', 'signature', 'cookie',
  'set_cookie', 'private_key', 'privatekey',
];

const fieldAlt = SECRET_FIELDS.map((f) => f.replace(/_/g, '[-_]?')).join('|');

const RULES: ReadonlyArray<[RegExp, string]> = [
  // Authorization headers and bearer values, whatever follows.
  [/\b(authorization|x-tech-token|x-join-proof)(["']?\s*[:=]\s*["']?)(bearer\s+)?[^\s"',;}]+/gi, `$1$2${REDACTED}`],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  // JWTs, technician tokens, bcrypt hashes.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[jwt]'],
  [/\bst2\.[A-Za-z0-9._-]{10,}/g, '[tech-token]'],
  [/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g, '[bcrypt]'],
  // A named secret field: "token":"…", token=…, pin: 1234, ?access_code=…
  [new RegExp(`(["']?\\b(?:${fieldAlt})\\b["']?\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s,&;}\\]]+)`, 'gi'), `$1"${REDACTED}"`],
  // A PIN in words: "PIN 1234", "pin was 004321".
  [/\b(pin)(\s+(?:is\s+|was\s+|of\s+)?)\d{4,8}\b/gi, `$1$2${REDACTED}`],
  // Long hex (hashes, keys, secrets) and long base64url runs (keys, secrets). 32+ characters: never a bill number, an
  // amount, a time or a UUID (a UUID's groups are shorter — device and order ids stay, support needs them).
  [/\b[a-f0-9]{32,}\b/gi, '[hex]'],
  [/\b[A-Za-z0-9_-]{40,}\b/g, '[key]'],
];

/** The text with every secret-looking value replaced. Never throws. */
export function redactLog(text: string): string {
  let out = String(text ?? '');
  for (const [re, to] of RULES) {
    try { out = out.replace(re, to); } catch { /* a rule that cannot run takes nothing away */ }
  }
  return out;
}
