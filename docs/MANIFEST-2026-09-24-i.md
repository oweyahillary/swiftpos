# MANIFEST 2026-09-24-i — Phase 2 slice 4: the web theme picker (A327) · A326 closed

**Base commit:** `bb31313` (origin/dev, delivery 2026-09-24-h; CI #395 green; tag `v0.6.6`; owner's 0.6.6 screenshots → A326 CLOSED).
**Register:** A327 NEW → FIX BUILT (P3); A326 → CLOSED; A323 tracker; header; changelog. Counts unchanged (18 · 17 · 19).
**Deploy:** the **dashboard only**. No cloud, admin, database or desktop change (no version bump).

## What
`apps/dashboard/src/pages/settings/BrandingTab.tsx` — reads `theme_id` + `themes_enabled` (A325's GET).
- **Themes OFF:** nothing new is shown; Save sends no `theme_id` (the cloud keeps what is stored).
- **Themes ON:** "App theme" picker (the seven, from `lib/themes.ts`; nothing chosen shows **Ocean** — what the cloud serves) with a
  "Suggested" badge and "Use it" (complementary pairing); a **Till preview** drawn by the till's rules (action from `themeTokens`, strip
  + sidebar tint from `resolveBrandLayer`, prices and Paid green); the **lock preview** wears the theme when there is no brand colour
  (the till's PinPage rule); **Save** sends `theme_id`; **Reset** clears it too.
- Phase 1 pins untouched (checked against every existing test regex BEFORE editing — the lesson of CI #394).

## Files (5)
| File | Change |
|---|---|
| `apps/dashboard/src/pages/settings/BrandingTab.tsx` | Picker, till preview, load/save/reset of `theme_id`. |
| `tests/branding-theme-picker.test.mjs` | **NEW.** 13 checks (CI's tests loop + run-all). |
| `docs/AUDIT-REGISTER.md` | A327; A326 CLOSED; tracker; header; changelog. |
| `docs/VERIFY-LOG-2026-09-24.md` | §A326 (the 0.6.6 screenshots). |
| `docs/MANIFEST-2026-09-24-i.md` | This file. |

## Verification (rule 7)
```
BENCH — headless Chromium, the REAL BrandingTab, cloud mocked, PUT bodies captured: 15/15
  OFF: no picker, no till preview · lock preview teal (Phase 1) · Save sends NO theme_id
  ON, nothing chosen: Ocean selected · till Charge rgb(59,130,246) · lock Enter Ocean · no brand strip
  pick Violet → Charge + lock rgb(139,92,246) · Save → {…, theme_id:"violet"} · Reset → {…, receipt_logo_enabled:false, theme_id:null}
  yellow brand #F5B800: lock + strip stay rgb(245,184,0) · Sky "Suggested" + "Use it" → Sky, Charge rgb(14,165,233) · no page errors
  (first run read colours mid-fade — the dashboard's global theme transition — and counted the badge in the name: the MEASUREMENT fixed)
node tests/branding-theme-picker.test.mjs 13/13 — mutations: theme_id sent with themes off · picker unconditional · lock ignores the
  theme · reset keeps the theme → each bites
branding-web-page 26/0 · branding-web-contrast 11/0 · web-receipt-logo-browser 6/0
apps/dashboard npm run build 0 · typecheck-ratchet OK · run-all GREEN 120/120 · all 26 apps/desktop/test pass
check-register-consistency / check-doc-refs / check-root-clean / check-test-registration → OK
```

## Not verified here (rule 16) — owner, after the dashboard deploy
1. Dashboard → Business → **Branding** (B Foods has themes on) → **App theme** visible; Ocean selected; pick another → both previews change.
2. **Save branding** → within ~20 s the till's buttons follow the new theme (no restart).
3. Set a **brand colour** (e.g. a palette colour) → Save → the till's brand strip, lock curtain and Manager sidebar take it
   (the path A326 could not exercise).
4. For a business with themes OFF: the page looks exactly as before.

## Rollback
```bash
git checkout bb31313 -- apps/dashboard/src/pages/settings/BrandingTab.tsx docs/AUDIT-REGISTER.md docs/VERIFY-LOG-2026-09-24.md && git rm -q --ignore-unmatch tests/branding-theme-picker.test.mjs docs/MANIFEST-2026-09-24-i.md && rm -f tests/branding-theme-picker.test.mjs docs/MANIFEST-2026-09-24-i.md
```
