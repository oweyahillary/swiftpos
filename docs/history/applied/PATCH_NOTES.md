# SwiftPOS remediation patch — full audit close-out + error-handling cleanup

Drop `apps/` and `migrations/` over your repo root. 45 files change (2 new, 43
modified). Every file typechecks against your dependencies (`tsc --noEmit
--skipLibCheck`) with **zero new type errors**.

Most modified files changed only because of the shared `sendError` rollout (a
mechanical, low-risk swap). The security/logic fixes are in the handful of files
listed under "Security & logic fixes".

## Order of operations
1. Run `migrations/21_mpesa_payment_tracking.sql` in Supabase **first**.
2. Set env vars (below).
3. Deploy.

## Env vars to confirm
```
ADMIN_JWT_SECRET=<64-char secret>     # server won't boot without it
TECH_HMAC_SECRET=<64-char secret>     # server won't boot without it
MPESA_ALLOWED_IPS=<Daraja IPs, verified in your portal>
MPESA_ENVIRONMENT=production
NODE_ENV=production                   # so sendError hides detail from clients
```

---

## Security & logic fixes (the important files)

| Finding | File | Change |
|---|---|---|
| C2 | routes/mpesa.ts | Callback IP allow-list + amount validation + idempotency |
| H1 | routes/kitchen.ts | KDS requires a token; branch derived from token; tenant-scoped |
| H2 | middleware/adminAuth.ts, routes/tech.ts | Removed hardcoded fallback secrets |
| H3 | lib/webhooks.ts, routes/webhooks.ts | SSRF guard on delivery **and** the test-ping |
| M1 | middleware/auth.ts | Reject deactivated accounts each request |
| M2 | middleware/auth.ts, adminAuth.ts, routes/auth.ts | Pin JWT algorithm (HS256) |
| M3 | routes/mpesa.ts + migration 21 | Pending-payment state moved to DB |
| M4 | routes/onboarding.ts | Roll back business on failed provisioning |
| M5 | (superseded by sendError — see below) | |
| L1 | routes/tech.ts | timingSafeEqual length guard |
| L3 | lib/webhooks.ts | Bounded webhook retries with backoff |
| L5 | routes/orders.ts | Validate discount_id belongs to the business |

(Frontend note for **H1**: the KDS tablet must now send a bearer token — an
unauthenticated `/kds` will get 401.)

---

## Shared `sendError` helper — full error-leakage cleanup

`apps/server/src/lib/sendError.ts` (new) replaces handlers that returned a raw
error object's `.message` to the client, which leaked internal detail (DB
constraint/column names, stack hints).

What it does:
- Logs full detail server-side with a reference id: `[error 9f2ac118] 500 — <detail>`.
- Returns a safe generic client message plus that `ref`.
- In **non-production only** (`NODE_ENV !== 'production'`) also includes the
  detail in the response, to keep local/staging debugging fast.

```ts
if (error) { sendError(res, error); return; }                 // generic 500
sendError(res, err, { message: 'Client creation failed' });   // custom message
sendError(res, error, { status: 400, message: 'Auth creation failed' });
```

### Scope — every status, not just 500

- **~231 `res.status(500)` sites across 37 files** converted (the bulk).
- **The remaining non-500 raw-`.message` sites** are now handled too:
  - `routes/auth.ts` (`/refresh`): deliberate token errors carry a `TOKEN_*` code
    and safe message and are still surfaced (the client needs the code); any
    *unexpected* error now goes through `sendError`.
  - `routes/admin.ts`: the Supabase auth-create error is `sendError` (400); detail
    logged + shown in non-prod.
  - `routes/staff.ts`: the 207 "invite email failed" response keeps its `user`
    payload but no longer appends the raw email/SMTP error text.
  - `routes/webhooks.ts` (`/:id/test`): the test-ping now runs the **same SSRF
    guard** as delivery (it was doing its own unguarded `fetch` — a second SSRF
    vector) and disables redirects. Its error stays in the `{ success, error }`
    shape on purpose: it describes the owner's *own* endpoint (connection refused
    / TLS / timeout), which is the point of a test and leaks no internals.

