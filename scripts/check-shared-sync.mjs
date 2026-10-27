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
    // A588: the petrol POS's forecourt — grade colours, the fuel keypad (amount / litres), the gauges (tank or today's
    // litres), a pump's state. Pure, no imports.
    name: 'forecourt.ts',
    copies: [
      'shared/forecourt.ts',
      'apps/desktop/src/shared/forecourt.ts',   // the till's pumps screen (PumpsView, lazy)
      'apps/dashboard/src/lib/forecourt.ts',    // the web POS's pumps and fuel keypad
    ],
  },
  {
    // A571: barcodes — EAN-13 / UPC-A / Code 128 bars and the in-store codes the cloud assigns (prefix 20).
    name: 'barcode.ts',
    copies: [
      'shared/barcode.ts',
      'apps/server/src/lib/barcode.ts',         // POST /api/products/barcodes/generate
      'apps/dashboard/src/lib/barcode.ts',      // Products (Generate) and Print labels
      'apps/desktop/src/shared/barcode.ts',     // the till's Labels screen (preview)
      'apps/desktop/src/main/barcode.ts',       // the till's label printing
    ],
  },
  {
    // A577: items sold by weight — scale label barcodes (21–29, price or weight inside), the weighed line, its amount.
    name: 'scaleBarcode.ts',
    copies: [
      'shared/scaleBarcode.ts',
      'apps/server/src/lib/scaleBarcode.ts',        // the scale settings cleaned; a weighed line's amount checked
      'apps/dashboard/src/lib/scaleBarcode.ts',     // the web POS (CashierScreen, MinimartPOS) and the settings' test box
      'apps/desktop/src/shared/scaleBarcode.ts',    // the till's sale screen
      'apps/desktop/src/main/scaleBarcode.ts',      // the till's main process (the receipt's weighed lines)
    ],
  },
  {
    // A571: labels of any size for any printer — the layout, the HTML / SVG page, sheets, TSPL, ZPL, ESC/POS.
    name: 'labels.ts',
    copies: [
      'shared/labels.ts',
      'apps/server/src/lib/labels.ts',          // the label settings, cleaned before they are stored
      'apps/dashboard/src/lib/labels.ts',       // Print labels (browser driver, sticker sheets)
      'apps/desktop/src/shared/labels.ts',      // the till's Labels screen (preview)
      'apps/desktop/src/main/labels.ts',        // the till's label printing (driver, TSPL, ZPL, receipt printer)
    ],
  },
  {
    // A445: offers — the rules the till's cart, the web POS's cart and the cloud's check of a sale all run.
    name: 'offers.ts',
    copies: [
      'shared/offers.ts',
      'apps/server/src/lib/offers.ts',          // the cloud checks what a sale claims, and validates an offer on save
      'apps/desktop/src/shared/offers.ts',      // the till's cart and Manager › Offers
      'apps/desktop/src/main/offers.ts',        // the main process cleans what the pull stores
      'apps/dashboard/src/lib/offers.ts',       // the web POS's cart and the Offers page
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
  // confirmReasons.ts (0.6.27) moved to packages/core in shared-components step 1 — imported as
  // '@zaptill/core/confirmReasons', no copies (docs/SHARED-COMPONENTS-PLAN.md). The CORE check below keeps it that way.
  // Step 2 (batches A and B) moved 26 more the same way — every file in packages/core/src (the plan's "Step 2 progress").
  {
    // 0.6.28: the release number every surface shows ("v0.6.28 · <commit>") — moves with apps/desktop's version.
    name: 'release.ts',
    copies: [
      'shared/release.ts',
      'apps/dashboard/src/lib/release.ts',
      'apps/server/src/lib/release.ts',
      'apps/admin/src/lib/release.ts',
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
    // A490: the ONE permission catalogue — every fine key, the broad keys it replaces, expansion and the ceiling.
    name: 'permissions.ts',
    copies: [
      'shared/permissions.ts',
      'apps/server/src/lib/permissions.ts',     // the cloud checks fine keys, expands old grants, builds tokens
      'apps/dashboard/src/lib/permissions.ts',  // the web POS, manager portal and the Roles and permissions screen
      'apps/admin/src/lib/permissions.ts',      // the admin portal shows a client's roles read-only
      'apps/desktop/src/shared/permissions.ts', // the till's screens
      'apps/desktop/src/main/permissions.ts',   // the till's main process (rootDir is src/main)
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

// Shared-components (docs/SHARED-COMPONENTS-PLAN.md): a rule that moved to packages/core/src is imported from
// '@zaptill/core/<name>' and has NO copies. A copy growing back (an old branch merged, a file pasted for speed) would be
// a second implementation that nothing keeps in step — so a file of the same name in shared/ or an app's lib/, shared/
// or main/ folder fails, and so does a module that is still listed above.
const CORE_DIR = path.join(ROOT, 'packages', 'core', 'src');
const COPY_DIRS = [
  'shared',
  'apps/server/src/lib', 'apps/server/src/shared',
  'apps/dashboard/src/lib',
  'apps/admin/src/lib',
  'apps/desktop/src/main', 'apps/desktop/src/shared',
];
const coreModules = fs.existsSync(CORE_DIR) ? fs.readdirSync(CORE_DIR).filter((f) => f.endsWith('.ts')) : [];
for (const mod of coreModules) {
  const regrown = COPY_DIRS.map((d) => `${d}/${mod}`).filter((c) => fs.existsSync(path.join(ROOT, c)));
  const listed = SHARED.some((e) => e.name === mod);
  if (regrown.length || listed) {
    console.error(`\nFAIL ${mod} lives in packages/core/src — import it as '@zaptill/core/${mod.replace(/\.ts$/, '')}', do not copy it:`);
    for (const c of regrown) console.error(`  delete ${c}`);
    if (listed) console.error(`  remove its entry from SHARED in scripts/check-shared-sync.mjs`);
    problems++;
  } else {
    console.log(`  ok   ${mod.padEnd(24)} packages/core only (no copies)`);
  }
}

// …and only by its package name. A relative import ('../../../packages/core/src/x') type-checks and even builds, but the
// cloud's and the desktop main process's compiled code would then require a path outside the app: not shipped in the
// installer's app.asar, not present on Render. The bundlers would inline it, so the rule is the same everywhere.
const APP_SRC = ['apps/server/src', 'apps/dashboard/src', 'apps/admin/src', 'apps/desktop/src'];
const RELATIVE_CORE = /(?:from\s+|import\(\s*|require\(\s*)['"](?:\.\.?\/)+(?:[^'"]*\/)?packages\/core\b/;
const walkSrc = (d, out = []) => {
  if (!fs.existsSync(d)) return out;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walkSrc(p, out); else if (/\.(tsx?|mjs|cjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
};
for (const dir of APP_SRC) {
  for (const f of walkSrc(path.join(ROOT, dir))) {
    if (RELATIVE_CORE.test(fs.readFileSync(f, 'utf8'))) {
      console.error(`\nFAIL ${path.relative(ROOT, f)} imports packages/core by a relative path — use '@zaptill/core/<name>'.`);
      problems++;
    }
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
