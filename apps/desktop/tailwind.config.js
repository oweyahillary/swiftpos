/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // A326 (client branding Phase 2, slice 3): two themeable scales, driven by CSS variables set by
      // src/renderer/lib/themeVars.ts. Their DEFAULTS (src/renderer/index.css) are Tailwind's own green values,
      // so a till whose business has themes OFF renders exactly as before. Status (paid/success/online), money
      // and the SwiftPOS wordmark keep plain `green-*` — see docs/A326-till-green-classification.md.
      //   action  — buttons, selected states, links, focus rings  → the curated ACTION theme
      //   brand   — the in-app lock curtain                       → the business's own BRAND colour
      //   on-brand — text on a brand fill (black or white, whichever reads)
      // (The old `brand` green scale here was never used — 0 uses — and is replaced.)
      colors: {
        action: {
          300: 'rgb(var(--action-300) / <alpha-value>)', 400: 'rgb(var(--action-400) / <alpha-value>)',
          500: 'rgb(var(--action-500) / <alpha-value>)', 600: 'rgb(var(--action-600) / <alpha-value>)',
          700: 'rgb(var(--action-700) / <alpha-value>)', 900: 'rgb(var(--action-900) / <alpha-value>)',
        },
        brand: {
          400: 'rgb(var(--brand-400) / <alpha-value>)', 500: 'rgb(var(--brand-500) / <alpha-value>)',
          600: 'rgb(var(--brand-600) / <alpha-value>)', 700: 'rgb(var(--brand-700) / <alpha-value>)',
        },
        'on-brand': 'rgb(var(--on-brand) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
