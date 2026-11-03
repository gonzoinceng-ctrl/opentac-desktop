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
- [ ] **1.3 Clone, install, start.** Watch the setup window. *Expected:* phases run CLONING, INSTALLING, STARTING with a progress bar and a streaming log tail; no stack traces; the log tail scrolls and pauses when scrolled up.
- [ ] **1.4 Globe renders.** Wait (a few minutes on a normal connection; first Vite start can take up to about 60 s). *Expected:* the main window appears at `http://127.0.0.1:<port>/`, the setup window hides, the globe renders and live aircraft appear with no keys entered.
- [ ] **1.5 Pinned port.** `cat D/state.json`. *Expected:* `lastPort` is set (4173 if it was free) and `installedCommit`, `installedLockHash`, `installedNodeVersion` and `lastSuccessfulStart` are filled in; `rollbackCommit` is null.
- [ ] **1.6 Loopback only.** Run the `lsof` helper. *Expected:* the engine listens on `127.0.0.1:<port>` only, never `*` or `0.0.0.0`. (With a non-OpenAI AI provider the gateway is also `127.0.0.1` only.)
- [ ] **1.7 Doctor does not block.** `grep -i doctor ~/Library/Logs/OpenTac/main.log`. *Expected:* a `Setup doctor finished: ready=… exit=…` line (the report text itself is not logged); "not ready" for missing optional keys does not stop the app.
- [ ] **1.8 About panel.** OpenTac › About OpenTac…. *Expected:* credit line to Bilawal Sidhu with repo link, app version, engine commit / upstream tag / `stable-*` tag, channel, remote, Electron / Chromium / bundled Node versions, a licences link.

## 2. Quit and relaunch

- [ ] **2.1 Warm start time.** Quit with Cmd-Q, relaunch, time to the globe. *Expected:* under about 15 s, no INSTALLING phase; `main.log` shows the install check as up to date.
- [ ] **2.2 Browser state kept.** Before quitting, add a favourite or toggle a layer; after relaunch check it. *Expected:* still there (same port, so same origin).
- [ ] **2.3 Window bounds.** Resize and move the main window, quit, relaunch. *Expected:* restored; on a changed display arrangement the window still lands on a visible display.
- [ ] **2.4 Quit leaves nothing running.** Cmd-Q, then `pgrep -fl opentac-start` and `lsof` helper. *Expected:* no engine process, port released within a few seconds.
- [ ] **2.5 Close window is not quit.** Click the red close button. *Expected:* window closes, Dock icon stays, the server keeps running; clicking the Dock icon re-shows the globe; Cmd-Q then quits for real.
- [ ] **2.6 Force quit of the shell.** `kill -9` the OpenTac main process. *Expected:* the engine child exits by itself within a few seconds (stdin watchdog); no orphan in `pgrep`.

## 3. Keys

- [ ] **3.1 Save a Cesium ion token.** In the engine's POWER UP panel enter a valid Cesium ion token and save. *Expected:* the page reloads, photorealistic tiles appear, the shell never shows CRASHED or an error; `pgrep -fl opentac-start` shows the **same pid** before and after (the server restarts internally; upstream behaviour).
- [ ] **3.2 Where the token lives.** *Expected:* `C/.env` contains the token, mode `-rw-------` (`ls -l`). `grep -r <token> D ~/Library/Logs/OpenTac` finds it **only** in `C/.env`.
- [ ] **3.3 Token survives an engine update.** Do steps 5.3 to 5.6, then recheck. *Expected:* the token row still shows as set and tiles still load.
- [ ] **3.4 No keys leak into the engine's environment.** `ps eww -p <engine pid> | tr ' ' '\n' | grep -E 'API_KEY|TOKEN|SECRET'`. *Expected:* nothing from the engine key list (see DECISIONS "Engine contract drift"), so no row in Provider Settings is marked "external". (The one exception is the deliberate `OPENAI_API_KEY` placeholder when a non-OpenAI summary provider is active; see 14.4.)
- [ ] **3.5 Keys survive Reset and relaunch.** After 5.10 (Reset and update) and, separately, 5.11(b) (Reset engine files) and a relaunch the key is still present. *Expected:* yes.

## 4. Menus and windows

- [ ] **4.1 Menu structure.** *Expected:* OpenTac (About, Check for App Updates…, Preferences ⌘,), Engine (Check for Engine Updates…, Open in Browser, Restart Server, Reload Page, Show Logs, Reinstall Dependencies…, Reset to Upstream…, Provider Settings Help), View › Developer (Toggle DevTools, GPU status, Open Data Folder, Copy Diagnostics), Help (upstream README, report engine issue, report app issue, opentac.icu). Engine items say "engine"; app items say "app" or "OpenTac"; the two are never mixed.
- [ ] **4.2 Open in Browser.** *Expected:* the default browser loads the same `127.0.0.1:<port>` URL and the globe works there.
- [ ] **4.3 Copy Diagnostics.** *Expected:* clipboard holds versions plus the last 50 log lines with secrets redacted.
- [ ] **4.4 Accessibility basics.** In the setup window use Tab and Shift-Tab; press Esc in Preferences and About. *Expected:* visible focus, logical order, controls labelled for VoiceOver, Esc closes the panel.

