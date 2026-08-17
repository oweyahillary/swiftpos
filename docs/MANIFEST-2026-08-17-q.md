# MANIFEST 2026-08-17-q — A126 admin portal Phase 3: glass refresh

**Base:** built on top of **A125** (the purge preview; A125 unpushed and also touches
`AdminPortal.tsx`, so this is cumulative). Register ID **A126**. Front-end only.

> **Apply order:** p (A125) → **q (A126)**. q's `admin.ts` + `AdminPortal.tsx`
> supersede p's (supersets). `index.css` is new-to-this.
>
> **Visual change — I could not see the result on the bench.** It compiles and the
> tokens are a faithful translation of the approved mockup, but please review it in a
> browser; we expected to refine it ("improve with time").

## Files (3 + manifest)

| File | Change |
|---|---|
| `apps/admin/src/index.css` | Inter + Space Grotesk fonts; **aurora backdrop** on `body` (deep navy + cyan/violet/green glow, fixed); glass scrollbars; solid `select option` for readability. |
| `apps/admin/src/AdminPortal.tsx` | **`C` palette** → glass (base `#070b14`, translucent `surface`/`card`, light edge, accent `#38e1ff` + `violet #a78bfa` + softer `green`/`text`/`muted`/`danger`). **`S` styles** → frosted glass: sidebar/topbar/modal `backdrop-filter`, transparent `main` (aurora shows through), cards `blur(22px)` + radius 18 + soft shadow + top-highlight, glassy inputs/buttons. **Space Grotesk** on the SwiftPOS wordmark + main KPI numbers. (Plus the cumulative A125 preview.) |

## Design intent (from the locked mockup)

Not the "flat near-black + one neon accent" the portal was — an aurora backdrop the
frosted surfaces refract, dual-tone cyan/violet glow, and characterful display type.
Data-dense layout unchanged; this is a skin over the same structure.

## Known first-pass limitations (refine later)

- Some components use hardcoded inner backgrounds (e.g. `#0f1929`, `#0a1628`) that
  won't turn glass — they'll read as solid dark islands until tokenised.
- Space Grotesk applied only to the wordmark + main-dashboard KPIs, not every heading.
- `backdrop-filter` needs a modern browser (fine for Chrome/Edge/Safari).

## Verified (bench)

- Server `tsc` clean (A125 preview); admin `vite build` clean; type errors unchanged
  at **65**. Gates green: supabase-catch, permission-parity, register, doc-refs,
  table-usage. **Visual result not verifiable here.**

## Rollback

`git checkout -- apps/admin/src/AdminPortal.tsx apps/admin/src/index.css apps/server/src/routes/admin.ts`.
