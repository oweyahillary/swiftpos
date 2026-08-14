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
const shortName = dev ? 'SwiftPOS-Dev' : 'SwiftPOS';

module.exports = {
  appId: dev ? 'com.swiftpos.desktop.dev' : 'com.swiftpos.desktop',
  productName: name,
  directories: { output: 'release' },
  compression: 'normal',
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
    target: ['nsis', 'portable'],
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
    include: 'build/installer.nsh',
    allowElevation: true,
  },
  portable: { artifactName: shortName + '-${version}-portable.exe' },
  electronLanguages: ['en-US'],
};
