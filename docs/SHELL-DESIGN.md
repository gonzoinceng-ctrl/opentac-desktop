# OpenTac shell design (controller, windows, IPC, UI, updates)

This is the implementation contract for the Electron main process above the engine modules.
It consolidates `docs/brief/03-ARCHITECTURE.md`, `08-STAGED-UPDATES.md` and every correction in
`docs/DECISIONS.md`. Where this file and the brief differ, this file wins (and DECISIONS.md says why).

Existing modules (do not duplicate): `paths`, `logger`, `redact`, `ringBuffer`, `state`, `ports`,
`git`, `checkout`, `install`, `envFile`, `server`, `aiGateway` under `src/main/`, types in `src/shared/types.ts`.

## 1. Process entry (`src/main/index.ts`)

ESM. At module top level, synchronously: `protocol.registerSchemesAsPrivileged([{ scheme: 'app',
privileges: { standard: true, secure: true, supportFetchAPI: true } }])`,
`app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')`,
`app.setName('OpenTac')`, single-instance lock (`app.requestSingleInstanceLock()`; on failure
`app.quit()`; on `second-instance` focus the main window or the setup window). Then
`app.whenReady().then(boot)`. **Never** `await app.whenReady()` at top level.

`boot()`: resolve `Paths` (`app.getPath('userData')`, `app.getPath('logs')`, `process.resourcesPath`,
`app.getAppPath()`, `app.isPackaged`, `process.arch`), `ensureDataDirs`, create the electron-log sink
and `Logger`, load `ShellState` (a damaged `state.json` is salvaged field by field: channel, port, summary provider and app settings are kept when valid, a truncated file keeps channel and port, garbage resets; a one-time startup notice says what was kept), register `app://` via `protocol.handle` serving
`dist/renderer/setup/**` only (path-traversal guard; 404 otherwise), install permission handlers,
build the menu, create the `AppController`, and call `controller.start()`. Boot never waits for `safeStorage` (the Keychain prompt), and a plain launch never asks it (DECISIONS 2026-11-04), before creating windows; key storage simply reports unavailable until it answers.

Lifecycle: `window-all-closed` does nothing on macOS (server keeps running; Dock icon stays);
`activate` re-shows the main window when `RUNNING`, else the setup window. `before-quit` sets a
quitting flag and awaits `controller.shutdown()` (stop server, stop gateway, flush state and logs)
with a 8 s cap; then `app.exit(0)`. `powerMonitor` `resume` triggers a rate-limited update check.

## 2. Controller (`src/main/controller.ts`)

Explicit enum + transition table; every transition through `transition(to, reason)` and logged.

```
Phase = 'BOOT' | 'CLONING' | 'INSTALLING' | 'STARTING' | 'RUNNING' | 'CRASHED' | 'CHECKING'
      | 'DISCLOSING' | 'UPDATING' | 'RESTARTING' | 'ROLLING_BACK' | 'ERROR'
```

Allowed transitions (anything else throws, which is a programming error):
- BOOT → CLONING | INSTALLING | STARTING | ERROR
- CLONING → INSTALLING | ERROR
- INSTALLING → STARTING | ERROR
- STARTING → RUNNING | ERROR | ROLLING_BACK (only when a rollback marker exists)
- RUNNING → CHECKING | CRASHED | RESTARTING | ERROR
- CHECKING → RUNNING | DISCLOSING | ERROR
- DISCLOSING → RUNNING | UPDATING
- UPDATING → INSTALLING | STARTING | ROLLING_BACK | ERROR
- ROLLING_BACK → INSTALLING | STARTING | ERROR
- RESTARTING → STARTING | ERROR
- CRASHED → STARTING | INSTALLING | ERROR
- ERROR → BOOT (Retry) | CLONING (Reset) | INSTALLING (Reinstall) | STARTING

`start()` (BOOT):
1. Disk space pre-check on `dataDir` volume: < 2 GB free → ERROR `DISK_SPACE` (Retry). Use
   `fs.statfs`.
2. If `OPENTAC_ENGINE_REMOTE` env is set it overrides `state.remoteUrl` for this run (CI). If
   `OPENTAC_ENGINE_REF` is set it overrides channel resolution.
