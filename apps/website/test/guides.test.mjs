// The guides (night 3): every entry in src/lib/guides.ts has its page and the other way round, the metadata fits search
// results, the wording follows the standing rules (no "till" except M-Pesa's "Till number", no hype), and the worked
// price example adds up from the draft prices in site.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUIDES, DRAFT_GUIDE_PATHS, guideHref, zaptillCost } from '../src/lib/guides.ts';
import { PRICES } from '../src/lib/site.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages', 'guides');
const pages = readdirSync(DIR).filter((f) => f.endsWith('.astro') && f !== 'index.astro').map((f) => f.replace(/\.astro$/, ''));

test('every guide has a page, and every page is listed', () => {
  assert.deepEqual([...GUIDES.map((g) => g.slug)].sort(), [...pages].sort());
  assert.equal(new Set(GUIDES.map((g) => g.slug)).size, GUIDES.length, 'slugs are unique');
});

test('each guide page uses its own slug', () => {
  for (const slug of pages) {
    const src = readFileSync(join(DIR, slug + '.astro'), 'utf8');
    assert.match(src, new RegExp(`<Guide slug="${slug}"`), slug);
  }
});

test('guide metadata fits search results', () => {
  for (const g of GUIDES) {
    assert.ok(g.metaTitle.length <= 65, `${g.slug}: title ${g.metaTitle.length} chars`);
    assert.ok(g.metaTitle.endsWith('| ZapTill'), `${g.slug}: title ends with the brand`);
    assert.ok(g.description.length >= 70 && g.description.length <= 165, `${g.slug}: description ${g.description.length} chars`);
    assert.ok(g.summary.length > 40, `${g.slug}: summary`);
    assert.match(g.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(['draft', 'ready'].includes(g.status));
    assert.ok(Number.isInteger(g.minutes) && g.minutes > 0);
    for (const r of g.related) assert.ok(r.href.startsWith('/'), `${g.slug}: related links are internal`);
  }
});

test('drafts are the paths kept out of the sitemap', () => {
  assert.deepEqual(DRAFT_GUIDE_PATHS, GUIDES.filter((g) => g.status === 'draft').map(guideHref));
});

// The text a reader sees: frontmatter, comments, tags and attribute values that are file paths left out.
const visible = (src) => src
  .replace(/^---[\s\S]*?---/, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/\s(?:src|href|class|slot|name)="[^"]*"/g, ' ')
  .replace(/<[^>]+>/g, ' ');

test('no guide says "till" (point of sale or POS), except M-Pesa\'s Till number', () => {
  const files = [...pages, 'index'].map((s) => join(DIR, s + '.astro'));
  const all = [...files.map((f) => [f, visible(readFileSync(f, 'utf8'))]), ['guides.ts', GUIDES.map((g) => `${g.title} ${g.metaTitle} ${g.description} ${g.summary} ${g.related.map((r) => r.label).join(' ')}`).join(' ')]];
  for (const [f, text] of all) {
    const hits = [...text.matchAll(/(?<![\w/.-])(till|tills|till's)(?![\w-])(?!\s+number)/gi)];
    assert.equal(hits.length, 0, `${f}: ${hits.map((h) => text.slice(Math.max(0, h.index - 30), h.index + 30)).join(' | ')}`);
  }
});

test('no hype or claims outside the claims check', () => {
  for (const slug of pages) {
    const text = visible(readFileSync(join(DIR, slug + '.astro'), 'utf8'));
    for (const bad of [/24\/7/, /guarantee/i, /best in kenya/i, /100%/, /zero leakage/i, /\bAI\b/, /eTIMS/i, /raise (your )?prices?/i]) {
      assert.doesNotMatch(text, bad, `${slug}: ${bad}`);
    }
  }
});

test('the worked price example adds up from the draft prices', () => {
  const one = zaptillCost({ branches: 1, years: 3 });
  assert.equal(one.setup, PRICES.setup);
  assert.equal(one.cloud, PRICES.monthly * (36 - PRICES.trialMonths));
  assert.equal(one.total, PRICES.setup + PRICES.monthly * 35);
  const two = zaptillCost({ branches: 2, years: 3 });
  assert.equal(two.setup, 2 * PRICES.setup, 'setup is per branch');
  assert.equal(two.cloud, one.cloud, 'the cloud is per business, not per branch');
  const withA = zaptillCost({ branches: 1, years: 3, analytics: true });
  assert.equal(withA.total - one.total, PRICES.analyticsMonthly * 36);
  assert.equal(one.perDay, Math.round(one.total / (3 * 365)));
});
