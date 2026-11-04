# Manual QA script

Run this before every public release, on the signed build from the draft release, and tick every
box by hand. Sources: `docs/brief/01-BRIEF.md` ("Definition of done"), `05-PRODUCTION-READINESS.md`
("Runtime behaviour", "Updates", "Failure handling") and the Phase 6 failure drills in
`04-IMPLEMENTATION-PLAN.md`, adjusted by `docs/DECISIONS.md` and `docs/SHELL-DESIGN.md`.

Every step has an action, an expected result and a checkbox. A step that cannot be run (no
hardware, no second Mac) is marked "not executed" with the reason, never ticked. Checkboxes are left
unticked in the repository; tick them in a copy and attach it to the release.

| Field | Value |
|---|---|
| App version / arch | |
| Engine commit / `stable-*` tag | |
| macOS version / machine | |
| Tester / date | |

## 0. Setup and helpers

- **Fresh data directory.** For drills that must not touch your real install, launch with
  `OPENTAC_DATA_DIR=/tmp/opentac-qa`. From a packaged app:
  `OPENTAC_DATA_DIR=/tmp/opentac-qa /Applications/OpenTac.app/Contents/MacOS/OpenTac`. From source:
  `OPENTAC_DATA_DIR=/tmp/opentac-qa npm run dev`. Delete the directory between drills that need a
  first run. **This is fully isolated only for unpackaged builds** (`npm run dev`): there Chromium's
  profile and the logs move to `$OPENTAC_DATA_DIR/electron-user-data` and `$OPENTAC_DATA_DIR/logs`.
  A **packaged** app only moves the shell's data directory; it keeps the real install's Chromium
  profile, `~/Library/Logs/OpenTac/` and the single-instance lock. When testing the packaged app,
  **quit the real install first**, or run the whole script from a separate macOS user account.
- **Logs.** `tail -f ~/Library/Logs/OpenTac/main.log` (packaged; for an unpackaged run with
  `OPENTAC_DATA_DIR`, `$OPENTAC_DATA_DIR/logs/main.log`). *Engine › Show Logs* opens the folder. The
  engine's stdout/stderr is also teed to `server.log` in the same folder (timestamped, redacted,
  with `[gev:shell]` ready/exit markers); the last 200 lines are in the setup window log tail and
  CRASHED/ERROR panels, and the engine's own files are in `C/.gev-logs/`; `main.log` (info level)
  records the launcher's spawn, ready line and exit. `OPENTAC_LOG_LEVEL=debug` raises `main.log`
  verbosity for one run.
- **Data layout.** See `docs/DATA-DIR.md`. `D` below means the data directory, `C` means `D/checkout`.
- **Bundled git** (for staging a stale checkout):
  `GIT=/Applications/OpenTac.app/Contents/Resources/app.asar.unpacked/node_modules/dugite/git/bin/git`.
- **Child process.** `pgrep -fl opentac-start` shows the engine server process.
- **Listening sockets.** `lsof -iTCP -sTCP:LISTEN -P -n | grep -E 'node|OpenTac'`.
- **Needs two engine commits.** For update drills the mirror must have a `stable` ahead of an older
  commit or tag you can start from (for example an upstream tag such as `v0.2.1`). If the real mirror
  has no gap, point `OPENTAC_ENGINE_REMOTE` at a fixture or fork that does.

## 1. First run

Use a fresh macOS user account with no developer tools if you can (no git, no Node, no Xcode CLT).

- [ ] **1.1 Open the disk image.** Download the `.dmg` from the draft release, open it, drag OpenTac to Applications, launch. *Expected:* no "unidentified developer", "damaged" or malware dialog; the app opens.
- [ ] **1.2 Setup window credit.** *Expected:* the first screen carries "OpenTac is an unofficial desktop app for God's Eye View by Bilawal Sidhu (MIT)" with a working repository link, and honest copy about downloading about 200 MB of source and about 400 MB of dependencies from GitHub and npm.
- [ ] **1.3 Clone, install, start.** Watch the setup window. *Expected:* phases run CLONING, INSTALLING, STARTING with a progress bar and a streaming log tail; no stack traces; the log tail scrolls and pauses when scrolled up. npm's "deprecated" and "install-scripts" advisories are not shown in the tail (they stay in `main.log`). Once RUNNING the setup window shows only a compact status line ("You can close this window."), with no bar or log, and hides itself after the last notice is dismissed.
- [ ] **1.4 Globe renders.** Wait (a few minutes on a normal connection; first Vite start can take up to about 60 s). *Expected:* the main window appears at `http://127.0.0.1:<port>/`, the setup window hides, the globe renders and live aircraft appear with no keys entered.
- [ ] **1.5 Pinned port.** `cat D/state.json`. *Expected:* `lastPort` is set (4173 if it was free) and `installedCommit`, `installedLockHash`, `installedNodeVersion` and `lastSuccessfulStart` are filled in; `rollbackCommit` is null.
- [ ] **1.6 Loopback only.** Run the `lsof` helper. *Expected:* the engine listens on `127.0.0.1:<port>` only, never `*` or `0.0.0.0`. (With a non-OpenAI AI provider the gateway is also `127.0.0.1` only.)
- [ ] **1.7 Doctor does not block.** `grep -i doctor ~/Library/Logs/OpenTac/main.log`. *Expected:* a `Setup doctor finished: ready=… exit=…` line (the report text itself is not logged); "not ready" for missing optional keys does not stop the app.
- [ ] **1.8 About panel.** OpenTac › About OpenTac…. *Expected:* credit line to Bilawal Sidhu with repo link, app version, engine commit / upstream tag / `stable-*` tag, channel, **Engine source** (the remote), Electron / bundled Node versions, a credit link to the upstream repository, and a licences link (THIRD_PARTY_NOTICES.md on GitHub until opentac.icu is live).

