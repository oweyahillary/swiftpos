const base = require('@swiftpos/config/tailwind.base');
/** @type {import('tailwindcss').Config} */
module.exports = {
  ...base,
  content: ['./index.html', './src/**/*.{ts,tsx}'],
};
