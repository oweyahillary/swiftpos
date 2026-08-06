# Fix: PIN attribution (#11) and auth rate-limiter bypass (#12)

Two auth-hardening fixes. Neither corrupts existing data, but #11 was quietly
mis-attributing sales and #12 left the PIN brute-force limit ineffective.

## Files in this bundle

    apps/server/src/routes/auth.ts     PIN uniqueness + ambiguous-match refusal
    apps/server/src/index.ts           auth limiter keys on IP, not a header
    tests/pin-and-ratelimit.test.mjs   proof, standalone

Both source files are complete — drop them over the existing ones. No migration.

## #11 — shared PINs mis-attribute sales

The POS login (`/api/auth/verify-pin`) took only a PIN, looped over every active
staff member bcrypt-comparing, and attributed to the FIRST match. With 4-digit
PINs and a handful of staff, two people sharing a PIN is likely — and then every
sale one of them rang was booked to the other. Per-cashier accountability was
silently wrong, and the shift/drawer attribution built on it inherited the error.

Two changes:

  * LOGIN now collects ALL matches and REFUSES (409, code PIN_NOT_UNIQUE) if more
    than one staff member matches, rather than guessing. A shared PIN is a
    condition to correct, not to paper over.
  * SET-PIN (`/api/auth/set-pin`) now rejects a PIN already in use by another
    active staff member (409, PIN_NOT_UNIQUE). bcrypt hashes are salted so a
    plain unique index cannot catch this; the new PIN is compared against every
    other active user's hash. That is N bcrypt compares on a rare admin action,
    which is cheap, and it keeps the hot path (login) unambiguous.

Note on cost: BCRYPT_ROUNDS is 12, which is correct and unchanged. The login loop
still does up to N compares, but with uniqueness enforced at set-time it will
find exactly one match in healthy data. (A future refinement could ask the client
for a staff selection first and do a single compare, but that changes the
PIN-only login UX and is left as a product decision.)

>> AFTER DEPLOYING: existing data may already contain two staff with the same
   PIN. Those users will now get PIN_NOT_UNIQUE at login until a manager resets
   one of them. That is the correct outcome — it surfaces an attribution
   ambiguity that was previously silent — but tell your managers so a shared-PIN
   login failure is understood, not mistaken for a bug.

## #12 — the PIN brute-force limit never fired

The auth rate limiter keyed attempts on `x-device-id`, a CLIENT-SUPPLIED header.
An anonymous attacker brute-forcing PINs just sets a fresh device id on every
request, so each attempt looked like a new device and the 30-per-15-min limit
never triggered. The device key made sense for the GENERAL API limiter (two
tills behind one office NAT should not share a quota) but is exactly wrong for
the AUTH limiter, whose whole job is to stop an anonymous attacker who controls
that header.

Now there are two keys:

  * AUTH limiter keys on the source IP (with the session token when the caller is
    already authenticated, so a legit owner calling verify-pin repeatedly is
    bucketed per-session). The anonymous login path — the brute-force target —
    always keys on IP and cannot be widened by spoofing a header.
  * GENERAL API limiter keeps the device/session/IP key, so the two-tills-behind-
    one-NAT fairness the original comment describes is preserved.

## Test

    node tests/pin-and-ratelimit.test.mjs   (needs bcryptjs or bcrypt)

12 checks against real bcrypt hashes: correct attribution, set-pin uniqueness
accept/reject, a shared PIN refused rather than mis-attributed, the auth limiter
ignoring a rotated device header and bucketing on IP, and the general API limiter
still separating two tills behind one NAT. Expected: 12 PASS.

## Do you need to build the desktop app?

No. Server-only, no migration, no desktop build. After deploying, confirm a
normal PIN login still works, that setting a duplicate PIN is refused, and (if
you can) that rapid repeated bad PINs from one source start returning 429.
