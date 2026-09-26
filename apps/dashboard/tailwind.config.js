/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // A328 (client branding Phase 2, slice 4b-1): the web POS + shared components' ACTION colour, driven by CSS
        // variables (src/index.css) that DEFAULT to Tailwind's exact greens — a business with themes OFF looks as before.
        // Status, money and the back-office pages keep plain green (docs/A328-web-pos-green-classification.md).
        action: {
          400: 'rgb(var(--action-400) / <alpha-value>)',
          500: 'rgb(var(--action-500) / <alpha-value>)',
          600: 'rgb(var(--action-600) / <alpha-value>)',
        },
        // A329 step 3: the BACK OFFICE's own colour — a FIXED SwiftPOS teal, never the client's theme (A323 4b-2). Values
        // live in src/index.css (one place). Fills never change with the mode; only the text shades do (400 on dark,
        // 700 on white). Pick by job: `swift` fill + dark label · `swift-strong` fill + white label/knob/tick ·
        // `swift-light` / `swift-deep` their hovers · `swift-text` / `swift-text-hover` text and links · `swift-logo` the
        // wordmark. docs/A329-back-office-colour-classification.md.
        swift: {
          DEFAULT:      'rgb(var(--swift) / <alpha-value>)',
          light:        'rgb(var(--swift-light) / <alpha-value>)',
          strong:       'rgb(var(--swift-strong) / <alpha-value>)',
          deep:         'rgb(var(--swift-deep) / <alpha-value>)',
          logo:         'rgb(var(--swift-logo) / <alpha-value>)',
          text:         'rgb(var(--swift-text) / <alpha-value>)',
          'text-hover': 'rgb(var(--swift-text-hover) / <alpha-value>)',
        },
        brand: {
          50:  '#f0fdf4', 100: '#dcfce7', 200: '#bbf7d0',
          300: '#86efac', 400: '#4ade80', 500: '#22c55e',
          600: '#16a34a', 700: '#15803d', 800: '#166534', 900: '#14532d',
        },
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
