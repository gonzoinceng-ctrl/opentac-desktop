# Troubleshooting

Find the symptom (the title the setup window shows, or what you see), read the cause, apply the fix.
Error codes are the `UserErrorCode` values in `src/main/errors.ts`; the code and the raw error line
are in `~/Library/Logs/OpenTac/main.log` (*Engine › Show Logs*), which records at `info` level and
redacts secrets. The engine's stdout/stderr is teed to `~/Library/Logs/OpenTac/server.log`
(timestamped, secrets redacted, `[gev:shell]` ready/exit markers, rotated at 10 MB with five archives);
the last 200 lines are also shown in the setup window (log tail, CRASHED and ERROR panels), and the
engine keeps its own files in `C/.gev-logs/`. Launch with `OPENTAC_LOG_LEVEL=debug` for more `main.log` detail. Where a path is shown, `D` is the data directory
(`~/Library/Application Support/OpenTac`) and `C` is `D/checkout`; see [`DATA-DIR.md`](DATA-DIR.md).

If nothing here helps, use *View › Developer › Copy Diagnostics* and file an issue: app problems at
<https://github.com/gonzoinceng-ctrl/opentac-desktop/issues>, problems with the globe itself at
<https://github.com/bilawalsidhu/gods-eye-view/issues>. To tell them apart, switch to the `upstream`
channel (Preferences › Engine channel) or use *Engine › Open in Browser*.

## Error panel reference

### Not enough free disk space (`DISK_SPACE`)
- **Cause:** less than 2 GB free on the volume holding the data directory when OpenTac started. The
  first run needs about 200 MB for the clone and about 400 MB for dependencies, plus working space.
- **Fix:** free space (empty Trash, remove old simulators or downloads), then Retry. Check with
  `df -h ~/Library/Application\ Support`. Moving the data directory to another volume is possible
  with `OPENTAC_DATA_DIR`, but that is a development setting.

### Your disk is full (`DISK_FULL`)
- **Cause:** the disk filled up *during* a clone or `npm ci` (npm reported `ENOSPC`).
- **Fix:** free about 1 GB, then Retry. A partly installed `C/node_modules` is replaced by `npm ci`.

### Couldn't download God's Eye View (`NETWORK` or `CLONE_FAILED`, first run)
- **Cause:** GitHub could not be reached (offline, captive portal, VPN or proxy blocking
  `github.com`), or the clone failed for another reason. The raw line says which.
- **Fix:** check the connection, open <https://github.com> in a browser, disconnect a VPN that
  blocks git, then Retry. Nothing is left half-installed. If you set `OPENTAC_ENGINE_REMOTE` or edited
  `remoteUrl` in `state.json`, check that URL.

### Couldn't reach GitHub (`NETWORK`, during an update)
- **Cause:** the update check or fetch could not reach the mirror. The installed version keeps working.
- **Fix:** Retry later. Launch-time checks fail quietly; only *Check for Engine Updates…* shows this.

### Couldn't download the dependencies (`NETWORK`, during `npm ci`)
- **Cause:** the npm registry could not be reached. OpenTac already retried once.
- **Fix:** check the connection (corporate proxies sometimes allow github.com but block
  `registry.npmjs.org`), then Retry. Already-downloaded packages are cached in `D/npm-cache`, so a retry
  is faster.

### Installing dependencies failed / took too long (`NPM_FAILED`)
- **Cause:** `npm ci` exited with an error, was cancelled, or exceeded its time limit. The raw line is
  the tail of npm's output. Common causes: a flaky connection, a full disk, an interrupted earlier
  install, or an engine release whose lockfile is out of step.
- **Fix:** Retry (a second attempt is usually faster). If it repeats: quit, delete `C/node_modules`,
  relaunch (or use *Engine › Reinstall Dependencies…*). If the log shows the same package failing every
  time, try the `upstream` channel to see whether upstream has the problem, and report it. The
  message "The bundled Node runtime is missing" means a damaged app: reinstall OpenTac.
- **Note:** npm 11 may print warnings about install scripts not being on an allow list. They are
  harmless and are not the cause.

### The downloaded engine is incomplete (`NPM_FAILED`, no lockfile)
- **Cause:** the checkout has no `package-lock.json`, so dependencies cannot be installed. Usually a
  damaged or half-made clone.
- **Fix:** use the offered re-download (*Reset engine files*). It deletes the checkout and clones again; your `.env` is kept (restored from `env.backup`), `.gev-cache` and `node_modules` are not.

### The downloaded engine folder is damaged (`GIT_FAILED`, missing or not a repository)
- **Cause:** `C` or `C/.git` was deleted or corrupted.
- **Fix:** use the offered re-download. Saved API keys in `C/.env` are kept. If you deleted the whole
  `C`, the keys are gone; re-enter them in POWER UP.

### The expected version was not found / A download step failed / The update couldn't be applied (`GIT_FAILED`)
- **Cause:** a git step failed, or the mirror no longer has the commit the app expects (for example
  after the channel or remote was changed).
