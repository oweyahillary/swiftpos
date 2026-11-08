// The web POS screens' styles (Tailwind, the dashboard's own theme) — Till stage 1, docs/ANDROID-APP-DESIGN.md §11.
module.exports = { plugins: { tailwindcss: { config: require('path').join(__dirname, 'tailwind.config.cjs') }, autoprefixer: {} } };
