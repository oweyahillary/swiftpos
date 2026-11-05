// The dashboard's Tailwind theme, unchanged (one POS design) — only where to look for classes differs: the web POS screens
// and the shared pieces the Shop POS bundles (Till stage 1, docs/ANDROID-APP-DESIGN.md §11).
const path = require('path');
const dashboard = require('../dashboard/tailwind.config.js');

module.exports = {
  ...dashboard,
  content: [
    path.join(__dirname, '../dashboard/src/**/*.{ts,tsx}'),
    path.join(__dirname, '../../packages/ui/src/**/*.{ts,tsx}'),
    path.join(__dirname, 'src/**/*.{ts,tsx}'),
  ],
};