- **Fix:** Retry; if it repeats, use the re-download (*Reset engine files*, which also keeps only `.env`). Check Preferences › Engine channel and that
  `remoteUrl` in `state.json` is the mirror (<https://github.com/gonzoinceng-ctrl/opentac-engine>).

### GitHub took too long to answer (`GIT_FAILED`, timeout)
- **Cause:** a git operation hit its time limit on a slow or filtered connection.
- **Fix:** Retry on a better connection.

### The update source changed unexpectedly (`TAG_DRIFT`)
- **Cause:** a release tag on the mirror now points at different code than the copy on your Mac. The
  mirror forbids moving its tags, so this indicates a mirror integrity problem. OpenTac stops on
  purpose and does not auto-recover.
- **Fix:** nothing is lost and the installed version still runs (choose Restart Server). Do not force
  anything. Report it on the app repository so the owner can inspect the mirror.

### The usual port is already in use (`PORT_IN_USE`) / The port is already in use (`EADDRINUSE`)
See "Port in use" below.

### God's Eye View took too long to start (`START_TIMEOUT`)
- **Cause:** the engine server did not become ready in time, or printed its ready line but did not
  answer HTTP. The first start after an install can take up to about a minute (Vite optimises
  dependencies); a very slow or busy Mac can take longer.
- **Fix:** Retry. If it repeats, Reinstall dependencies. The error panel shows the last engine output, and `main.log` has the launcher's start and exit lines.

### A required piece is missing (`VITE_MISSING`)
- **Cause:** `C/node_modules` is incomplete or deleted (the engine needs its Vite dev server at runtime,
  so installs must include development dependencies).
- **Fix:** Reinstall. This is the expected result of deleting `node_modules` while the app is running.

### God's Eye View didn't start / stopped unexpectedly (`START_FAILED`)
- **Cause:** the engine process exited before it was ready, or crashed. The panel shows the last lines.
  Typical causes: an engine release that needs a newer app, a corrupt dependency tree, a port conflict,
  a bad `.env` line, or a dependency that cannot load.
- **Fix:** Restart, then Reinstall, then read the last output in the CRASHED panel and the launcher lines in `main.log`. After a crash OpenTac restarts the server
  once automatically; a second crash within 60 seconds waits for you (crash-loop guard). If this began
  right after an engine update, OpenTac rolls back automatically; if the rollback also failed you will
  see "Couldn't go back to the previous version" with Retry, Reinstall and Show Logs.

### The summary provider isn't working
- **Cause:** the local AI gateway reported a problem: Ollama not running or the model name wrong, a
  missing or wrong OpenRouter/xAI key, or the provider answering with empty text (thinking models
  can spend the whole token budget on reasoning).
- **Fix:** Preferences › AI › Test shows the reply, latency and finish reason. Start Ollama, pick an
  installed model, re-enter the key, or switch the summary provider back to OpenAI.

### Something went wrong (`UNKNOWN`)
- **Cause:** an unexpected error. The raw line and a stack are in `main.log`.
- **Fix:** Retry; if it repeats, copy diagnostics and file an app issue.

### Couldn't go back to the previous version (rollback failed)
- **Cause:** an engine update failed to start, and restoring the previous commit or its dependencies
  also failed (often offline with a cold npm cache).
- **Fix:** connect to the network and Retry (reinstalls from cache or the registry), or Reinstall. The
  rollback marker stays in `state.json` so the next launch offers it again.

## Other symptoms

### Provider Settings says a key is "external"
- **What you see:** in the engine's POWER UP / Provider Settings panel the OpenAI key row is locked and
  reads as set from the environment; saving it fails with a 409.
- **Cause:** OpenTac has a summary provider other than OpenAI selected (Ollama, OpenRouter or xAI). The
  engine only calls its OpenAI summary code when `OPENAI_API_KEY` is non-empty, so OpenTac passes a
  **placeholder** value in the engine's process environment (only if `C/.env` has no OpenAI key of its
  own). Upstream treats any key present in the environment at boot as "external" and read-only. The
  placeholder is not a real key and never reaches OpenAI.
- **Fix:** Preferences › AI › set the summary provider back to **OpenAI**; the engine restarts without the
  placeholder and the row is editable. To use voice with a non-OpenAI summary provider, enter your
  real OpenAI or Gemini key **before** switching (if `C/.env` already holds a key, nothing is locked
  and voice loads it). Voice is never rerouted; it needs OpenAI or Gemini.
- **Other rows locked too?** The shell starts the engine with a clean environment containing none of
  the engine's provider keys. If a different row is "external", something put that variable into the
  engine's environment: check for a custom launcher override or tooling that exports it.

### Port in use
- **What you see:** "The usual port is already in use" with Retry and "Use a different port".
- **Cause:** OpenTac pins one local port per install (4173 if it was free on first run) because
  layers, favourites, the SDR choice and the microphone permission are stored per origin
  (`http://127.0.0.1:<port>`). Another program (a dev server, an old OpenTac process, a different app)
  is on that port.