## 2. Quit and relaunch

- [ ] **2.1 Warm start time.** Quit with Cmd-Q, relaunch, time to the globe. *Expected:* under about 15 s, no INSTALLING phase; `main.log` shows the install check as up to date.
- [ ] **2.2 Browser state kept.** Before quitting, add a favourite or toggle a layer; after relaunch check it. *Expected:* still there (same port, so same origin).
- [ ] **2.3 Window bounds.** Resize and move the main window, quit, relaunch. *Expected:* restored; on a changed display arrangement the window still lands on a visible display.
- [ ] **2.4 Quit leaves nothing running.** Cmd-Q, then `pgrep -fl opentac-start` and `lsof` helper. *Expected:* no engine process, port released within a few seconds.
- [ ] **2.5 Close window is not quit.** Click the red close button. *Expected:* window closes, Dock icon stays, the server keeps running; clicking the Dock icon re-shows the globe; Cmd-Q then quits for real.
- [ ] **2.6 Force quit of the shell.** `kill -9` the OpenTac main process. *Expected:* the engine child exits by itself within a few seconds (stdin watchdog); no orphan in `pgrep`.

## 3. Keys

- [ ] **3.1 Save a Cesium ion token.** In the engine's POWER UP panel (or Preferences › API keys, see 16.1) enter a valid Cesium ion token and save. *Expected:* the page reloads, photorealistic tiles appear, the shell never shows CRASHED or an error; `pgrep -fl opentac-start` shows the **same pid** before and after (the server restarts internally; upstream behaviour).
- [ ] **3.2 Where the token lives.** *Expected:* `C/.env` contains the token, mode `-rw-------` (`ls -l`). `grep -r <token> D ~/Library/Logs/OpenTac` finds it **only** in `C/.env`.
- [ ] **3.3 Token survives an engine update.** Do steps 5.3 to 5.6, then recheck. *Expected:* the token row still shows as set and tiles still load.
- [ ] **3.4 No keys leak into the engine's environment.** `ps eww -p <engine pid> | tr ' ' '\n' | grep -E 'API_KEY|TOKEN|SECRET'`. *Expected:* nothing from the engine key list (see DECISIONS "Engine contract drift"), so no row in Provider Settings is marked "external". (The one exception is the deliberate `OPENAI_API_KEY` placeholder when a non-OpenAI summary provider is active; see 14.4.)
- [ ] **3.5 Keys survive Reset and relaunch.** After 5.10 (Reset and update) and, separately, 5.11(b) (Reset engine files) and a relaunch the key is still present. *Expected:* yes.

## 4. Menus and windows

- [ ] **4.1 Menu structure.** *Expected:* OpenTac (About, Check for App Updates…, Preferences ⌘,), Engine (Check for Engine Updates…, Open in Browser, Restart Server, Reload Page, Show Logs, Reinstall Dependencies…, Download Engine Again…, Provider Settings Help), View › Developer (Toggle DevTools, GPU Status, Open Data Folder, Copy Diagnostics), Window (Minimize, Zoom, Close with Cmd-W, Bring All to Front), Help (God’s Eye View README, Report an Engine Issue, Report an App Issue, opentac.icu). Open About OpenTac…: it lists the OpenTac and engine versions, the engine channel, **Engine source** (the remote URL) and a credit line linking to the upstream repository; its licences link currently opens THIRD_PARTY_NOTICES.md on GitHub until the website domain is live. Engine items say "engine"; app items say "app" or "OpenTac"; the two are never mixed.
- [ ] **4.2 Open in Browser.** *Expected:* the default browser loads the same `127.0.0.1:<port>` URL and the globe works there.
- [ ] **4.3 Copy Diagnostics.** *Expected:* clipboard holds versions plus the last 50 log lines with secrets redacted.
- [ ] **4.4 Accessibility basics.** In the setup window use Tab and Shift-Tab; press Esc in Preferences and About. *Expected:* visible focus, logical order, controls labelled for VoiceOver, Esc closes the panel.

## 5. Engine update

Stage a stale checkout: quit; delete `D` (or use a fresh `OPENTAC_DATA_DIR`); launch once with
`OPENTAC_ENGINE_REF=<older tag or SHA>` so the first run installs the older commit; wait for RUNNING;
enter a Cesium token (3.1) so there is something to preserve; quit; relaunch **without** the override.

