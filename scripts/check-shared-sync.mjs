#!/usr/bin/env node
/**
 * check-shared-sync.mjs — fail CI when a shared file diverges between apps.
 *
 * There is no shared package in this monorepo and adding one means build
 * tooling across three apps with different bundlers. The pragmatic alternative
 * is a copied file plus a check that the copies are identical — which is the
 * same trick scripts/schema-parity.mjs already plays for Postgres and SQLite.
 *
 * This exists because of audit H2. VAT was overstated on every discounted sale
 * for months because /open and /pay each computed the same money their own way.
 * Parking has the same shape with worse odds: the till prices a session offline
 * at the barrier, the server prices it again on sync, and if those two ever
 * disagree the drawer will not balance and nobody will know which figure was
 * right. Two copies of one file is acceptable. Two implementations is not.
 *
 * To change a shared file: edit one copy, copy it to the others verbatim, run
 * its test vectors, commit all copies together.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Each entry: the canonical copy first, then every copy that must match it. */
const SHARED = [
  {
    name: 'parkingTariff.ts',
    copies: [
      'shared/parkingTariff.ts',
      'apps/server/src/shared/parkingTariff.ts',
      'apps/desktop/src/shared/parkingTariff.ts',
    ],
  },
  {
    // A344: one fixed colour per payment method — the till's and the web's payment buttons and method labels.
    name: 'paymentColours.ts',
    copies: [
      'shared/paymentColours.ts',
      'apps/desktop/src/shared/paymentColours.ts',
      'apps/dashboard/src/lib/paymentColours.ts',
    ],
  },
  {
    // 0.6.23: the mouse wheel never changes a number field (the till and the web).
    name: 'numberInputs.ts',
    copies: [
      'shared/numberInputs.ts',
      'apps/desktop/src/shared/numberInputs.ts',
      'apps/dashboard/src/lib/numberInputs.ts',
    ],
  },
  {
    // A367 (0.6.24): notes on an item and on the order — cleaning, the owner's quick picks, the ticket lines.
    name: 'orderNotes.ts',
    copies: [
      'shared/orderNotes.ts',
      'apps/desktop/src/shared/orderNotes.ts',
      'apps/desktop/src/main/orderNotes.ts',   // the main process cleans what it stores (rootDir is src/main)
      'apps/dashboard/src/lib/orderNotes.ts',
      'apps/server/src/lib/orderNotes.ts',     // the cloud cleans what it stores
    ],
  },
  {
    // 0.6.27: the manager's reason where their count differs from the cashier's ('confirm_shows_cashier_figures').
    name: 'confirmReasons.ts',
    copies: [
      'shared/confirmReasons.ts',
      'apps/desktop/src/shared/confirmReasons.ts',
      'apps/desktop/src/main/confirmReasons.ts',
      'apps/dashboard/src/lib/confirmReasons.ts',
      'apps/server/src/lib/confirmReasons.ts',
    ],
  },
  {
    // 0.6.28: what is on a kitchen ticket (sentQty), kitchen void reasons and their Z-report sums.
    name: 'kitchenLines.ts',
    copies: [
      'shared/kitchenLines.ts',
      'apps/desktop/src/shared/kitchenLines.ts',
      'apps/desktop/src/main/kitchenLines.ts',
      'apps/dashboard/src/lib/kitchenLines.ts',
      'apps/server/src/lib/kitchenLines.ts',
    ],
  },
  {
    // 0.6.27: how an expense was paid (only cash leaves the drawer) and its Z-report line (the type first).
    name: 'expenseMethod.ts',
    copies: [
      'shared/expenseMethod.ts',
      'apps/desktop/src/shared/expenseMethod.ts',
      'apps/desktop/src/main/expenseMethod.ts',  // the Z-report and expected per method (rootDir is src/main)
      'apps/dashboard/src/lib/expenseMethod.ts',
      'apps/server/src/lib/expenseMethod.ts',    // the cloud's expected cash / per method
    ],
  },
  {
    // 0.6.27: History filtered and ordered by payment method or order type.
    name: 'historyView.ts',
    copies: [
      'shared/historyView.ts',
      'apps/desktop/src/shared/historyView.ts',
      'apps/dashboard/src/lib/historyView.ts',
    ],
  },
  {
    // 0.6.27: the rider and the delivery fee (pass-through, paid to the rider in cash), and "Delivery — Eugene".
    name: 'delivery.ts',
    copies: [
      'shared/delivery.ts',
      'apps/desktop/src/shared/delivery.ts',
      'apps/desktop/src/main/delivery.ts',      // the main process records the rider's pay-out
      'apps/dashboard/src/lib/delivery.ts',
      'apps/server/src/lib/delivery.ts',        // the cloud stores the fee and pays the rider for a web sale
    ],
  },
  {
    // 0.6.27: per-client POS switches, set in the admin portal, carried to the till and the web with pos/init.
    name: 'posFeatures.ts',
    copies: [
      'shared/posFeatures.ts',
      'apps/desktop/src/shared/posFeatures.ts',
      'apps/desktop/src/main/posFeatures.ts',   // the main process reads the stored switches (rootDir is src/main)
      'apps/dashboard/src/lib/posFeatures.ts',
      'apps/server/src/lib/posFeatures.ts',     // the cloud sends them with pos/init
      'apps/admin/src/lib/posFeatures.ts',      // the admin portal lists and switches them
    ],
  },
  {
    // A365: the shift-confirmation rules the till and the web POS share (methods to declare, amounts, labels, paper).
    name: 'shiftConfirm.ts',
    copies: [
      'shared/shiftConfirm.ts',
      'apps/desktop/src/shared/shiftConfirm.ts',
      'apps/dashboard/src/lib/shiftConfirm.ts',
    ],
  },
  {
    // A324 (client branding Phase 2, slice 1): the curated action themes + the brand-colour rule. One registry
    // for the till, the web and the cloud (which validates theme ids on write — A325).
    name: 'themes.ts',
    copies: [
      'shared/themes.ts',
      'apps/desktop/src/shared/themes.ts',
      'apps/dashboard/src/lib/themes.ts',
      'apps/server/src/lib/themes.ts',     // A325: the cloud validates theme ids on write
    ],
  },
  {
    // A295 accent guard. shared/ is the source of truth; the renderer imports the
    // desktop/src/shared copy; the desktop/src/main copy exists ONLY so tsconfig.main
    // emits dist/main/contrast.js for contrast.test.mjs (the renderer is noEmit).
    // A319: the web Branding page judges a custom accent with THIS rule (it had its own copy, which
    // required WHITE button text and measured a different surface — it rejected #F5B800, which the
    // till accepts with black text). Vendored, not imported: Vercel builds apps/dashboard alone.
    name: 'contrast.ts',
    copies: [
      'shared/contrast.ts',
      'apps/desktop/src/shared/contrast.ts',
      'apps/desktop/src/main/contrast.ts',
      'apps/dashboard/src/lib/contrast.ts',
    ],
  },
];

