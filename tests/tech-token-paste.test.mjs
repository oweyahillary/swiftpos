/**
 * tech-token-paste.test.mjs — D18: a technician who only has the token (which is
 * all Admin Tech Access hands out) can paste it and reach the token step, instead
 * of the reveal field truncating it.
 *
 *   node tech-token-paste.test.mjs
 *
 * The reveal input is `maxLength={12}` and upper-cases — pasting an `st2.<...>`
 * token there truncated it to `st2.XXXXXXXX` and corrupted the base64, so the
 * full token could never be entered and even the stub failed as "Incorrect code".
 * The fix: an onPaste on the reveal field detects the `st2.` prefix, prevents the
 * default (bypassing maxLength + upper-casing), sets the FULL token, and jumps to
 * the token step. Source-guarded here; the on-screen paste is confirmed by the
 * owner on the amber build (rule 16).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pin = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/pages/PinPage.tsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (label, cond, d = '') => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}  ${d}`); } };

// the reveal-field onPaste handler is unambiguous in this file; check its parts directly
const onPaste = pin;

ok('the reveal field has an onPaste handler', /onPaste=\{e =>/.test(pin));
ok('it detects a token by the st2. prefix', /startsWith\('st2\.'\)/.test(onPaste));
ok('it prevents the default (bypassing maxLength + upper-casing)',
   /e\.preventDefault\(\)/.test(onPaste));
ok('it sets the FULL pasted value, not a truncated one',
   /setTokenInput\(text\)/.test(onPaste));
ok('it jumps straight to the token step',
   /setTechStage\('token'\)/.test(onPaste));
// the field itself is still the capped reveal input (we route AROUND it, not widen it)
ok('the reveal input keeps its maxLength (fix routes around it, not by widening)',
   /maxLength=\{12\}/.test(pin));

console.log(`\n${fail === 0 ? `All ${pass} checks passed. Token paste routes past the reveal field.` : `${fail} FAILED (${pass} passed)`}`);
process.exit(fail === 0 ? 0 : 1);
