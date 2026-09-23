# MANIFEST 2026-09-23-o — bundle builder: Windows regression from -n fixed

**Base commit:** `b646b51` (origin/dev, delivery -n; all 9 -n files checksum-matched on the pulled tip; gates exit 0;
CI #377 completed successfully). No shipped file has moved since; all ship whole.
**What broke:** the owner's Windows run of `node scripts/build-escpos-renderer.mjs --check` after -n:
`Error: Cannot find module 'C:\swiftpos\pos\node_modules\npm\bin\npx-cli.js'`, then `Command failed: "npx.cmd" "--yes" …`.
-n quoted the command NAME. npx.cmd locates npm through its own folder (`%~dp0`), and cmd.exe resolves `%~dp0` to the
current folder when a batch file is invoked by a quoted name found on PATH — so npx looked for npm inside the repo.
-m's line (`npx.cmd "--yes" …`, name unquoted — Node joins file + args with spaces under `shell: true`) ran on the
owner's box, with only a DEP0190 warning.
**Fix:** win32 hands cmd.exe `npx.cmd "<arg>" "<arg>" …` as ONE string (`execSync`): the -m line, without DEP0190.
**Why my -n check missed it (rule 9):** the win32 branch was simulated on Linux with a `sh` script named `npx.cmd`;
that has no cmd.exe and no `%~dp0`, so quoting the name made no difference there.
**Scope:** `scripts/build-escpos-renderer.mjs` + register. No product code; Linux/CI path unchanged; no deploy needed.
**Byte-affecting:** no.

## Files (3)

| File | Change |
|---|---|
| `scripts/build-escpos-renderer.mjs` | win32 command line: name unquoted, arguments quoted, one string. Linux path untouched. |
| `docs/AUDIT-REGISTER.md` | Header Last-updated, changelog row, note on A314. Counts unchanged. |
| `docs/MANIFEST-2026-09-23-o.md` | This file. |

## Verification (rule 7)

```
Tip b646b51 (pulled): 9/9 -n checksums OK · register/doc-refs/root-clean/test-registration exit 0 ·
  shared/printing npm test exit 0 · web-receipt-logo-browser 6/6 · bundle --check OK (Linux) · CI #377 green
-o command line vs the -m line (Node's shell:true join) with a real Windows temp path:  string-equal: true
-o command line vs the -n line that failed:                                           different: true ("npx.cmd" quoted)
Node 24.21.0: linux branch --check --throw-deprecation → OK · win32 branch (sh stand-in) --throw-deprecation → OK
register / doc-refs / root-clean / test-registration → exit 0
```

## Not verified here — owner (Windows, Node 24)
`node scripts/build-escpos-renderer.mjs --check` → `OK — … reproducible` and **no** DEP0190 line. This is the only real
test of the win32 branch; a Linux bench cannot run cmd.exe.

## Rollback
```bash
git checkout b646b51 -- scripts/build-escpos-renderer.mjs docs/AUDIT-REGISTER.md && git rm -q --ignore-unmatch docs/MANIFEST-2026-09-23-o.md && rm -f docs/MANIFEST-2026-09-23-o.md
```
