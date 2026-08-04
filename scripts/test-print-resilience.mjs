#!/usr/bin/env node
/**
 * Print resilience — a wedged Windows print spooler must DEGRADE the app,
 * never freeze it. Found in the field on an XP-80: spooler wedged → the
 * settings screen sat on "Reading the printer…" forever and the printer list
 * never populated. Two distinct hang vectors, each needing its own ceiling:
 *
 *   - getPrintersAsync has no timeout of its own and blocks indefinitely on a
 *     wedged spooler.
 *   - execFile's kill can be DEFEATED: a PowerShell blocked inside a hung
 *     printer driver waits kernel-side and can be unkillable, so the callback
 *     never fires and the promise never settles.
 *
 * The rule these assertions pin: every layer owns its own ceiling — main
 * races both vectors, the renderer races the IPC anyway (belt over braces),
 * and Re-detect stays pressable during a hang because it is the escape hatch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const ok = (name, cond, extra='') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};
const PS = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/printService.ts'), 'utf8');
const HK = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/hooks/usePaperGeometry.ts'), 'utf8');
const WC = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/components/PaperWidthControl.tsx'), 'utf8');

console.log('\n1. Main owns a ceiling on both hang vectors');
{
  ok('getPrintersAsync is raced — a wedged spooler returns empty, not never',
     /Promise\.race\(\[\s*win\.webContents\.getPrintersAsync\(\),[\s\S]{0,120}6_000/.test(PS));
  ok('probeGeometry has an OUTER race over the child kill',
     /return Promise\.race\(\[\s*probeGeometryInner\(deviceName\),[\s\S]{0,140}10_000/.test(PS));
  ok('the inner path (execFile timeout + sanity checks) survives intact',
     PS.includes("{ timeout: 8_000, windowsHide: true }") && PS.includes('const plausible ='));
  ok('the unkillable-child case is documented where the fix lives',
     PS.includes('unkillable'));
}

console.log('\n2. The renderer does not trust main');
{
  ok('the hook races the IPC with its own ceiling',
     /Promise\.race\(\[\s*posApi\.print\.geometry\(device\),[\s\S]{0,140}12_000/.test(HK));
  ok('a generation counter lets a fresh attempt supersede a hung one',
     HK.includes('genRef.current') && /if \(gen !== genRef\.current\) return;/.test(HK));
  ok('a stale settle cannot clear a newer attempt\'s probing state',
     /finally \{\s*if \(gen === genRef\.current\) \{ setProbing\(false\)/.test(HK));
}

console.log('\n3. The escape hatch stays open');
{
  ok('Re-detect is NOT disabled while probing',
     !/disabled=\{disabled \|\| geo\.probing/.test(WC)
     && WC.includes('escape hatch'));
}

console.log('\n4. Interactive pickers survive re-renders');
{
  const PT = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/pages/PrintersTab.tsx'), 'utf8');
  // The field bug: PrinterPicker defined INSIDE the component = new type per
  // render = React remounts the <select> = an open dropdown snaps shut under
  // the status-dot probes. Read as "stuck on Microsoft Print to PDF".
  ok('PrinterPicker is module-scope (stable identity)',
     /\nfunction PrinterPicker\(/.test(PT) && !/const PrinterPicker = \(/.test(PT));
  ok('it is declared before the component, not inside it',
     PT.indexOf('function PrinterPicker(') < PT.indexOf('export default function PrintersTab'));
  ok('printers are passed explicitly (no closure over component state)',
     /<PrinterPicker printers=\{printers\}/.test(PT));
  ok('a saved-but-unplugged printer stays selectable', PT.includes('(saved)'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
