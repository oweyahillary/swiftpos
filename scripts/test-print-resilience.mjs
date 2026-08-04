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

console.log('\n5. Routing edits are instant; tickets say what to make; one owner per setting');
{
  const IH = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/ipcHandlers.ts'), 'utf8');
  const TL = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/lib/ticketLines.ts'), 'utf8');
  const KT = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/lib/printKOT.ts'), 'utf8');
  const PB = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/pages/PrintersTab.tsx'), 'utf8');

  // Ticking ten categories used to mean ten full-catalogue re-pulls in a row.
  {
    // Scope each check to the HANDLER BODY (up to the next ipcMain.handle) —
    // a fixed character window ran into the NEXT handler, whose full-catalogue
    // refresh is legitimate for a category write.
    const body = (channel) => {
      const i = IH.indexOf(`ipcMain.handle('${channel}'`);
      const j = IH.indexOf('ipcMain.handle(', i + 1);
      return IH.slice(i, j === -1 ? undefined : j);
    };
    const stationWrites = ['manage:createStation', 'manage:updateStation', 'manage:deleteStation', 'manage:setStationCategories'];
    ok('station writes refresh ONLY the two station tables',
       stationWrites.every(c => body(c).includes('refreshStationsLocal()') && !body(c).includes('refreshCatalogue()')));
  }
  ok('the light refresh rewrites both tables transactionally',
     /refreshStationsLocal[\s\S]{0,900}DELETE FROM category_stations[\s\S]{0,80}DELETE FROM print_stations[\s\S]{0,700}\)\(\)/.test(IH));

  // A flat product's description reaches the KITCHEN ticket; a combo's does not
  // (its components already say what to make); the packer's ticket stays names.
  ok('flat products carry their description as ITEMIZED prep lines',
     TL.includes('components.length === 0 ? parseDescriptionLines') && TL.includes('noteLines?: string[]'));
  ok('the kitchen ticket renders one indented line per item (component style)',
     /for \(const nl of line\.noteLines[\s\S]{0,200}padding-left:10px/.test(KT));
  ok('the dispatcher ticket does NOT',
     !fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/lib/printDispatcher.ts'), 'utf8').includes('noteLines'));
  {
    // BEHAVIORAL: run the actual parser (extracted verbatim from the module).
    const fn = TL.slice(TL.indexOf('export function parseDescriptionLines'), TL.indexOf('\n}', TL.indexOf('export function parseDescriptionLines')) + 2)
      .replace('export function', 'function')
      // Strip the TS annotations so the verbatim body runs under plain Node.
      .replace('(description?: string | null): string[] | undefined', '(description)');
    const parse = new Function(`${fn}; return parseDescriptionLines;`)();
    const a = parse('3pc chicken, 2 fries, 1 soda 500ml');
    ok('comma prose itemizes into three lines', Array.isArray(a) && a.length === 3 && a[1] === '2 fries', JSON.stringify(a));
    const b = parse('Chicken\nFries\n- Coleslaw');
    ok('newlines win over commas; bullets stripped', b.length === 3 && b[2] === 'Coleslaw', JSON.stringify(b));
    ok('empty/whitespace description renders nothing', parse('   ') === undefined && parse(null) === undefined);
    const c = parse(Array.from({ length: 20 }, (_, i) => `item ${i}`).join(', '));
    ok('paragraph descriptions are capped, not ticket-eating', c.length === 8);
  }

  // One owner per setting: with a station of the kind configured, the legacy
  // card becomes a pointer, and the legacy value survives as a silent fallback.
  ok('legacy kitchen card yields to a configured Kitchen station',
     /stationKinds\.has\('kitchen'\) \? \(/.test(PB));
  ok('legacy dispatcher card yields to a configured Packing station',
     /stationKinds\.has\('dispatch'\) \? \(/.test(PB));
  ok('stations unreachable = legacy cards shown (the safe default)',
     PB.includes('the safe default'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
