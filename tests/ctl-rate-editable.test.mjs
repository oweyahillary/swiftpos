/**
 * ctl-rate-editable.test.mjs — A277: owners can set the Catering/Tourism Levy rate, so the
 * CTL line (already rendered on the receipt) actually appears.
 *
 *   node tests/ctl-rate-editable.test.mjs
 *
 * The CTL amount is computed at sale, printed on the receipt (ReceiptView) and shown in reports —
 * but ctl_rate was stuck at 0 because nothing let an owner set it. This guards the newly-wired
 * path: server accepts+validates ctl_rate, and the Business Profile form exposes it.
 *
 * MUTATIONS TO CONFIRM BITE:
 *   - drop 'ctl_rate' from server EDITABLE            → "server EDITABLE includes ctl_rate" fails
 *   - remove the ctl_rate validation block            → "server validates ctl_rate 0..100" fails
 *   - remove the ctl_rate field from the form         → "Business Profile form exposes ctl_rate" fails
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}  ${detail}`); } };

const biz  = r('apps/server/src/routes/business.ts');
const form = r('apps/dashboard/src/pages/settings/BusinessProfileTab.tsx');
const rcpt = r('apps/desktop/src/renderer/components/ReceiptView.tsx');

ok('server EDITABLE includes ctl_rate',
   /const EDITABLE = \[[^\]]*'ctl_rate'[^\]]*\]/.test(biz));
ok('server validates ctl_rate 0..100 (mirrors vat_rate)',
   /'ctl_rate' in updates/.test(biz) && /CTL rate must be between 0 and 100/.test(biz));
ok('Business Profile type carries ctl_rate',
   /ctl_rate:\s*number\s*\|\s*null/.test(form));
ok('Business Profile form exposes a ctl_rate field',
   /key:\s*'ctl_rate'/.test(form) && /Catering\/Tourism Levy/.test(form));
ok('Business Profile save payload sends ctl_rate',
   /ctl_rate:\s*record\.ctl_rate/.test(form));
ok('receipt already renders the CTL line (downstream present)',
   /ctlRate\s*>\s*0\s*&&\s*row\(`CTL/.test(rcpt));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