const sha = (p) =>
  crypto.createHash('sha256')
    // Normalise line endings only. The repo has mixed CRLF/LF from Windows
    // editing, and a check that fails on that alone would be turned off within
    // a week — which is worse than not having it.
    .update(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'))
    .digest('hex');

let problems = 0;
let checked = 0;

for (const { name, copies } of SHARED) {
  const present = copies.filter((c) => fs.existsSync(path.join(ROOT, c)));
  const missing = copies.filter((c) => !fs.existsSync(path.join(ROOT, c)));

  if (missing.length) {
    console.error(`\nFAIL ${name}: ${missing.length} copy/copies missing:`);
    for (const m of missing) console.error(`  ${m}`);
    problems++;
    continue;
  }

  const hashes = new Map();
  for (const c of present) {
    const h = sha(path.join(ROOT, c));
    if (!hashes.has(h)) hashes.set(h, []);
    hashes.get(h).push(c);
  }
  checked += present.length;

  if (hashes.size === 1) {
    console.log(`  ok   ${name.padEnd(24)} ${present.length} copies identical`);
  } else {
    console.error(`\nFAIL ${name}: ${hashes.size} different versions in the tree:`);
    for (const [h, files] of hashes) {
      console.error(`  ${h.slice(0, 12)}  ${files.join(', ')}`);
    }
    console.error(`\nCopy one over the others verbatim and re-run the vectors:`);
    console.error(`  npx tsx scripts/test-parking-tariff.mjs`);
    problems++;
  }
}

// The check's own failure mode is finding nothing and declaring success.
if (checked === 0) {
  console.error('\nrefusing to pass: no shared files were found at all. Check the paths in SHARED.');
  process.exit(2);
}

if (problems) {
  console.error(`\n${problems} shared file(s) out of sync.\n`);
  process.exit(1);
}

console.log(`\nOK — ${checked} shared file copies all agree.`);
