/**
 * bt-print.test.mjs — Bluetooth receipt printing (apps/android/src/shop/rules.ts bluetoothTarget + the printing.ts routing,
 * the BtPrinter native plugin, and the Printer-settings picker).
 *
 *   node --no-warnings tests/bt-print.test.mjs
 *
 * WHY: a receipt printer can now be a PAIRED Bluetooth printer, stored as "bt:<MAC>", alongside a network (IP) printer and
 * a USB printer on a PC (the branch server). The target classifier (Bluetooth vs network) is pure and decides which
 * transport prints; the native Bluetooth socket work is device-only, so it is source-checked.
 *
 * MUTATIONS TO CONFIRM BITE (each made, seen to fail, reverted):
 *   - bluetoothTarget treating an IP as Bluetooth        → "a network address is not a Bluetooth target" fails
 *   - bluetoothTarget accepting a malformed MAC          → "a malformed bt: target has no address" fails
 *   - printing.ts not routing bt: via BtPrinter.print    → "printing.ts routes a bt: target to the BtPrinter plugin" fails
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

function requireFrom(dirs, name) {
  for (const d of dirs) { try { return createRequire(path.join(ROOT, d, 'package.json'))(name); } catch { /* next */ } }
  throw new Error(`cannot resolve ${name}`);
}
const esbuild = requireFrom(['apps/android', 'apps/dashboard', 'apps/server'], 'esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
fs.writeFileSync(path.join(tmp, 'entry.ts'), `export * from ${JSON.stringify(path.join(ROOT, 'apps/android/src/shop/rules.ts'))};\n`);
esbuild.buildSync({
  entryPoints: [path.join(tmp, 'entry.ts')], bundle: true, format: 'cjs', platform: 'node',
  outfile: path.join(tmp, 'out.cjs'), resolveExtensions: ['.ts', '.tsx', '.js', '.json'], logLevel: 'silent',
});
const R = createRequire(import.meta.url)(path.join(tmp, 'out.cjs'));

const run = () => {
  console.log('\nbluetoothTarget (pure — Bluetooth vs network)');
  ok('a network address is not a Bluetooth target (null → the caller takes the IP path)', R.bluetoothTarget('192.168.1.50') === null);
  ok('a "printer:" network address is not a Bluetooth target', R.bluetoothTarget('printer:192.168.1.50:9100') === null);
  ok('a bt: target yields the MAC', R.bluetoothTarget('bt:AA:BB:CC:DD:EE:FF')?.address === 'AA:BB:CC:DD:EE:FF');
  ok('the printer: prefix is stripped and the MAC upper-cased', R.bluetoothTarget('printer:bt:aa:bb:cc:dd:ee:ff')?.address === 'AA:BB:CC:DD:EE:FF');
  {
    const r = R.bluetoothTarget('bt:not-a-mac');
    ok('a malformed bt: target has no address (a setup mistake, not a retry)', r !== null && r.address === null);
  }
  ok('notABtPrinter gives words for the screen', typeof R.notABtPrinter() === 'string' && R.notABtPrinter().length > 10);

  console.log('\nSource — the native plugin + wiring are in place');
  {
    const plugin = read('apps/android/android/app/src/main/java/com/zaptill/app/BtPrinterPlugin.java');
    ok('BtPrinterPlugin is a Capacitor plugin named "BtPrinter"', /@CapacitorPlugin\(name = "BtPrinter"/.test(plugin));
    ok('it prints over Bluetooth Classic SPP', /00001101-0000-1000-8000-00805F9B34FB/.test(plugin) && /createRfcommSocketToServiceRecord/.test(plugin));
    ok('it declares + guards the BLUETOOTH_CONNECT runtime permission', /BLUETOOTH_CONNECT/.test(plugin) && /requestPermissionForAlias/.test(plugin));
    ok('it lists bonded devices only (no scan/location)', /getBondedDevices/.test(plugin) && !/startDiscovery/.test(plugin));

    ok('MainActivity registers the plugin', /registerPlugin\(BtPrinterPlugin\.class\)/.test(read('apps/android/android/app/src/main/java/com/zaptill/app/MainActivity.java')));
    ok('the manifest grants BLUETOOTH_CONNECT', /android\.permission\.BLUETOOTH_CONNECT/.test(read('apps/android/android/app/src/main/AndroidManifest.xml')));
    ok('plugins.ts exports the BtPrinter plugin', /export const BtPrinter = registerPlugin<BtPrinterPlugin>\('BtPrinter'\)/.test(read('apps/android/src/native/plugins.ts')));

    const printing = read('apps/android/src/shop/printing.ts');
    ok('printing.ts routes a bt: target to the BtPrinter plugin', /const bt = bluetoothTarget\(target\)/.test(printing) && /BtPrinter\.print\(\{ address: bt\.address/.test(printing));
    ok('printing.ts exposes listBtPrinters on the host', /listBtPrinters: \(\) => BtPrinter\.listPaired\(\)/.test(printing));

    const modal = read('apps/dashboard/src/pages/pos/PrinterSettingsModal.tsx');
    ok('the Printer-settings screen has the Bluetooth picker (Android-gated)', /shopPosHost\(\)\?\.listBtPrinters/.test(modal) && /Find Bluetooth printers/.test(modal) && /'bt:' \+ d\.address/.test(modal));
    ok('the host type carries listBtPrinters', /listBtPrinters\?:/.test(read('apps/dashboard/src/lib/shopPos.ts')));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
};
run();