- [ ] **5.1 Stale checkout detected.** *Expected:* about 20 s after RUNNING the setup window shows the disclosure panel; the globe keeps running behind it.
- [ ] **5.2 Disclosure contents.** *Expected:* remote URL (credentials redacted), channel `stable`, from → to using tag names where known, commit count, subjects newest first, author and date, diffstat, whether `package-lock.json` changed, a working GitHub compare link, and "Tested by OpenTac on <date>, gate run <link>, canary <N> days" (the canary is a 72-hour trial period where a new engine version is run and checked before it is promoted to everyone). No untested banner on `stable`. Buttons: Update, Later, Skip this version.
- [ ] **5.3 Apply.** Click Update. *Expected:* main window is disabled and progress shows; the server is stopped **first**, then checkout, then install only if the lockfile changed (the log says why), then start; the globe reloads without quitting the app.
- [ ] **5.4 Result recorded.** *Expected:* About shows the new engine commit / tag; `state.json` `installedCommit` is the new commit, `rollbackCommit` and `skippedCommit` are null; `git -C C log -1` matches (use `$GIT`).
- [ ] **5.5 Fast-forward only.** `$GIT -C C reflog -5`. *Expected:* detached checkouts of the target commit only; no merge or rebase commits.
- [ ] **5.6 Keys and caches preserved.** *Expected:* `C/.env` unchanged (same checksum as before), `C/.gev-cache/` still present, token still works (3.3).
- [ ] **5.7 Up to date.** Engine › Check for Engine Updates… right after. *Expected:* a message naming the engine version and `stable-*` tag; no fetch needed (log shows the `ls-remote` shortcut).
- [ ] **5.8 Rollback by interrupted update.** Quit. Edit `D/state.json`: set `rollbackCommit` to the older commit's full SHA while the checkout is at the newer one. Launch with `OPENTAC_FAIL_START_ONCE=1`. *Expected:* the first start fails, the shell enters ROLLING_BACK, checks out the older commit (reinstalling only if the lockfile differs), starts successfully (the variable is used for one spawn only), reaches RUNNING at the older commit with a visible notice ("Restoring the previous version" while it works); `rollbackCommit` is cleared.
- [ ] **5.9 Rollback variant: the post-update start fails.** Stage a stale checkout (as for 5.1) and launch with `OPENTAC_FAIL_START_ONCE=1`; apply the update as in 5.3. *Expected:* `rollbackCommit` is persisted before the start, so the first post-update start fails, the shell rolls back to the previous commit (reinstalling only if the lockfile differs), the second start succeeds, the progress panel says "Restoring the previous version", the final notice says the update did not start, the previous version was restored and that update is marked as skipped (choose Check for Engine Updates to try it again), and `skippedCommit` is set to the failed target so it is not offered again on launch or in the 6-hourly check. (A plain launch of a current install with the variable set and no `rollbackCommit` starts normally: the controller arms the flag only while a rollback marker exists, so there is no "plain launch ERROR" variant.)
- [ ] **5.10 Dirty tree.** Quit. `echo x >> C/README.md`. Relaunch and trigger an update (stale first, as above). *Expected:* the disclosure flags the dirty tree, lists the modified file, and offers **Reset and update** only; plain Update is not offered. After Reset and update: the file is restored, `C/.env` and `C/.gev-cache/` untouched, nothing the user entered lost.
- [ ] **5.11 Download Engine Again menu (ERROR phase only).** (a) With the globe RUNNING choose Engine › Download Engine Again…. *Expected:* no destructive confirmation; a message "This is only available when the engine shows an error" that points to Reinstall Dependencies… and Check for Engine Updates… instead. Nothing is deleted. (b) Reach ERROR (for example 7.15, `rm -rf C/.git`), then click *Reset engine files* (or use the menu item). *Expected:* one dialog "Download the engine again?" (asked once, not twice); after confirming, the **whole** `C` is deleted, re-cloned and reinstalled (CLONING, INSTALLING, STARTING), and the app runs. Only `C/.env` is kept (restored via `D/env.backup`); `C/.gev-cache/` and `C/node_modules/` are rebuilt, not kept.
- [ ] **5.12 Channel switch to candidate.** Preferences › Updates › Canary (the `candidate` channel: a version still inside its 72-hour trial period, before it is promoted to everyone). *Expected:* warning "Canary: may break"; an immediate interactive check; the disclosure carries the yellow **untested** banner (if `candidate` equals `stable`, the message says up to date).
- [ ] **5.13 Channel switch back to stable (backwards move).** Switch from `candidate` or `upstream` (while ahead of `stable`) back to `stable`. *Expected:* the disclosure says the target is an **older commit** and offers Reset and update; confirming moves the checkout back and reinstalls only if the lockfile differs. Check `upstream` shows the untested banner too. A backwards move is titled "Move the engine back to an older version", carries a warning banner, and says how many commits it removes rather than "0 commits"; the decision buttons stay in view without scrolling.
- [ ] **5.14 Skip this version.** Click Skip on a disclosure; relaunch. *Expected:* no prompt on launch or in the 6-hourly check; `state.json` `skippedCommit` is set. Engine › Check for Engine Updates… (interactive) **ignores** the skip and shows the disclosure again. (A `severity: security` promotion bypasses a skip; execute only if you have one, else mark not executed.)
- [ ] **5.15 Later.** Click Later. *Expected:* panel closes; next check re-offers it.
- [ ] **5.16 Launch check is rate limited.** Relaunch twice within 6 h with no new commit. *Expected:* nothing visible (no panel, no notice) and no new `lastUpdateCheck` in `state.json`. The skip itself is logged **only at debug level** (`launch update check skipped: last check was …`), so set App settings › Log detail to debug (or launch with `OPENTAC_LOG_LEVEL=debug`) before this step if you want to see it in `main.log`; at the default level the log is silent. Interactive checks always run.
- [ ] **5.17 Other triggers.** Sleep and wake, and refocus the window after more than 6 h of `lastUpdateCheck` age (edit the field to simulate). *Expected:* a quiet check runs on resume and on focus, once per window.
- [ ] **5.18 minShell gate.** Point `OPENTAC_ENGINE_REMOTE` at a fixture whose `stable-*` annotation has a `minShell` above the app version. *Expected:* an "Update OpenTac first" panel with a Check for App Updates button; the engine update is never applied.
- [ ] **5.19 Offline update check.** Turn Wi-Fi off, Engine › Check for Engine Updates…. *Expected:* after about 1.5 s a "Contacting GitHub…" panel appears; an unreachable remote counts as offline after the `ls-remote` timeout (about 30 s, not minutes), then a non-blocking "Couldn't reach GitHub" notice; the globe keeps working; Dismiss hides the setup window. The launch-time variant is logged only. See also 11.2.

