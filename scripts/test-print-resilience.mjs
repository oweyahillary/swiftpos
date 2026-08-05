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
  ok('the kitchen ticket renders one indented line per FILTERED item (component style)',
     /for \(const nl of kitchenPrepLines\(line\.noteLines, kitchenExcludeTerms\)[\s\S]{0,200}padding-left:10px/.test(KT));
  {
    const DP = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/lib/printDispatcher.ts'), 'utf8');
    ok('the dispatcher ticket itemizes the SAME lines — UNFILTERED (owner rule: drinks/sauces print here)',
       /noteLines[\s\S]{0,220}for \(const nl of line\.noteLines\)/.test(DP)
       && !DP.includes('kitchenPrepLines'));
  }
  ok('the KITCHEN ticket renders through the owner filter, terms threaded from settings',
     KT.includes('kitchenPrepLines(line.noteLines, kitchenExcludeTerms)')
     && KT.includes('settings.paperWidth, settings.kitchenExcludeTerms'));
  {
    // OWNER RULE, behaviorally: extract KITCHEN_NOTE_EXCLUDE + kitchenPrepLines
    // verbatim and run them against the real 12PCS Family Meal description.
    const rx = TL.match(/KITCHEN_NOTE_EXCLUDE =\s*(\/[^;]+\/i);/)[1];
    const EX = eval(rx);
    const kitchen = (lines) => lines.filter(l => !EX.test(l));
    const meal = ['12pc tender', '4 sauces', 'large fries', '1L soft drink'];
    const k = kitchen(meal);
    ok('OWNER RULE: sauces and soft drinks never reach the kitchen',
       k.join(',') === '12pc tender,large fries', JSON.stringify(k));
    const combo = ['5pc chicken', 'cole slaw', 'popcorn', 'medium fries', 'soft drink'];
    ok('5PC combo: kitchen sees four prep lines, drink dropped',
       kitchen(combo).length === 4 && !kitchen(combo).includes('soft drink'));
    ok('juice/soda/water/dips also excluded',
       kitchen(['mango juice', 'soda', 'water', '2 dips', 'rice']).join(',') === 'rice');
  }
  {
    const RB = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/components/ReceiptView.tsx'), 'utf8');
    const PP = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/pages/POSPage.tsx'), 'utf8');
    ok('all three field-approved formats carry the DO-NOT-MODIFY lock',
       [KT, RB, fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/lib/printDispatcher.ts'), 'utf8')]
         .every(src => src.includes('FIELD-APPROVED FORMAT (owner, 04 Aug 2026)')));
    // FINAL OWNER RULING (04 Aug): the font/scale experiment is REVERTED —
    // the owner never asked for it. What is locked is the ARRANGEMENT.
    ok('no zoom anywhere in the print pipeline',
       ['lib/printReceipt.ts', 'lib/printKOT.ts', 'lib/printDispatcher.ts']
         .every(f => !fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer', f), 'utf8').includes('zoom:')));
    ok('the success modal is untouched', !PP.includes('TRUE PAPER WIDTH'));
    {
      // The approved footer stack, IN ORDER: payments → owner box (verbatim,
      // rule only when non-empty) → fixed closing block (thank-you · TAX
      // RECEIPT · Powered by SwiftPOS) → final rule.
      // Anchored search: each element must appear AFTER the previous one —
      // the lock comment above the stack names the same strings, so a naive
      // indexOf finds prose, not elements.
      const iPay = RB.indexOf('Payment Detail:');
      const iBox = RB.indexOf('lines(footerText).length > 0 && (', iPay);
      const iFix = RB.indexOf("footerMessage || 'Thank you for your business!'", iBox);
      const iTax = RB.indexOf('TAX RECEIPT UPON REQUEST', iFix);
      const iPow = RB.indexOf('Powered by SwiftPOS', iTax);
      ok('footer stack order: payments → owner box → fixed block → Powered last',
         iPay > -1 && iPay < iBox && iBox < iFix && iFix < iTax && iTax < iPow);
      ok('empty owner box leaves NO orphan rule (rule lives inside the conditional)',
         /lines\(footerText\)\.length > 0 && \([\s\S]{0,700}\{rule\(\)\}\s*<\/>/.test(RB));
      ok('header line 2 reads "Branch — Till", never the TILL concatenation',
         RB.includes('`${branchName} — ${tillNumber}`') && !/TILL \{tillNumber\}/.test(RB));
      ok('the branch name flows from the local branches table through pos:init',
         fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/ipcHandlers.ts'), 'utf8')
           .includes('SELECT name FROM branches WHERE id = ?'));
    }
    {
      // Owner-extensible kitchen exclusions: mechanism, behaviorally.
      const fn = TL.slice(TL.indexOf('export function kitchenPrepLines'), TL.indexOf('\n}', TL.indexOf('export function kitchenPrepLines')) + 2)
        .replace('export function', 'function')
        .replace('(noteLines?: string[], extraTerms?: string): string[]', '(noteLines, extraTerms)');
      const rx = TL.match(/KITCHEN_NOTE_EXCLUDE =\s*(\/[^;]+\/i);/)[1];
      const kitchen = new Function(`const KITCHEN_NOTE_EXCLUDE = ${rx}; ${fn}; return kitchenPrepLines;`)();
      const meal = ['5pc chicken', 'cole slaw', 'popcorn', 'medium fries', 'soft drink'];
      ok('built-in rule alone: drink out, food in', kitchen(meal).length === 4);
      ok("owner adds 'coleslaw\\npopcorn': both drop, no code change",
         kitchen(meal, 'cole slaw\npopcorn').join(',') === '5pc chicken,medium fries');
      ok('owner terms are case-insensitive substrings', kitchen(['Popcorn Chicken'], 'popcorn').length === 0);
      ok('blank lines in the owner box are ignored', kitchen(meal, '\n  \n').length === 4);
      const PB2 = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/pages/PrintersTab.tsx'), 'utf8');
      ok('the owner edits the list on the Printers tab',
         PB2.includes('Kitchen exclusions') && PB2.includes('kitchenExcludeTerms'));
      ok('KOT threads the owner terms through', KT.includes('settings.kitchenExcludeTerms'));
    }
    ok('ReceiptView stays inline-styled — zero Tailwind classes',
       !/className=/.test(RB));
  }
  {
    // BEHAVIORAL: run the actual parser (extracted verbatim from the module).
    const fn = TL.slice(TL.indexOf('export function parseDescriptionLines'), TL.indexOf('\n}', TL.indexOf('export function parseDescriptionLines')) + 2)
      .replace('export function', 'function')
      // Strip the TS annotations so the verbatim body runs under plain Node.
      .replace('(description?: string | null): string[] | undefined', '(description)');
    const parse = new Function(`${fn}; return parseDescriptionLines;`)();
    const a = parse('3pc chicken, 2 fries, 1 soda 500ml');
    ok('comma prose itemizes into three lines', Array.isArray(a) && a.length === 3 && a[1] === '2 fries', JSON.stringify(a));
    // The REAL menu (kudo_kudo_menu_clean.csv) — '+'-separated components.
    const k = parse('5pc chicken + cole slaw + popcorn + medium fries + soft drink');
    ok("the Kudo menu's '+' descriptions itemize", k.length === 5 && k[1] === 'cole slaw' && k[4] === 'soft drink', JSON.stringify(k));
    const b = parse('Chicken\nFries\n- Coleslaw');
    const bp = parse('Chicken\n+ Fries\n+ Coleslaw');
    ok("newline lists with leading '+' strip the marker", bp.length === 3 && bp[1] === 'Fries', JSON.stringify(bp));
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

console.log('\n6. The cloud is an improvement, never a requirement');
{
  const IH = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/ipcHandlers.ts'), 'utf8');
  const SI = fs.readFileSync(path.join(ROOT, 'apps/server/src/index.ts'), 'utf8');
  const HK2 = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/hooks/usePaperGeometry.ts'), 'utf8');
  ok('PIN-screen branches come from the LOCAL table first',
     /auth:listBranches[\s\S]{0,900}SELECT id, name FROM branches/.test(IH));
  ok('a cold/rate-limited server falls back to the local answer, not an error',
     /catch \{ \/\* cold server, rate limit, no link/.test(IH));
  ok('station reads fall back to the local mirrors',
     /manage:listStations[\s\S]{0,200}catch \{ return localStations\(\)/.test(IH));
  ok('category reads fall back to the local table',
     /manage:listCategories[\s\S]{0,300}SELECT \* FROM categories WHERE status/.test(IH));
  ok('rate limiter keys per DEVICE, not the branch NAT IP',
     SI.includes("req.header('x-device-id')") && SI.includes('keyGenerator: limiterKey'));
  ok('the till sends its device id on every cloud call',
     (IH.match(/'x-device-id'/g) || []).length >= 1
     && (fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main/syncEngine.ts'), 'utf8').match(/'x-device-id'/g) || []).length === 2);
  ok('a persisted width detection is honoured — no re-probe on every mount',
     HK2.includes('detectedWidthMm) > 0) { setTried(true); return; }'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
