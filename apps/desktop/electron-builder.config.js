/**
 * electron-builder.config.js — dev/prod desktop flavour in one place (D17).
 *
 * SWIFTPOS_ENV=dev  →  "SwiftPOS Dev" build: amber DEV icon, distinct appId,
 *                      its own %APPDATA% (so dev trading never touches prod's
 *                      swiftpos.db), and a dev-suffixed artifact name.
 * unset / anything else  →  prod (the safe default — a missing variable never
 *                      produces a prod-badged build by mistake, and never a
 *                      dev one either; you must ASK for dev).
 *
 * This replaces the static `build` block that lived in package.json. It is the
 * one source that decides icon + name + appId + artifactName together, so the
 * four can never disagree. Version is still owned by the build tooling
 * (`npm version` in release:patch) and is deliberately not set here (rule 22).
 */
const dev = String(process.env.SWIFTPOS_ENV || 'prod').toLowerCase() === 'dev';

const name = dev ? 'SwiftPOS Dev' : 'SwiftPOS';

module.exports = {
  appId: dev ? 'com.swiftpos.desktop.dev' : 'com.swiftpos.desktop',
  productName: name,
  // A284: productName above only names the INSTALLER/exe. At runtime Electron reads
  // app.getName() from the packaged app's package.json, whose static "productName":
  // "SwiftPOS" made BOTH flavours resolve userData to %APPDATA%\SwiftPOS — one shared
  // swiftpos.db/log/token/backups. extraMetadata injects the flavour name into that
  // bundled package.json, so app.getName() differs and the folders finally separate
  // (dev -> %APPDATA%\SwiftPOS Dev, prod -> %APPDATA%\SwiftPOS), making the promise
  // in this file's header true.
  extraMetadata: { productName: name },
  directories: { output: 'release' },
  compression: 'normal',
  // D3: auto-update feed. Only the PROD flavour publishes/consumes a feed — dev
  // builds are hand-installed for trade-tests and never auto-update (autoUpdate.ts
  // also skips the dev flavour by name), so a dev till can't pull a prod release
  // or vice versa. GitHub Releases hosts the installer + .blockmap + latest.yml
  // the updater polls. Unsigned for now: the loop works; Windows SmartScreen shows
  // on first install until a signing cert is added (CSC_LINK/CSC_KEY_PASSWORD env
  // at build time — a config flip, not a code change). See docs/DESKTOP-AUTOUPDATE.md.
  publish: dev ? null : [{ provider: 'github', owner: 'oweyahillary', repo: 'swiftpos' }],
  files: [
    'dist/**/*',
    'resources/**/*',
    '!**/*.map',
    '!**/*.ts',
    '!**/*.md',
    '!**/{test,__tests__,tests,powered-test,example,examples}/**',
    '!**/{.eslintrc,.prettierrc,.editorconfig,tsconfig.json,.npmignore}',
    '!node_modules/exceljs/dist/**',
    '!node_modules/better-sqlite3/{src,deps,build/Release/obj,build/Release/obj.target}/**',
    '!node_modules/better-sqlite3/build/**/*.{o,a,lib,exp,pdb,ilk}',
  ],
  linux: { target: ['AppImage', 'deb'] },
  win: {
    // A288: NSIS only. The portable target published a second, updater-invisible
    // release per tag (no latest.yml/blockmap) and can't run installer.nsh or
    // self-update — not something a till would deploy. Build portable locally
    // on demand if ever needed; don't publish it.
    target: ['nsis'],
    icon: dev ? 'resources/icon.dev.ico' : 'resources/icon.ico',
    artifactName: '${productName}-${version}-${arch}.${ext}',
  },
  mac: { target: ['dmg'] },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: name,
    // A283: custom NSIS include lives at build/installer.nsh (committed via git add -f
    // past the build/ ignore). It adds the branch-node firewall rule (TCP 4100-4103,
    // private) at install time. Must stay in step with the committed file — if the
    // file is absent from a clean checkout the NSIS build fails (see A282/the first
    // D3 release). Load-bearing for multi-till; harmless on a single till.
    include: 'build/installer.nsh',
    allowElevation: true,
  },
  electronLanguages: ['en-US'],
};