## 6. App update

Needs two published releases (for example 0.1.0 installed, 0.1.1 published). Mark not executed if only one exists.

- [ ] **6.1 Detect.** OpenTac › Check for App Updates…. *Expected:* "OpenTac X is available. Download now?" with the version and release notes; the engine is not mentioned.
- [ ] **6.2 Download and restart.** Accept. *Expected:* download progress; then "Restart to update"; on confirm the engine server stops **before** the app quits (no orphan afterwards), the app relaunches at the new version.
- [ ] **6.3 Data untouched.** *Expected:* `D` unchanged (checkout, `.env`, `state.json`, window bounds); the engine starts without INSTALLING.
- [ ] **6.4 Both architectures.** Repeat on arm64 and on Intel (or x64 under Rosetta). *Expected:* each arch gets its own update file (`latest-mac.yml` lists both).
- [ ] **6.5 No downgrade.** Offer an update older than the installed version (or inspect config). *Expected:* never offered; `allowDowngrade` is false.
- [ ] **6.6 Unpackaged builds.** Run `npm run dev` and check for app updates. *Expected:* the updater is inactive.
- [ ] **6.7 What a pack build can and cannot test.** `app-update.yml` is written only by `npm run dist` (dmg/zip) builds, not by `npm run pack`. A pack build therefore has no update configuration, logs an ENOENT for `app-update.yml` on every app-update check, and cannot be used to test shell auto-update; use a `dist` build or the draft release for 6.1 to 6.5.

## 7. Failure drills

For each drill, afterwards run the "recovery" check: the app returns to RUNNING without deleting anything by hand unless the step says so. Every ERROR panel must show: a plain-language message, the underlying error line, Retry, Show Logs, and Reset where it makes sense. No stack trace is ever shown in the UI.

