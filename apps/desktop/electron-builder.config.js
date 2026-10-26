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
const path = require('node:path');
const { pathToFileURL } = require('node:url');
// A590: ctx.arch is electron-builder's Arch enum number (builder-util: ia32 = 0, x64 = 1, armv7l = 2, arm64 = 3,
// universal = 4). Mapped here, not required from electron-builder, so this file still loads where it is not installed.
const Arch = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];

const dev = String(process.env.SWIFTPOS_ENV || 'prod').toLowerCase() === 'dev';

// 0.6.36 (A386): the product is ZapTill — the installer, the Start-menu and Apps entry, and the data folder
// (%APPDATA%\\ZapTill; the till moves %APPDATA%\\SwiftPOS across on first start — src/main/userDataMove.ts). The appId stays
// com.swiftpos.desktop on purpose: it is how Windows and the updater know this is the SAME app, so it updates in place.
const name = dev ? 'ZapTill Dev' : 'ZapTill';

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
  // A590 (P0): the 32-bit app of every combined installer (0.6.32 … 1.0.20) shipped NO SQLite driver for its arch —
  // better-sqlite3 13 has no win32-ia32 prebuild, and its binding.gyp builds nothing when the HOST (x64) has a prebuild,
  // so electron-builder's per-arch @electron/rebuild "finished" for ia32 in 2 s having compiled nothing (and wiped
  // build/). better-sqlite3 is Node-API (one binary serves every Electron), so:
  //   - npmRebuild: false — electron-builder no longer runs node-gyp per arch (it could only wipe the ia32 driver);
  //   - beforePack: x64 → the shipped prebuilds/win32-x64.node is checked; ia32 → build/Release/better_sqlite3.node is
  //     compiled from source (force_build=1, Electron headers) when missing or stale — scripts/native-driver.mjs;
  //   - afterPack: that arch's own packaged exe must load better-sqlite3 and open ':memory:' — scripts/native-gate.mjs
  //     (the release workflow runs the same gate again on both unpacked apps and the installer before it uploads).
  // The loader takes prebuilds/win32-x64.node on 64-bit and build/Release/better_sqlite3.node on 32-bit, so both apps
  // carry both files; each loads only its own.
  npmRebuild: false,
  beforePack: async (ctx) => {
    if (ctx.electronPlatformName !== 'win32') return;
    const arch = Arch[ctx.arch];
    const { ensureDriver } = await import(pathToFileURL(path.join(__dirname, 'scripts', 'native-driver.mjs')).href);
    ensureDriver(arch);
  },
  afterPack: async (ctx) => {
    if (ctx.electronPlatformName !== 'win32' || process.platform !== 'win32') return;
    const arch = Arch[ctx.arch];
    const { gateDir } = await import(pathToFileURL(path.join(__dirname, 'scripts', 'native-gate.mjs')).href);
    const g = gateDir(ctx.appOutDir, arch);
    for (const l of g.lines) console.log(`  • A590 gate ${l}`);
    if (!g.ok) throw new Error(`A590: the ${arch} app cannot load its SQLite driver — not packaging it (${g.lines.join('; ')})`);
  },
  compression: 'normal',
  // D3: auto-update feed. Only the PROD flavour publishes/consumes a feed — dev
  // builds are hand-installed for trade-tests and never auto-update (autoUpdate.ts
  // also skips the dev flavour by name), so a dev till can't pull a prod release
  // or vice versa. GitHub Releases hosts the installer + .blockmap + latest.yml
  // the updater polls. Unsigned for now: the loop works; Windows SmartScreen shows
  // on first install until a signing cert is added (CSC_LINK/CSC_KEY_PASSWORD env
  // at build time — a config flip, not a code change). See docs/DESKTOP-AUTOUPDATE.md.
  // A348 (0.6.16): every build is published as a PRE-RELEASE. Tills on 0.6.16+ never poll GitHub — they update only to
  // the version the cloud approved for their business (/api/desktop-update); tills on 0.6.15 and older follow GitHub's
  // latest NON-pre-release, so a pre-release reaches none of them. The cloud reads pre-releases with no token (public
  // repo) or a read-only one (private). To send a version to EVERY old till, untick "pre-release" on GitHub (done once,
  // for 0.6.16, so old tills pick up the approval check).
  publish: dev ? null : [{ provider: 'github', owner: 'oweyahillary', repo: 'swiftpos', releaseType: 'prerelease' }],
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
    // A590: build/ keeps only Release/better_sqlite3.node (scripts/native-driver.mjs tidies it); never its stamp.
    '!node_modules/better-sqlite3/build/Release/zaptill-native.json',
  ],
  // A509: the updater task's script, shipped as resources\updater\zaptill-update.ps1 (a reference copy a technician can
  // read). The task never runs this copy: build/installer.nsh writes the script straight from the installer's own
  // payload into "%ProgramFiles%\ZapTill Updater" (administrators only) — the install folder can be chosen, and may not
  // be locked down.
  extraResources: [{ from: 'updater', to: 'updater', filter: ['zaptill-update.ps1'] }],
  linux: { target: ['AppImage', 'deb'] },
  win: {
    // A288: NSIS only. The portable target published a second, updater-invisible
    // release per tag (no latest.yml/blockmap) and can't run installer.nsh or
    // self-update — not something a till would deploy. Build portable locally
    // on demand if ever needed; don't publish it.
    // 0.6.32 (owner, 2026-10-02: a client's till is Windows 10 32-bit, 4 GB): ONE installer for 64-bit AND 32-bit
    // Windows — it installs the build that fits the machine. The auto-updater follows it (latest.yml names this file),
    // so a 32-bit till keeps updating to 32-bit. Electron publishes win32-ia32; the 32-bit SQLite driver is compiled
    // from source (A590, see beforePack).
    // About twice the download of a 64-bit-only installer. Windows 7/8 are not supported by this Electron at all.
    target: [{ target: 'nsis', arch: ['x64', 'ia32'] }],
    icon: dev ? 'resources/icon.dev.ico' : 'resources/icon.ico',
    artifactName: '${productName}-${version}-${arch}.${ext}',
  },
  mac: { target: ['dmg'] },
  nsis: {
    // 0.6.32: the combined installer's name, fixed — "SwiftPOS-0.6.32.exe" (no arch: it carries both). The release
    // workflow checks for exactly this name; the cloud's update feed serves any .exe of the approved release.
    artifactName: '${productName}-${version}.${ext}',
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
