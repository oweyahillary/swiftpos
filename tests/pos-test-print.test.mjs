/**
 * pos-test-print.test.mjs — the POS "Test print" (apps/dashboard/src/lib/posTestPrint.ts).
 *
 *   node --no-warnings tests/pos-test-print.test.mjs      (bundles the lib with esbuild; renderer + transport are injected)
 *
 * WHY THIS MATTERS: a Shop POS (Android) prints a receipt to a NETWORK printer named by its address; before this there was
 * no way to set that address or prove the printer works short of a real sale. posTestPrint renders a sample receipt with
 * the SAME renderer a real receipt uses and sends it down the SAME seam (printBytesToServer → RawPrinter on a Shop POS),
 * so a passing test proves the real path. These tests pin the dispatch (empty address refused kindly; a good address
 * rendered and sent to 'printer:'+address) and the sample shape (money in CENTS).
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - posTestPrint not throwing on an empty address        → "an empty address is refused before any send" fails
 *   - posTestPrint sending the bare address (no 'printer:') → "a good address is sent as a printer: target" fails
 *   - sampleReceiptOrder total in shillings not cents       → "the sample receipt is in cents" fails
 *   - the modal calling the PC-bridge testPrint            → "the modal tests through the seam, not the dead PC bridge" fails
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { console.log(`  ok   ${n}`); pass++; } else { console.log(`  FAIL ${n}  ${String(d).slice(0, 900)}`); fail++; } };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

function requireFrom(dirs, name) {
  for (const d of dirs) { try { return createRequire(path.join(ROOT, d, 'package.json'))(name); } catch { /* next */ } }
  throw new Error(`cannot resolve ${name}`);
}
const esbuild = requireFrom(['apps/dashboard', 'apps/android', 'apps/server'], 'esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-'));
fs.writeFileSync(path.join(tmp, 'entry.ts'), `
  export { posTestPrint, normalizeAddress, sampleReceiptOrder, sampleBusinessConfig } from ${JSON.stringify(path.join(ROOT, 'apps/dashboard/src/lib/posTestPrint.ts'))};
`);
esbuild.buildSync({
  entryPoints: [path.join(tmp, 'entry.ts')], bundle: true, format: 'cjs', platform: 'node',
  outfile: path.join(tmp, 'out.cjs'), resolveExtensions: ['.ts', '.tsx', '.js', '.json'], logLevel: 'silent',
});
const M = createRequire(import.meta.url)(path.join(tmp, 'out.cjs'));

// A renderer + transport we can watch. render returns identifiable bytes; send records what it was handed.
function makeDeps() {
  const calls = { render: [], send: [] };
  const render = (order, business, paperWidth) => { calls.render.push({ order, business, paperWidth }); return new Uint8Array([7, 8, 9]); };
  const send = async (target, bytes) => { calls.send.push({ target, bytes: Array.from(bytes) }); };
  return { deps: { render, send }, calls };
}

