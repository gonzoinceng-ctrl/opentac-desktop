# Data directory reference

Everything OpenTac writes lives outside the signed `.app` bundle. The paths are computed in one
place, `src/main/paths.ts` (`resolvePaths`); the shell never writes inside `OpenTac.app`.

- **Data directory** (`dataDir`): `~/Library/Application Support/OpenTac/`, or the value of
  `OPENTAC_DATA_DIR` when set (resolved to an absolute path).
- **Logs directory** (`logsDir`): `~/Library/Logs/OpenTac/` (Electron's `app.getPath('logs')`).
- **`OPENTAC_DATA_DIR` and isolation.** The variable always moves the shell's own data directory
  (checkout, `state.json`, `secrets.json`, `npm-cache`). What else moves depends on the build:
  - **Unpackaged (`npm run dev`, e2e):** Chromium's profile (`userData`) goes to
    `<dir>/electron-user-data` and the logs to `<dir>/logs` (`src/main/index.ts`). The run is fully
    isolated from a real install, single-instance lock included.
  - **Packaged app:** only `paths.ts` honours the variable. `userData` stays at
    `~/Library/Application Support/OpenTac/` and the logs stay in `~/Library/Logs/OpenTac/`. The real
    install's Chromium profile and its single-instance lock are shared, so a packaged QA run collides
    with a running real install (and browser state keyed by `http://127.0.0.1:<port>` can mix). Quit
    the real install first, or test the packaged app from a separate macOS user account.

"Safe to delete" below means: the app recovers on its own at the next launch, and what you lose.
Quit OpenTac before deleting anything.

## Paths under the data directory

| Path | `Paths` field | Purpose | Safe to delete? |
|---|---|---|---|
| `checkout/` | `checkoutDir` | The live git checkout of the engine (God's Eye View). Runs under the bundled Node. Never edited by hand: updates are fast-forward only. | Yes, as a whole. Next launch re-clones (about 200 MB) and reinstalls (about 400 MB). **You lose `checkout/.env` (your API keys)**: copy it out first. |
| `checkout/.env` | `envFile` | The engine's own settings and API keys, written by the POWER UP / Provider Settings panel. Mode 0600. Git-ignored upstream. | Only if you are happy to re-enter every key. Never touched by updates or by Reset. |
| `checkout/node_modules/` | `nodeModulesDir` | Engine dependencies from `npm ci` (about 400 MB). Includes `vite`, which the engine needs at runtime. | Yes. Detected as missing (`no-node-modules`) and reinstalled at next launch; needs network. Or use *Engine › Reinstall Dependencies…*. |
| `checkout/node_modules/.vite/` | `viteCacheDir` | Vite's dependency-optimisation cache. First start after it is gone takes up to about 60 s. | Yes. Rebuilt automatically. |
| `checkout/.gev-cache/` | `gevCacheDir` | Engine runtime cache (the engine writes it relative to its working directory, which is the checkout). Git-ignored upstream. | Yes. Refilled as feeds are fetched. Preserved by updates and Reset. |
| `checkout/.gev-logs/` | `gevLogsDir` | Engine-side logs written by the engine itself. Git-ignored upstream. | Yes. |
| `state.json` | `stateFile` | The shell's state, schema version 1: channel, `remoteUrl`, installed commit / lockfile hash / Node version, `rollbackCommit`, last update check, `lastPort`, update-on-launch flag, `skippedCommit`, main window bounds, remembered USB devices, and the AI preference (`provider`, `model`, `ollamaHost`). Contains no secrets. Written atomically, mode 0600. | Yes, but you lose the pinned port (saved layers and permissions are keyed by origin and will look reset), channel, skipped version and USB choices. The next launch re-detects the install state. |
| `state.json.bak` | `stateBackupFile` | Copy of a `state.json` that failed validation, kept when the shell falls back to defaults (the corrupt-state drill). | Yes. |
| `secrets.json` | (secrets module) | OpenRouter and xAI keys for the AI gateway, encrypted with Electron `safeStorage`; the key that protects the file lives in your login Keychain. Mode 0600. Not the engine's keys. | Yes. You re-enter the OpenRouter/xAI keys in Preferences › AI. |
| `npm-cache/` | `npmCacheDir` | npm's download cache for `npm ci`. Lets a failed update reinstall the previous dependencies while offline. | Yes. Costs a full re-download on the next install and removes the offline rollback safety net. |
| `env.backup` | (controller) | Temporary copy of `checkout/.env` taken before the checkout is deleted (re-download) and restored after the new clone. | Yes, once no re-download is in progress. |
| Chromium profile (`Cache`, `GPUCache`, `Local Storage`, `IndexedDB`, `Session Storage`, `Cookies`, ...) | (Electron `userData`) | The browser profile for the globe window. It is `~/Library/Application Support/OpenTac/` for a packaged app (even with `OPENTAC_DATA_DIR` set), and `<OPENTAC_DATA_DIR>/electron-user-data/` for an unpackaged run that sets it; it is **not** `dataDir` in general. **Layers, favourites, SDR choice and the microphone grant live here, keyed by the engine origin `http://127.0.0.1:<port>`.** This is why the port is pinned. | Individually yes; you lose that browser-side state. The shell's own files above are unaffected. |

## Paths under the logs directory

| Path | Purpose | Safe to delete? |
|---|---|---|
| `main.log` | The shell: state transitions, git and npm operations with durations, updates, permissions, and the engine launcher's lifecycle (spawn, ready line, exit). electron-log, file level `info`, rotated at 10 MB. Secrets redacted. | Yes. |

There is **no `server.log`**. The engine's stdout and stderr go to a 200-line in-memory ring buffer
(shown in the setup window's log tail and in the CRASHED / ERROR panels) and to a `debug`-level log
call that the `info`-level file transport drops. `Paths.serverLog` exists in `paths.ts` but nothing
writes it. The only on-disk engine evidence is therefore what `main.log` records at `info` (start,
ready line, exit codes, the raw error line of a failed start). The engine's own files are in
`checkout/.gev-logs/`.

## Read-only paths inside the app bundle

Packaged builds only (`Resources/` under `OpenTac.app`). Never written; replaced wholesale by an app
update.

| Path | `Paths` field | Purpose |
|---|---|---|
| `Resources/node/bin/node` | `nodeBin` | The bundled Node 24 that runs the engine. Never Electron's Node, never `node` on PATH. |
| `Resources/node/lib/node_modules/npm/bin/npm-cli.js` | `npmCli` | The bundled npm. `Resources/node/bin/npm` and `npx` exist too, because upstream's doctor runs `npm` via PATH. |
| `Resources/node/LICENSE` | | Node's licence plus its bundled components'. |
| `Resources/launcher/opentac-start.mjs` | `launcherScript` | The launcher that starts the engine. |
| `Resources/app.asar.unpacked/node_modules/dugite/git/` | `gitDir` | The git binary (dugite). Not on PATH. |

Unpackaged development builds use `vendor/node/darwin-<arch>/`, `resources/launcher/` and
`node_modules/dugite/git/` in the repository instead.

## What survives what

| Operation | `.env` | `.gev-cache` | `node_modules` | `state.json` | `secrets.json` | `npm-cache` | Chromium profile |
|---|---|---|---|---|---|---|---|
| Quit and relaunch | kept | kept | kept | kept | kept | kept | kept |
| Engine update (fast-forward) | kept | kept | reinstalled only if `package-lock.json` or bundled Node changed | kept (installed commit updated, `rollbackCommit` set then cleared) | kept | kept | kept |
| Failed engine update, automatic rollback | kept | kept | restored from the npm cache if the lockfile differs | kept (`rollbackCommit` retained if rollback also fails) | kept | kept | kept |
| Switch channel | kept | kept | as for an update | kept (channel changed) | kept | kept | kept |
| *Reset and update* (disclosure button: dirty tree, or backwards move; `resetToTarget`) | kept | kept | kept unless the lockfile changes | kept | kept | kept | kept |
| *Reset engine files* (error-panel button) or *Engine › Reset to Upstream…* (ERROR phase only; `resetCheckout`) | kept (restored from `env.backup` into the fresh clone) | **lost** | **lost** (reinstalled) | kept (installed fields cleared, then re-set) | kept | kept | kept |
| *Reinstall Dependencies…* | kept | kept | deleted and reinstalled | kept | kept | kept | kept |
| App update (new OpenTac version) | kept | kept | kept | kept | kept | kept | kept |
| Delete `checkout/` | **lost** | lost | lost | kept (stale install fields are re-detected) | kept | kept | kept |
| Delete the whole data directory | **lost** | lost | lost | lost | lost | lost | lost |
| Move the app to the Trash | kept | kept | kept | kept | kept | kept | kept |

The two resets are different operations. *Reset and update* moves the existing checkout to the
target commit and discards only changes to **tracked** files (nothing the user entered, since keys
live in the git-ignored `.env`). *Reset engine files* / *Reset to Upstream…* asks "Download the engine
again?", deletes the whole `checkout/` (`rm -rf`), re-clones and reinstalls; only `.env` is carried
over, through `env.backup`. The menu item does nothing unless the app is in the ERROR phase (it
returns immediately in any other phase), so from a running globe use the update disclosure instead.
Uninstalling OpenTac does not remove the data
or logs directories; delete them by hand for a clean slate.