## 5. Engine update

Stage a stale checkout: quit; delete `D` (or use a fresh `OPENTAC_DATA_DIR`); launch once with
`OPENTAC_ENGINE_REF=<older tag or SHA>` so the first run installs the older commit; wait for RUNNING;
enter a Cesium token (3.1) so there is something to preserve; quit; relaunch **without** the override.

- [ ] **5.1 Stale checkout detected.** *Expected:* about 20 s after RUNNING the setup window shows the disclosure panel; the globe keeps running behind it.
- [ ] **5.2 Disclosure contents.** *Expected:* remote URL (credentials redacted), channel `stable`, from → to using tag names where known, commit count, subjects newest first, author and date, diffstat, whether `package-lock.json` changed, a working GitHub compare link, and "Tested by OpenTac on <date>, gate run <link>, canary <N> days". No untested banner on `stable`. Buttons: Update, Later, Skip this version.
- [ ] **5.3 Apply.** Click Update. *Expected:* main window is disabled and progress shows; the server is stopped **first**, then checkout, then install only if the lockfile changed (the log says why), then start; the globe reloads without quitting the app.
- [ ] **5.4 Result recorded.** *Expected:* About shows the new engine commit / tag; `state.json` `installedCommit` is the new commit, `rollbackCommit` and `skippedCommit` are null; `git -C C log -1` matches (use `$GIT`).
- [ ] **5.5 Fast-forward only.** `$GIT -C C reflog -5`. *Expected:* detached checkouts of the target commit only; no merge or rebase commits.
- [ ] **5.6 Keys and caches preserved.** *Expected:* `C/.env` unchanged (same checksum as before), `C/.gev-cache/` still present, token still works (3.3).
- [ ] **5.7 Up to date.** Engine › Check for Engine Updates… right after. *Expected:* a message naming the engine version and `stable-*` tag; no fetch needed (log shows the `ls-remote` shortcut).
- [ ] **5.8 Rollback by interrupted update.** Quit. Edit `D/state.json`: set `rollbackCommit` to the older commit's full SHA while the checkout is at the newer one. Launch with `OPENTAC_FAIL_START_ONCE=1`. *Expected:* the first start fails, the shell enters ROLLING_BACK, checks out the older commit (reinstalling only if the lockfile differs), starts successfully (the variable is used for one spawn only), reaches RUNNING at the older commit with a visible notice; `rollbackCommit` is cleared.
- [ ] **5.9 Rollback variant: the post-update start fails.** Stage a stale checkout (as for 5.1) and launch with `OPENTAC_FAIL_START_ONCE=1`; apply the update as in 5.3. *Expected:* `rollbackCommit` is persisted before the start, so the first post-update start fails, the shell rolls back to the previous commit (reinstalling only if the lockfile differs), the second start succeeds, a notice says the update was rolled back, and `skippedCommit` is set to the failed target so it is not offered again on launch or in the 6-hourly check. (A plain launch of a current install with the variable set and no `rollbackCommit` starts normally: the controller arms the flag only while a rollback marker exists, so there is no "plain launch ERROR" variant.)
- [ ] **5.10 Dirty tree.** Quit. `echo x >> C/README.md`. Relaunch and trigger an update (stale first, as above). *Expected:* the disclosure flags the dirty tree, lists the modified file, and offers **Reset and update** only; plain Update is not offered. After Reset and update: the file is restored, `C/.env` and `C/.gev-cache/` untouched, nothing the user entered lost.
- [ ] **5.11 Reset to Upstream menu (ERROR phase only).** (a) With the globe RUNNING choose Engine › Reset to Upstream… and confirm the first dialog. *Expected:* nothing happens (the controller ignores `resetCheckout` outside ERROR); `main.log` says it was ignored in phase RUNNING. Record this as a known no-op. (b) Reach ERROR (for example 7.15, `rm -rf C/.git`), then click *Reset engine files*, or use the menu item and confirm both dialogs. *Expected:* a second dialog "Download the engine again?"; after confirming, the **whole** `C` is deleted, re-cloned and reinstalled (CLONING, INSTALLING, STARTING), and the app runs. Only `C/.env` is kept (restored via `D/env.backup`); `C/.gev-cache/` and `C/node_modules/` are rebuilt, not kept.
- [ ] **5.12 Channel switch to candidate.** Preferences › Engine channel › Canary. *Expected:* warning "Canary: may break"; an immediate interactive check; the disclosure carries the yellow **untested** banner (if `candidate` equals `stable`, the message says up to date).
- [ ] **5.13 Channel switch back to stable (backwards move).** Switch from `candidate` or `upstream` (while ahead of `stable`) back to `stable`. *Expected:* the disclosure says the target is an **older commit** and offers Reset and update; confirming moves the checkout back and reinstalls only if the lockfile differs. Check `upstream` shows the untested banner too.
- [ ] **5.14 Skip this version.** Click Skip on a disclosure; relaunch. *Expected:* no prompt on launch or in the 6-hourly check; `state.json` `skippedCommit` is set. Engine › Check for Engine Updates… (interactive) **ignores** the skip and shows the disclosure again. (A `severity: security` promotion bypasses a skip; execute only if you have one, else mark not executed.)
- [ ] **5.15 Later.** Click Later. *Expected:* panel closes; next check re-offers it.
- [ ] **5.16 Launch check is rate limited.** Relaunch twice within 6 h with no new commit. *Expected:* log shows the check skipped by the rate limit; interactive checks always run.
- [ ] **5.17 Other triggers.** Sleep and wake, and refocus the window after more than 6 h of `lastUpdateCheck` age (edit the field to simulate). *Expected:* a quiet check runs on resume and on focus, once per window.
- [ ] **5.18 minShell gate.** Point `OPENTAC_ENGINE_REMOTE` at a fixture whose `stable-*` annotation has a `minShell` above the app version. *Expected:* an "Update OpenTac first" panel with a Check for App Updates button; the engine update is never applied.
- [ ] **5.19 Offline update check.** Turn Wi-Fi off, Engine › Check for Engine Updates…. *Expected:* a non-blocking "Couldn't reach GitHub" message; the globe keeps working; the launch-time variant is logged only. See also 11.2.