3. `checkout.exists()` false → CLONING: `checkout.clone(remoteUrl, progress)`; on success
   `fetch()` is implicit; resolve target for `state.channel`, `checkoutDetached(target.commit)`.
4. `install.needsInstall(state)` → INSTALLING when needed. On success save `installedLockHash`,
   `installedNodeVersion`, `installedCommit = head`. Then `runDoctor()` and log; never block.
5. STARTING: choose port (see §6), start AI gateway if provider ≠ openai, build server options
   (placeholder key rule in §7), `server.start()`. `firstRun` = no `lastSuccessfulStart` or
   install happened this boot. Save `lastSuccessfulStart`, `lastPort`, clear `rollbackCommit`.
6. RUNNING: show main window at `http://127.0.0.1:<port>/`, hide setup window. Schedule the launch
   update check (§8) after 20 s, the shell update check after 30 s.

Errors: every caught module error (`GitError`, `InstallError`, `ServerError`) maps to a
`UserError { title, message, detail, actions: Action[] }` via `src/main/errors.ts` with plain
sentences (no stacks). Actions by context: `retry`, `showLogs`, `reinstall`, `resetCheckout`,
`changePort`, `rollback`, `quit`.

Crash policy: a `server` exit event with `expected: false` while RUNNING → CRASHED, setup window
shows the engine output since the current start (not a fixed 200 lines), names the exit reason (signal or exit code) and offers Restart / Show Logs / Reinstall. One automatic restart if the
previous automatic restart was more than 60 s ago, otherwise wait for the user. During the automatic restart the setup window stays hidden; after a successful restart a notice says what happened.

`OPENTAC_FAIL_START_ONCE`: the controller reads it from its own env once, passes it to exactly one
`server.start()` call via `extraEnv`, then forgets it.

## 3. Update flow (`src/main/update.ts`)

`checkForUpdates({ interactive })`:
1. CHECKING. Cheap path first: `checkout.lsRemote(remoteUrl, [targetRef])` (30 s timeout; a timeout counts as offline); if the remote SHA equals
   `head()` → "Up to date" (no fetch). Else `checkout.fetch()`; `NETWORK` → if interactive show a
   non-blocking "Couldn't reach GitHub" notice in the setup window, else log; back to RUNNING. An interactive check shows a "Contacting GitHub…" panel after 1.5 s; Dismiss hides the window.
   `TAG_DRIFT` → ERROR with a clear explanation (mirror integrity), never auto-recover.
2. `resolveTarget(channel)`, `status(target)`. `behind === 0` → up to date (message names
   `upstreamTag ?? short sha` and the `stable-*` tag). If `!isAncestor` → disclosure flagged
   `needsReset` (backwards move, e.g. channel switch from candidate to stable), shown as a downgrade: its own title, a warning banner and the number of commits removed.
3. Build `Disclosure`: remote (redacted), channel, from → to (tag names when known), commit count
   (+ truncated flag), subjects newest first, author, date, `diffStat`, `lockfileChanged`,
   compare URL `https://github.com/<owner>/<repo>/compare/<from>...<to>` derived from the remote
   URL (null for non-GitHub remotes), dirty report, `TagAnnotation` fields for `stable-*`
   (`gateRun`, `canaryDays`, `minShell`, `severity`, `upstreamTag`), and `untested: channel !== 'stable'`.
4. **minShell**: if `semver.gt(minShell, app.getVersion())` the disclosure is replaced by a
   "Update OpenTac first" panel (button: Check for App Updates). Never apply.
5. `skippedCommit === target.commit` and not interactive and severity ≠ `security` → stay quiet.
6. DISCLOSING: setup window shows the panel. Actions: `confirmUpdate`, `laterUpdate`,
   `skipUpdate` (saves `skippedCommit`), `resetAndUpdate` (only when dirty or `needsReset`).

`applyUpdate(target, { reset })`:
1. UPDATING. `rollbackCommit = head()` saved to state **before** anything else. Block the main
   window (`setEnabled(false)`), show the setup window with progress.
