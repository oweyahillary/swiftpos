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
      // A470 (owner: "look and feel, response animations, speed"): short, quiet motion so every tap answers and things
      // arrive instead of popping. 100–180 ms — a cashier never waits on an animation. They move with the INDIVIDUAL
      // `translate` / `scale` properties, not `transform`, so they add to an element's own Tailwind transform (the toasts'
      // -translate-x-1/2 centring) instead of replacing it mid-animation. prefers-reduced-motion turns every one of
      // them off (src/renderer/index.css).
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'pop-in': { from: { opacity: '0', scale: '.96' }, to: { opacity: '1', scale: '1' } },
        'slide-up': { from: { opacity: '0', translate: '0 8px' }, to: { opacity: '1', translate: '0 0' } },
        'slide-in-right': { from: { opacity: '0', translate: '16px 0' }, to: { opacity: '1', translate: '0 0' } },
        bump: { '0%': { scale: '1' }, '40%': { scale: '1.25' }, '100%': { scale: '1' } },
        'line-in': {
          from: { opacity: '0', translate: '0 -4px', 'background-color': 'rgb(var(--action-500) / .18)' },
          '40%': { opacity: '1', translate: '0 0' },
          to: { 'background-color': 'rgb(var(--action-500) / 0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 120ms ease-out',
        'pop-in': 'pop-in 160ms cubic-bezier(.2,.9,.3,1.2)',
        'slide-up': 'slide-up 160ms ease-out',
        'slide-in-right': 'slide-in-right 180ms ease-out',
        bump: 'bump 180ms ease-out',
        'line-in': 'line-in 900ms ease-out',
      },
    },
  },
  plugins: [
    // A470: `press` — a button that dips a touch when pressed (active:scale-[.97]), on the individual `scale` property so
    // it never fights a transform class. Off under prefers-reduced-motion.
    function ({ addUtilities }) {
      addUtilities({
        '.press': { transition: 'scale 100ms ease-out' },
        '.press:not(:disabled):active': { scale: '.97' },
        '@media (prefers-reduced-motion: reduce)': {
          '.press': { transition: 'none' },
          '.press:not(:disabled):active': { scale: 'none' },
        },
      });
    },
  ],
};
