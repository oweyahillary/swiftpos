# SwiftPOS / ZapTill docs — index

The map of everything under `docs/`. There are ~560 markdown files here; most of the bulk is **historical** (per‑batch
manifests, dated handoffs, verify logs). This index links the **live** docs by purpose and points at the archives for the
rest. New docs: drop them in the right section below and add a line here.

> Built 2026‑11‑15. The spec bulk was sorted into folders — **`designs/`** (agreed design docs, all 59 code references
> updated) and **`tasks/`** (A‑register feature specs) — and the 348 per‑batch **manifests were archived out of the repo**
> (zip in `C:\swiftpos\other files`; breadcrumb in [manifests/](manifests/)). The dated **handoffs were archived out too**
> (same zip folder) — keeping only the two rules‑bearing ones — and the `VERIFY-*`/`MORNING-*` **logs swept into
> `history/`** (§11).

---

## 1. Start here — how a session runs (the working rules)
- [WORKING-RULES.md](WORKING-RULES.md) — **one entry point to every standing rule** (method, base rules, owner rulings, conventions).
- [WORKING-METHOD.md](WORKING-METHOD.md) — the canonical session method (sits on top of the base rules).
- the base rules 1–24 + owner rulings now live in [WORKING-RULES.md](WORKING-RULES.md) (lifted from the handoffs 2026‑11‑15).
- [AUDIT-REGISTER.md](AUDIT-REGISTER.md) + [AUDIT-ID-INDEX.md](AUDIT-ID-INDEX.md) — the A‑register (every change, by id).
- [ROADMAP.md](ROADMAP.md) · [BUGFIXES.md](BUGFIXES.md).

## 2. Manuals & guides (user / technician facing)
- [Manuals/](Manuals/) — each as `.md` + `.docx` + `.html` (the standing rule): **ANDROID-INSTALL**, **BARCODE-LABELS**, **WEIGHED-ITEMS**, + Technical Manuals for DB setup (Local PostgreSQL / Supabase).
- [RUNBOOK.md](RUNBOOK.md) · [RESTORE-GUIDE.md](RESTORE-GUIDE.md) · [BACKUPS.md](BACKUPS.md) (+ `.docx`/`.html`) · [PRINT-SERVER-SETUP.md](PRINT-SERVER-SETUP.md).
- [setup/](setup/) — installer / technician setup material.

## 3. Architecture & design
- [ANDROID-APP-DESIGN.md](designs/ANDROID-APP-DESIGN.md) · [DESKTOP_DESIGN.md](designs/DESKTOP_DESIGN.md).
- Branch server / sync: [BRANCH-SERVER-PLAN.md](BRANCH-SERVER-PLAN.md) · [BRANCH_AUTHORITY_AND_SYNC_DESIGN.md](designs/BRANCH_AUTHORITY_AND_SYNC_DESIGN.md) · [PHASE5-NODE-AUTHORITY.md](designs/PHASE5-NODE-AUTHORITY.md) · [PHASE5-READPATH-PLAN.md](PHASE5-READPATH-PLAN.md) · [PHASE6-BRANCH-SETTINGS.md](designs/PHASE6-BRANCH-SETTINGS.md).
- Features: [PARKING-DESIGN.md](designs/PARKING-DESIGN.md) · [SIGNAGE-DESIGN.md](designs/SIGNAGE-DESIGN.md) · [SHIFT-DAY-WEB-PARITY-DESIGN.md](designs/SHIFT-DAY-WEB-PARITY-DESIGN.md) · [PHASE2-3-DESIGN.md](designs/PHASE2-3-DESIGN.md).
- Till Stage 3 (on branch `android-till-3`): `SCOPE-TILL-STAGE-3.md`, `BUILD-TILL-STAGE-3A/3B/3C/3D*.md`, [HELD-ORDERS-CROSS-TILL-D9.md](designs/HELD-ORDERS-CROSS-TILL-D9.md), [D9-decision-brief.md](designs/D9-decision-brief.md).

## 4. Plans, scopes & roadmap
- [ADMIN-PORTAL-PLAN.md](ADMIN-PORTAL-PLAN.md) · [DESKTOP-ONLY-CUTOFF-PLAN.md](DESKTOP-ONLY-CUTOFF-PLAN.md) · [SHARED-COMPONENTS-PLAN.md](SHARED-COMPONENTS-PLAN.md) · [SUSPEND-PURGE-PLAN.md](SUSPEND-PURGE-PLAN.md).
- Platform move (on hold): [PLATFORM-MOVE-OVERVIEW.md](PLATFORM-MOVE-OVERVIEW.md) · [VPS-MIGRATION-PLAN.md](VPS-MIGRATION-PLAN.md) · [OWN-AUTH-PLAN.md](OWN-AUTH-PLAN.md).
- Scopes: [SCOPE-A295-branding.md](SCOPE-A295-branding.md) · [SCOPE-enrolment-only-activation.md](SCOPE-enrolment-only-activation.md) · [SCOPE-node-authority-A160.md](SCOPE-node-authority-A160.md).

