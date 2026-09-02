/**
 * machine-fingerprint.test.mjs — A182.
 * The MAC selection must be deterministic (same machine → same MAC across
 * reinstalls) and must skip loopback/virtual/zero adapters.
 */
import assert from 'assert';
import { pathToFileURL, fileURLToPath } from 'url';
import path from 'path'; import Module from 'module';

// Load the compiled helper.
const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(here, '..', 'dist', 'main', 'machineFingerprint.js')).href);
const { selectStableMac } = mod;

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`FAIL  ${n}`); } };

const eth = (mac, internal = false) => [{ mac, internal, family: 'IPv4' }];

console.log('machine fingerprint (stable MAC)\n');

// picks the real adapter, skips loopback
ok('skips the internal loopback', selectStableMac({
  lo: eth('00:00:00:00:00:00', true), eth0: eth('a4:b1:c2:d3:e4:f5'),
}) === 'a4:b1:c2:d3:e4:f5');

// deterministic: order of interfaces / multiple NICs → same lowest MAC
const nics = { eth1: eth('ff:ee:dd:cc:bb:aa'), eth0: eth('11:22:33:44:55:66') };
ok('deterministic across NICs (lowest wins)', selectStableMac(nics) === '11:22:33:44:55:66');
ok('same result regardless of key order', selectStableMac({ eth0: eth('11:22:33:44:55:66'), eth1: eth('ff:ee:dd:cc:bb:aa') }) === '11:22:33:44:55:66');

// skips virtual adapters (docker/vbox/etc.)
ok('skips virtual adapters', selectStableMac({
  vboxnet0: eth('0a:00:27:00:00:00'), docker0: eth('02:42:ac:11:00:02'), en0: eth('3c:22:fb:aa:bb:cc'),
}) === '3c:22:fb:aa:bb:cc');

// skips the all-zero MAC
ok('skips the zero MAC', selectStableMac({ eth0: eth('00:00:00:00:00:00'), eth1: eth('de:ad:be:ef:00:11') }) === 'de:ad:be:ef:00:11');

// nothing usable → null (never throws)
ok('returns null when nothing usable', selectStableMac({ lo: eth('00:00:00:00:00:00', true) }) === null);
ok('handles empty input', selectStableMac({}) === null);

// MUTATION guard: a real machine yields a NON-null, well-formed MAC
const real = selectStableMac({ en0: eth('3c:22:fb:aa:bb:cc') });
ok('mutation guard: a valid NIC produces a colon-MAC', /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(real || ''));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
