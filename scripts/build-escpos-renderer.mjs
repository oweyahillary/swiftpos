// Regenerate apps/dashboard/src/lib/escposRenderer.js from shared/printing.
// Run after changing shared/printing's receipt render:  node scripts/build-escpos-renderer.mjs
//
// --check (A314): build to a temp file and fail if it differs from the committed
// bundle. In CI, so a shared/printing change that is not rebuilt into the web
// bundle fails the build — the web and the till then print from the same code
// by construction, not by a hand-run md5 in each manifest.
//
// esbuild is PINNED here, not taken from a package.json: its output shifts
// between versions, and an unpinned `npx --yes esbuild` would compare against
// whatever was latest that morning (a red with no change, i.e. a gate that
// cries wolf — rule 23). Pinning via npx keeps the root package/lockfile out of
// it. Bump the pin deliberately, rebuild, commit the bundle in the same change.
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ESBUILD = 'esbuild@0.28.2';
const TARGET = 'apps/dashboard/src/lib/escposRenderer.js';
const CHECK = process.argv.includes('--check');

// Windows: npx is npx.cmd, and Node (>= 18.20.2 / 20.12.2, CVE-2024-27980) refuses to spawn a .cmd
// without a shell — `spawnSync npx ENOENT` on the owner's Git Bash (2026-09-23). So on win32 hand the
// shell ONE command line with every argument double-quoted (a temp dir under a user profile can hold
// spaces). Not an args array + shell:true: Node 24 warns on that (DEP0190, owner's run 2026-09-23)
// and a later Node may refuse it. Every argument here is ours — no user input reaches this line.
// Linux/macOS (CI) keep the direct, shell-free spawn.
const WIN = process.platform === 'win32';
// The command NAME stays unquoted; only the arguments are quoted. npx.cmd finds npm via its own folder
// (%~dp0), and cmd.exe resolves %~dp0 to the CURRENT folder when a batch file is invoked by a QUOTED
// name found on PATH — the -n builder did that and died with "Cannot find module
// C:\swiftpos\pos\node_modules\npm\bin\npx-cli.js" (owner, 2026-09-23). This is exactly the line Node
// built for -m (`npx.cmd "--yes" …`), which ran on the owner's box; -n only changes how it is handed
// over (one string, so Node 24 does not warn DEP0190).
const winCommandLine = (args) => `npx.cmd ${args.map((a) => `"${a}"`).join(' ')}`;
const build = (outfile) => {
  const args = ['--yes', ESBUILD, 'scripts/escpos-renderer/entry.ts',
    '--bundle', '--format=esm', '--platform=browser', '--log-level=warning',
    '--inject:scripts/escpos-renderer/buffer-shim.js', `--outfile=${outfile}`];
  if (WIN) execSync(winCommandLine(args), { stdio: 'inherit' });
  else execFileSync('npx', args, { stdio: 'inherit' });
};

if (!CHECK) {
  build(TARGET);
  console.log(`wrote ${TARGET} (${ESBUILD})`);
} else {
  const dir = mkdtempSync(join(tmpdir(), 'escpos-bundle-'));
  try {
    build(join(dir, 'escposRenderer.js'));
    // LF-normalised, as check-shared-sync does: a CRLF working copy on Windows
    // must not read as drift.
    const norm = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    const want = norm(TARGET), got = norm(join(dir, 'escposRenderer.js'));
    if (want === got) {
      console.log(`OK — ${TARGET} is reproducible from shared/printing (${ESBUILD}).`);
    } else {
      const a = want.split('\n'), b = got.split('\n');
      let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
      console.log(`FAIL — ${TARGET} is stale against shared/printing at line ${i + 1}`);
      console.log(`  committed: ${JSON.stringify(a[i] ?? '<end of file>')}`);
      console.log(`  rebuilt:   ${JSON.stringify(b[i] ?? '<end of file>')}`);
      console.log('  Fix: node scripts/build-escpos-renderer.mjs, review, commit the bundle.');
      process.exitCode = 1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
