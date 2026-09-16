# MANIFEST 2026-09-16-b  (cumulative — supersedes -a)

**Base commit:** dev @ `66ae9bc` (A284 landed). Extract over the project root
`/c/swiftpos/pos`. This zip carries A284 (already committed) PLUS A283.

**IMPORTANT — one file is NOT in this zip on purpose:**
`apps/desktop/build/installer.nsh` already exists in your working tree (the
authored 2026-08-02 original). I did not ship a re-typed copy — that would risk
overwriting the real file (rule 4). You commit YOUR copy with `git add -f`
(command below). If for any reason it is missing on your disk, tell me and I will
reconstruct it from your 2026-09-16 paste.

## Files in this zip
- `apps/desktop/electron-builder.config.js` — A283: restore `nsis.include:
  'build/installer.nsh'` (removed in A282 to get the first release green). Now
  safe because the file is being committed this time. Also still carries A284's
  `extraMetadata` line.
- `.gitignore` — A283: un-ignore `apps/desktop/build/installer.nsh` (it sits under
  the ignored `build/`), so a clean checkout / `git clean` never drops it again.
- `docs/MANIFEST-2026-09-16-b.md` — this manifest.

## Committed from YOUR working tree (not in the zip)
- `apps/desktop/build/installer.nsh` — the branch-node firewall rule
  (NSIS customInstall/customUnInstall, TCP 4100-4103 private). Load-bearing for
  multi-till; harmless on a single till.

## Apply (from repo root)
    cd /c/swiftpos/pos
    unzip -o "../patch files/swiftpos-2026-09-16-b.zip" -d .
    git add -f apps/desktop/build/installer.nsh
    git add apps/desktop/electron-builder.config.js .gitignore docs/MANIFEST-2026-09-16-b.md docs/AUDIT-REGISTER.md
    # confirm the file is now tracked:
    git ls-files apps/desktop/build/installer.nsh    # must print the path
    git commit -m "A283: commit build/installer.nsh (branch-node firewall) + restore nsis include; un-ignore path"
    git push origin dev

## Rollback
    git checkout -- apps/desktop/electron-builder.config.js .gitignore
    git rm --cached apps/desktop/build/installer.nsh      # untrack (file stays on disk)
    # after commit:  git revert <commit-sha>

## Register (rule 14) — paste into docs/AUDIT-REGISTER.md, then re-home into §A
    A283 → FIX BUILT — build/installer.nsh (branch-node firewall rule, TCP 4100-4103
    private) committed via git add -f and un-ignored; nsis.include restored. Reverses
    the A282 removal now that the file ships. Awaiting a green release build WITH the
    include to confirm CI finds the file.

## Not carried (rule 22)
- No package.json / version. Version is decided by the build tooling at build time.