- [ ] **7.1 No network during clone.** Fresh data dir, Wi-Fi off, launch. *Expected:* ERROR "Could not reach the engine repository" (`NETWORK`) with Retry and Show Logs; no hang (timeouts apply); no half-made `C` that blocks a retry. Turn Wi-Fi on, click Retry. *Expected:* clone, install, start complete normally.
- [ ] **7.2 No network mid-clone.** Start a first run, turn Wi-Fi off while CLONING. *Expected:* same error and recovery as 7.1.
- [ ] **7.3 No network during update.** With a stale checkout (section 5 staging), turn Wi-Fi off before Update, or during the fetch. *Expected:* a soft failure (5.19) or an error that leaves the checkout and the running app intact; reconnect and retry works.
- [ ] **7.4 No network during `npm ci`.** Stage an update that changes the lockfile; cut the network after UPDATING begins. *Expected:* install fails with `NETWORK` after one automatic retry; the checkout is rolled back and dependencies reinstalled from the warm `npm-cache`; if that cannot work offline the ERROR is actionable (Retry, Reinstall, Show Logs) and `rollbackCommit` remains in `state.json`.
- [ ] **7.5 `npm ci` failure.** Run with `OPENTAC_NPM_CLI_OVERRIDE` pointing at a script that prints an error and exits 1 (fresh data dir). *Expected:* ERROR "Installing dependencies failed" (`NPM_FAILED`) with the tail of npm's output as the raw error line, plus Retry, Show Logs and Quit OpenTac (no Reinstall button here; Engine › Reinstall Dependencies… is the menu route); the globe never starts half-installed.
- [ ] **7.6 Server crash after start and crash-loop guard.** With the globe running, `kill -9 $(pgrep -f opentac-start)`. *Expected:* state CRASHED, but the setup window stays hidden during the one automatic restart; when it succeeds a notice says the engine "stopped unexpectedly (it was stopped by signal SIGKILL) and was restarted automatically". The crash panel (shown instead if the restart fails or automatic restart is off) names the exit reason (signal or exit code) and shows the engine output since the current start (a few lines after a quick kill, not 200), with Restart / Show Logs / Reinstall dependencies. Kill it again **within 60 s**. *Expected:* no second automatic restart; the CRASHED panel waits for you. Click Restart: it recovers. Wait over 60 s, kill once more: automatic restart works again.
- [ ] **7.7 Port stolen.** Quit. `nc -l 127.0.0.1 $(jq .lastPort D/state.json)` in a terminal. Launch. *Expected:* ERROR `PORT_IN_USE`; the headline is generic and the raw-error box names the port ("Port N is not free on 127.0.0.1."); Retry and "Use a different port", and the warning that saved layers and permissions will appear reset. Stop `nc`, Retry: starts on the same port. Repeat with `nc` running and choose "Use a different port": starts on a new port; `lastPort` updated; the globe shows default (reset) browser state.
- [ ] **7.8 Port taken during launch (race).** Start `nc` just after the probe (hard to time; try a loop that grabs the port when `opentac-start` appears). *Expected:* one automatic retry after 1 s, then the same ERROR as 7.7. Mark not executed if you cannot hit the window.
- [ ] **7.9 Deleted `node_modules` while quit.** Quit, `rm -rf C/node_modules`, launch. *Expected:* INSTALLING with a reason of no `node_modules` (see `main.log`), then RUNNING; no manual step.
- [ ] **7.10 Deleted `node_modules` while running.** `rm -rf C/node_modules`, then Engine › Restart Server. *Expected:* an ERROR that says dependencies are not installed (`VITE_MISSING`) offering Reinstall; Reinstall repairs it.
- [ ] **7.11 Dirty tracked file.** Covered by 5.10; additionally confirm a dirty tree never blocks plain launch: edit a tracked file, relaunch. *Expected:* the app starts normally and only the update path mentions the edit.
- [ ] **7.12 Corrupt `state.json`.** Quit. `echo '{ not json' > D/state.json`. Launch. *Expected:* the app starts; `D/state.json.bak` holds the bad file; `main.log` has a warning that the state was rejected; a one-time notice at startup says the settings file was damaged and was reset, and lists what was kept (a garbage file keeps nothing: defaults, channel `stable`); the install check re-detects state (a reinstall from the warm cache is acceptable); the port may differ from before, so browser state may look reset. Repeat with a **truncated** file (cut a real `state.json` in the middle): the channel and the port are kept (found by pattern) and named in the notice. Repeat with valid JSON in which one field is wrong (for example a bad `installedCommit` but good `channel`, `lastPort`, `ai`, `app`): those four are kept field by field and named in the notice (update channel, port, summary provider, App settings).
- [ ] **7.13 Disk space low (not yet verified on a real full disk: the panel copy and its Retry-only button set have never been seen).** Create a small volume: `hdiutil create -size 1g -fs APFS -volname QA /tmp/qa.dmg && hdiutil attach /tmp/qa.dmg`, then launch with `OPENTAC_DATA_DIR=/Volumes/QA/d`. *Expected:* ERROR `DISK_SPACE` (less than 2 GB free) with Retry, before any clone starts. `hdiutil detach /Volumes/QA` afterwards.
- [ ] **7.14 Disk fills during install.** Use a volume just over 2 GB, or fill it during INSTALLING. *Expected:* ERROR "not enough free disk space" (`DISK_FULL`) with the raw ENOSPC line, Retry after freeing space works. Mark not executed if you cannot build the situation.
- [ ] **7.15 Engine checkout damaged.** Quit, `rm -rf C/.git`, launch. *Expected:* ERROR "The downloaded engine folder is damaged" (code `GIT_FAILED`, from `NOT_A_REPO`: a checkout folder without `.git`; not the "Couldn't download God's Eye View" panel) with *Reset engine files* (download again), Show Logs and Quit OpenTac; the message says saved API keys are kept; after re-download `C/.env` is still there.
- [ ] **7.16 Mirror tag drift (if testable).** Against a fixture remote where a mirrored tag moves. *Expected:* ERROR `TAG_DRIFT` explaining mirror integrity; it is never auto-recovered. Mark not executed otherwise.
- [ ] **7.17 Timeouts.** With a blackholed network (for example firewall the host), start a clone. *Expected:* the operation fails by timeout with an error rather than spinning forever.
- [ ] **7.18 Ready line only.** Start the engine and watch the log. *Expected:* the shell switches to RUNNING on `[OpenTac] Ready at http://127.0.0.1:<port>/`, not on Vite's own "Local:" line.

## 8. Voice (microphone)

Needs an OpenAI (or Gemini) key entered in POWER UP.

- [ ] **8.1 Prompt appears once.** Reset the grant first: `tccutil reset Microphone icu.opentac.app`. Click the mic in the globe. *Expected:* a single macOS prompt whose text reads "OpenTac uses the microphone for hands-free voice control."; allow it.
- [ ] **8.2 Voice works.** *Expected:* voice control connects and answers; no second prompt on later clicks or after a restart.
- [ ] **8.3 Denial is handled.** `tccutil reset Microphone icu.opentac.app`, click the mic, choose Don't Allow. *Expected:* the app does not crash; the engine shows its own error; a one-time dialog explains how to enable it in System Settings › Privacy & Security › Microphone. Enable it there, relaunch: voice works.
- [ ] **8.4 Other permissions denied.** In DevTools: `navigator.geolocation.getCurrentPosition(console.log, console.warn)`, `navigator.mediaDevices.getDisplayMedia()`. *Expected:* both are refused cleanly without a crash.

## 9. WebUSB (needs hardware)

Mark **not executed** without an RTL-SDR dongle.