const run = async () => {
  console.log('\nnormalizeAddress');
  eq('trims surrounding space', M.normalizeAddress('  192.168.1.50  '), '192.168.1.50');
  eq('undefined is empty', M.normalizeAddress(undefined), '');

  console.log('\nsampleReceiptOrder / sampleBusinessConfig (pure)');
  {
    const o = M.sampleReceiptOrder(new Date('2026-11-16T00:00:00Z'));
    ok('the sample receipt is in cents', o.total === 10000 && o.lines[0].lineTotal === 10000 && o.payments[0].amount === 10000, JSON.stringify(o));
    ok('it is marked a test, not a sale', o.billNumber === 'TEST' && String(o.note).toLowerCase().includes('not a sale'));
    ok('it is a well-formed single-line order', o.lines.length === 1 && o.kotCount === 0 && o.changeGiven === 0 && Array.isArray(o.lines[0].units));
    const b = M.sampleBusinessConfig('', '');
    ok('business falls back to a name + required tax fields', b.name === 'ZapTill' && b.vatRate === 0 && b.ctlRate === 0 && b.currencyCode === 'KES');
    eq('a given business name is used', M.sampleBusinessConfig('African Fries').name, 'African Fries');
  }

  console.log('\nposTestPrint dispatch');
  {
    const { deps, calls } = makeDeps();
    let threw = null;
    try { await M.posTestPrint({ address: '', paperWidth: 80 }, deps); } catch (e) { threw = e; }
    ok('an empty address is refused before any send', threw !== null && calls.send.length === 0);
    ok('the refusal names what to do', threw && /address/i.test(threw.message));
  }
  {
    const { deps, calls } = makeDeps();
    let threw = null;
    try { await M.posTestPrint({ address: '   ', paperWidth: 80 }, deps); } catch (e) { threw = e; }
    ok('a whitespace-only address is refused too', threw !== null && calls.send.length === 0);
  }
  {
    const { deps, calls } = makeDeps();
    const r = await M.posTestPrint({ address: ' 192.168.1.50:9100 ', paperWidth: 58, businessName: 'Mama Oliech' }, deps);
    eq('the result reports the printer tested (direct)', r, { printer: '192.168.1.50:9100', via: 'direct' });
    eq('render was called once at the chosen paper width', calls.render.map((c) => c.paperWidth), [58]);
    ok('render received the sample order + business', calls.render[0].order.billNumber === 'TEST' && calls.render[0].business.name === 'Mama Oliech');
    eq('a good address is sent as a printer: target', calls.send.map((c) => c.target), ['printer:192.168.1.50:9100']);
    eq('the exact rendered bytes are what is sent', calls.send[0].bytes, [7, 8, 9]);
  }

  console.log('\nposTestPrint — branch server (USB-on-PC) path');
  {
    // Joined server prints: it wins, and nothing is sent directly even with an address set.
    const { deps, calls } = makeDeps();
    deps.printViaServer = async () => ({ printed: 1, configured: 1 });
    const r = await M.posTestPrint({ address: '192.168.1.50', paperWidth: 80 }, deps);
    eq('a joined server that prints wins (no direct send)', [r, calls.send.length], [{ printer: 'the connected computer', via: 'branch-server' }, 0]);
  }
  {
    // Joined server with no printer configured → a named, actionable error.
    const { deps } = makeDeps();
    deps.printViaServer = async () => ({ printed: 0, configured: 0 });
    let threw = null;
    try { await M.posTestPrint({ address: '', paperWidth: 80 }, deps); } catch (e) { threw = e; }
    ok('a server with no printer set up says so', threw && /no receipt printer set up/i.test(threw.message));
  }
  {
    // Joined server, printer configured but nothing printed → check-it-is-on error.
    const { deps } = makeDeps();
    deps.printViaServer = async () => ({ printed: 0, configured: 2 });
    let threw = null;
    try { await M.posTestPrint({ address: '', paperWidth: 80 }, deps); } catch (e) { threw = e; }
    ok('a configured-but-silent server says to check the printer', threw && /nothing printed/i.test(threw.message));
  }
  {
    // No server reachable (null) → falls back to the direct address.
    const { deps, calls } = makeDeps();
    deps.printViaServer = async () => null;
    const r = await M.posTestPrint({ address: '10.0.0.9', paperWidth: 80 }, deps);
    eq('an unreachable server falls back to the direct address', [r.via, calls.send.map((c) => c.target)], ['direct', ['printer:10.0.0.9']]);
  }

  // ── Source: the modal wires the REAL renderer + seam, not the PC-bridge testPrint (dead on a tablet) ──
  console.log('\nSource — the Printer Settings modal');
  {
    const modal = read('apps/dashboard/src/pages/pos/PrinterSettingsModal.tsx');
    ok('the modal imports posTestPrint', /from ['"].*lib\/posTestPrint['"]/.test(modal));
    ok('the modal tests through the seam, not the dead PC bridge',
      /printBytesToServer/.test(modal) && /renderEscPos/.test(modal) && !/\btestPrint\b/.test(modal));
    ok('there is a receipt-printer address field (receiptPrinterName)', /receiptPrinterName/.test(modal));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
};
run();
