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
and `Logger`, load `ShellState`, register `app://` via `protocol.handle` serving
`dist/renderer/setup/**` only (path-traversal guard; 404 otherwise), install permission handlers,
build the menu, create the `AppController`, and call `controller.start()`.

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
shows the last 200 ring lines and Restart / Show Logs / Reinstall. One automatic restart if the
previous automatic restart was more than 60 s ago, otherwise wait for the user.

`OPENTAC_FAIL_START_ONCE`: the controller reads it from its own env once, passes it to exactly one
`server.start()` call via `extraEnv`, then forgets it.

## 3. Update flow (`src/main/update.ts`)

`checkForUpdates({ interactive })`:
1. CHECKING. Cheap path first: `checkout.lsRemote(remoteUrl, [targetRef])`; if the remote SHA equals
   `head()` → "Up to date" (no fetch). Else `checkout.fetch()`; `NETWORK` → if interactive show a
   non-blocking "Couldn't reach GitHub" toast in the setup window, else log; back to RUNNING.
   `TAG_DRIFT` → ERROR with a clear explanation (mirror integrity), never auto-recover.
2. `resolveTarget(channel)`, `status(target)`. `behind === 0` → up to date (message names
   `upstreamTag ?? short sha` and the `stable-*` tag). If `!isAncestor` → disclosure flagged
   `needsReset` (backwards move, e.g. channel switch from candidate to stable).
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
   differs from `installedLockHash`, start. If that also fails → ERROR with Retry / Reinstall /
   Show Logs; `rollbackCommit` stays in state so the next boot offers it.

Launch and in-session checks: on RUNNING + 20 s, then every 6 h while RUNNING, on `powerMonitor`
resume and on main-window focus, each rate-limited to once per 6 h (`lastUpdateCheck`) unless
interactive. Checks use the cheap `lsRemote` path; only a real difference triggers a fetch.

Channel switch (Preferences): save `channel`, then `checkForUpdates({ interactive: true })`. A
backwards move shows the "older commit" notice and goes through `resetAndUpdate`.

## 4. Shell updater (`src/main/shellUpdate.ts`)

`import updater from 'electron-updater'; const { autoUpdater } = updater;` (CJS getter export).
`autoDownload = false`, `allowDowngrade = false`, `allowPrerelease = false`, logger = our logger.
Inactive when `!app.isPackaged`. Check on RUNNING + 30 s and from the App menu. On
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
- `listOllamaModels()` → names from `GET <ollamaHost>/api/tags` (10 s timeout) or an error string.

Main window only: nothing beyond the shared surface.

## 9. Secrets (`src/main/secrets.ts`)

`safeStorage.isEncryptionAvailable()` checked at boot (async variant); keys encrypted with
`encryptStringAsync`, stored as base64 in `<dataDir>/secrets.json` (0600, atomic write), decrypted on
demand with `decryptStringAsync`; when `shouldReEncrypt` is true, re-encrypt and save. If encryption
is unavailable (unsigned dev build without Keychain access) the AI panel says so and refuses to
store keys. Keys are never logged, never in `state.json`, never in the engine `.env`.

## 10. AI provider wiring

When `state.ai.provider !== 'openai'`: start the gateway with a fresh random `authToken`
(32 bytes hex) per launch, pass `aiGatewayUrl` and `extraEnv.OPENTAC_AI_GATEWAY_TOKEN` to the
server, and `injectPlaceholderOpenAiKey = !(await envFileHasKey(paths.envFile, 'OPENAI_API_KEY'))`.
Changing the provider in Preferences restarts the engine server (RESTARTING) because the env
must change; the panel says so. The "Test" button calls `gateway.testPrompt()` and shows text,
latency and `finishReason`/error plainly. The panel carries the two fixed lines: "Voice control
uses OpenAI or Gemini — configure those in the engine's POWER UP panel." and "While a non-OpenAI
summary provider is active, the engine's OpenAI key row is locked; switch back to OpenAI to edit it."

## 11. Menu (`src/main/menu.ts`)

- **OpenTac**: About OpenTac… (custom panel in the setup window: both versions, attribution line,
  licences link, GPU status button) · Check for App Updates… · Preferences… (⌘,) · Hide/Quit.
- **Engine**: Check for Engine Updates… · Open in Browser · Restart Server · Reload Page ·
  Provider Settings help (external README anchor) · Show Logs · Reinstall Dependencies… ·
  Reset to Upstream… (confirm dialog listing what is lost: nothing the user entered).
- **View**: Reload (same as Reload Page), zoom, fullscreen, **Developer** submenu: Toggle
  DevTools, GPU status (awaits `app.getGPUInfo('basic')` then logs `getGPUFeatureStatus()`),
  Open Data Folder, Copy Diagnostics (versions + last 50 log lines, redacted).
- **Window**: standard. **Help**: Upstream README · Report an engine issue (upstream) · Report an
  app issue (wrapper repo) · opentac.icu.

## 12. Setup renderer (`src/renderer/setup/`)

Plain TypeScript, no framework, one `index.html` with panels toggled by `phase`:
`progress` (phase title, determinate/indeterminate bar, streaming log tail with auto-scroll and
a pause-on-scroll-up), `disclosure`, `crash`, `error`, `about`, `preferences` (tabs: General,
Engine channel, AI), `usb-picker.html` (separate page). First screen carries the attribution line
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
