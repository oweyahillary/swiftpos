# MANIFEST 2026-08-14-j — tech token paste fix (D18)

**Delta on your pushed `dev`** (base `a9d7be6`). **Desktop change** → rebuild
required, and that build bumps the version (rule 15). `package.json` not shipped
(your 0.5.31 stands until the rebuild).

**Register:** D18 opened (P2, OPEN). Header D-P2 1→2.

---

## Files

| File | What |
|---|---|
| `apps/desktop/src/renderer/pages/PinPage.tsx` | `onPaste` on the reveal field: a pasted `st2.` token routes straight to the token step with the full value. |
| `docs/AUDIT-REGISTER.md` | D18 entry + header. |
| `docs/MANIFEST-2026-08-14-j.md` | this file. |

## The bug
Admin Tech Access hands out a **token** (`st2.…`, hundreds of chars) and no reveal
code. The desktop asks for the 8-char reveal **code** first, in an
`<input maxLength={12}>` that upper-cases. A tech with only the token pastes it
there → truncated to 12 chars, base64 corrupted by upper-casing → "not allowing
the full string", and the token's real field (a textarea) sits behind a reveal
gate they can't pass. Fix: detect a pasted token and jump to the token step with
the full value. Safe — the reveal code grants nothing alone; the token is
branch-scoped and cryptographically verified.

## Deploy
Rebuild the desktop (`npm run release:both`) so tills get the fix — that bumps the
version. No cloud/dashboard change.

---

## Rollback
```bash
cd /c/swiftpos/pos
git checkout a9d7be6 -- apps/desktop/src/renderer/pages/PinPage.tsx docs/AUDIT-REGISTER.md
rm docs/MANIFEST-2026-08-14-j.md
```

## Verified on the bench (rule 7 — Linux, Node 20; rule 9)
- Renderer `tsc`: **0 errors**. Gates green: register-consistency, doc-refs.

## NOT verified here — live (rules 9, 16) — closes D18
- Paste a real admin-issued token at the reveal prompt → reach an unlocked tech
  session (no truncation).
- The normal path still works: type the 8-char reveal code → token step → unlock.

## Complementary, not done (your call)
Admin Tech Access could also **show the branch reveal code** beside the token, so
the intended reveal→token flow works without relying on the paste shortcut. Small
addition to the Tech Access page if you want it.
