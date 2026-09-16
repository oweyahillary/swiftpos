# MANIFEST 2026-09-16-a

**Base commit:** dev HEAD after A282 (v0.5.39 green release — `installer.nsh`
include removed). Extract this zip over the project root `/c/swiftpos/pos`.

**Note (rule 4):** `electron-builder.config.js` has MOVED in your tree since the
A284 patch was cut (A282 removed the `nsis.include` line), which is why
`git apply` failed. This ships the file WHOLE. The whole file already
incorporates the A282 removal, so it will not re-introduce the CI break — the
only difference from your current file is the one added `extraMetadata` line.

## Files
- `apps/desktop/electron-builder.config.js` — A284: add
  `extraMetadata: { productName: name }` so the built app's runtime
  `app.getName()` differs per flavour, giving dev and prod SEPARATE userData
  (`%APPDATA%\SwiftPOS Dev` vs `%APPDATA%\SwiftPOS`) and ending the shared
  `swiftpos.db`/log/token/backups. Does NOT touch `nsis.include` (stays out, so
  the release build stays green).
- `docs/MANIFEST-2026-09-16-a.md` — this manifest.

## Rollback
    git checkout -- apps/desktop/electron-builder.config.js   # before commit
    # after commit:  git revert <commit-sha>

## Not in this zip (deliberately)
- A283 (`build/installer.nsh` re-add + `include` line) — ships in `-b`, cumulative.
- No `package.json` / version (rule 22).