## 6. App update

Needs two published releases (for example 0.1.0 installed, 0.1.1 published). Mark not executed if only one exists.

- [ ] **6.1 Detect.** OpenTac › Check for App Updates…. *Expected:* "OpenTac X is available. Download now?" with the version and release notes; the engine is not mentioned.
- [ ] **6.2 Download and restart.** Accept. *Expected:* download progress; then "Restart to update"; on confirm the engine server stops **before** the app quits (no orphan afterwards), the app relaunches at the new version.
- [ ] **6.3 Data untouched.** *Expected:* `D` unchanged (checkout, `.env`, `state.json`, window bounds); the engine starts without INSTALLING.
- [ ] **6.4 Both architectures.** Repeat on arm64 and on Intel (or x64 under Rosetta). *Expected:* each arch gets its own update file (`latest-mac.yml` lists both).
- [ ] **6.5 No downgrade.** Offer an update older than the installed version (or inspect config). *Expected:* never offered; `allowDowngrade` is false.
- [ ] **6.6 Unpackaged builds.** Run `npm run dev` and check for app updates. *Expected:* the updater is inactive.

## 7. Failure drills

For each drill, afterwards run the "recovery" check: the app returns to RUNNING without deleting anything by hand unless the step says so. Every ERROR panel must show: a plain-language message, the underlying error line, Retry, Show Logs, and Reset where it makes sense. No stack trace is ever shown in the UI.

