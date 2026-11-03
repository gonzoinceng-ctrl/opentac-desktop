# OpenTac end-to-end tests

Playwright `_electron` smoke tests that launch the real unpackaged app (`electron .`) against a
throwaway data directory, a fixture git mirror, a fake launcher and a fake npm. No network.

## Run

```
npm run build   # the tests launch dist/, so build first
npm run e2e     # playwright test -c test/e2e/playwright.config.ts
```

`node scripts/e2e-prepare.mjs` does both steps. The suite takes a few seconds on a warm machine
(limit: 120 s per test, 4 minutes overall). One worker, tests run in order and share one app.

## What is covered

1. Boot reaches RUNNING: engine window at `http://127.0.0.1:<port>/`, a `<canvas>`, and
   `window.openTac.getVersions()` returns the app version and the engine commit.
2. The setup window is hidden (not destroyed) while RUNNING.
3. `window.open('https://example.com')` opens no new window; the shell logs that it would have
   opened the system browser.
4. Engine update: the mirror's `stable` moves to c3, the Engine menu item
   "Check for Engine Updates…" is clicked, the setup window shows the disclosure with a commit list,
   "Later" hides it again.
5. Preferences (menu item "Preferences…") › API keys: the rows come from the fake engine's
   `GET /api/setup/status` (two keys, served by `test/fixtures/fake-launcher.mjs`), entering a value and
   pressing Save posts to its `POST /api/setup/keys` (which checks the exact local `Origin`), the row
   becomes Set, and the app never leaves RUNNING for CRASHED.
6. Quit stops the app and no fake launcher process remains (`pgrep`).

## How the data directory is prepared (`prepare.ts`)

`prepareDataDir()` returns `{ dataDir, mirrorUrl, fixture, cleanup }`. It builds the fixture mirror
from `test/helpers/checkout-fixture.ts`, clones it into `<dataDir>/checkout` at `stable` (c2), adds a
fake `node_modules`, and writes `state.json` with `installedCommit` = the stable sha,
`installedLockHash` = sha256 of `package-lock.json`, `installedNodeVersion` = `process.execPath
--version` without the `v`, channel `stable` and `remoteUrl` = the mirror URL. A boot from it skips
clone and install and goes straight to STARTING then RUNNING.

## Environment given to the app

| Variable | Value |
| --- | --- |
| `OPENTAC_DATA_DIR` | the prepared temp data dir (also moves Chromium's profile and the logs under it) |
| `OPENTAC_ENGINE_REMOTE` | `file://` URL of the fixture mirror |
| `OPENTAC_LAUNCHER_OVERRIDE` | `test/fixtures/fake-launcher.mjs` |
| `OPENTAC_NODE_OVERRIDE` | `process.execPath` of the test runner |
| `OPENTAC_NPM_CLI_OVERRIDE` | `test/helpers/core-fake-npm-cli.cjs` |
| `OPENTAC_E2E_NO_EXTERNAL=1` | `windows.ts` logs `E2E: openExternal suppressed for <url>` instead of calling `shell.openExternal` for navigation and `window.open` |
| `FAKE_MODE=ok`, `NO_COLOR=1` | fake launcher behaviour, plain output |

The `OPENTAC_*_OVERRIDE` variables are honoured only by unpackaged builds.
