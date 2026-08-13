# Desktop auto-update (register D3)

**Status: SCAFFOLD.** The code (`apps/desktop/src/main/autoUpdate.ts`) is written
and correct against the electron-updater API, but it is **not wired, not built,
and not verified** — none of that is possible on the Linux bench, and the pieces
below are release-engineering decisions only the owner can make. Follow this to
finish and prove it.

Today every release is a hand-installed `.exe` per till. That is the root of A1
(no release pipeline) and the tax on every desktop fix — a till is always a
version or two behind, and a schema bump reaches the fleet only when someone
walks to each machine.

---

## 1. Add the dependency

```bash
cd apps/desktop
npm i electron-updater
```

`electron-updater` pulls in `electron-log` transitively; the scaffold does not
use it (it logs to console) so nothing else is needed.

## 2. Wire it into main

In `apps/desktop/src/main/index.ts`, import the module and call it once the app
is ready. Add the import near the other main imports:

```ts
import { initAutoUpdate } from './autoUpdate';
```

and call it inside the existing `app.whenReady().then(() => { ... })` block,
after `createWindow()` (around line 213):

```ts
  createWindow();

  // D3: check the release feed on launch and every 6h; install on next quit.
  // No-op in dev (app.isPackaged guard) so `npm run dev` is unaffected.
  try { initAutoUpdate(); } catch (e) { console.error('[startup] autoUpdate init failed:', e); }
```

After this, `cd apps/desktop && npx tsc -p tsconfig.main.json --noEmit` should be
clean for these files (it will still show the pre-existing `@swiftpos/printing`
resolution errors unrelated to D3).

## 3. Configure the publish target (electron-builder)

`electron-updater` reads a feed the build publishes. Add a `publish` block under
`build` in `apps/desktop/package.json`. Two common choices:

**GitHub Releases** (simplest if the repo host is GitHub):
```jsonc
"build": {
  "appId": "co.ke.swiftpos.till",
  "publish": [{ "provider": "github", "owner": "<org>", "repo": "swiftpos" }]
  // ...existing win/nsis config...
}
```

**Generic feed** (any HTTPS server you control — an S3 bucket, a VPS):
```jsonc
"publish": [{ "provider": "generic", "url": "https://updates.swiftpos.co.ke/till/" }]
```

The build uploads three things the updater needs: the installer `.exe`, its
`.blockmap` (for delta downloads), and `latest.yml` (the version manifest the
client polls). Whatever host you pick must serve all three.

## 4. Code signing (Windows) — required in practice

Unsigned auto-updates trip Windows SmartScreen and some AV, and a till running
unattended cannot click through a warning. You need an EV or OV code-signing
certificate. electron-builder reads it from the environment at build time:

```bash
export CSC_LINK=/path/to/cert.pfx          # or a base64 data: URL
export CSC_KEY_PASSWORD='...'
```

Without a certificate the mechanism still works in testing, but do not ship it to
real tills unsigned.

## 5. Release a version

```bash
cd apps/desktop
# bump the version in package.json (auto-update compares versions)
npm version patch            # 0.5.28 -> 0.5.29, or edit by hand
# build AND publish to the feed (needs GH_TOKEN for github, or bucket creds)
GH_TOKEN=... npx electron-builder --win --publish always
```

Wire this into CI later so releases are not hand-built from a working folder
(that is A1). A minimal GitHub Actions job: checkout, `npm ci` in `apps/desktop`,
`electron-builder --win --publish always` with the signing + token secrets.

## 6. Prove it end to end

1. Build and install **v0.5.29** on a Windows test machine from the published
   installer (not a local build — it must carry the feed metadata).
2. Bump to **v0.5.30**, build, `--publish always`.
3. Launch the installed v0.5.29. Within a few seconds the log shows
   `update-available` then `update-downloaded`. Quit the app; it installs. Relaunch
   → v0.5.30. That is the whole loop working.

## 7. How this interacts with the rest

- **Schema versions.** `LOCAL_SCHEMA_VERSION` and `REQUIRED_DESKTOP_SCHEMA` are how
  the server rejects a too-old till. Auto-update makes the fleet converge on its
  own, so a schema bump (like A66's 51→52) stops meaning a site visit. Until D3
  ships, a bump still requires hand-reinstalls.
- **Offline-first.** A till only updates when it can reach the feed. That is
  correct: an offline till keeps selling on its current version and updates the
  next time it is online, on the next quit — never mid-service.
- **Rollback.** Keep the previous `latest.yml`/installer on the feed so you can
  re-publish a known-good version if a release regresses. electron-updater will
  not downgrade automatically, so a bad release is pulled by publishing a higher
  version with the fix.

---

## What is done vs outstanding

- **Done:** `apps/desktop/src/main/autoUpdate.ts` — the updater wiring, dev-guarded,
  silent, non-blocking.
- **Outstanding (you):** add the dependency; wire the one call in `index.ts`;
  choose and configure a publish target; obtain a signing certificate; cut the
  first published release; run the §6 end-to-end check; wire the release into CI
  to finally close A1.