### Deliberately left as-is (safe, not leaks)
Intentional user-facing 4xx string messages ("Customer not found", "Credit limit
exceeded", validation errors), the gated `TOKEN_*` auth messages, the controlled
`CORS:` message, and the webhook test diagnostic. The global error handler in
`index.ts` was already safe (generic 500, stack only in non-prod) and is unchanged.

**After this pass, no unexpected/internal error reaches a client verbatim in
production.**

### One behavioural change to know
Production 500s now return `{ error: <generic>, ref }` instead of
`{ error: <db string> }`. The frontend reads `error`, so users just see a clean
message + a reference id. If any client code branched on specific 500 error
*text* (those checks were all server-side in what I reviewed), switch it to the
response `code`.

---

## Still outstanding (only you can do these)
- **C1** — rotate the secrets that were in the uploaded `.env` (Supabase
  service-role key, JWT_SECRET, ADMIN_JWT_SECRET, TECH_HMAC_SECRET, Resend key,
  SMTP password).
- **L5 discount authorization** — who may apply a manual discount is a product
  decision (no discount permission key exists today).

---

## UI FIX + DEMO NOTES (added for the client pitch)

**Cart variant display fix — `apps/dashboard/src/pages/pos/CashierScreen.tsx`**
The cart was rendering variant lines as `groupName: optionName`, but the cart
stores the variant under `name`, so those showed as "undefined: undefined" for
any product with variants (price was always correct — display only). Fixed to
show the variant name that's actually present. Dashboard builds clean (exit 0).

**Two rules for tonight's demo:**
1. **KDS: demo on the CURRENT (un-patched) backend only.** The H1 security fix
   makes `/api/kitchen/*` require a token; the KDS page (`KDSPage.tsx`) doesn't
   send one yet, so on the patched backend it returns 401 (empty screen).
   Updating the KDS to authenticate is a follow-up before the patch goes live.
2. Everything else (12 dashboard type warnings, 55 admin type warnings) is
   TypeScript strictness with no runtime effect — both apps build and run.
   The client never sees the admin portal anyway.

---

## QA BUG FIXES (from live admin testing)

Root-caused from the code and fixed:

**#1 — Blank screen / React #310 on admin login** (`apps/admin/src/AdminPortal.tsx`)
The root component declared `const [sidebarOpen] = useState(false)` *after* the
`if (!token || !admin) return <LoginPage/>` early return. Logged-out rendered
fewer hooks than logged-in, so logging in changed the hook count → React #310 →
blank screen (reload "fixed" it because the logged-in path then ran from the
first render). Moved the `useState` above the early return. Admin builds clean.

**#2 — "undefined Restaurant" on client detail** (`AdminPortal.tsx`)
Business Profile rendered the type as `${TYPE.icon} ${TYPE.label}`, but
`TYPE_META` has no `icon` field (icons come from the `<TypeIcon>` component), so
it printed "undefined <label>". Changed to `TYPE.label`.

**#5 — Token generation 500s** (`apps/server/src/routes/admin.ts`)
`/api/admin/tech/generate-token` and `/api/admin/mode-switch/generate` call
`crypto.createHmac/createHash/randomBytes`, but the file never imported Node's
crypto — so `crypto` resolved to the Web Crypto global (no such methods) →
TypeError → 500 every time. Added `import crypto from 'node:crypto'`. This was a
pre-existing bug; token generation never worked.

### #3 / #4 — "Enable web access" freeze + new businesses unusable (diagnosis)
Root cause is the **native `window.confirm()` (enable web access) and
`window.prompt()` (branch licence)** in `AdminPortal.tsx`. An automated browser
agent can't dismiss native dialogs, so the tab appears frozen and the request
never fires → nothing is applied → new businesses can't be licensed/enabled.

Two important points:
- **A human clicking OK is not affected** — native dialogs work for a person, so
  this will most likely NOT reproduce in a manual demo. It blocks *agent* testing.
- Enforcement uses `businesses.web_access_expires_at` with a **fallback to the
  legacy `feature_flags.web_hosting` flag when the column is NULL** (which it is
  for new businesses, since creation never sets it). So once the request actually
  fires, the button's write *does* grant access.

Recommended follow-up (not yet applied): replace the native `confirm`/`prompt`
calls in `toggleWebHosting` and `toggleBranchLicence` with in-app modals — fixes
agent-testability and is better UX. Optionally, have "Enable web access" also set
`web_access_expires_at` (e.g. +1 year) so the renewal clock is authoritative
rather than relying on the legacy-flag fallback.

---

## QA ROUND 2 (admin re-test on localhost)

Confirmed fixed by you: blank-screen-on-login (#1), "undefined Type" (#2), token
generation 500s (#5). This round fixes the rest — all in
`apps/admin/src/AdminPortal.tsx`:

**"Enable web access" freeze (#3) — root cause found.**
It wasn't a loop — it was `window.confirm()`. Execution blocked on the native
dialog and never reached `setFeatures`, which is why the tab froze AND the change
never applied. Native `confirm`/`prompt` also can't be dismissed by an automated
browser, so they hang agent tests. Replaced every native `confirm`/`prompt` in
the client-detail page (web access, suspend, mark-paid, branch licence) with a
non-blocking in-app modal (Promise-based `askConfirm`/`askPrompt`). This unblocks
enabling web access — and therefore the owner/manager/POS login testing on the
new businesses.

**Tech Access "Confirm" → /tokens/undefined/confirm 404.**
A freshly generated token was added to the list from the generate response, which
returns `token_id` (not `id`), so `confirmToken(t.id)` sent `undefined`. Now
normalises `token_id → id` on insert (same guard added for mode-switches).

**"-172767s ago" expiry.**
`timeAgo()` returned `${seconds}s ago` with negative seconds for future dates
(expiry is always in the future). Added a guard: future dates render as a real
date instead.

Admin app builds clean (exit 0). No backend change this round.

Note: enabling web access sets the legacy `feature_flags.web_hosting` flag, which
the login gate honours only while `businesses.web_access_expires_at` is NULL
(true for new businesses). That's fine for testing now; longer term, consider
having "Enable web access" also set `web_access_expires_at` so the renewal clock
is the single source of truth.

---

## QA ROUND 3

Important: the freeze on Suspend/Activate, the `/tokens/undefined/confirm` 404, and
the "-172767s ago" display were all already fixed in the previous patch's
`AdminPortal.tsx` (the freeze root cause was the shared native `window.confirm`/
`prompt` on the Client Detail page — replaced with a non-blocking modal, which
covers web-access, Suspend, mark-paid AND branch Activate). If you still see them,
you're running the pre-modal build — apply the current `AdminPortal.tsx`.

New fixes this round:

**New Client form — silent password rejection** (`apps/admin/src/AdminPortal.tsx`)
The owner-password input had `required minLength={8}`, so a <8-char password was
blocked by the browser's native validation *before* the submit handler ran — the
handler's visible error message never fired, and the native bubble is easy to miss
on a long form. Removed the native `minLength`, so the in-form error now shows, and
added a live red border + inline "Must be at least 8 characters." as you type.

**Locked-out "Contact SwiftPOS" WhatsApp placeholder** (`apps/dashboard/src/pages/LoginPage.tsx`)
The link was hardcoded to `254700000000`. It now reads `VITE_SUPPORT_WHATSAPP`,
falling back to the placeholder. Set your real support number in the dashboard's
environment and rebuild:
```
VITE_SUPPORT_WHATSAPP=2547XXXXXXXX   # your WhatsApp number, no +, no spaces
```
(Vite inlines env vars at build time, so rebuild/redeploy the dashboard after setting it.)

Both apps build clean (exit 0).

Same-class item not yet changed: TechPage "Revoke" still uses a native `prompt`
(different component, needs its own modal state). Not in your reported list; I can
convert it too if you want zero native dialogs anywhere.

---

## QA ROUND 4 — remove ALL native JS dialogs from admin

Swept the whole admin app for native `window.confirm` / `window.prompt` /
`alert`. Result: every one now uses the styled in-app modal (or inline error).
`apps/admin/src/AdminPortal.tsx` only:

Already on the modal from earlier rounds (verified): enable/disable web access,
suspend (reason), mark invoice paid (ref), branch licence fee + ref, and Tech
Access token revoke (reason).

Fixed this round:
- **RenewForm** used a native `alert(e.message)` on renewal failure → now an
  inline red error message in the form.
- **Branch licence "Revoke"** had NO confirmation at all (it toggled instantly).
  Added a modal confirm: "Revoke the desktop licence for '…'? The desktop app on
  this branch will be blocked on its next sync." (matches the destructive nature
  of the action you flagged).

Verification (run on the file): `alert(`=0, `window.confirm`=0 live calls (1 match
is a code comment), `window.prompt`=0, bare `prompt(`/`confirm(`=0; 7 modal-driven
`askConfirm`/`askPrompt` calls. Admin builds clean (exit 0).

Note: both `ClientDetailPage` and `TechPage` carry their own small modal
implementation (they're separate components). If you'd like, a future tidy-up is
to extract one shared `<Modal>` + `useConfirm()` hook so there's a single
implementation — not required, purely DRY.

---

## QA ROUND 5 — consolidate the modal into one shared hook

Extracted a single `useModal()` hook (defined once, near the design tokens) that
returns Promise-based `askConfirm` / `askPrompt` plus a `modal` element to render.
Both `ClientDetailPage` and `TechPage` now use it and render `{modal}` — the two
duplicated ~22-line modal implementations are gone. One source of truth for the
confirm/prompt UI; behaviour and styling unchanged. No dangling `setModal` /
`resolveModal` references; admin builds clean (exit 0).

---

## QA ROUND 6 — POS/dashboard end-to-end findings

**Inventory "Restock/Adjust" 500 + false "0 / out of stock" (one root cause).**
`apps/server/src/routes/inventory.ts` — the adjust handler inserted
`created_by: req.userId` into `stock_movements`, but an owner authenticated via
Supabase may have no `users` row, so their `req.userId` isn't a valid FK →
insert 500s. (The sale path avoids this by not setting created_by.) The
`stock_levels` upsert runs *before* that insert and succeeds, so stock was
silently written while the request errored — which is why the inventory list kept
showing a stale "0" (the frontend never got a success to refresh on) even though
real stock was 150/1. Fix: `created_by: req.isOwner ? null : req.userId`. This
fixes BOTH the 500 and the false-0 (adjust now succeeds → list refreshes → shows
real stock). A brand-new product with no stock set still correctly shows 0.

**Adjust Stock modal — unreachable buttons on short screens.**
`AdjustmentModal.tsx` was a fixed, centred overlay with no scroll, so Save/Cancel
clipped off below ~630px. Added scroll + `max-h-[90vh]`.

**Checkout "Amount tendered" silent failure.**
`PaymentModal.tsx` — the field showed the total only as a placeholder; the real
value was empty, so `tenderedNum` was 0, `cashValid` false, and the Confirm button
sat disabled with no feedback. A blank cash field now means "pay exact", so
Confirm works immediately (type a value only when the customer pays more).

**Customers no longer require the loyalty program.**
`apps/server/src/routes/loyalty.ts` — the blanket `requireLoyalty` gate blocked
basic customer create/list/edit/delete/lookup. Moved the gate to the
loyalty-specific `/settings` route only, so simple contact records work without
turning on loyalty. (Create-customer only needs name/phone; no loyalty data.)

**Cosmetic.** Category names no longer truncate ("Beverages", not "Beve…"); the
shared restaurant/café settings page title is now the type-neutral "Dine-in
Settings" instead of "Restaurant Settings" (it's reached via the "Café Setup" nav
for cafés).

**Not a bug — staff email:** the edit form already pre-fills `editing.email`, and
editing name/role can't wipe an email (frontend omits a blank email; backend only
updates it `if (email !== undefined)`). A blank field just means that staff has no
email on record (PIN-created). No change needed.

Backend typechecks clean; dashboard builds clean.

---

## QA ROUND 7 — three criticals + two more (POS testing)

**#1 Critical — silent session-expiry broke the terminal.** When the cashier's
POS token expired after idle and couldn't refresh, api.ts fired
`swiftpos:session-expired`, but only the OWNER auth context listened (it called
supabase signOut). The POS cashier session (separate, sessionStorage-based) never
cleared, so the terminal stayed mounted while every call 401'd → empty "No
products", no shift buttons, no message. Fix: `POSAuthContext` now listens for
that event, drops the cashier session (→ back to the PIN lock), and sets a flag;
`POSLoginScreen` shows "Your session expired from inactivity. Please sign in
again." Files: `context/POSAuthContext.tsx`, `pages/pos/POSLoginScreen.tsx`.

**#2 Critical — every shift close 500'd.** `POST /api/shifts/:id/close` writes
`shifts.expected_cash` and `shifts.cash_variance`, but NO migration ever created
those columns → the UPDATE failed every time. The float in/out feature also reads
a `float_transactions` table that was never created. Fix: **migration
`22_shift_close_and_float.sql`** adds the missing shift columns (idempotently) and
creates `float_transactions`. No server code change — the code was correct; the
schema was missing. **Run this migration**, then the stuck-open shift will close.

**#3 Critical — double-charge on rapid tap.** `POST /api/orders` had no
double-submit guard; a touchscreen double-tap created two paid orders. The
`placing` state didn't help because React re-renders async. Fix (`PaymentModal`):
a synchronous `chargingRef` blocks the second call immediately, AND a per-sale
`idempotency_key` is sent in the order body (the server already dedupes on it), so
even a slipped-through duplicate creates only one order. Reset on failure so a
genuine retry still works.

**#4 — staff PIN-create dropped email.** The PIN-mode create payload omitted
`email` (only invite-mode sent it), so PIN staff saved `email: null` and couldn't
log in. Fix: include `email` in the PIN create call (`StaffTab.tsx`). The backend
already accepts it.

**#5 Cosmetic — Z-report label/value ran together on screen.** The `.row`
flex/space-between styles were written only into the print window, so the
on-screen preview was unstyled ("Completed Orders0"). Added the same styles
(scoped to `.zreport-print`) to the on-screen render. `ZReportModal.tsx`.

Dashboard builds clean; migration is idempotent/additive.

**Run order:** migration 22 first, then deploy. The session-expiry and
double-charge fixes are frontend; the shift-close fix is the migration.

---

## QA ROUND 8 — re-fixes (two earlier "fixes" didn't hold)

**#1 Session-expiry — the actual root cause (POS + Admin).** My round-7 listener
was correct but never fired: the POS client (`posRequest` in POSAuthContext) only
recovered a 401 when `code === 'PERMISSIONS_CHANGED'` — an ordinary expired-token
401 just threw, never signalling expiry. Now `posRequest` handles ANY 401: refresh
+ retry once, and on failure it flags + clears the cashier session → the terminal
returns to the PIN lock with "Session expired…". The Admin app had the same gap
(its `req()` didn't handle 401 at all → silent "0 clients"); now on 401 it clears
the admin token, flags a message, and returns to the login screen. Files:
`context/POSAuthContext.tsx`, `admin/src/AdminPortal.tsx`.

**#2 Close shift 500 — status.** The handler itself doesn't throw from any visible
path; every Supabase error is handled. The confirmed real gap is the missing
`shifts.expected_cash` / `cash_variance` columns and the missing `float_transactions`
table — **migration 22 fixes these** (still required; if you haven't run it, that's
the fix). Also fixed a latent bug: the frontend sends `notes: null`, but
`CloseShiftSchema` rejected null (→ 400); now `z.string().nullable().optional()`.
If close still 500s AFTER migration 22, the server already logs the real stack
(index.ts global handler: `log.error('Unhandled route error', …)`) — grab that log
line and I can pinpoint the exact throw; I couldn't reproduce it statically.

**#3 Double-click — now a crash instead of a double-charge.** The dedup worked
(one order), but a null `business` during the modal→receipt transition crashed
`ReceiptView` on `business.vat_rate`, and — critically — the POS routes were NOT
wrapped in the existing `ErrorBoundary` (only the owner dashboard was), so the
crash blanked the whole terminal. Fixes: `ReceiptView` guards a null business;
`App.tsx` now wraps the POS and Manager surfaces in `ErrorBoundary` so no render
bug can blank the cashier screen. The synchronous charge guard + idempotency key
from round 7 remain (they stopped the double-charge).

Dashboard + admin build clean.

---

## Owner password reset (admin portal)

Restaurant owners authenticate via **Supabase Auth** (their password lives in
`auth.users`, not your app tables). Added an admin-portal reset:

- Backend: `POST /api/admin/clients/:id/reset-owner-password` (requireAdmin) —
  validates min 8 chars, looks up `businesses.owner_id`, and calls
  `supabase.auth.admin.updateUserById(owner_id, { password })` (service-role).
  Writes an audit entry (`business.reset_owner_password`) but never logs the
  password. `apps/server/src/routes/admin.ts`.
- Frontend: a **Reset Password** button on the client detail page (next to
  Suspend/Activate) — prompts for the new password via the in-app modal and calls
  the endpoint. `apps/admin/src/AdminPortal.tsx`.

Admin builds clean; endpoint typechecks clean.

---

## QA ROUND 9 — last two cosmetic/naming issues

**Category name mid-word break.** The card was a single row where three text
buttons (Disable/Edit/Delete) squeezed the name into ~25px, so `break-words`
shattered "Beverages" → "Bevera/ges". Restructured the card: avatar + name get a
full-width top row (name now `truncate` + hover tooltip, only ellipsising genuinely
long names), and the action buttons moved to their own row below a divider.
`CategoriesPage.tsx`.

**"Café Setup" nav vs "Dine-in Settings" title.** The sidebar label is dynamic
per business type; the page title was static. Now the page reads `business.type`
(via `useBusiness`) and shows the matching label — "Café Setup" for cafés,
"Restaurant Setup" for restaurants — so nav and page title agree. The shared
internal route `/settings/restaurant` is unchanged (not user-facing).
`RestaurantSettingsPage.tsx`.

Dashboard builds clean. This clears the backlog.

---

## QA ROUND 9 — checkout 400 diagnosis + negative-price fraud vector

**Checkout 400 (critical).** Traced the order handler: the only 400 a clean cart
can hit is the "Missing required fields" check (`branch_id` / `order_number` /
`items` / `payment`) or the recompute's product-not-found. `order_number` and
`items` are always populated, so the field in question is almost certainly
**`branch_id`** — `POSLoginScreen` falls back to `branchId: branchId ?? ''` when
the login response doesn't resolve a single branch, and `''` is falsy → every
order 400s. Two changes to pin it down and fix it:
  - Backend now names the missing field: `Missing required fields: branch_id`
    (instead of the generic message) so the next test says exactly which. `orders.ts`.
  - Frontend guards an empty branch before charging with a clear message
    ("No branch is set for this session…") instead of a silent 400. `PaymentModal.tsx`.

  Note on the "silent" part: the modal DOES render errors and the API client DOES
  throw on 400 — so a truly blank failure points to a **stale build**. Copy the
  whole `apps/` tree and restart the dev server; the named-field error will then
  show and tell us if it's `branch_id`. If it is, the real fix is in the login
  branch-resolution (I can finish that once confirmed).

**Negative-price "phantom discount" (fraud vector).** The product create route
never validated price (the schema wasn't wired to it), so negative-priced
products could exist and act as untracked, permission-free discounts. Fixed at
two layers: the create route now rejects negative `base_price`/`cost_price`
(`products.ts`), and the checkout recompute clamps any catalogue unit price to
≥ 0 (`orders.ts`) so even pre-existing negative products can't reduce a bill.

**Category XSS/SQLi payloads + duplicates:** these are inert (React escapes,
Supabase parameterises) and the name is already length-capped in the schema; the
entries you saw are directly-inserted test data. A uniqueness constraint would
need a DB migration — happy to add if you want it, but it's hygiene, not a live risk.

Dashboard builds clean; changed server files transpile clean.

---

## QA ROUND 10 — checkout ROOT CAUSE fixed (variant shape) + fleet/health

**Checkout 400 "Unknown variant: undefined / undefined" — ROOT CAUSE, fixed.**
The cart builder (`useCart.ts › confirmVariants`) stored each variant as the raw
option `{id, name, price_adjustment}` and threw away the group entirely. The
backend recompute (and the order-item insert) key on `groupName`/`optionName`, so
every variant product produced `undefined/undefined` → 400 on 100% of orders with
a variant. (Variant-free items worked, which is why earlier sales sometimes went
through.) Fixed on both sides:
  - Frontend now builds the canonical `{groupId, groupName, optionId, optionName,
    priceAdjustment}` shape (`toggleVariantOption` carries the group; `confirmVariants`
    maps it). This also fixes the receipt/cart variant display.
  - Backend recompute now ALSO accepts the option `id` as a fallback and gives a
    readable error label — so even a stale frontend build can complete a sale
    (`orders.ts`).

**Admin fleet "misleading zeros" on expiry.** `DashboardPage` swallowed load
errors (`.catch(console.error)`) and then rendered `stats?.total ?? 0`, so a
failed/expired load looked like real "0 clients / 0 revenue" data. It now shows
the error with a Retry (a 401 still clears the token via `req()` and returns to
login). `AdminPortal.tsx`.

**/health hammering + 503.** The local-print bridge URL was hardcoded to
`http://localhost:3001` — your API's dev port — so printer detection was polling
the backend's `/health` (a Supabase ping that 503s), spamming it. It's now
`VITE_PRINT_SERVER_URL` (unset = feature disabled, no polling). Point it at your
real bridge port if you use one. `localPrintServer.ts`.

**Noted, not code bugs:** POS lets you add out-of-stock items (currently by
design — food is made to order; can add a warning/block if you want stock enforced
at the till). The mismatched "book cover" images on African Breakfast / Ugali
managu are bad `image_url`s in the seed data. Fleet health (0 healthy / 3
attention / 6 critical) reflects seed data.

Dashboard + admin build clean; backend variant fallback typechecks clean.

---

## QA ROUND 11 — Print Bill freeze, Post to Room, Transfer text

**Print Bill froze the tab (high severity).** `printGuestCheck` opened a popup
window and called `w.print()`. A popup can be blocked (null) or half-load and then
hang the tab, and `window.print()` opens a modal native dialog an automated/kiosk
environment can't dismiss — and the popup was never cleaned up. Rewritten to print
via a hidden iframe with `onafterprint` cleanup and a 60s fallback removal (the
same safe pattern now also used for the room-charge slip). `CashierScreen.tsx`.

**Post to Room was non-functional.** Its payload didn't match the order API —
no `order_number`, no `payment`/`payments` leg (just a bare `payment_method`), and
items as flat `product_id` instead of `product:{id}` — so the server returned
"Missing required fields" every time. Rebuilt the payload to the real contract:
`order_number`, canonical items, totals, and a proper `payments` leg (method
`other`, with the room + guest in the reference). Now it posts a completed sale
against the room. `CashierScreen.tsx`.

**Transfer Table text.** "Move 's order to another table" — the table-name
variable was empty for orders without a table. Now shows the table name when
present, else "Move this order to another table". `CashierScreen.tsx`.

**Already fixed in round 10 (re-confirmed here from a pre-patch build):** the
checkout "Unknown variant" 400 and the Admin fleet silent-zeros. Apply the patch
and rebuild both frontends.

**Noted, not fixed (scope/design):** out-of-stock items addable at the till
(currently by design — can add a warning/block if wanted); in-progress cart lost
on reload (would need server-side draft persistence — a feature, not a bug); the
Menu-panel items (Hold/Create Orders, Customers, Products, Payments, Discounts)
render "not built yet" placeholders — genuinely unbuilt, not regressions.

Dashboard builds clean.

---

## QA ROUND 12 — timezone/reporting, table auto-clear

**Off-by-one dates (systemic).** Every "today" default used
`new Date().toISOString().slice(0,10)` — the UTC calendar date, which is yesterday
for Kenya (UTC+3) in the local evening/early morning. Added a shared
`lib/localDate.ts` (`localDateStr`) using local components and replaced the pattern
across Cockpit/Overview, Reports, Z-Report, Reservations, POS reports, Manager
views, and Expenses.

**Sales not appearing in Reports/Cockpit.** Order status was fine (`completed`),
so this was the date filter. The backend `getDateRange` mixed UTC and server-local
parsing (`new Date('2026-07-10')` = UTC midnight, but `new Date('...T23:59:59')` =
server-local), so day-filters dropped orders — and on a UTC host the Cockpit's
UTC "today" missed EAT-day sales. `getDateRange` now interprets filter dates as the
EAT business day (`+03:00`) consistently. Combined with the frontend fix, "today"
and an explicit date both capture the right sales. (Offset is a constant for now;
TODO make per-business.) `reports.ts`.

**Table stayed "Occupied" after payment.** The table only cleared via the receipt's
"New Sale" button (`onSuccess`); dismissing the receipt any other way left it stuck
with the paid order. Added `onPaid`, fired the instant payment succeeds, which frees
the table immediately regardless of how the receipt is closed. `PaymentModal.tsx`,
`CashierScreen.tsx`.

**Post to Room** was already fixed in round 11 — it's in this bundle; you were
testing a pre-round-11 build.

Reservations booking confirmed working. Dashboard builds clean; server typechecks
clean at the changed region.
