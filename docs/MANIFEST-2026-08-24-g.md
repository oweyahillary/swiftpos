# MANIFEST — 2026-08-24-g

**Base commit:** `a36d1dc` (`dev` tip — desktop v0.5.36). Applies **on top of dev**.
**Register ID:** **A158** (P1, security) — FIX BUILT on the bench; **OPEN** pending
amber-build verification (rule 16).
**Working rules:** `HANDOFF-2026-08-08-evening.md` §0, rules 1–23.
**Apply:** `git apply MANIFEST-2026-08-24-g.patch` · **Rollback:** `git apply -R MANIFEST-2026-08-24-g.patch`

Removes owner email/password login from the till at every layer. A terminal is now
provisioned only by a one-time enrolment code, so the owner's reusable dashboard
credentials are never typed or stored on shared hardware. Web dashboard login is untouched.

---

## Files

| # | Change | File | What |
|---|--------|------|------|
| 1 | edit | `apps/desktop/src/renderer/App.tsx` | `owner-login` state → `enrol`; session-less till → `EnrolPage`; `LoginPage` import + `handleOwnerLogin` removed; **sign-out clears staff only** → PIN (device stays enrolled). |
| 2 | new | `apps/desktop/src/renderer/pages/EnrolPage.tsx` | Focused activation screen (business id + one-time code → `redeemEnrolment`). Same visual identity as the retired LoginPage. |
| 3 | delete | `apps/desktop/src/renderer/pages/LoginPage.tsx` | The owner email/password screen. |
| 4 | edit | `apps/desktop/src/main/ipcHandlers.ts` | `auth:login` handler removed (tombstone comment); channel doc updated. |
| 5 | edit | `apps/desktop/src/main/preload.ts` | `auth:login` bridge removed; `auth:enrolDevice` kept. |
| 6 | edit | `apps/desktop/src/renderer/lib/posApi.ts` | `auth.login` binding removed; error-map entry repointed to enrolment. |
| 7 | edit | `apps/server/src/routes/auth.ts` | `POST /desktop-login` **tombstoned** (410 `DESKTOP_LOGIN_RETIRED`), keeping shared `registerDesktopTerminal`; route header updated. |
| 8 | edit | `tests/auth-surface.test.mjs` | Repointed to assert `/enrol/redeem` mints `surface:'desktop'` and `/desktop-login` mints none. |
| 9 | new | `tests/terminal-activation.test.mjs` | Cross-layer guard: owner-login gone from App/IPC/preload/posApi/server. Mutation-checked. |
| 10 | edit | `docs/AUDIT-REGISTER.md` | A158 entry; Open tally **A-P1 11→12**; Counts + Last-updated. |
| 11 | new | `docs/MANIFEST-2026-08-24-g.md` | This manifest. |

**Not touched (rule 22):** no `package.json` version, no lockfile, no migration, no schema.

## Why removal is clean (verified at source)
`enrol/redeem` is a full replacement — it mints the **same** owner-scoped desktop session
as `desktop-login` (`surface:'desktop'`, D14 terminal registration, suspended-business
check), and both wrote the same singleton `session` row. So no server behaviour is lost.
The shared `registerDesktopTerminal` helper is kept.

## Design decisions in this batch
- **Sign-out = staff only.** The device/enrolment session is the terminal identity and
  persists; a routine cashier sign-out returns to the PIN pad, never strands the till.
- **De-enrol is deliberate, not a button.** Clearing the device session (re-provisioning)
  is a future tech-menu action (Phase 1.5), not wired here.
- **Recovery** for a session-less till = the `EnrolPage` (owner issues a fresh one-time
  code). No owner-login safety net; enrolment needs the cloud, but so did owner-login.

## Evidence (rule 7 / rule 9 — Linux, Node 22 bench)
```
server tsc / desktop renderer tsc     clean
desktop main tsc                      only the 4 pre-existing implicit-any (untouched files)
check-ipc-parity                      147/147 (auth:login removed from both sides)
typecheck-ratchet                     server/dashboard/admin 0
auth-surface.test                     12/0     terminal-activation.test  10/0 (mutation-checked)
check-register-consistency            OK (A-P1 12 agrees with body)
run-all.mjs                           green
```

## Could NOT be done here (rule 16) — the close conditions
The Electron UI can't run on the bench. Verify on the amber `dev` build:
1. Fresh till → enrol with a portal code → lands on PIN; the email/password screen never appears.
2. Session-loss (wipe the `session` row) → shows EnrolPage, not owner-login.
3. Cashier sign-out → PIN pad, device stays enrolled (no re-enrol needed).

## Rollout (rule 13)
Update **every** client till to this enrolment-only build BEFORE the `/desktop-login`
tombstone reaches their server — an un-updated old build (≤0.5.36 without this) still calls
`/desktop-login` and would lose its only sign-in path. On `dev` there are no old builds.
