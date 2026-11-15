# A622: install first at every start, every log in a support bundle, a menu on the Tech page

Owner, 2026-11-04. TJS T1, a branch server, sat on 1.0.20 for a week. The pulled 7-day log showed why it never caught up:

- **28 Oct 10:11:** "Restart for the update". The updater task checked 1.0.21, ZapTill closed, and 20 seconds later it was back on 1.0.20.
- **28 Oct 21:00:** the idle install. Same result after 22 seconds. After that ZapTill stopped trying (once per version).
- **Every day after:** staff opened ZapTill by hand each morning. A branch server opened by hand never installed (A541's rule). During trading it was never idle for 90 minutes, and the PC was switched off at night.

The owner asked for two things:

- "on start up whether is a server or a till it should always install downloaded updates they should happen as the first thing on startup"
- "how can we get all logs the app generates not just running logs"

## 1. Install first at every start

- **Every start installs a waiting update first,** before the branch server serves and before the PIN screen. This covers a branch server opened by hand, a POS opened by hand, a start at Windows sign-in, and the restart task.
- **No more "once per version".** The guard against a loop is the start right after an install. The relaunch task, and ZapTill's own fallback when an install never starts, launch it with `--updated`, and that start never installs. A failing installer therefore costs one try per start, and the next start tries again.
- **When nobody may be there, there is never a Windows prompt.** This applies to the restart task after a crash and to a POS's quiet sign-in launch. Those install through the ZapTill Updater task only.
- **A POS's quiet sign-in launch is unchanged: once per version** (the gate's `signinTried`). Opening the POS by hand covers it.

## 2. Why an install did not take

The updater task writes its answer to `%ProgramFiles%\ZapTill Updater\updater-status.json`, for example `failed: installer exit 2`.

- **At every start ZapTill reads that answer.** If it concerns a version newer than the one running, the install did not take.
- **The first start that sees it writes it to `swiftpos.log`,** together with the updater log's last 8 lines.
- **Every update report carries it as `install_error`.** The cloud keeps it (`updateState.ts`).
- **The admin portal shows it** on the Desktop updates line: "Downloaded 1.0.23 — the install failed (installer exit 2); it tries again each time ZapTill starts".

The hourly check no longer says "approved 1.0.21, this machine runs 1.0.21" when 1.0.21 is only downloaded. It now says "1.0.21 is downloaded and waiting to install".

## 3. Every log in a support bundle

A pull from the admin portal and the Tech page's Send / Save now carry these sections (`machineLogs.ts`):

| Section | What it holds |
|---|---|
| `swiftpos.log` | as before |
| `auth.log` | the sign-in history; now ticked by default in the admin portal's Pull logs |
| `updater.log` | the ZapTill Updater task's own log in the window: what it checked, what it installed, the installer's exit code |
| `updater-status.json` | the updater's last answer |
| Windows Application events | errors and warnings naming ZapTill in the window (a crash, a hang, the installer), at most 40 |

The same redaction and size cap apply to every section. A part that cannot be read says so in one line.

## 4. The Tech page's menu

The owner asked: "the tech screen is too long for scrolling can we add a menu to it for each section".

- A menu at the top stays in view, and one section shows at a time.
- The sections are: Device (with the customer screen), Sync, Logs & diagnostics, Branch & joining (with Rejoin), Updates, Backups & history, Database, Branding, Reset.
- The last section picked is kept on that POS.

## Tests

- `apps/desktop/test/a622-install-first.test.mjs` (29)
- `tests/a622-install-error.test.mjs` (4)
- A541's and A546's tests were updated to the new rule.