2. `server.stop()` first (the tree must not change under a live Vite).
3. If `reset`: `checkout.resetToTarget(target.commit)`; else `checkoutDetached(target.commit)`.
4. If `lockfileChanged(rollbackCommit, target.commit)` or `needsInstall` → INSTALLING.
5. STARTING → RUNNING; `webContents.reload()` on the main window; save `installedCommit`,
   clear `rollbackCommit`, `skippedCommit`.
6. Any failure in 3–5 → ROLLING_BACK: `checkoutDetached(rollbackCommit)`, reinstall if the lock
   differs from `installedLockHash`, start. The panel reads "Restoring the previous version"; on success the failed target is saved as `skippedCommit` and the final notice says so. If that also fails → ERROR with Retry / Reinstall /
   Show Logs; `rollbackCommit` stays in state so the next boot offers it.

Launch and in-session checks: on RUNNING + 20 s, then every 6 h while RUNNING, on `powerMonitor`
resume and on main-window focus, each rate-limited to once per 6 h (`lastUpdateCheck`) unless
interactive. Checks use the cheap `lsRemote` path; only a real difference triggers a fetch.

Channel switch (Preferences): save `channel`, then `checkForUpdates({ interactive: true })`. A
backwards move shows the "older commit" notice and goes through `resetAndUpdate`.

## 4. Shell updater (`src/main/shellUpdate.ts`)

`import updater from 'electron-updater'; const { autoUpdater } = updater;` (CJS getter export).
`autoDownload = false`, `allowDowngrade = false`, `allowPrerelease = false`, logger = our logger.
Inactive when `!app.isPackaged`. `app-update.yml` is written only by `dist` (dmg/zip) builds, so a `npm run pack` build cannot test the shell auto-update path. Check on RUNNING + 30 s and from the App menu. On
`update-available`: dialog "OpenTac X is available. Download now?" → `downloadUpdate()`. On
`update-downloaded`: dialog "Restart to update" → `controller.shutdown()` **then**
`autoUpdater.quitAndInstall()` (quitAndInstall closes windows before `before-quit`, so the engine
must be stopped explicitly first). All strings say "OpenTac" / "the app", never "engine".

## 5. Windows (`src/main/windows.ts`)

- **Setup window**: 760×560, min 600×440, resizable, `titleBarStyle: 'default'`, `show: false`
  until `ready-to-show`, loads `app://setup/index.html`, preload `dist/preload/setup.cjs`,
  `webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
  webSecurity: true, spellcheck: false }`. Closing it while not RUNNING asks "Quit OpenTac?".
  While RUNNING it is hidden, not destroyed.
- **Main window**: 1440×900 default, min 1024×640, bounds restored from `state.mainWindowBounds`
  (validated against `screen.getDisplayMatching`), `backgroundColor: '#0a0a0f'`, standard title
  bar, preload `dist/preload/main.cjs`, same webPreferences plus
  `autoplayPolicy: 'no-user-gesture-required'`. Navigation guard on `webContents`:
  `will-navigate`, `will-redirect`, `will-frame-navigate` allow only the engine origin
  (`http://127.0.0.1:<port>`); `https:`/`mailto:` → `shell.openExternal`; everything else denied.
  `setWindowOpenHandler`: `https:` → `shell.openExternal`, return `{ action: 'deny' }` always.
  Bounds saved on `resize`/`move` (debounced 500 ms). During RESTARTING the window is
  `setEnabled(false)` and a small overlay message is shown in the setup window.
- `did-fail-load` with `ERR_CONNECTION_REFUSED` while RUNNING (Vite restarting after a key save)
  → retry `loadURL` every 500 ms for up to 15 s before treating it as a problem; the child has not
  exited, so it is not a crash.
