# ZapTill's own sign-in — plan to replace Supabase Auth

Plan only, 2026-10-26, branch `shared-components`. No application code is changed by this document. It goes with `docs/VPS-MIGRATION-PLAN.md` (the move to one server) and `docs/PLATFORM-MOVE-OVERVIEW.md` (the short version for the owner).

Owner, 2026-10-26: "while we are doing the shared components work think of implementing auth on our own, it's a project also, we can do the two in one go."

**The short answer:** ZapTill already runs most of its own sign-in. Every session — owner, partner, manager, cashier, till, technician, admin — is a ZapTill token signed with ZapTill's keys, renewed through ZapTill's own refresh tokens (migration 13, rotation with reuse detection, A88/D13), with ZapTill's own second step (A391), reset codes (A402) and lockouts (A494). Supabase Auth is used for one thing: **it stores the owners' and partners' email + password and checks it**, plus a few account chores (create, change email, set password, read the email). The web dashboard also keeps a second, Supabase browser session, used for page gating, the live counters and one logo upload. Replacing Supabase Auth is therefore mainly a credential store and about 30 call sites — not a new sign-in system.

## 1. Inventory of every sign-in flow today

| # | Flow | Who | Credential checked by | Session issued by | Files |
|---|---|---|---|---|---|
| 1 | Password sign-in to the web dashboard | owner | **Supabase Auth** (`authClient.auth.signInWithPassword`, `routes/auth.ts:733`); then the browser signs in to Supabase **again** itself (`LoginPage.tsx:176`) | ZapTill (`JWT_SECRET`, access 15 min, refresh 30 days, `ownerLogin: true`) + a Supabase browser session | `routes/auth.ts` `/login`, `lib/ownerBusiness.ts`, `apps/dashboard/src/pages/LoginPage.tsx`, `context/AuthContext.tsx` |
| 2 | Partner sign-in (A550) | a staff member the owner lets into the full dashboard | **Supabase Auth** (same `/login`), then the link: `business_settings.web_partners` (the owner's grant) **and** the account's `app_metadata.zaptill_partner` (business → person) | ZapTill (`webPartner`, `partnerBranches`, `allBranches`; re-checked at every renewal) | `lib/webPartners.ts`, `routes/auth.ts` `partnerSignIn`, `/refresh` |
| 3 | Partner invite / revoke | owner | creates a Supabase account with an unusable password (`auth.admin.createUser`) or finds the existing one (`auth.admin.generateLink` magic link, not sent), writes `app_metadata` (`updateUserById`); revoke clears the link | — (the invitee sets a password with the A402 code) | `routes/staff.ts:193-196, 809-813, 873` |
| 4 | Client created in the admin portal | ZapTill admin | `auth.admin.createUser` with the owner's first password, `email_confirm: true` | — | `routes/admin.ts:469` |
| 5 | Legacy self-onboarding | (owner) | browser `supabase.auth.signUp`, server `auth.getUser(token)` | — | `apps/dashboard/src/pages/OnboardingPage.tsx`, `routes/onboarding.ts:49` |
| 6 | Owner email changed by the admin | ZapTill admin | `auth.admin.updateUserById(email)` | — | `routes/admin.ts:1114` |
| 7 | Owner password reset by the admin (A495) | super admin | `setOwnerPassword` → `auth.admin.updateUserById(password)` | revokes the owner's browser sessions | `routes/admin.ts:1045`, `lib/passwordReset.ts` |
| 8 | Forgot password / reset code (A402) | owner, partner | ZapTill code (6 digits, 15 min, 5 tries, `password_reset_codes`, migration 124); the new password is written to **Supabase Auth** (`updateUserById`), email read with `getUserById` | revokes every browser session (`revokeBrowserSessions`) | `lib/passwordReset.ts`, `routes/auth.ts` `/password/forgot`, `/password/reset` |
| 9 | Change password, forced first change (A568) | owner, partner | current password checked by **Supabase Auth** (`signInWithPassword`, `routes/auth.ts:2066`); set by `setOwnerPassword`; the browser then signs in to Supabase again (`ForcePasswordChangePage.tsx:38`) | the current session kept, others revoked | `routes/auth.ts` `/password/change`, `ForcePasswordChangePage.tsx` |
| 10 | Sign-in codes / second step (A391, A398) | admins, owners, managers, partners | ZapTill: emailed code or TOTP (`lib/loginOtp.ts`, migration 119, `OTP_PEPPER`), trusted-device token; per client switch `login_codes` | — | `lib/loginOtp.ts`, `routes/auth.ts` `/otp/*` |
| 11 | Sessions: renew, sign out, current session | everyone with a ZapTill token | ZapTill `refresh_tokens` (sha256 of the token, `session_id`, `device_hint`, `replaced_by` — migrations 13, 84; chain-based replay detection `lib/refreshGrace.ts`; A477 handshake `/refresh/ack`) | ZapTill | `routes/auth.ts` `/refresh`, `/refresh/ack`, `/logout`, `/session`; `lib/tillSessions.ts` |
| 12 | Supabase-token fallback in `requireAuth` | owner | Supabase JWT (`SUPABASE_JWT_SECRET`), accepted **only** while sign-in codes are off (`LOGIN_OTP=off`) | — | `middleware/auth.ts:320-404` |
| 13 | Staff invite email | owner | `auth.admin.inviteUserByEmail` (creates a Supabase account a cashier never uses — staff sign in with a PIN) | — | `routes/staff.ts:544` |
| 14 | Owner's email for jobs and notices | — | `auth.admin.getUserById` | — | `jobs/cloudPlanReminders.ts`, `jobs/dailySummary.ts`, `jobs/lowStockChecker.ts` (2), `jobs/ownerAlertsData.ts`, `lib/ownerBusiness.ts`, `routes/auth.ts:1200, 2063`, `routes/staff.ts:193` |
| 15 | Till joins the business (enrolment code), till signs itself back in (device secret), machine binding (A415, A477) | the till | ZapTill (single-use code; `device_secret_hash`; till identity) | ZapTill (till's own session, no person) | `routes/auth.ts` `/enrol/redeem`, `/device-token`; `lib/deviceGrant.ts`, `lib/tillIdentity.ts` |
| 16 | PIN sign-in on a till and the web POS; set PIN | managers, cashiers | ZapTill (bcrypt PIN hashes in `users`, attempts and lockout `lib/pinAttempts.ts`, A494) | ZapTill (`surface`, `pinSignIn`, branch-scoped) | `routes/auth.ts` `/pos-login`, `/verify-pin`, `/set-pin`; web POS tokens `swiftpos_pos_token` |
| 17 | Technician tokens | technicians | ZapTill, Ed25519 (`TECH_SIGNING_PRIVATE_KEY` / `_PUBLIC_KEY`), verified offline on the till | — | `lib/techToken.ts`, `routes/tech.ts` |
| 18 | Admin portal sign-in | ZapTill staff | ZapTill: `admin_users.password_hash` (bcrypt 12, dummy hash for unknown emails), OTP, account re-read every request (A495) | ZapTill (`ADMIN_JWT_SECRET`, 8 h, `sessionStorage`) | `routes/admin.ts`, `middleware/adminAuth.ts`, `apps/admin/src/AdminPortal.tsx` |
| 19 | Kitchen display token | KDS screen | ZapTill (long-lived, branch-scoped, version-revocable, migration 137) | ZapTill (`surface: 'kds'`) | `routes/kitchen.ts`, `middleware/auth.ts` |
| 20 | The till's push channel (A531) | the till | the same `requireAuth` as every request | — | `lib/liveHub.ts` |
| 21 | Branch-server shop network (A489, A496) | tills at a branch | certificate pinned on the LAN | — | `apps/desktop/src/main/lanTls.ts` (not affected by this plan) |
| 22 | Ops events, GitHub releases | machines | `OPS_INGEST_TOKEN`, `GITHUB_RELEASES_TOKEN` | — | unaffected |

**Count.** Of 22 flows, **14 depend on Supabase Auth in some way (1–14)**, 8 are already ZapTill's alone. In code: **23 server call sites in 11 files** (`getUserById` 12, `updateUserById` 4, `createUser` 2, `signInWithPassword` 2, `generateLink` 1, `inviteUserByEmail` 1, `getUser` 1), plus the `requireAuth` Supabase-token branch, plus **8 Auth calls, 2 Storage calls and 1 Realtime channel in 7 dashboard files**.

**Token storage in browsers today:** the dashboard keeps ZapTill's access **and refresh** tokens in `localStorage` (`swiftpos_access_token`, `swiftpos_refresh_token`, `swiftpos_pos_token`, `swiftpos_pos_refresh_token`) and sends them as `Authorization: Bearer`; no cookies, so no CSRF exposure today. The admin portal keeps its token in `sessionStorage`. The Supabase browser session sits in `localStorage` too.

## 2. Design

### Accounts

A new table **`accounts`** (in `public`, service role only, RLS on with no policy, like the other platform tables):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, primary key | **the same id as `auth.users.id`** — so `businesses.owner_id` and every partner grant keep pointing at the same person |
| `email` | text, not null | stored lower-case and trimmed; unique index on `lower(email)` |
| `password_hash` | text, null | bcrypt (`$2a$…` imported, `$2b$12$…` new); null = no password yet (an invitee) |
| `password_changed_at` | timestamptz | used to refuse tokens issued before a password change |
| `email_verified_at` | timestamptz | imported from `email_confirmed_at` |
| `status` | text: `active`, `disabled` | `banned_until` / `deleted_at` imported as `disabled` |
| `failed_count`, `locked_until` | int, timestamptz | the A494 account lock made durable (today it is per process, in memory) |
| `last_sign_in_at`, `created_at`, `updated_at` | timestamptz | |
| `session_version` | int, default 1 | bumped by "sign out everywhere" and by a password or email change |

A second table **`account_links`** replaces `app_metadata.zaptill_partner` (A550's second record): `(account_id, business_id, user_id, kind = 'partner', created_at)`, unique `(account_id, business_id)`. Only the server writes it, as only the service role could write `app_metadata`. The owner's grant (`business_settings.web_partners`) stays as it is; both records stay required at every sign-in and renewal, exactly as A550 designed. Owners need no link: `businesses.owner_id = accounts.id` is the link, as today.

After the import, a migration repoints the foreign keys that named `auth.users` (`businesses.owner_id`, `stock_movements.created_by`) to `accounts(id)` (`docs/VPS-MIGRATION-PLAN.md` § 6). A small compatible `auth.uid()` function stays for the 149 RLS policies.

### Passwords

- **bcrypt, cost 12** (the server already uses `bcrypt` 6 at cost 12 for PINs and admin passwords). Imported Supabase hashes are bcrypt (`$2a$10$…`, to be verified — § 4); Node's `bcrypt` checks `$2a$` and `$2b$` alike. On a successful sign-in with a cost-10 hash, the password is re-hashed at cost 12 (transparent upgrade). argon2id would need a second native module and could not check the imported hashes, so bcrypt is the right choice here; bcrypt at cost ≥ 10 meets OWASP ASVS L2.
- bcrypt reads only the first 72 bytes: new passwords are limited to 72 bytes (UTF-8) with a clear message, instead of today's 128 characters (`passwordProblem`), so no part of a password is silently ignored.
- Policy: at least **10** characters for new passwords (today 8; existing passwords keep working), not only spaces, not the email, not in a list of the 10,000 most common passwords shipped with the server (no outside call). Decision for the owner: 10 or 12 (ASVS asks 12).
- Unknown email: one comparison against a dummy hash, the same answer and timing as a wrong password (the admin portal already does this, A495).

### Rate limits and lockout

Kept as they are: the `/api/auth` limiter (`authLimiter`, A494/A505 keys), the per-account lock (`pinAttempts.ts` `accountLocked` / `noteAccountFailure`, A507 tells the account), PIN attempts. The account lock moves to `accounts.failed_count` / `locked_until` so it survives a restart. The wrong-password answer stays the same word for word for every reason (A550: never tell a revoked partner their password was right).

### Tokens and sessions

Already in place and kept: access token 15 minutes, refresh 30 days, refresh tokens stored as a sha256 hash with `jti`, `session_id`, `device_hint`, rotated on every use with `replaced_by` and chain-based replay detection (`lib/refreshGrace.ts`: a lost response is reissued, a real replay revokes the session), the permissions version check (`pv`), the A494 re-read of the person at every renewal, the A477 till handshake. Added:

1. **Key id and rotation.** Tokens get a `kid` header. `JWT_SECRET` stays the key for `kid` `k1` (so every live session survives the move); a new optional `JWT_KEYS` holds `{kid: secret}` for the next key. Signing uses the newest key, verification accepts every listed one; a key is removed after 30 days (the refresh lifetime). The same for `ADMIN_JWT_SECRET`. Moving to Ed25519 for access tokens (as the technician tokens already use) is possible later; not needed now.
2. **Revocation on password change, email change, role change.** Password and email changes already revoke the browser sessions (`revokeBrowserSessions`); with `session_version` in the token, an access token issued before the change is refused at once instead of living out its 15 minutes. Role and permission changes are already covered by `pv` (`PERMISSIONS_CHANGED`).
3. **Sessions page and "sign out everywhere".** Settings › Security lists the account's open sessions from `refresh_tokens` (device, IP, last renewal, this browser marked), with "Sign out" per row and "Sign out everywhere" (revokes the rows, bumps `session_version`). Tills' own sessions are never listed or revoked from here (A406/A415).
4. **Audit entries** (in the existing audit log, never with a password, code or token): sign-in succeeded / failed / locked, second step passed / failed, password set / reset / changed, email changed, session revoked, partner link added / removed, account created / disabled.

### Email verification and resets

- Accounts made by the admin portal are verified by definition (the admin typed the email), as today (`email_confirm: true`). A changed email gets a 6-digit code to the **new** address before it takes effect, and a notice to the old one.
- Forgot password, reset and change keep the A402 design and the existing mailer (`lib/mailer.ts`, Resend over HTTPS); only the line that writes the password changes, from Supabase to `accounts`.
- Partner invites keep the A402 code flow (no link that can be forwarded). The invite no longer creates a Supabase account; it creates an `accounts` row with no password (or finds the existing one by email) and the `account_links` row.
- The staff invite (`inviteUserByEmail`) is replaced by the existing mailer with a plain "you were added to … on ZapTill" message; staff still sign in with a PIN.

### One-time codes and TOTP

Kept exactly (A391): emailed codes, authenticator-app TOTP, trusted devices, the admin portal's switch per client, `LOGIN_OTP=off` as the emergency switch. Nothing of it depends on Supabase. (TOTP is already built — it is not a "later" item.)

### Cookie or bearer for the dashboards

**At the cut-over: unchanged — bearer tokens.** Changing the token transport on the same night as the server would add risk for no immediate gain. **After the move (recommended, within a month):** the dashboard's **refresh** token moves to an `HttpOnly; Secure; SameSite=Strict` cookie on `api.zaptill.co.ke`, path `/api/auth/refresh`, and the access token lives only in memory. `app.`, `admin.`, every client address and `api.` are one site (`zaptill.co.ke`), so the cookie works with `credentials: 'include'` and `Access-Control-Allow-Credentials` for the allowed origins (`CORS_ORIGINS`, `TENANT_ROOT_DOMAIN`). The refresh endpoint is the only cookie-authenticated route, it checks `Origin` against the same list, and `SameSite=Strict` stops cross-site use — so CSRF stays closed. A stolen `localStorage` (XSS) then yields at most a 15-minute access token, not a 30-day refresh token. Tills, the branch server and the web POS's till-like sessions keep bearer tokens.

### Several businesses, partners, client addresses

- An owner of several businesses: unchanged — `resolveOwnerBusinesses` answers `409 MULTIPLE_BUSINESSES` with the list and the dashboard asks (BUG-18).
- Partners: `resolvePartnerSignIn` and `checkPartner` read `account_links` instead of `app_metadata`; everything else in `lib/webPartners.ts` stays.
- Client addresses (A378): the tenant is still looked up **before** the password is checked, and on a client's address only that business opens (`findTenant`, `ownedTenantBusiness`).
- One email can be an owner in one business and a partner in another: one `accounts` row, one owner relation, one partner link — the same as one Supabase account today.

### Dashboard changes (removes `@supabase/supabase-js` from the dashboard)

| File | Change |
|---|---|
| `src/lib/supabase.ts` | deleted (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` gone) |
| `src/context/AuthContext.tsx` | the session is "a ZapTill token is held and `/api/auth/session` answers"; sign-out clears ZapTill tokens and calls `/api/auth/logout` |
| `src/lib/api.ts` | `getAuthHeader` uses only the ZapTill token |
| `src/pages/LoginPage.tsx` | step 3 (the second, Supabase sign-in) removed |
| `src/pages/ForcePasswordChangePage.tsx` | the Supabase re-sign-in removed |
| `src/pages/OnboardingPage.tsx` | retired (clients are created in the admin portal) or moved to the API, including the logo upload (`POST /api/business/logo`, stored as the branding logos are) |
| `src/pages/OverviewPage.tsx` | the Realtime channel replaced by the existing 60-second refresh, or by a web session on the A531 push channel (a doorbell, then a read) — which also works for partners, who get nothing from Realtime today |

This step can ship on `dev` **before** the move (it only stops using the Supabase browser session), which takes risk off the cut-over night.

## 3. Server changes

| File | Change |
|---|---|
| new `lib/accounts.ts` | `findAccountByEmail`, `verifyPassword` (dummy hash, re-hash on upgrade), `setPassword`, `createAccount`, `setEmail`, `disableAccount`, `accountEmail(id)`, partner links |
| `lib/supabase.ts` | `authClient` removed |
| `routes/auth.ts` | `/login` and `/password/change` verify with `accounts`; `/refresh` reads the email from `accounts` |
| `lib/passwordReset.ts` | `setOwnerPassword` writes `accounts`; emails read from `accounts`; links from `account_links` |
| `lib/webPartners.ts` | `metaLinks` / `withMetaLink` read and write `account_links` |
| `routes/staff.ts` | invite and revoke use `accounts` + `account_links`; staff invite email through the mailer |
| `routes/admin.ts` | create client → `createAccount`; change owner email → `setEmail` |
| `routes/onboarding.ts` | retired, or accepts a ZapTill token |
| `jobs/*` (5 files), `lib/ownerBusiness.ts` | `accountEmail(id)` instead of `getUserById` |
| `middleware/auth.ts` | the Supabase-token branch and `SUPABASE_JWT_SECRET` removed; `kid` and `session_version` checks added |

Behind one flag during the build: **`AUTH_PROVIDER=supabase`** (today's behaviour, the default) or **`zaptill`**. One module (`lib/accounts.ts`) has both implementations, so every route calls the same function whichever is on.

## 4. Moving the existing accounts

1. **Check the hash format first, on dev, then on production** (the owner runs it in Supabase's SQL editor; it prints no hash):
   `select left(encrypted_password, 4) as prefix, count(*) from auth.users group by 1;`
   Expected: `$2a$` for every account that has a password, and empty for invitees who never set one. Anything else (no rows expected) is reset by code after the move.
2. **Export** only the needed columns (`id, email, encrypted_password, email_confirmed_at, created_at, updated_at, last_sign_in_at, banned_until, deleted_at, raw_app_meta_data`) with `\copy … to 'accounts.csv' csv header`, run by the owner. The file holds password hashes: copy it to the server over SSH only, load it, delete it (`shred -u`). Never in git, email or chat.
3. **Load** into `accounts` (ids preserved), and `raw_app_meta_data -> 'zaptill_partner'` into `account_links` (each pair checked against `business_settings.web_partners`; a link without a grant is dropped, as it opens nothing today either).
4. **Test** with the dev data: every dev account signs in with its usual password; a test account with a known password is compared with `bcrypt.compare` before and after.
5. **First sign-in after the move:** the same email and password work; the session the browser already holds keeps working (the same `JWT_SECRET`, the same `refresh_tokens` rows), so most people notice nothing. Only the Supabase browser session is gone, and with § 2's dashboard change nothing needs it.
6. **No hash, or a bad one:** "Forgot password?" sends the A402 code. The admin portal's reset (super admin) still works.

## 5. Security review checklist (OWASP ASVS 4.0, level 2 items that apply)

- [ ] V2.1 Passwords: minimum length (10 or 12), 72-byte limit stated, no composition rules, common-password list, paste allowed, change requires the current password (A568 ✓).
- [ ] V2.2 Anti-automation: per-address and per-account limits (A494/A505 ✓), durable account lock, the account told of a lock (A507 ✓), no user enumeration in sign-in, forgot and invite answers.
- [ ] V2.4 Credential storage: bcrypt cost ≥ 10 (12), unique salt per hash (built in), dummy-hash timing.
- [ ] V2.5 Recovery: codes 6 digits, 15 minutes, 5 tries, single use, separate hash domain from sign-in codes (A402 ✓); all sessions revoked after a reset ✓; a notice to the account after a change.
- [ ] V2.7/2.8 Second step: emailed code and TOTP (A391 ✓), the code bound to the sign-in attempt, TOTP secret encrypted at rest (`APP_ENCRYPTION_KEY`).
- [ ] V3.2/3.3 Sessions: new session id at sign-in ✓, refresh rotation and replay detection ✓, sign-out revokes server side ✓, absolute lifetime 30 days ✓, revocation on password/email change (session version — new), sign out everywhere (new).
- [ ] V3.4 Cookies (after the cookie step): `HttpOnly`, `Secure`, `SameSite=Strict`, host-only on `api.`, narrow path.
- [ ] V3.5 Tokens: algorithm pinned (`HS256` only ✓), `kid` and rotation (new), `tokenType` checked (access vs refresh) ✓.
- [ ] V4 Access control: tenant checks in the API unchanged ✓; partner link needs both records ✓; client address checked before the password ✓.
- [ ] V6 Secrets: `JWT_SECRET`, `JWT_KEYS`, `ADMIN_JWT_SECRET`, `OTP_PEPPER`, `APP_ENCRYPTION_KEY` only in the server's env file; at least 32 random bytes each.
- [ ] V7 Logging: the audit entries in § 2, never a password, code, token or hash; failed sign-ins logged with the masked email (`maskEmail`).
- [ ] V8 Data: the accounts export handled as a secret (§ 4); `accounts` reachable only by the service role.
- [ ] V13 API: the auth routes keep `validateLoose` schemas, JSON only, sizes capped.
- [ ] V14 Config: `helmet` ✓; CORS list unchanged; HTTPS only (Caddy, HSTS on `api.`, `app.`, `admin.`).

## 6. Test plan

- **Unit tests** (`tests/*.test.mjs`, the house style): `verifyPassword` against a real imported-format `$2a$10$` hash and a `$2b$12$` hash; re-hash on upgrade; dummy-hash path for an unknown email; 72-byte rule; password policy; account lock and unlock times; `kid` selection and an old key accepted, a removed key refused; `session_version` refusal; partner link requires both records (each missing alone refused); account import mapping (ids kept, partner links filtered by grant).
- **HTTP tests** (like `tests/auth-hardening.test.mjs`, `partner-login-a550.test.mjs`, `password-reset.test.mjs`, `login-otp.test.mjs`) run with `AUTH_PROVIDER=zaptill`: owner sign-in, `409 MULTIPLE_BUSINESSES`, client address refusal, partner sign-in and renewal, revoked partner gets the wrong-password answer word for word, forgot/reset revokes sessions, forced change, second step, sign out everywhere, the admin's create / change email / reset.
- **Source checks:** with the flag at `zaptill`, no `auth.admin.`, `signInWithPassword`, `auth.getUser` or `SUPABASE_JWT_SECRET` is reachable (a test that fails if one is added back); the dashboard bundle contains no `supabase` string.
- **Mutation checks:** for each guard (timing dummy, lock, partner grant, link, tenant, session version, `kid`), flip it in a copy and confirm a test fails — as the A494/A550 suites already do.
- **Manual, on the VPS dev:** owner, partner and admin sign-ins with real dev accounts; a reset by code; a forced change; a till renewing through the change (tills are never affected).
- **Full CI step set** after every step (`ci.yml`, with the sqlite driver on `NODE_PATH`), as for the shared-components branch.

## 7. Rollout

**Recommended: build behind the flag, switch at the VPS cut-over (not a long dual-run).** A dual-run in which both Supabase Auth and ZapTill accept passwords would need every password change written to both stores and kept in step; that is more moving parts than it saves. Instead:

1. **`accounts` and `account_links` tables** (a migration safe on Supabase and the VPS; unused while the flag is `supabase`), and the import script. *(week 0)*
2. **Server side behind `AUTH_PROVIDER`**, every test above. *(weeks 0–1)*
3. **Dashboard without the Supabase browser session** (§ 2 table) — works with either provider, so it can go to `dev` and production **before** the move. *(week 1)*
4. **VPS dev with `AUTH_PROVIDER=zaptill`** on the imported dev accounts; a week of use. *(weeks 1–2)*
5. **Production: the flag is `zaptill` from the first minute on the VPS** (accounts imported in the freeze window, with the database). Supabase Auth is never used again.
6. **Fallback on the night:** if step 4 has not passed its checkpoint, production moves with the GoTrue container (`docs/VPS-MIGRATION-PLAN.md` § 10) and the flag stays `supabase`; the switch to `zaptill` follows on the VPS a week later, after importing accounts from GoTrue's database on the same server (no Supabase involved).
7. **After the move:** the cookie step (§ 2), the sessions page, and removal of the flag and the Supabase branch of the code.

**How it fits the branch.** The work is done on `shared-components` like the rest, in its own commits, and tested on the VPS dev environment, which runs that branch. The branch's rules apply: no behaviour change for the people using ZapTill (same sign-in pages, same answers), the full CI step set after every step. Because the move to production is made from `dev`'s code, steps 1–3 are taken to `dev` on their own (they are self-contained and switched off by default) once tested, without waiting for the whole branch.