- [ ] **9.1 Device picker.** Plug in a dongle and open the SDR layer. *Expected:* a device picker appears (Chromium-style or the shell's small picker), listing the dongle by name.
- [ ] **9.2 Stream plays.** Pick it. *Expected:* the SDR stream starts and audio/spectrum shows.
- [ ] **9.3 Choice remembered.** Quit, relaunch, open the SDR layer. *Expected:* no picker; the device connects. `state.json` `usbDevices` holds vendor, product, product name and serial.
- [ ] **9.4 Two dongles with one serial.** If you have two boards sharing a serial, pick one and relaunch. *Expected:* the remembered one is the one you picked, not whichever enumerates first. Otherwise mark not executed.
- [ ] **9.5 Cancel and unplug.** Cancel the picker; unplug mid-stream. *Expected:* no crash; the engine reports the disconnect.

## 10. Autoplay, links and GPU

- [ ] **10.1 Autoplay.** Open a CCTV stream and a radio station. *Expected:* both start without a click.
- [ ] **10.2 External links.** Click an `https:` link inside the globe (credits, a feed source). *Expected:* opens in the default browser; no new OpenTac window appears. `mailto:` opens the mail client.
- [ ] **10.3 Navigation is confined.** In DevTools run `location.href='https://example.com'`, `window.open('file:///etc/hosts')`, `window.open('javascript:alert(1)')`. *Expected:* the main window never leaves the engine origin; `https:` goes to the default browser; the others do nothing.
- [ ] **10.4 GPU status.** View › Developer › GPU status. *Expected:* log shows WebGL `enabled` and `gpu_compositing` `enabled` (not software).
- [ ] **10.5 Fullscreen and clipboard.** Enter fullscreen from the globe; copy a coordinate. *Expected:* both work for the engine origin.
- [ ] **10.6 Globe stops drawing (Cesium "cartesian has a NaN component" / "Rendering has stopped").** This is an intermittent upstream halt that is hard to trigger on purpose; if it happens, or if you can provoke Cesium's red error overlay in DevTools, watch the globe. *Expected:* the shell notices the overlay and reloads the page within about 1.5 s, at most three times in ten minutes; the log has `globe render error #N` lines. When the three reloads are used up and the globe is still dead, a dialog "The globe stopped drawing" offers *Reload Page* or *Not Now*. Mark not executed if the halt cannot be reproduced.

## 11. Sleep, wake and connectivity

- [ ] **11.1 Sleep/wake.** With the globe running, put the Mac to sleep for a few minutes and wake it. *Expected:* the server is still the same process, the page reconnects its feeds without a manual reload, and a quiet update check is logged on resume.
- [ ] **11.2 Network drop and return.** Turn Wi-Fi off for a minute, then on. *Expected:* feeds recover; the shell stays RUNNING; no error panel.
- [ ] **11.3 Key save does not look like a crash.** Save any key; the page briefly fails to load while Vite restarts. *Expected:* the window retries and recovers within 15 s with no CRASHED state.

## 12. Instances and resources

- [ ] **12.1 Two instances.** With OpenTac running, `open -n /Applications/OpenTac.app`. *Expected:* no second window or second engine; the first window is focused. `pgrep -fl opentac-start` shows one process.
- [ ] **12.2 Memory bound.** Idle at the globe for 10 minutes on an Apple Silicon Mac. Sum all OpenTac and `node` processes in Activity Monitor. *Expected:* under about 1.5 GB total (a sanity bound, not an SLA).
- [ ] **12.3 No unbounded log growth.** After a long session. *Expected:* `main.log` rotates at about 10 MB (electron-log `maxSize`); the in-memory ring buffer stays bounded (the crash panel shows 200 lines); `server.log` rotates at 10 MB and keeps five archives (`server.log.1` ... `server.log.5`), so the logs folder stays bounded at roughly 120 MB.
- [ ] **12.4 Binds loopback.** Repeat 1.6 after long use and with the AI gateway active. *Expected:* loopback only.

## 13. Gatekeeper and signing (fresh Mac or fresh user account)

Run on the `.dmg` downloaded **through a browser** so it is quarantined, ideally on a Mac that has
never seen the app. Do both architectures (Intel at least under Rosetta).

- [ ] **13.1 Open test.** Mount, drag, launch. *Expected:* no "unidentified developer" or "damaged" dialog.
- [ ] **13.2 `spctl`.** `spctl -a -vv -t install /Applications/OpenTac.app`. *Expected:* `accepted`, `source=Notarized Developer ID`.
- [ ] **13.3 `stapler`.** `xcrun stapler validate /Applications/OpenTac.app` and on the `.dmg`. *Expected:* "The validate action worked!".
- [ ] **13.4 `codesign`.** `codesign --verify --deep --strict --verbose=2 /Applications/OpenTac.app`. *Expected:* valid on disk, satisfies its Designated Requirement.
- [ ] **13.5 Bundled Node entitlements.** `codesign -d --entitlements - /Applications/OpenTac.app/Contents/Resources/node/bin/node`. *Expected:* JIT, unsigned executable memory, and library-validation-disabled entitlements are present.
- [ ] **13.6 Native addons load.** After a first run on the clean Mac, `grep -i -E 'dlopen|code signature|library validation' ~/Library/Logs/OpenTac/*.log`, then in `C` load the ad-hoc-signed addons with the bundled node: `/Applications/OpenTac.app/Contents/Resources/node/bin/node -e "require('sharp'); console.log('sharp ok')"` (and the platform rollup package under `C/node_modules/@rollup/`). *Expected:* no dlopen or signature errors in the logs; the native addons from `npm ci` (rollup, fsevents, sharp/libvips) load under the hardened runtime, and the engine starts.
- [ ] **13.7 Bundle contents per arch.** `file …/Resources/node/bin/node` and the unpacked `…/dugite/git/bin/git`. *Expected:* each matches the app's architecture (arm64 build ships arm64, x64 ships x86_64); `…/Resources/node/lib/node_modules/npm/bin/npm-cli.js` and `…/Resources/node/bin/npm` exist; no Git Credential Manager files in the dugite tree.
- [ ] **13.8 Fuses.** `npx @electron/fuses read --app /Applications/OpenTac.app`. *Expected:* RunAsNode disabled, cookie encryption enabled, NODE_OPTIONS disabled, inspect arguments disabled, asar integrity enabled, only-load-from-asar enabled.
- [ ] **13.9 Doctor sees npm.** The doctor report is not logged, so run it by hand: `cd C && PATH=/Applications/OpenTac.app/Contents/Resources/node/bin:$PATH /Applications/OpenTac.app/Contents/Resources/node/bin/node scripts/setup-doctor.mjs`. *Expected:* the report does not say npm is missing; `Resources/node/bin/npm` resolves into the bundled npm.

## 14. AI providers

- [ ] **14.1 Default untouched.** On a **new install** the summary provider is OpenAI (the engine's own behaviour; Ollama, OpenRouter and xAI are opt-in), and the engine's own OpenAI key row is editable. With provider OpenAI, the engine's environment (`ps eww -p <engine pid>`) shows no `OPENTAC_AI_GATEWAY_URL`; no gateway is listening. *Expected:* the engine's HUD summary requests go to OpenAI directly.
- [ ] **14.2 Ollama.** Run a small instruct model locally; Preferences › AI summaries › Ollama (opt-in), pick a model from the list (a select box fed by Ollama; OpenAI shows no model box), Test. *Expected:* the test shows the reply text, latency and finish reason (or a plain error); the server restarts; HUD summaries come from the local model. (Thinking models may return empty text; the Test button says so.)
- [ ] **14.3 OpenRouter and xAI.** Enter a key for each, Test. *Expected:* works; keys are in `secrets.json` (encrypted, mode 0600), not in `state.json`, `C/.env` or logs. If Keychain access is unavailable (unsigned dev build) the panel says so and refuses to store keys. Dev (unpackaged `npx electron .`) and packaged builds share one login-keychain item, "OpenTac Safe Storage"; a build with a different code signature than the one that created it makes macOS ask for the login password (Allow / Always Allow / Deny). The window must still appear and the app must stay usable while that dialog is up, with key storage reporting unavailable until it is answered. To reset on a test Mac: `security delete-generic-password -s 'OpenTac Safe Storage'`.
- [ ] **14.4 Placeholder key behaviour.** With a non-OpenAI provider active and no OpenAI key in `.env`, open Provider Settings. *Expected:* the OpenAI row is locked (shown as set externally) and the panel text explains why; with a real OpenAI key already in `.env` nothing is locked and voice still loads it.
- [ ] **14.5 Voice caveat visible.** *Expected:* the AI panel says voice control uses OpenAI or Gemini, configured in the POWER UP panel, and that the OpenAI row is locked while a non-OpenAI summary provider is on.
- [ ] **14.6 Provider offline.** Quit Ollama mid-session. *Expected:* HUD summaries degrade to upstream's keyless behaviour; no crash, no error panel.
- [ ] **14.7 Switch back.** Switch provider to OpenAI. *Expected:* the server restarts; the interceptor env var is absent again.

## 15. Logs and redaction spot-check

- [ ] **15.1 Key in logs.** After saving at least one key per provider you use: `grep -R -E 'sk-|AIza|ghp_|eyJ|Bearer ' ~/Library/Logs/OpenTac D --include='*.log' --include='*.json' | grep -v 'C/.env'`. *Expected:* no real secret anywhere; only `[REDACTED]` markers.
- [ ] **15.2 Assignments.** `grep -i -E 'api_key|token|secret' ~/Library/Logs/OpenTac/*.log`. *Expected:* values are `[REDACTED]`; non-secret settings such as `max_tokens=200` are not blanked.
- [ ] **15.3 URL credentials.** Use a remote URL with credentials via `OPENTAC_ENGINE_REMOTE=https://user:secret@example.invalid/x.git`. *Expected:* logs and the disclosure show `[REDACTED]@`.
- [ ] **15.4 Copy Diagnostics.** Paste it. *Expected:* nothing secret.
- [ ] **15.5 Telemetry.** Watch outbound connections for a minute with Little Snitch or `nettop`. *Expected:* only GitHub (mirror and releases), npm during installs, and whatever God's Eye View itself fetches; nothing to OpenTac-owned analytics (there is none).

## 16. Settings (Preferences)

Set `C` to the checkout directory (`<data dir>/checkout`). Open Preferences with Cmd-, and confirm
the six tabs: General, Updates, API keys, AI summaries, Engine settings, App settings.

- [ ] **16.1 Enter an engine key.** Preferences › API keys, with the engine RUNNING. The summary line says "N of M keys set." (the locked OpenAI placeholder is not counted) and every registry row shows its title, what it unlocks, a tier badge (Free key, Billing account, Optional paid), a state (Set / Not set / Locked) and a Get key link. Paste a Cesium ion token into its row, press Show to check it, then Save. *Expected:* the row says "Key saved. The engine is restarting itself", the main window reloads, the row shows **Set**, the shell never shows CRASHED, and `pgrep -fl opentac-start` shows the **same pid** before and after. `C/.env` contains `CESIUM_ION_TOKEN=<token>` (mode `-rw-------`), the rest of the file is unchanged, and the token is in no log (`grep -r <token> ~/Library/Logs/OpenTac` finds nothing).
- [ ] **16.2 Clear a key.** Press Clear on that row. *Expected:* the row returns to Not set, `C/.env` now has `# CESIUM_ION_TOKEN=` (commented out, not deleted), the engine restarts itself again, no CRASHED.
- [ ] **16.3 Two-variable key.** Enter only the OpenSky client id, Save, then the secret. *Expected:* the row stays Not set after the first and becomes Set after the second.
- [ ] **16.4 Engine not running.** Quit the engine (for example a rollback drill ending in ERROR, or open Preferences during STARTING). *Expected:* the list still shows, with a note that keys can be entered once the engine is running; the inputs are disabled; set/unset reflects the names in `C/.env`.
- [ ] **16.5 Locked row.** With a non-OpenAI summary provider chosen in Preferences › AI summaries (provider Ollama, no OpenAI key in `C/.env`) open API keys. *Expected:* the OpenAI row says **Locked** and the "N of M keys set" summary does not count the placeholder with the explanation that OpenTac supplies a placeholder key while summaries use another provider and that you should switch back to OpenAI (and enter your real key before switching away). Its inputs are disabled. Switch the provider back to OpenAI: after the restart the row is editable. For a key exported in the shell environment before launch, the row says "Managed outside Provider Settings".
- [ ] **16.6 OpenRouter and xAI.** In the same tab under "OpenTac AI summaries" save and remove an OpenRouter key. *Expected:* works as in 14.3; the key is in `secrets.json`, never in `C/.env`.
- [ ] **16.7 Engine setting round trip.** Preferences › Engine settings › Voice: pick a different voice (for example cedar), Save. *Expected:* the note "Saving restarts the engine to apply the settings." is visible, the window shows "Restarting the engine to apply settings…", **Preferences stays open** through the restart (the tabs and the Done button stay in view while you scroll), the engine goes RESTARTING, STARTING, RUNNING (new pid), `C/.env` has `OPENAI_REALTIME_VOICE=cedar` and everything else, comments and the key lines included, is unchanged. Reopen the tab: the voice shows cedar. Set it back to Default: the line becomes `# OPENAI_REALTIME_VOICE=`.
- [ ] **16.8 Validation.** In Spend and rate limits type `abc` or `-1` in a limit and Save. *Expected:* a plain refusal at the field itself (and a half-typed number such as `1e` or `-` is refused inline too), nothing written, no restart. Pasted keys are trimmed of stray spaces. A warning (for example the privacy warning on `GEV_VOICE_LOG_CONTENT`) appears only when it applies to the current value.
- [ ] **16.9 CCTV regions and secret.** In CCTV cameras turn one region off and set a camera cap, Save. *Expected:* one line per changed value in `C/.env`; untouched regions write nothing. In Data feeds enter an Ontario 511 key, Save: the field then shows "Saved" and never the value; Remove comments it out.
- [ ] **16.10 .env hygiene.** After 16.7 to 16.9: `ls -l C/.env` is `-rw-------`; `grep -c '' C/.env` shows no duplicated lines; no `HOST=`, `PORT=` or `VITE_` line was added by OpenTac.
- [ ] **16.11 App settings.** Switches save immediately. Launch at login (packaged build): the item appears under System Settings › General › Login Items. Turn off "Restart the engine automatically after a crash", `kill -9` the engine: *Expected:* CRASHED screen with Restart, no automatic restart. Set the update interval to "Only when OpenTac starts": no background checks after the launch check (see `main.log`). Log level: change it, relaunch: `main.log` honours it (unless `OPENTAC_LOG_LEVEL` is set, which wins).
- [ ] **16.12 Proxy.** Enter a proxy address with a user name (`http://u:p@host:1`): refused with a plain sentence. Enter a valid one: saved; `Engine › Reinstall Dependencies…` and an update check run with `HTTPS_PROXY` set (visible in `ps eww` of the npm child); after an engine restart `ps eww -p <engine pid>` shows `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` and `NODE_USE_ENV_PROXY=1`. Clearing both removes them.
- [ ] **16.13 Engine mirror.** The warning "Only change this to point at your own mirror; the default is the OpenTac mirror." is shown. `http://` and `git@…` addresses are refused. A valid `https://` or `file://` address is saved and the tab says it applies at the next launch; relaunch and confirm the remote in About. Reset to default clears it.
- [ ] **16.14 Maintenance buttons.** Open data folder and Open logs folder open Finder. Forget remembered USB devices asks first; afterwards the engine asks you to choose the SDR again. Reinstall dependencies needs a second click and then reinstalls; Reset engine files is disabled unless the app is in ERROR (Engine › Download Engine Again… shows an explanation instead).
- [ ] **16.15 Keyboard and labels.** Tab through every tab with the arrow keys; every field is reachable and read by VoiceOver with its label; Esc closes Preferences.

## Sign-off

- [ ] Every step above is ticked or marked "not executed" with a reason.
- [ ] Failures are recorded in `docs/DECISIONS.md` or as issues before release.
- [ ] `docs/brief/05-PRODUCTION-READINESS.md` ticked for everything this script proves.