- **Cesium render halt** (upstream's "cartesian has a NaN component" / "Rendering has stopped"): the main-window preload reports Cesium's error overlay; the shell reloads the page after about 1.5 s, at most three times in ten minutes (`shouldAutoReloadAfterRenderError`), then shows a "The globe stopped drawing" dialog with *Reload Page* / *Not Now*. Nothing in the checkout is patched.

## 6. Ports (`src/main/controller.ts` + `ports.ts`)

Pinned per install. First run: `findFreePort({ preferred: 4173 })`, saved as `lastPort`. Later
runs: if `isPortFree(lastPort)` use it; else ERROR `PORT_IN_USE` with actions Retry and
"Use a different port" (explains that saved layers, favourites and permissions are tied to the port
and will appear reset). `EADDRINUSE` from `server.start()` after the probe (race) → one automatic
retry on the same port after 1 s, then the same ERROR.

## 7. Permissions (`src/main/permissions.ts`)

`engineOrigin = 'http://127.0.0.1:<port>'` (updated by the controller when the port is chosen).

- `setPermissionCheckHandler`: `usb`, `media` (details.mediaTypes ⊆ ['audio']), `clipboard-read`,
  `clipboard-sanitized-write`, `fullscreen`, `pointerLock` → true only for `engineOrigin`
  (compare `new URL(requestingOrigin).origin`); everything else false.
- `setPermissionRequestHandler`: same allow-list; for `media` with audio call
  `systemPreferences.askForMediaAccess('microphone')` first (macOS) and grant only if it resolves
  true; if `getMediaAccessStatus('microphone') === 'denied'` show a one-time dialog pointing to
  System Settings › Privacy & Security › Microphone. `geolocation`, `notifications`,
  `display-capture`, `hid`, `serial`, `midi` → deny.
- WebUSB: `session.on('select-usb-device', (event, details, callback))` → `event.preventDefault()`,
  show a small picker (a modal `BrowserWindow` on `app://setup/usb-picker.html`, or a `dialog`
  message box with buttons when ≤ 3 devices), callback with the chosen `deviceId` or `undefined`.
  Persist `{ vendorId, productId, productName, serialNumber }` in `state.usbDevices`.
  `setDevicePermissionHandler` returns true for `deviceType === 'usb'`, `engineOrigin`, and a
  device matching all persisted fields that are present. `setUSBProtectedClassesHandler` not set.

## 8. IPC (`src/main/ipc.ts`, `src/preload/*.ts`, `src/shared/ipc.ts`)

All `ipcMain.handle` channels are prefixed `opentac:` and validate payloads with hand-rolled guards
in `src/shared/ipc.ts` (no Node builtins; it is bundled into the preloads). The preload exposes
only typed wrappers; the renderer never passes paths, URLs other than `https:`/`mailto:` for
`openExternal`, or free-form commands.

Shared (both windows, `window.openTac` / `window.openTacSetup`):
- `getVersions(): { app, electron, chromium, node: bundled, engine: { commit, short, upstreamTag, stableTag, channel, remote }, licensesUrl }`
- `openExternal(url)` — `https:` or `mailto:` only, validated in main.
- `openLogsFolder()`

Setup window only:
- `onState(cb)` → `PublicState` pushed on every transition and progress tick (throttled 100 ms):
  `{ phase, progress: { pct?: number, label: string } | null, message, logTail: string[], disclosure: Disclosure | null, error: UserError | null, port: number | null, channel, prefs: Prefs, ai: AiPrefsPublic, canary: { lastLaunchedCandidate: string | null } }`
- `action(name, payload?)` with names: `retry`, `confirmUpdate`, `laterUpdate`, `skipUpdate`,
  `resetAndUpdate`, `restartServer`, `reinstall`, `rollback`, `changePort`, `checkForUpdates`,
  `checkForAppUpdates`, `openPreferences`, `closePreferences`, `quit`.
- `setPrefs({ channel?, updateCheckOnLaunch? })`
- `setAi({ provider, model, ollamaHost })` and `setAiKey({ provider: 'openrouter'|'xai', key })`
  (key goes straight to `secrets.ts`, never echoed back; `getAiStatus()` reports only `hasKey`).
- `testAi()` → `AiTestResult`.
- Settings (section 14): `setAppSettings(patch)`, `getEngineKeys()`, `saveEngineKey({ values })`,
  `clearEngineKey({ id })`, `getEngineSettings()`, `saveEngineSettings({ patch })`. `PublicState` also
  carries `app`, `engineKeys` and `engineSettings`. Two more action names: `openDataFolder` (handled
  in `ipc.ts` like `showLogs`) and `forgetUsbDevices` (controller, with a confirm dialog).
- `listOllamaModels()` → names from `GET <ollamaHost>/api/tags` (10 s timeout) or an error string.

Main window only: nothing beyond the shared surface.

## 9. Secrets (`src/main/secrets.ts`)

`safeStorage.isEncryptionAvailable()` checked at boot (async variant); keys encrypted with
`encryptStringAsync`, stored as base64 in `<dataDir>/secrets.json` (0600, atomic write), decrypted on
demand with `decryptStringAsync`; when `shouldReEncrypt` is true, re-encrypt and save. If encryption
is unavailable (unsigned dev build without Keychain access) the AI panel says so and refuses to
store keys. Keys are never logged, never in `state.json`, never in the engine `.env`.

## 10. AI provider wiring

The default for new installs is `openai` (upstream's own behaviour: no gateway, the engine's own OpenAI key row is editable); Ollama, OpenRouter and xAI are opt-in in Preferences › AI summaries (the Ollama model is a select fed by Ollama; OpenAI shows no model box). When `state.ai.provider !== 'openai'`: start the gateway with a fresh random `authToken`
(32 bytes hex) per launch, pass `aiGatewayUrl` and `extraEnv.OPENTAC_AI_GATEWAY_TOKEN` to the
server, and `injectPlaceholderOpenAiKey = !(await envFileHasKey(paths.envFile, 'OPENAI_API_KEY'))`.
Changing the provider in Preferences restarts the engine server (RESTARTING) because the env
must change; the panel says so, Preferences stays open through the restart and then reads "Saved. The engine has restarted with the new provider." The "Test" button calls `gateway.testPrompt()` and shows text,
latency and `finishReason`/error plainly. The panel carries the two fixed lines: "Voice control
uses OpenAI or Gemini — configure those in the engine's POWER UP panel." and "While a non-OpenAI
summary provider is active, the engine's OpenAI key row is locked; switch back to OpenAI to edit it."

## 11. Menu (`src/main/menu.ts`)

- **OpenTac**: About OpenTac… (custom panel in the setup window: both versions, attribution line,
  Engine source (the remote), a credit link to the upstream repository, licences link: THIRD_PARTY_NOTICES.md on GitHub until the website domain is live, GPU status button) · Check for App Updates… · Preferences… (⌘,) · Hide/Quit.
- **Engine**: Check for Engine Updates… · Open in Browser · Restart Server · Reload Page ·
  Provider Settings help (external README anchor) · Show Logs · Reinstall Dependencies… ·
  Download Engine Again… (asks once; acts only in ERROR, otherwise shows an explanatory message and does nothing; nothing the user entered is lost).
- **View**: Reload (same as Reload Page), zoom, fullscreen, **Developer** submenu: Toggle
  DevTools, GPU status (awaits `app.getGPUInfo('basic')` then logs `getGPUFeatureStatus()`),
  Open Data Folder, Copy Diagnostics (versions + last 50 log lines, redacted).
- **Window**: Minimize, Zoom, Close (Cmd-W), Bring All to Front. **Help**: Upstream README · Report an engine issue (upstream) · Report an
  app issue (wrapper repo) · opentac.icu.

## 12. Setup renderer (`src/renderer/setup/`)

Plain TypeScript, no framework, one `index.html` with panels toggled by `phase`:
`progress` (phase title, determinate/indeterminate bar, streaming log tail with auto-scroll and
a pause-on-scroll-up; RUNNING shows only a compact status line and the window hides after the last notice is dismissed; npm "deprecated"/"install-scripts" advisories are filtered from the tail), `disclosure` (its decision buttons are sticky and always in view), `crash`, `error`, `about`, `preferences` (tabs: General, Updates,
API keys, AI summaries, Engine settings, App settings), `usb-picker.html` (separate page). First screen carries the attribution line
and the honest first-run copy ("downloading the God's Eye View source (~200 MB) and its
dependencies (~400 MB) from GitHub and npm"). Strict CSP meta `default-src 'self'; style-src
'self'; img-src 'self' data:`. Accessibility: labelled controls, focus order, Esc closes
Preferences/About, buttons reachable by keyboard.

## 13. Tests

- Unit: controller transition table (every allowed/forbidden edge), error mapping, disclosure
  builder with a mocked `CheckoutManager`, minShell gate, skip/rate-limit logic, port pinning
  decisions, IPC guards, secrets round trip with a fake safeStorage.
- Integration: update flow against the fixture mirror (`test/helpers/checkout-fixture.ts`) with the
  fake launcher: behind → disclosure → apply → RUNNING; lock changed → install step (fake npm);
  start failure once (`OPENTAC_FAIL_START_ONCE`) → rollback reaches RUNNING at the old commit;
  dirty tree → reset path preserves `.env`.
- E2E (Playwright `_electron`, `test/e2e/`): launched with `OPENTAC_DATA_DIR` pointing at a prepared
  data dir (fixture mirror + fake launcher via `OPENTAC_LAUNCHER_OVERRIDE` and
  `OPENTAC_NODE_OVERRIDE` env, both honoured only when `!app.isPackaged`): reaches RUNNING,
  main window URL matches `http://127.0.0.1:\d+/`, `<canvas>` exists on the fake page,
  `window.openTac.getVersions()` resolves, external link opens no new window, menu-driven
  "Check for Engine Updates" shows the disclosure, quit leaves no child process.

## 14. Settings (`engineKeys.ts`, `envSettings.ts`, `src/shared/appSettings.ts`, Preferences tabs)

Preferences is the one place to enter every key and setting. Each kind is stored where its consumer
reads it, and the shell never keeps a second copy:

| What | Store | Writer |
|---|---|---|
| The 11 engine registry keys | engine `.env` | the **engine** (`POST /api/setup/keys`), relayed by `engineKeys.ts` |
| Engine settings (voice, limits, feeds, CCTV, Ontario 511 key) | engine `.env` | the **shell** (`envSettings.ts`), then an engine restart |
| App settings, channel, summary provider | `state.json` (`app` object) | the shell, immediately |
| OpenRouter and xAI keys | `secrets.json` (`safeStorage`) | the shell (`setAiKey`) |

**Engine keys** (`src/main/engineKeys.ts`). `createEngineKeysClient({ engineUrl, fetchImpl?, log })` has
`status()` (`GET /api/setup/status`, parsed to `{ keys, setCount, total, store }`) and
`save(updates)` (`POST /api/setup/keys`, body `{ ENV_VAR: value | null }`, null removes). Both send
`Origin: http://127.0.0.1:<port>` (upstream's `admitKeySetupRequest` demands the exact local origin on a
POST) and the POST sends `Content-Type: application/json`. A `409 { code: 'external' }` ("managed outside
Provider Settings") becomes a plain sentence; other refusal codes map to sentences too. Values only ever
travel in the request body; results hold booleans, ids and sentences. The list is **not** hard-coded:
what the engine reports is shown (so it tracks the engine version). `ENGINE_KEY_CATALOG` (ids, titles,
env var names) is used only (a) for the static fallback shown while the engine is not running, with
set/unset read from the names of non-empty variables in `.env` via `envFileKeys`, and (b) to add the one
row the engine hides from its status (`google-maps-server`) under "Advanced keys". Rows with
`managed: 'external'` are **Locked**; the OpenAI row gets the placeholder explanation (DECISIONS "Engine
contract drift") when an opt-in non-OpenAI summary provider is chosen. After a successful save the engine restarts
itself about 250 ms later and the child process **does not exit**: the controller makes no phase change
(nothing can reach CRASHED), updates the row optimistically and polls the status quietly until the
engine answers again.

**Engine settings** (`src/shared/engineSettingsCatalog.ts`, re-exported by `src/main/envSettings.ts`).
`ENGINE_SETTINGS_CATALOG: SettingGroup[]` (Voice, Spend and rate limits, Data feeds, CCTV cameras) lists
typed settings (`string | number | boolean | enum | list | url | secret`, enum options, default,
min/max, placeholder, `requiresRestart`) with descriptions taken from upstream's `.env.example`, plus a
region table for every `CCTV_<REGION>_*` variable (one row per region: enabled checkbox, camera cap,
optional URL and districts). Never offered: the 11 registry variables, `HOST`, `PORT`,
`GEV_ALLOWED_HOSTS`, `GEV_KEY_SETUP_TRUSTED_PEERS`, `GEV_EMBED_FRAME_ANCESTORS`, `VITE_*` and
`CCTV_SOURCES_FILE/JSON`, `CCTV_PREFER_AUSTIN`, `CCTV_FORCE_AUSTIN`, the two Vegvesen sub-switches.
A half-typed number (for example `1e` or `-`) is refused inline at the field and nothing is written; errors appear at the field, pasted keys are trimmed, and a warning shows only when it applies to the current value. `validateSetting(key, value)` returns `{ ok: true, value }` (normalised: booleans to the setting's own
`1/0` or `true/false`, numbers canonical) or `{ ok: false, reason }`; every value rejects control
characters and the dotenv metacharacters (hash, both quote marks, dollar sign, backslash and backtick), so what is written is what the engine reads
back. `writeEngineSettings(envFile, patch)` mirrors upstream's `upsertDotenvValues`: replace the last
active assignment in place, else uncomment the last commented one, else append under a header; a `null`
comments every active assignment out as `# KEY=`; every other line and comment (including the registry
lines) is preserved byte for byte; atomic tmp + fsync + rename, mode 0600, refuses to write through a
symlink, all-or-nothing validation, writes serialised. A `''` value is an assignment, not a clear, only
where upstream defines empty as "off" (`PHOTON_URL`, the Caltrans and TxDOT districts). Secret-typed
values (`ONTARIO_511_API_KEY`) are read back as `''` with a `set` flag. The controller's
`saveEngineSettings` writes, refreshes `PublicState.engineSettings`, logs the **names** changed (never
values) and, when RUNNING, restarts the engine (RESTARTING, STARTING, RUNNING; Vite and the engine read
`.env` at start); in any other phase it only writes and says the settings apply at the next start.

**App settings** (`state.json` `app`, schema version stays 1; missing fields fill from defaults,
`validateState` checks them). `launchAtLogin` calls an injected function (index.ts:
`app.setLoginItemSettings`, packaged builds only). `autoRestartOnCrash` (default on) gates the single
automatic restart. `updateCheckInterval` is `launch-only` (no interval; resume and focus checks skipped),
`6h` (default) or `daily` (24 h interval and rate limit); changing it replaces the timer live.
`logLevel` is `default | error | warn | info | debug`, read from `state.json` before the logger exists
and applied at the next launch by `resolveLogLevels(env, isPackaged, setting)`: `OPENTAC_LOG_LEVEL` wins,
then the setting, then the defaults. `proxy` is `{ httpsProxy, noProxy }` (http(s) URL without
credentials): it reaches the engine child as `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` and
`NODE_USE_ENV_PROXY=1` (`buildServerEnv`'s `proxy` option; those names are reserved so `extra` cannot set
them), and the git runner and the npm install manager as `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` through a
`proxyEnv()` hook read on every call. Git and npm use a change at once; the engine at its next start.
`engineRemoteUrl` (https:// or file:// only, no credentials) overrides the mirror and is read **once at
launch**, so it takes effect at the next launch; `OPENTAC_ENGINE_REMOTE` still wins. The tab shows
"Only change this to point at your own mirror; the default is the OpenTac mirror." and a Reset-to-default
button. Maintenance buttons: Open data folder, Open logs folder, Forget remembered USB devices (confirm,
clears the controller copy and the index.ts list), Reinstall dependencies and Reset engine files (two-step
buttons; Reset is enabled only in ERROR, where the controller honours it).

**Renderer.** Pure helpers in `view.ts` (`keyRowState`, `settingFieldModel`, `regionRowModels`,
`buildSettingsPatch`, ...) are unit tested; `setup.ts` builds key rows once per id set and updates them in
place so typing is never lost on a state push, and builds the engine settings groups once from the
catalogue. Every input has a label or `aria-label`; Esc closes Preferences. Preferences stays open through a settings-driven engine restart, and its tabs and Done button are sticky (stay in view while scrolling). The key summary reads "N of M keys set" and ignores the locked OpenAI placeholder. Key rows save per row (Save,
Clear, Show/Hide); engine settings have one Save per group with the visible note "Saving restarts the
engine to apply the settings."; app settings save on change (text fields have a Save button).
