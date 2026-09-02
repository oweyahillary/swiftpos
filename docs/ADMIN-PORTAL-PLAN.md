# ADMIN-PORTAL-PLAN.md — capability completion + glass refresh

> **Status: plan, agreed direction.** From the admin-portal audit (A117). The
> portal is strong on ongoing client ops (billing, subscriptions, features,
> suspend/activate, tech tokens) but thin on **lifecycle and fleet-security
> actions** — the "only an admin can do this" powers. This is the path to close
> those gaps, fix two data/graphics issues, and move the look to a glass feel.
>
> Glass mockup (direction locked, will refine over time): `admin-portal-glass-mockup.html`.

---

## What the audit found (the gaps we're closing)

Every item below was confirmed by reading the routes + the portal UI, not assumed.

| # | Gap | Evidence | Severity |
|---|---|---|---|
| G1 | **Cannot add a branch anywhere** | dashboard `POST /api/branches` returns 403 `BRANCH_CREATION_RESTRICTED` (a stub); admin portal has no create-branch endpoint/UI. Only branch ever made is the "Main Branch" at `POST /clients`. | High |
| G2 | **Cannot close/deactivate a branch** | branches have `status`, but admin can only licence/enrol — no status control. | High |
| G3 | **Cannot rotate a branch reveal code** | `POST /branches/:id/reveal-code/regenerate` exists but **no UI calls it** — the A114 tech-access kill switch is unreachable. | High (security) |
| G4 | **Cannot revoke a stolen/compromised till** | admin devices view is read-only; revocation (`DELETE /api/devices/:id`) is owner-only. In the stolen-terminal incident (RUNBOOK §0.2) the agent can't act. | **Highest (security)** |
| G5 | **Cannot edit a business's core details** | `PATCH /clients/:id` exists server-side; no edit form in the portal (typo'd name/type is permanent). | Medium |
| G6 | **Cannot change owner email / reassign ownership** | only `reset-owner-password` (password only). No way to fix a wrong owner or hand over a business. | Medium |
| G7 | **No client offboard / close** | `suspend` is the only end-state. (Policy call — hard delete is rightly absent, but there's no graceful close either.) | Policy |
| G8 | **"Fleet Health" card charts business TYPE, not health** | the bar chart plots `typeBreakdown`, under a "Fleet Health" header with health numbers. | Medium (graphics) |
| G9 | **Two uncross-checked fleet counts** | KPI "Total Clients" from `/fleet/stats`; buckets + chart from `/fleet/health`. Can silently drift. | Low |

---

## Phase 1 — the "only an admin can do" powers (function first)

Fleet-security and lifecycle actions, roughly highest-impact first.

1. **Revoke a stolen/compromised till (G4).** Add an admin device-revoke endpoint
   + a "Revoke" action in the admin devices view. Highest priority — it's a
   security power the agent is expected to have and doesn't.
2. **Rotate a branch reveal code (G3).** Wire the existing
   `reveal-code/regenerate` endpoint to a button. Restores the A114 kill switch.
3. **Create a branch (G1).** *Blocked on decision D1 below.* Build once the model
   is chosen; mirror the Main-Branch insert from `POST /clients`.
4. **Close / deactivate a branch (G2).** Admin sets branch `status`; guard the
   main branch and any active tills.
5. **Edit business core details (G5).** Wire the existing `PATCH /clients/:id` to
   an edit form (name / type / currency).
6. **Change owner email / reassign ownership (G6).** New endpoint (update the
   owner auth email; optionally reassign `owner_id`), audit-logged.

Each ships with an audit-log entry (the portal already logs admin actions) and,
where it writes, an RLS-safe scoped query.

## Phase 2 — data integrity + graphics

7. **Fix the Fleet Health graphic (G8).** Make the chart plot the three health
   buckets (Healthy/Attention/Critical); give "Clients by Type" its own labelled
   card — both already drawn in the mockup.
8. **One source for the fleet count (G9).** Derive KPI total and the chart/buckets
   from a single response (or assert the two agree), so they can't drift.

## Phase 3 — glass refresh

Apply the glass treatment across sidebar, topbar, KPI tiles, cards, tables, and
modals. Evolve the existing cyan-on-navy identity; keep the data-dense layout an
ops tool needs. Ship incrementally (shared primitives first, screen by screen)
so it never blocks Phases 1–2.

### Glass design tokens (from the locked mockup)

```
Backdrop   deep navy #070b14 → #0a1120, with an aurora glow:
           cyan rgba(56,225,255,.22) top-left · violet rgba(167,139,250,.20) top-right
Glass      fill rgba(255,255,255,.045) · backdrop-blur(22px) saturate(150%)
           edge rgba(255,255,255,.10) top-highlight · radius 18px
           shadow 0 10px 34px rgba(2,6,16,.45), inset 0 1px 0 rgba(255,255,255,.06)
Accents    cyan #38e1ff + violet #a78bfa (dual-tone, not a single neon)
Status     green #34e5a0 · amber #fbbf24 · rose #fb6f92 · red #ff5c6c
Type       Space Grotesk (display / numbers) · Inter (body / data)
```

Not the "flat near-black + one neon accent" default the portal is now — the aurora
backdrop + frosted depth + dual-tone glow are the deliberate choices.

---

## Open decisions (needed before the blocked items build)

- **D1 · Branch creation model (gates Phase 1 #3):**
  - **(a)** admin-only — build create-branch in the admin portal (matches the 403's
    intent; keeps branch-add a controlled/billable event). *Recommended.*
  - **(b)** owner self-serve — replace the `branches.ts` 403 with a real handler so
    the dashboard's existing "Add branch" works.
  - **(c)** both — self-serve create, with licence/enrol still admin-gated (already is).
- **D2 · Client offboard (gates Phase 1 #7 / G7):** add a "close account" flow
  (archive, stop billing), or is `suspend` enough? Hard delete stays out either way.

---

## Delivery notes

- Build off a fresh clone of `dev` each time; register rows delivered as paste-in
  lines, not full-file rewrites (protects concurrent edits like A116/signage).
- Phase 1 items are independent — each can be its own small audit ID, or bundled.
- Phase 3 is additive and can interleave; no phase blocks another except D1/D2.

*Plan, 2026-08-17. Direction agreed; scheduling per owner. No app code changed to
produce this document.*
