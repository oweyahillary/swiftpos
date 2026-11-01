/**
 * business-settings-menu-a620.test.mjs — A620 (owner, 2026-11-01, Settings › Business: "the top nav is cluttered";
 * "under payment method this is confusing … adding mpesa integration there makes no sense, under integration we can add a
 * menu left side like the normal navigation where there is a section for webhooks, mpesa, kra … emails we can add it in
 * reports"; "keep off kitchen receipt and Quick notes for orders … should be under printers").
 *
 *   node tests/business-settings-menu-a620.test.mjs
 *
 * Pins the new arrangement in the source: the grouped left menu, Integrations' three pages and the old links' redirects,
 * the Payments page's three sections without the M-Pesa details, the report e-mails on Reports, the kitchen ticket on
 * Printers. Users and access / Devices and printers keep their top tabs.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (n, f) => { try { f(); pass++; console.log(`  ok   ${n}`); } catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); } };
const D = 'apps/dashboard/src/';

console.log('\nA620 — Settings › Business: a grouped left menu; Integrations; Payments; report e-mails; kitchen ticket\n');

ok('the section shell: groups → a left menu (md up) and a dropdown on a phone; tabs alone → the top tabs as before', () => {
  const s = read(D + 'pages/settings/SettingsSection.tsx');
  assert.match(s, /if \(groups\?\.length\) return <GroupedSection/);
  assert.match(s, /className="hidden md:block w-56 flex-shrink-0 border-r border-gray-800/);
  assert.match(s, /<select aria-label="Settings page"[\s\S]*className="md:hidden/);
  assert.match(s, /<optgroup key=\{g\.title\} label=\{g\.title\}>/);
  assert.doesNotMatch(read(D + 'pages/settings/UsersAccessPage.tsx'), /groups=/);
  assert.doesNotMatch(read(D + 'pages/settings/DevicesPrintersPage.tsx'), /groups=/);
});
ok('Business: four groups — Your business, Selling, Setup, Integrations (M-Pesa the owner\'s, KRA eTIMS, Webhooks)', () => {
  const b = read(D + 'pages/settings/BusinessPage.tsx');
  for (const t of ['Your business', 'Selling', 'Setup', 'Integrations']) assert.match(b, new RegExp(`title: '${t}'`));
  assert.match(b, /\.\.\.\(isOwner \? \[\{ to: 'integrations\/mpesa', label: 'M-Pesa \(STK push\)' \}\] : \[\]\)/);
  assert.match(b, /\{ to: 'integrations\/kra', label: 'KRA eTIMS' \}/);
  assert.match(b, /\.\.\.\(webhooks \? \[\{ to: 'integrations\/webhooks', label: 'Webhooks' \}\] : \[\]\)/);
  assert.match(b, /<SettingsSection title="Business" tabs=\{groups\.flatMap\(\(g\) => g\.tabs\)\} groups=\{groups\} \/>/);
  assert.doesNotMatch(b, /ReportSchedulerTab/, 'the report e-mails are on Reports now');
  assert.doesNotMatch(b, /'Tax & compliance'/);
});
ok('routes: Integrations\' pages; the old Tax & compliance, Integrations and eTIMS links land on the new pages', () => {
  const a = read(D + 'App.tsx');
  assert.match(a, /<Route path="integrations"          element=\{<IntegrationsIndexRoute \/>\} \/>/);
  assert.match(a, /<Route path="integrations\/mpesa"    element=\{<MpesaRoute \/>\} \/>/);
  assert.match(a, /<Route path="integrations\/kra"      element=\{<EtimsSettingsPage \/>\} \/>/);
  assert.match(a, /<Route path="integrations\/webhooks" element=\{<WebhooksRoute \/>\} \/>/);
  assert.match(a, /<Route path="tax"          element=\{<Navigate to="\/dashboard\/settings\/business\/integrations\/kra" replace \/>\} \/>/);
  assert.match(a, /<Route path="settings\/etims"      element=\{<Navigate to="\/dashboard\/settings\/business\/integrations\/kra" replace \/>\} \/>/);
  const b = read(D + 'pages/settings/BusinessPage.tsx');
  assert.match(b, /return <Navigate to=\{isOwner \? 'mpesa' : 'kra'\} replace \/>;/);
  assert.match(b, /if \(!isOwner\) return <p className="p-6 text-sm text-gray-500">Only the owner manages the M-Pesa details\.<\/p>;/);
});
ok('Payments: 1 Ways to pay, 2 Your own payment methods, 3 Delivery platforms — the M-Pesa details gone from it', () => {
  const p = read(D + 'pages/PaymentMethodsPage.tsx');
  const i1 = p.indexOf('title="Ways to pay"'), i2 = p.indexOf('title="Your own payment methods"'), i3 = p.indexOf('title="Delivery platforms"');
  assert.ok(i1 > 0 && i1 < i2 && i2 < i3, `order: ${i1} ${i2} ${i3}`);
  assert.doesNotMatch(p, /MpesaStkSettings/);
  assert.match(p.slice(i3), /<BusinessPlatformPrices \/>/);
});
ok('report e-mails: an "Email schedule" button on Reports for the owner and partners (as the cloud allows)', () => {
  const r = read(D + 'pages/ReportsPage.tsx');
  assert.match(r, /const mayEmails = isOwner \|\| isPartner \|\| can\('settings\.report_emails'\);/);
  assert.match(r, /\{mayEmails && emailsOpen && \([\s\S]{0,200}<ReportSchedulerTab \/>/);
});
ok('the kitchen ticket (kept off it, quick notes) on Printers for a business with tables — gone from Restaurant setup', () => {
  const k = read(D + 'pages/settings/KitchenTicketSettings.tsx');
  assert.match(k, /Keep off the kitchen ticket/);
  assert.match(k, /saveSetting\('kitchen_exclusions', JSON\.stringify\(list\)\)/);
  const pr = read(D + 'pages/settings/PrintersPage.tsx');
  assert.match(pr, /const kitchenTicket = foodAreas\(useBusiness\(\)\.business\?\.type\)\.tables;/);
  assert.match(pr, /\{kitchenTicket && \([\s\S]{0,200}<KitchenTicketSettings \/>/);
  const rs = read(D + 'pages/settings/RestaurantSettingsPage.tsx');
  assert.doesNotMatch(rs, /Keep off the kitchen ticket<\/h2>/);
  assert.match(rs, /href="\/dashboard\/settings\/devices\/printers"/);
});
ok('the M-Pesa "not set up" messages point at the new place (web POS, desktop POS, the cloud)', () => {
  for (const f of [D + 'pages/pos/MpesaStkPanel.tsx', 'apps/desktop/src/main/mpesaStk.ts', 'apps/server/src/routes/mpesa.ts']) {
    assert.match(read(f), /Settings › Business › Integrations › M-Pesa/, f);
    assert.doesNotMatch(read(f), /Settings › Payments › M-Pesa/, f);
  }
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