- [ ] **7.1 No network during clone.** Fresh data dir, Wi-Fi off, launch. *Expected:* ERROR "Could not reach the engine repository" (`NETWORK`) with Retry and Show Logs; no hang (timeouts apply); no half-made `C` that blocks a retry. Turn Wi-Fi on, click Retry. *Expected:* clone, install, start complete normally.
- [ ] **7.2 No network mid-clone.** Start a first run, turn Wi-Fi off while CLONING. *Expected:* same error and recovery as 7.1.
- [ ] **7.3 No network during update.** With a stale checkout (section 5 staging), turn Wi-Fi off before Update, or during the fetch. *Expected:* a soft failure (5.19) or an error that leaves the checkout and the running app intact; reconnect and retry works.
- [ ] **7.4 No network during `npm ci`.** Stage an update that changes the lockfile; cut the network after UPDATING begins. *Expected:* install fails with `NETWORK` after one automatic retry; the checkout is rolled back and dependencies reinstalled from the warm `npm-cache`; if that cannot work offline the ERROR is actionable (Retry, Reinstall, Show Logs) and `rollbackCommit` remains in `state.json`.
- [ ] **7.5 `npm ci` failure.** Run with `OPENTAC_NPM_CLI_OVERRIDE` pointing at a script that prints an error and exits 1 (fresh data dir). *Expected:* ERROR "Installing dependencies failed" (`NPM_FAILED`) with the tail of npm's output as the raw error line, plus Retry, Show Logs and Reinstall; the globe never starts half-installed.
- [ ] **7.6 Server crash after start and crash-loop guard.** With the globe running, `kill -9 $(pgrep -f opentac-start)`. *Expected:* state CRASHED, the setup window shows the last 200 log lines and Restart / Show Logs / Reinstall; one automatic restart brings it back. Kill it again **within 60 s**. *Expected:* no second automatic restart; the CRASHED panel waits for you. Click Restart: it recovers. Wait over 60 s, kill once more: automatic restart works again.
- [ ] **7.7 Port stolen.** Quit. `nc -l 127.0.0.1 $(jq .lastPort D/state.json)` in a terminal. Launch. *Expected:* ERROR `PORT_IN_USE` naming the port, with Retry and "Use a different port", and the warning that saved layers and permissions will appear reset. Stop `nc`, Retry: starts on the same port. Repeat with `nc` running and choose "Use a different port": starts on a new port; `lastPort` updated; the globe shows default (reset) browser state.
- [ ] **7.8 Port taken during launch (race).** Start `nc` just after the probe (hard to time; try a loop that grabs the port when `opentac-start` appears). *Expected:* one automatic retry after 1 s, then the same ERROR as 7.7. Mark not executed if you cannot hit the window.
- [ ] **7.9 Deleted `node_modules` while quit.** Quit, `rm -rf C/node_modules`, launch. *Expected:* INSTALLING with a reason of no `node_modules` (see `main.log`), then RUNNING; no manual step.
- [ ] **7.10 Deleted `node_modules` while running.** `rm -rf C/node_modules`, then Engine › Restart Server. *Expected:* an ERROR that says dependencies are not installed (`VITE_MISSING`) offering Reinstall; Reinstall repairs it.
- [ ] **7.11 Dirty tracked file.** Covered by 5.10; additionally confirm a dirty tree never blocks plain launch: edit a tracked file, relaunch. *Expected:* the app starts normally and only the update path mentions the edit.
- [ ] **7.12 Corrupt `state.json`.** Quit. `echo '{ not json' > D/state.json`. Launch. *Expected:* the app starts; `D/state.json.bak` holds the bad file; `main.log` has a warning that the state was rejected and defaults are used; defaults (channel `stable`) are in effect; the install check re-detects state (a reinstall from the warm cache is acceptable); the port may differ from before, so browser state may look reset. Repeat with valid JSON of the wrong shape (for example `{"schemaVersion": 2}`): same outcome.
- [ ] **7.13 Disk space low.** Create a small volume: `hdiutil create -size 1g -fs APFS -volname QA /tmp/qa.dmg && hdiutil attach /tmp/qa.dmg`, then launch with `OPENTAC_DATA_DIR=/Volumes/QA/d`. *Expected:* ERROR `DISK_SPACE` (less than 2 GB free) with Retry, before any clone starts. `hdiutil detach /Volumes/QA` afterwards.
- [ ] **7.14 Disk fills during install.** Use a volume just over 2 GB, or fill it during INSTALLING. *Expected:* ERROR "not enough free disk space" (`DISK_FULL`) with the raw ENOSPC line, Retry after freeing space works. Mark not executed if you cannot build the situation.
- [ ] **7.15 Engine checkout damaged.** Quit, `rm -rf C/.git`, launch. *Expected:* ERROR "The downloaded engine folder is damaged" (code `GIT_FAILED`, from `NOT_A_REPO`) with buttons for downloading it again, Show Logs and Quit; the message says saved API keys are kept; after re-download `C/.env` is still there.
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

- [ ] **14.1 Default untouched.** With provider OpenAI, the engine's environment (`ps eww -p <engine pid>`) shows no `OPENTAC_AI_GATEWAY_URL`; no gateway is listening. *Expected:* the engine's HUD summary requests go to OpenAI directly.
- [ ] **14.2 Ollama.** Run a small instruct model locally; Preferences › AI › Ollama, pick a model, Test. *Expected:* the test shows the reply text, latency and finish reason (or a plain error); the server restarts; HUD summaries come from the local model. (Thinking models may return empty text; the Test button says so.)
- [ ] **14.3 OpenRouter and xAI.** Enter a key for each, Test. *Expected:* works; keys are in `secrets.json` (encrypted, mode 0600), not in `state.json`, `C/.env` or logs. If Keychain access is unavailable (unsigned dev build) the panel says so and refuses to store keys.
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

## Sign-off

- [ ] Every step above is ticked or marked "not executed" with a reason.
- [ ] Failures are recorded in `docs/DECISIONS.md` or as issues before release.
- [ ] `docs/brief/05-PRODUCTION-READINESS.md` ticked for everything this script proves.
