# MANIFEST 2026-08-14-k — Admin Tech Access shows the reveal code (D18 complement)

**Delta on your pushed `dev`** (base `a9d7be6`). Admin-only — no cloud, no
desktop, no version bump, `package.json` not shipped.

**Register:** folded into D18 (no count change) — the admin complement of the
tech-token fix.

---

## Files

| File | What |
|---|---|
| `apps/admin/src/AdminPortal.tsx` | Tech Access: on token generation, also fetch + show the branch **reveal code** beside the token, labelled "enter this FIRST on the till", with a copy button. |
| `docs/AUDIT-REGISTER.md` | D18 entry updated (admin complement done). |
| `docs/MANIFEST-2026-08-14-k.md` | this file. |

## What it does
Closes the mismatch behind D18 at the source: the tech now gets **both** halves of
the flow from one screen — the short reveal code (entered first on the till) and
the token (pasted second). Uses the existing `GET /api/admin/branches/:branchId/
reveal-code` endpoint. Combined with the desktop paste shortcut (D18, `-j`), the
tech can use either the intended two-step flow or just paste the token — both work.

## Deploy
Admin (Vercel) only. No cloud or desktop change.

---

## Rollback
```bash
cd /c/swiftpos/pos
git checkout a9d7be6 -- apps/admin/src/AdminPortal.tsx docs/AUDIT-REGISTER.md
rm docs/MANIFEST-2026-08-14-k.md
```

## Verified on the bench (rule 7 — Linux, Node 20; rule 9)
- Admin `tsc`: additions add no new errors. Gates green: register-consistency, doc-refs.

## NOT verified here — live (rules 9, 16)
- Generate a token → the reveal code appears beside it; entering that code then the
  token on the till reaches an unlocked tech session.
- A branch with no reveal code yet: the `GET` mints one on first read (existing
  endpoint behaviour) — confirm it shows rather than blanks.
