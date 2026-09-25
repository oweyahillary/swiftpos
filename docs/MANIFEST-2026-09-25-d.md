# MANIFEST 2026-09-25-d — A330: translucent grey panels get their light-mode colour (the "Add tip" panel and ~130 uses)

**Base:** delivery **2026-09-25-c** applied on `9d07e57` (push -c first; this delivery's register edits build on it).
**Deploy:** the **dashboard only**. Dark mode unchanged.

**What.** In light mode, every translucent grey panel (`bg-gray-{700,800,900,950}/N` — 11 classes, ~130 uses: the web POS "Add
tip" panel, customer / history / parking rows, cards, badges) stayed a dark grey block: the dark-first dashboard's light overrides
covered only solid greys and a few `hover:` variants. Added 11 light-mode rules — the same light colour as the solid override, at the
same opacity. None is a backdrop (checked). A new test keeps it complete.

## Files (4)
| File | Change |
|---|---|
| `apps/dashboard/src/index.css` | 11 `:root:not(.dark) .bg-gray-N\/A` rules. |
| `tests/light-mode-translucent.test.mjs` | **NEW.** 4 checks (CI's tests loop + run-all). |
| `docs/AUDIT-REGISTER.md` | A330 FIX BUILT; header; changelog. |
| `docs/MANIFEST-2026-09-25-d.md` | This file. |

## Verification
```
Chromium, compiled dashboard CSS: 11 classes — light: the light colour at the class's own opacity · dark: unchanged
real forced :hover (CDP) on a light row: BEFORE rgba(31,41,55,0.5) at rest AND hovered → AFTER rgba(241,245,249,0.5) both
node tests/light-mode-translucent.test.mjs 4/4 — its first run caught 2 classes the manual sweep missed (700/40, 700/50);
  mutations: a deleted rule · a drifted opacity · a new translucent class without a rule → each FAILS
dashboard build 0 · check-register-consistency / check-doc-refs / check-root-clean / check-test-registration → OK
node scripts/run-all.mjs GREEN 122/122 · all 26 apps/desktop/test pass (desktop untouched)
```
Noted, not changed: the hand-written light-mode `hover:` overrides inside the Tailwind layer are dropped by Tailwind (it derives the
hover variant from the base rule) — light rows show no hover change; cosmetic, pre-existing, follow-up.

## Owner, after the dashboard deploy
Web POS ☀ light mode → the "Add tip" panel is a light, subtle panel (not grey). Dashboard light mode → Customers rows, Parking settings,
history rows look light. Dark mode → unchanged.

## Rollback
```bash
# before commit:
git checkout HEAD -- apps/dashboard/src/index.css docs/AUDIT-REGISTER.md && rm -f tests/light-mode-translucent.test.mjs docs/MANIFEST-2026-09-25-d.md
# after commit: git revert <this commit>
```
