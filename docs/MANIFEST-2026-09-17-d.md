# MANIFEST 2026-09-17-d  (desktop — cumulative, supersedes -c)

**Base commit:** dev @ 0.5.42 (c55ec43). Extract over project root. Two files.
Apply this INSTEAD of -c (it contains -c's A293 plus the A289 title change).
Bench typecheck clean on the edits; CI does the full typecheck (rule 9).

## Files
- `apps/desktop/src/main/managerReports.ts` — A293: isolate getSalesSummary's
  payments + hourly sub-queries (revenue row always returns); fail-soft getTopProducts.
- `apps/desktop/src/main/index.ts` — A289 (revised): cloudBadgeTitle is now a pure
  FLAVOUR gate — PROD never shows the cloud host (clean client title), DEV always
  shows it. Removed PROD_CLOUD_HOSTS (no allowlist to maintain). Carries A291 poll.
- `docs/MANIFEST-2026-09-17-d.md` — this manifest.

## Why A289 changed
The allowlist approach left the host visible on prod until a prod host was listed —
and with none provisioned, prod kept showing the test cloud. Owner wants prod clean,
period. Pure flavour gate does that; wrong-cloud safety stays on the dev flavour
(used for setup) and can get a one-time first-launch warning later if wanted.

## Apply (from repo root) — EXTRACT then commit
    cd /c/swiftpos/pos
    grep -c "getSalesSummary payment split failed" apps/desktop/src/main/managerReports.ts  # 1
    grep -c "if (!devFlavour) return base" apps/desktop/src/main/index.ts                    # 1
    grep -c "PROD_CLOUD_HOSTS" apps/desktop/src/main/index.ts                                # 0
    # paste A293 + A289(revised) + A295 register lines into docs/AUDIT-REGISTER.md, then:
    git add apps/desktop/src/main/managerReports.ts apps/desktop/src/main/index.ts \
            docs/MANIFEST-2026-09-17-d.md docs/AUDIT-REGISTER.md
    git commit -m "A293 Overview sub-query isolation; A289 title = pure flavour gate (prod hides host)"
    git push origin dev

## Rollback
    git checkout -- apps/desktop/src/main/managerReports.ts apps/desktop/src/main/index.ts
