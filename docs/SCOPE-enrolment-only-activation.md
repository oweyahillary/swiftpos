# SCOPE — Remove owner email/password login from the till (enrolment-only activation)

**Proposed register ID:** A158 (P1, security) — not yet filed; this is the scope for your approval.
**Goal:** the owner's reusable email+password must never be entered or stored on a shale
till. A terminal is activated **only** by a one-time enrolment code; the owner
email/password screen is removed as a reachable entry point. The web dashboard login is
untouched.
**Tested on `dev` (amber build) before any client rollout.**

---

## Why this is the right fix (and its limit)

The credential-exposure risk you named is real: `desktop-login` takes the owner's
email+password on a shared till, so anyone who sees or captures them can log into the
web dashboard and edit anything. `enrol/redeem` already exists and replaces the password
with a **one-time, revocable, device-bound code** — and it mints the *same* owner-scoped
desktop token (`surface: 'desktop'`, confirmed at `auth.ts:68`), records the terminal
(D14), and checks suspended businesses, so it is a drop-in for everything `desktop-login`
does. The only reason the risk is still open is that **owner-login remains a reachable
fallback**. Closing that fallback is Phase 1.

**Limit (explicitly OUT of Phase 1 — see Phase 2):** the token on the till is still
owner-scoped, so a *stolen token* (extracted from the device) could still reach the
dashboard. Phase 1 removes the *credential* from the till; it does not device-scope the
token. That is a separate, larger job.

---

## Blast radius — every file that touches the owner-login path

### Renderer — `apps/desktop/src/renderer`
| File | Change |
|------|--------|
| `App.tsx` | New `'enrol'` state. Reroute the **three** `owner-login` entry points: `:36` (boot, no session) → `'enrol'`; `:43` (boot error catch) → `'enrol'`; `:113` `handleSignOut` → **repurpose** (see Recovery below). Remove `import LoginPage`, the `owner-login` render branch (`:128`), and `handleOwnerLogin`. |
| `pages/LoginPage.tsx` | Retire (delete once unreferenced). |
| `pages/InstallPage.tsx` | Extract the **enrolment step** (Step 2, business ID + code) so it renders standalone as the `'enrol'` state on a **configured-but-session-less** till — today it is reachable only during first install (`!configured`). |
| `lib/posApi.ts` | Remove the `auth.login` (desktop-login) binding + its error-message mapping (`:426`). Keep `auth.redeemEnrolment`. |

### Desktop main — `apps/desktop/src/main`
| File | Change |
|------|--------|
| `ipcHandlers.ts` | Remove the `desktop-login` IPC handler (`:75`). Keep the `enrol/redeem` IPC (`:155`). |
| `preload.ts` | Remove the `auth.login` bridge; keep `redeemEnrolment`. |

### Server — `apps/server/src`
| File | Change |
|------|--------|
| `routes/auth.ts` | **Tombstone** `POST /desktop-login` (410 Gone + comment, the A8/A145 pattern). **Keep** the shared helpers it and `enrol/redeem` both use — `ownerBusiness.ts` owner resolution and `registerDesktopTerminal` (D14). Update the file-header comment that documents desktop-login. |

`enrol/redeem` already carries full parity (surface, D14, suspended-check), so **no server
behaviour is lost** by retiring the route.

### Tests — `tests/`
| File | Change |
|------|--------|
| `auth-surface.test.mjs` | Currently asserts `/desktop-login` mints `surface:'desktop'`. Repoint to assert **`enrol/redeem`** mints `surface:'desktop'` (the sole desktop entry now), and that offline-auth/device-registration gating still holds. |
| `order-error-classification.test.mjs` | Update the `desktop-login` reference. |
| **new** `terminal-activation.test.mjs` | Prove owner email/password is **not** a reachable terminal entry point, and that enrolment is the only activation that yields a `surface:'desktop'` session. Mutation-checked: re-adding an owner-login route/state fails it. |

---

## Recovery design — the decision you need to confirm

Removing owner-login removes the on-till recovery path. Replacement, in priority order:

1. **Baseline (built by the `App.tsx` change):** a session-less till shows the **enrol
   screen** → owner issues a fresh one-time code from the portal → re-enrol. No owner
   password on the till. This is the routine recovery and needs no extra code beyond
   making the enrol screen reachable when `configured && !session`.

2. **Sign-out semantics change (important):** today `handleSignOut` clears the **device
   session**, which under enrolment-only would strand the till (needs a new code for a
   routine sign-out). Fix: routine sign-out clears **staff only** → back to the PIN pad;
   the device/enrolment session persists as the terminal's identity. **De-enrolling** a
   terminal (clearing the device session) becomes a deliberate action, not a button.

3. **Optional (Phase 1.5):** a **tech-menu** "re-provision / de-enrol this terminal"
   action, so a technician (tech token — branch-scoped, time-limited, *not* the owner
   password) can recover or retire a till in the field. Recommended but not blocking.

**Offline note:** enrolment needs the cloud — but so did owner-login, so no offline
recovery capability is lost.

---

## Rollout sequencing (this is the one that bites if skipped)

Old builds (≤ 0.5.35) call `desktop-login`. If the **server route is retired before every
client till is on the enrolment-only build**, those old tills lose owner-login with no
replacement and can't come online.

**Order:** (1) ship the enrolment-only desktop build to **all** of a client's tills →
(2) confirm each is enrolled and trading → (3) **then** tombstone the `desktop-login`
route on that client's server. On `dev`, do it all at once — no old builds to protect.

---

## Risks / edge cases

- **auth-surface test goes red** if the surface assertion isn't repointed to `enrol/redeem`. Handled above.
- **Session loss mid-trading** now requires a portal code (no owner-login safety net). Confirm the owner portal issues enrolment codes quickly and that staff know the flow.
- **`enrol/redeem` bypasses the web-access gate** exactly as `desktop-login` did — intended, no change.
- **Multi-business owner:** enrolment binds a till to one business/branch via the code (`InstallPage` comment: "a two-business owner is no longer a dead end"), so no "switch business on till" flow depends on owner-login. Verify during dev test.
- **Blast radius is auth** — every change is dev-tested (enrol → PIN, session-loss → re-enrol, owner screen genuinely gone) before a client sees it.

---

## Phase 2 (filed separately, NOT now) — device-scoped till token

Narrow the till's token so a *stolen token* can't reach the dashboard. Touches every
endpoint the till calls (sync, catalogue, orders, verify-pin) and can break sync if
rushed. Own scope, own test pass. File as its own P2 after Phase 1 ships.

---

## Deliverable shape when you approve

One batch on `dev`: renderer + main + server changes above, tests updated + the new
activation test, register entry A158, manifest. Bench-green, then you verify the whole
flow on the amber build before any client rollout. Estimated surface: ~6 code files +
3 test files, no migration, no schema change.
