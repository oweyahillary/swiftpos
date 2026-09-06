// Regenerate apps/dashboard/src/lib/escposRenderer.js from shared/printing.
// Run after changing shared/printing's receipt render:  node scripts/build-escpos-renderer.mjs
import { execFileSync } from 'node:child_process';
execFileSync('npx', ['--yes', 'esbuild', 'scripts/escpos-renderer/entry.ts',
  '--bundle', '--format=esm', '--platform=browser',
  '--inject:scripts/escpos-renderer/buffer-shim.js',
  '--outfile=apps/dashboard/src/lib/escposRenderer.js'], { stdio: 'inherit' });
console.log('wrote apps/dashboard/src/lib/escposRenderer.js');
