# MANIFEST 2026-09-16-c  (cumulative — supersedes -b)

**Base commit:** dev @ the v0.5.41 commit (A284 + A283 landed). Extract over the
project root `/c/swiftpos/pos`. Carries A284 + A283 (already committed) PLUS A288.

## Files in this zip
- `apps/desktop/electron-builder.config.js` — A288: `win.target` is now `['nsis']`
  (was `['nsis','portable']`); removed the `portable:` block and the now-unused
  `shortName` const. Stops the second, updater-invisible draft release per tag.
  Still carries A284 (`extraMetadata`) and A283 (`nsis.include`).
- `docs/MANIFEST-2026-09-16-c.md` — this manifest.

## Effect
- One release per tag from the next build onward (NSIS installer only, with
  latest.yml + blockmap). Existing v0.5.41 double-draft is unaffected — publish
  the 5-asset one and delete the 4-asset one by hand this once.
- No change to install/update behaviour; portable was never deployed to tills.
  Need a portable one-off later? Build locally: `npx electron-builder --win portable`
  (does not publish).

## Apply (from repo root)
    cd /c/swiftpos/pos
    unzip -o "../patch files/swiftpos-2026-09-16-c.zip" -d .   # or extract by hand
    node -e "const c=require('./apps/desktop/electron-builder.config.js');console.log(c.win.target, c.portable)"
    # expect: [ 'nsis' ] undefined
    # paste the A288 register line below into docs/AUDIT-REGISTER.md, then:
    git add apps/desktop/electron-builder.config.js docs/MANIFEST-2026-09-16-c.md docs/AUDIT-REGISTER.md
    git commit -m "A288: NSIS-only win target — stop the duplicate portable release per tag"
    git push origin dev

## Rollback
    git checkout -- apps/desktop/electron-builder.config.js
    # after commit:  git revert <commit-sha>

## Register (rule 14)
    A288 → FIX BUILT — win.target reduced to ['nsis']; portable target + block removed
    (also dropped unused shortName const). Portable published a second updater-invisible
    release per tag (no latest.yml/blockmap) and can't self-update or run installer.nsh.
    One release per tag from next build. Confirm on the tag after v0.5.41.

## Not carried (rule 22)
- No package.json / version.
