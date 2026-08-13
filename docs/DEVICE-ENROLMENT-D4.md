# Device enrolment (register D4, closes D1)

**Status: implemented across all three layers and type-checked; pending one live
end-to-end test.** The `device_enrolment_codes` table (migration 81) and its
single-use/expiry guarantee are proven against real Postgres
(`scripts/test-migration-81.mjs`). The endpoints (`routes/enrol.ts` issue,
`auth.ts` redeem) and the desktop (InstallPage + `auth:enrolDevice` +
`posApi.auth.redeemEnrolment`) are shipped, `tsc`-clean, and IPC-parity-balanced.
What has NOT run — because the bench has no server round-trip and no Electron — is
the actual HTTP flow, the token mint/verify, `registerDesktopTerminal` writing
`user_devices`, and a completed install. Run the §"Prove it" checklist below
before relying on it. This document is now the live-test runbook, not a proposal.

---

## The problem (D1)

A till provisions itself by an OWNER signing in on the device. Those credentials
belong to a person, not a terminal; and an owner with two businesses has no way
to say WHICH business this till serves — `/desktop-login` derives the business
from the account, and a two-business owner is a dead end. That is D1.

## The design

Identify the business by its **id**; authorise the device with a **single-use
enrolment code** the owner issues in the portal. The business is chosen
explicitly (the id), so the two-business ambiguity is gone. The code is shown
once, hashed at rest, expires quickly, and burns on first redeem — the same
shape `tech_access_tokens` and `mode_switch_requests` already use.

```
Owner portal  ──issue──▶  device_enrolment_codes (code_hash, business_id, expires_at)
Till          ──redeem─▶  server burns the code, registers the device, returns a desktop session
```

## Token identity decision (confirm this first)

The redeemed session is **the same token `/desktop-login` already mints**: an
owner-scoped desktop token — `userId` = the owner who issued the code
(`created_by`), `businessId` = the code's business, `surface: 'desktop'`,
`isOwner: true`, `permissionKeys: ['*']`, `branchId: null`. Rationale:

- `orders.cashier_id` REFERENCES `public.users(id)`, and the till's
  catalogue-pull / verify-pin token has always been an owner-scoped desktop
  token. Enrolment replaces the *password check* with a *code check*; it does not
  change what the token IS.
- It is **not weaker than today**: today the owner types their password on the
  till; with enrolment they never do, and the authorising secret is single-use
  and short-lived.

A genuinely device-scoped identity (a synthetic principal per terminal, not the
owner) would be stronger, but it means decoupling `orders.cashier_id` from
`users` — a much larger change. Out of scope for D4; noted for later.

## Wiring: extract the desktop-session helpers

`TokenPayload`, `issueTokenPair`, and `storeRefreshToken` are currently **local
to `routes/auth.ts`**. Redeem needs them. Extract them once to
`apps/server/src/lib/desktopSession.ts` and import from both `auth.ts` and the
new `enrol.ts` (no behaviour change to `auth.ts` — same functions, new home).
Alternatively place `/enrol/redeem` inside `auth.ts` to reuse them in place; the
extract is cleaner.

## Endpoint 1 — issue (owner portal)

`POST /api/enrol/code` — new `apps/server/src/routes/enrol.ts`, mounted in
`routes/index.ts` as `router.use('/enrol', enrolRoutes)`.

```ts
import { Router } from 'express';
import crypto from 'node:crypto';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';
import { sendError } from '../lib/sendError';
import { safeRouter } from '../middleware/asyncHandler';

const router = safeRouter();
router.use(requireAuth);

// Owner-only: a code provisions a till for the caller's business.
router.post('/code', async (req: any, res) => {
  if (!req.isOwner) { res.status(403).json({ error: 'Owner only' }); return; }

  const branchId = typeof req.body?.branch_id === 'string' ? req.body.branch_id : null;
  if (branchId) {
    // Tenant guard — never bind to another business's branch.
    const { data: b } = await supabase.from('branches')
      .select('id').eq('id', branchId).eq('business_id', req.businessId).maybeSingle();
    if (!b) { res.status(400).json({ error: 'Unknown branch' }); return; }
  }

  // Human-readable, unambiguous alphabet; the raw code is shown ONCE.
  const raw = crypto.randomBytes(10).toString('base32' in Buffer ? 'base32' : 'hex')
    .replace(/[^A-Z2-7]/gi, '').slice(0, 10).toUpperCase();
  const codeHash = crypto.createHash('sha256').update(raw).digest('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min

  const { error } = await supabase.from('device_enrolment_codes').insert({
    business_id: req.businessId,
    branch_id:   branchId,
    code_hash:   codeHash,
    created_by:  req.userId,
    expires_at:  expiresAt,
  });
  if (error) { sendError(res, error); return; }

  // business_id is returned so the till has both halves it needs to redeem.
  res.json({ code: raw, businessId: req.businessId, branchId, expiresAt });
});

export default router;
```

(Node has no `base32` Buffer encoding; use a tiny base32 helper or `hex` — the
snippet degrades to hex so it compiles. Swap in a real base32 for nicer codes.)

## Endpoint 2 — redeem (the till)