- **Fix:** find it: `lsof -iTCP:<port> -sTCP:LISTEN -n -P` (the port is `lastPort` in `D/state.json`),
  quit that program or `kill` a stale `opentac-start` process, then Retry and your saved state is intact.
  If you cannot free it, choose **Use a different port**: it works, but saved layers and permissions
  will look reset because the origin changed. (Moving back later restores them.)

### Gatekeeper warning
- **What you see:** "OpenTac can't be opened because Apple cannot check it for malicious software",
  "cannot be opened because the developer cannot be verified", or "OpenTac is damaged and can't be
  opened".
- **Cause:** official releases are signed with a Developer ID and notarized, so none of these should
  appear. They mean: the download is incomplete or modified (the "damaged" message), you are running a
  local unsigned build (`npm run pack`), or the app was copied in a way that dropped its signature.
- **Fix:** delete the app and download it again from <https://opentac.icu> or GitHub Releases; compare
  the SHA-256 shown on the download page. Verify with
  `spctl -a -vv -t install /Applications/OpenTac.app` (expected: `accepted`,
  `source=Notarized Developer ID`) and `xcrun stapler validate /Applications/OpenTac.app`. For your
  **own** unsigned build only, right-click › Open, or System Settings › Privacy & Security › Open
  Anyway. Do not bypass Gatekeeper for a build whose origin you do not know.

### npm not found in the doctor report
- **What you see:** upstream's setup doctor report says `npm` is missing or the environment is not
  ready. OpenTac runs the doctor only after an install, keeps its text in memory and does **not** write
  it to a log. `main.log` has only the summary line `Setup doctor finished: ready=… exit=…` (and
  `setup doctor: ready=… exit=…` from the controller).
- **To see the report:** run the bundled doctor by hand in `C`, with the bundled Node's `bin/` first on
  PATH (as the engine has it):
  `cd C && PATH=/Applications/OpenTac.app/Contents/Resources/node/bin:$PATH /Applications/OpenTac.app/Contents/Resources/node/bin/node scripts/setup-doctor.mjs`.
- **Cause:** upstream's `npm run doctor` runs `npm --version` through PATH. OpenTac puts the bundled
  Node's `bin/` first on the engine's PATH, so `Resources/node/bin/npm` (a link into the bundled npm)
  must exist. It is missing in a damaged or incomplete bundle, or in a development tree whose
  `vendor/node` was fetched by an older `fetch-node`.
- **Fix:** packaged app: reinstall OpenTac. Development: `rm -rf vendor/node && npm run fetch-node`, and
  confirm `vendor/node/darwin-<arch>/bin/npm` and
  `…/lib/node_modules/npm/bin/npm-cli.js` exist. The doctor never blocks start-up; "not ready" for
  missing optional API keys is normal and needs no action.

### The globe is blank or very slow
- **Cause:** WebGL is running in software, or the GPU process failed.
- **Fix:** *View › Developer › GPU Status* and check the log for WebGL `enabled` and `gpu_compositing`
  `enabled`. Quit other GPU-heavy apps, update macOS, and try *Engine › Open in Browser* to compare. On a
  Mac that cannot do hardware WebGL the globe will be slow regardless.

### The page flashes or reloads after saving a key
Not a bug. Saving a key restarts the engine server internally and reloads the page; the shell keeps
retrying for up to 15 seconds. It is a problem only if the window never comes back; then use
*Engine › Restart Server*, then read the launcher lines in `main.log` and use *Engine › Open in Browser* to see whether the engine itself answers.

### Layers, favourites or the microphone choice vanished
- **Cause:** the local port changed (see "Port in use"), or the browser profile was cleared.
- **Fix:** restore the original port (free it and relaunch). Browser state is tied to the origin and
  cannot be copied between ports.

### Microphone does not work
- **Cause:** macOS denied it (System Settings › Privacy & Security › Microphone, OpenTac off), or no
  OpenAI/Gemini key is configured for voice.
- **Fix:** enable OpenTac there, relaunch, and enter the key in POWER UP. OpenTac shows a one-time
  dialog pointing at this setting if it was denied. To see the prompt again:
  `tccutil reset Microphone icu.opentac.app`.

### The SDR layer finds no device
- **Cause:** no dongle, the picker was cancelled, or another app holds the device.
- **Fix:** plug it in, close other SDR software, reopen the layer and choose the device; the choice is
  remembered across restarts.

### An update says "Update OpenTac first"
The new engine release needs a newer app than the one installed. Use *OpenTac › Check for App
Updates…*, install it, then check for engine updates again. The engine update is never applied until
then.

### Engine › Reset to Upstream… does nothing
The menu item only acts while the app is in the ERROR state (the controller returns immediately in any
other phase). From a running globe, use the update disclosure's *Reset and update* instead; from an
error panel use *Reset engine files*.

### Reset everything
Quit OpenTac, back up `C/.env` if you want to keep your keys, and delete the data directory (or just
`C`). The next launch is a first run. See [`DATA-DIR.md`](DATA-DIR.md) for what each path holds.