## 5. Ops, backup & DB migration
- [RUNBOOK.md](RUNBOOK.md) · [BACKUPS.md](BACKUPS.md) · [RESTORE-GUIDE.md](RESTORE-GUIDE.md) · [LOCAL-SCHEMA-VERSIONS.md](LOCAL-SCHEMA-VERSIONS.md).
- **Supabase move (DONE 2026‑11‑15):** [SUPABASE-PROD-MOVE-2026-11-15.md](SUPABASE-PROD-MOVE-2026-11-15.md) (the real run + the gotcha) · [SUPABASE-ORG-MOVE.md](SUPABASE-ORG-MOVE.md) (full runbook) · [DB-MOVE-PLAYBOOK.md](DB-MOVE-PLAYBOOK.md) (quick‑ref).

## 6. Feature specs — the A‑register
The `A###-*.md` specs now live in **[tasks/](tasks/)** (`A59`, `A295`, `A612`, `A616`–`A622`, the `A326`/`A328`/`A329` colour‑classification set, …); full list + status in [AUDIT-REGISTER.md](AUDIT-REGISTER.md). Related at root: [PERMISSIONS-A490.md](PERMISSIONS-A490.md), [DEVICE-ENROLMENT-D4.md](DEVICE-ENROLMENT-D4.md).

## 7. Testing & QA
- [TEST_PLAN.md](TEST_PLAN.md) · [TEST_TOOLING.md](TEST_TOOLING.md) · [E2E-CI-PLAN.md](E2E-CI-PLAN.md) · [E2E-NIGHTLY.md](E2E-NIGHTLY.md).
- [checklists/](checklists/) · [testing/](testing/) · verification: [A129-live-verification-checklist.md](tasks/A129-live-verification-checklist.md); older `VERIFY-*` logs are in [history/verify/](history/verify/).

## 8. Schema & audits
- [SCHEMA_AUDIT.md](SCHEMA_AUDIT.md) · [LOCAL-SCHEMA-VERSIONS.md](LOCAL-SCHEMA-VERSIONS.md) · [PERMISSIONS-AUDIT.md](PERMISSIONS-AUDIT.md).

## 9. Marketing & website
- [marketing/](marketing/) — posters, screens, assets (the ZapTill poster set lives in `marketing/posters/`).
- Conventions: [POSTER-DESIGN-RULES.md](POSTER-DESIGN-RULES.md) · [POSTER-DESIGN-SYSTEM.md](POSTER-DESIGN-SYSTEM.md).
- [website/](website/) — the public site · [WEBSITE-BRIEF.md](WEBSITE-BRIEF.md).

## 10. Conventions & wording
- [BUSINESS-TYPE-WORDING.md](BUSINESS-TYPE-WORDING.md) — per‑business‑type terms (shared/businessTerms.ts).
- "node"/"cloud" never "server" (rule 21); general‑purpose, "Your Business" not a real client (A322) — see [WORKING-RULES.md](WORKING-RULES.md).

## 11. Folders & history / archive
- **[designs/](designs/)** — agreed design docs · **[tasks/](tasks/)** — A‑register feature specs · **[manifests/](manifests/)** — the 348 per‑batch records are **archived** out (zip in `C:\swiftpos\other files`; see that folder's README).
- [history/verify/](history/verify/) — swept `VERIFY-*` logs (30) · [history/mornings/](history/mornings/) — swept `MORNING-*` logs (8) · [history/applied/](history/applied/) — applied‑patch notes · [reports/](reports/) — current reports.
- [history/handoffs/](history/handoffs/) — **all dated handoffs archived** out (40), plus a second sweep of 12 old reference docs + stale design duplicates. The working rules they held were lifted into [WORKING-RULES.md](WORKING-RULES.md); the register keeps their names as historical identifiers. Only `SwiftPOS_eTIMS_Integration_Scope.md` (code‑referenced) is kept there.
- **Archived out of the repo (all 2026‑11‑15, in `C:\swiftpos\other files\`):** `zaptill-manifests-archive` (348) · `zaptill-handoffs-archive` (40) · `zaptill-handoffs-leftovers` (12 — old handoff‑package reference docs + stale design duplicates) · `zaptill-docs-archive` (15 — dated QA logs, finished audits, old phase status, one‑off mockups/proposals, draft SQL). Everything code‑referenced was kept.