`POST /api/auth/enrol/redeem` — in `auth.ts` (reuses the local session helpers),
**no `requireAuth`**: the caller has no session yet; the code IS the credential.

```ts
router.post('/enrol/redeem', async (req, res) => {
  const businessId = String(req.body?.business_id ?? '').trim();
  const rawCode    = String(req.body?.code ?? '').trim().toUpperCase();
  const deviceId   = String(req.body?.device_id ?? '').trim();
  if (!businessId || !rawCode || !deviceId) {
    res.status(400).json({ error: 'business_id, code and device_id are required' });
    return;
  }
  const codeHash = crypto.createHash('sha256').update(rawCode).digest('hex');

  // THE BURN — the exact atomic UPDATE proven in test-migration-81.mjs. Scoped
  // to the business so a code cannot be redeemed against the wrong tenant.
  // Active + unexpired only; RETURNING confirms it was valid AND is now spent.
  const { data: burned, error: burnErr } = await supabase.rpc('redeem_enrolment_code', {
    p_code_hash: codeHash, p_business_id: businessId, p_device_id: deviceId,
  });
  // (Or run the UPDATE via a SECURITY DEFINER function / a single supabase
  //  .update().eq(...).is('redeemed_at', null).gt('expires_at', now).select().single()
  //  — the point is the guard status='active' AND expires_at > now() is atomic.)
  if (burnErr || !burned) {
    res.status(401).json({ error: 'Invalid, expired or already-used code', code: 'ENROL_INVALID' });
    return;
  }
  const ownerId  = burned.created_by;    // public.users id — the token principal
  const branchId = burned.branch_id ?? null;

  await registerDesktopTerminal(businessId, ownerId, {
    deviceId,
    appVersion:   String(req.body?.app_version ?? '') || null,
    terminalCode: req.body?.terminal_code ?? null,
    ipAddress:    req.ip ?? null,
    role:         req.body?.device_role ?? null,
  });

  const sessionId = newSessionId();
  const payload: TokenPayload = {
    userId:             ownerId,
    businessId,
    branchId:           null,           // unbound-till fallback, like /desktop-login
    isOwner:            true,
    permissionKeys:     ['*'],
    permissionsVersion: /* compute as /desktop-login does */ 0,
    sessionId,
    surface:            'desktop',
  };
  const { accessToken, refreshToken } = issueTokenPair(payload);
  await storeRefreshToken(refreshToken, payload, req.ip ?? undefined, deviceId);

  res.json({ accessToken, refreshToken, token: accessToken, businessId, branchId });
});
```

The `redeem_enrolment_code` RPC (or inline update) runs exactly:

```sql
UPDATE public.device_enrolment_codes
SET status='redeemed', redeemed_at=now(), redeemed_device_id=$3
WHERE code_hash=$1 AND business_id=$2 AND status='active' AND expires_at > now()
RETURNING id, business_id, branch_id, created_by;
```

## Desktop — the InstallPage change (closes D1)

Today `apps/desktop/src/renderer/.../InstallPage` collects an owner email +
password and calls `/api/auth/desktop-login`, hard-coded to `mode='cloud'`
(register A66 noted a local-mode till is not even provisionable this way).
Replace that with two fields — **Business ID** and **Enrolment code** — and call
`/api/auth/enrol/redeem` with `{ business_id, code, device_id }` (the till
already has a stable `device_id` since install; auth.ts §"stable device_id"
relies on it). Store the returned tokens exactly as the owner-login path does.
No account, no password, no two-business ambiguity — the business is the id the
owner pasted.

## How D1 closes

D1 is "owner login is a dead end for a two-business owner." Enrolment identifies
the business explicitly, so the ambiguity is structurally gone. **D1 fully closes
when the desktop uses redeem** — until then both D1 and D4 stay OPEN; the schema
is the foundation, not the finish.

---

## Prove it — the live end-to-end test (the only thing left)

1. Apply migration 81 to the database.
2. As an owner in the portal, `POST /api/enrol/code` (optionally `{ branch_id }`).
   Confirm you get a raw code back and a `device_enrolment_codes` row exists with
   only its hash.
3. On a fresh till, enter the Business ID + code on the InstallPage. Confirm:
   redeem returns tokens; a `user_devices` row appears for the device; the code's
   row flips to `status='redeemed'`; the catalogue syncs; the install binds a
   branch and completes.
4. Re-enter the SAME code on another till → rejected (`ENROL_INVALID`). Let a code
   expire (15 min) → rejected. A code from business A entered with business B's id
   → rejected.
5. Confirm a redeemed till reaches `/api/pos/init` and is subject to the D11
   desktop-licence gate as normal.

## Done vs outstanding

- **Done, in the tree, type-checked:** migration 81 + its Postgres test;
  `routes/enrol.ts` (issue) and the `auth.ts` redeem; `schema-index.json`; the
  desktop `auth:enrolDevice` handler, preload bridge, `posApi.auth.redeemEnrolment`,
  and the InstallPage change; `tests/enrol-endpoints.test.mjs`.
- **Outstanding:** the §"Prove it" live test above. Only after it passes are D4
  and D1 closed. Optional follow-up: adopt D7 payload validation on
  `auth:enrolDevice` (done in the D7 rollout), and a portal UI for issuing codes.
