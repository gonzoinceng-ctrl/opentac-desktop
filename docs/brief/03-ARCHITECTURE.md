# 03 — Architecture

> **Note:** the update *source* described in §4.1 `resolveTarget` and §4.4 is
> superseded by `08-STAGED-UPDATES.md` (the app follows `stable`/`candidate`/
> `upstream-main` refs on the OpenTac mirror, not upstream tags). The
> mechanics — fast-forward only, disclosure, dirty check, conditional
> reinstall, restart, rollback — are unchanged.

## 1. Process model

```
┌──────────────────────────────────────────────────────────────────┐
│  Electron main process  (TypeScript, ESM)                        │
│                                                                  │
│   AppController  ── state machine ──►  RuntimeManager            │
│        │                                 ├─ CheckoutManager (git via dugite)
│        │                                 ├─ InstallManager  (bundled node + npm ci)
│        │                                 ├─ ServerManager   (spawn launcher, readiness, crash)
│        │                                 └─ UpdateManager   (fetch, disclose, ff, reinstall, restart)
│        │                                                         │
│   WindowManager ── setup window (local HTML) / main window (http://127.0.0.1:PORT)
│   MenuManager                                                    │
│   ShellUpdater  (electron-updater → wrapper repo GitHub Releases)│
│   Logger        (electron-log; tees server stdout/stderr)        │
└───────────────┬────────────────────────────────────┬─────────────┘
                │ IPC (contextBridge)                │ spawn
   ┌────────────▼──────────────┐        ┌────────────▼──────────────────────┐
   │ Setup/Update renderer     │        │ Bundled Node 24.14.x               │
   │ (our HTML, sandboxed)     │        │ runs <checkout>/… via our launcher │
   └───────────────────────────┘        │ = Vite dev server + provider       │
                                        │   middleware on 127.0.0.1:PORT     │
   ┌───────────────────────────┐        └────────────▲──────────────────────┘
   │ Main renderer             │  http               │
   │ loads http://127.0.0.1:P  ├─────────────────────┘
   │ (upstream's own client)   │
   └───────────────────────────┘
```

Three processes at steady state: Electron main, the upstream server under
bundled Node, and the Chromium renderer for the main window. The main
renderer is upstream's code; we inject nothing into it except a preload that
exposes a tiny, namespaced bridge (`window.openTac`) which upstream does
not know about and does not need.

## 2. On-disk layout

### Inside the bundle (read-only, signed)

```
OpenTac.app/Contents/
  MacOS/OpenTac
  Resources/
    app.asar                       # shell code (main, preload, setup UI)
    node/                          # extraResources, per-arch at build time
      bin/node                     # 24.14.x, signed w/ hardened runtime + JIT entitlements
      lib/node_modules/npm/        # npm as shipped in the Node tarball
    launcher/
      opentac-start.mjs                # our mirror of upstream's pinokio-start.mjs
    git/                           # dugite's git binary tree (from node_modules, unpacked)
```

### User data (writable)

```
~/Library/Application Support/OpenTac/
  checkout/                        # full git clone of upstream
    .env                           # written by upstream's Provider Settings panel
    .gev-cache/  .gev-logs/        # upstream caches/logs
    node_modules/                  # npm ci output (incl. .vite dep cache)
  state.json                       # shell state (schema below)
  npm-cache/                       # npm's cache dir (--cache), keeps installs fast and sandboxed
~/Library/Logs/OpenTac/
  main.log                         # electron-log, rotated
  server.log                       # tee of the server's stdout/stderr, rotated
```

`state.json` schema (versioned, validated on read, rewritten atomically):

```jsonc
{
  "schemaVersion": 1,
  "channel": "stable" | "main",
  "remoteUrl": "https://github.com/bilawalsidhu/gods-eye-view.git",
  "installedCommit": "sha",          // HEAD at last successful install
  "installedLockHash": "sha256",     // of package-lock.json at last npm ci
  "installedNodeVersion": "24.14.0", // bundled node used for last npm ci
  "lastUpdateCheck": "ISO-8601",
  "lastSuccessfulStart": "ISO-8601",
  "lastPort": 4173,
  "updateCheckOnLaunch": true,
  "skippedCommit": "sha" | null      // "Remind me later" for one specific target
}
```

## 3. Lifecycle state machine (AppController)

```
BOOT
 ├─ no checkout ──────────────► CLONING ──► INSTALLING ──► STARTING ──► RUNNING
 ├─ checkout, lock hash ≠ ────► INSTALLING ──► STARTING ──► RUNNING
 ├─ checkout, node_modules gone ► INSTALLING ──► STARTING ──► RUNNING
 └─ checkout OK ─────────────────────────────► STARTING ──► RUNNING
                                                   │
RUNNING ── server exits unexpectedly ───────► CRASHED ── user: Restart ──► STARTING
RUNNING ── Check for Updates ───────────────► CHECKING ── up to date ──► RUNNING
                                                   └─ update available ──► DISCLOSING
DISCLOSING ── user: Update ────────────────► UPDATING(ff) ──► [INSTALLING if lock changed] ──► RESTARTING ──► RUNNING
DISCLOSING ── user: Later / Skip ──────────► RUNNING
any ── fatal error ────────────────────────► ERROR (setup window shows message + Retry / Show Logs / Reset)
```

Rules:
- `STARTING` has a 120 s budget on first run after install (dep optimisation),
  60 s thereafter. Readiness = HTTP GET `http://127.0.0.1:PORT/` returns 200
  **and** the launcher printed its ready line. Either alone is insufficient
  (Vite can listen before middleware is fully wired; stdout can be delayed).
- While `CLONING`/`INSTALLING`/`STARTING`/`UPDATING`, the **setup window** is
  visible with live progress. When `RUNNING`, the main window is shown and
  the setup window hidden (kept alive, not destroyed).
- `RESTARTING` after an update: show a lightweight overlay/toast in the setup
  window, keep the main window open but blocked (`setEnabled(false)`), then
  `webContents.reload()` once ready. Do not navigate to `about:blank`.
- An upstream-triggered `server.restart()` (key save) is **not** a crash: the
  child process does not exit, Vite restarts internally. Detect crash only by
  the child's `exit` event.

## 4. Components

### 4.1 CheckoutManager (git via dugite)

- `ensureCheckout()`: if `checkout/.git` missing → `git clone --no-checkout
  <remote> checkout` then `git checkout <target>`; progress parsed from
  `--progress` stderr into percentage for the setup UI. Full clone (not
  shallow): 114 MB once, and it makes `rev-list`, tags and ff-checks trivial.
- `resolveTarget(channel)`:
  - `stable`: `git tag --list 'v*'` → filter strict semver (`^v\d+\.\d+\.\d+$`,
    no pre-release) → highest by semver compare → `refs/tags/vX.Y.Z` (use the
    peeled commit `^{}`).
  - `main`: `refs/remotes/origin/main`.
- `fetch()`: `git fetch --prune --tags origin` with a 5-minute timeout.
- `status()`: `{ head, target, behind: rev-list --count HEAD..target,
  ahead: rev-list --count target..HEAD, dirty: DirtyReport }`.
- `DirtyReport` from `git status --porcelain=v1 --untracked-files=all
  --ignored=no`: any line means a *tracked file modified* or *untracked,
  non-ignored file*. Both block fast-forward. Ignored files (`.env`,
  `.gev-cache`, `node_modules`…) never appear and never block. ⚠ If upstream
  ever un-ignores something we rely on, this check surfaces it as "dirty";
  log the file list.
- `fastForward(target)`: `git merge --ff-only <target>` on a detached HEAD is
  awkward; instead keep the checkout **detached at the target commit**:
  `git checkout --detach <target>`. Since we never commit, "fast-forward"
  semantics are simply: target must be a descendant of HEAD
  (`git merge-base --is-ancestor HEAD target`). If not (upstream force-pushed
  or user switched channel backwards), treat as `needsReset` and explain.
- `resetToUpstream(target)`: `git reset --hard <target>` then `git clean -fd`
  **excluding** ignored files (`clean -fd` without `-x` already preserves
  ignored paths — verify with a test that `.env` survives).
- `commitLog(from, to)`: `git log --format=%h%x00%s%x00%an%x00%cI from..to`
  and `git diff --shortstat from..to`; cap display at 200 commits.
- Remote URL printed in the disclosure is credential-redacted (mirror
  upstream's `redactRemoteUrl`).
- Set `GIT_TERMINAL_PROMPT=0` and no credential helpers; the remote is public.
  If someone changes `remoteUrl` in `state.json` to a private repo, it fails
  cleanly rather than hanging.

### 4.2 InstallManager (bundled Node + npm)

- `nodePath()` = `<Resources>/node/bin/node`; `npmCliPath()` =
  `<Resources>/node/lib/node_modules/npm/bin/npm-cli.js`. Run npm as
  `node npm-cli.js …` — never via a shell, never via `npm` on PATH.
- `needsInstall()`: `node_modules` missing, or `sha256(package-lock.json) !==
  state.installedLockHash`, or `state.installedNodeVersion !==
  bundledNodeVersion`.
- `install()`: `node npm-cli.js ci --no-audit --no-fund --loglevel=notice
  --cache <AppSupport>/npm-cache` with env:
  `PUPPETEER_SKIP_DOWNLOAD=1`, `CI=1`, `PATH=<Resources>/node/bin:/usr/bin:/bin`
  (node-gyp fallback needs python/make only if a prebuilt is missing — do not
  promise this works; surface the error), `HOME` as normal, `npm_config_*`
  unset. Stream output to the setup UI and `server.log`.
- After success: run upstream's doctor `node scripts/setup-doctor.mjs` and
  log its report; if it says not ready, show the report but **do not block**
  (the doctor also complains about missing optional keys).
- Retry policy: one automatic retry on network-class failures (ECONNRESET,
  ETIMEDOUT, `npm ERR! network`), then surface to user with Retry.

### 4.3 ServerManager

- Port: try `state.lastPort`, else find a free port in 4173–4273 on
  `127.0.0.1` (bind test). Pass `PORT` and `HOST=127.0.0.1`; the launcher uses
  `strictPort: true`.
- Spawn: `<node> <Resources>/launcher/opentac-start.mjs` with `cwd = checkout`,
  env = clean base (`PATH`, `HOME`, `TMPDIR`, `LANG`) + `HOST`, `PORT`,
  `NODE_ENV=development`, `OPENTAC=1`, `OPENTAC_VERSION=<shell ver>`,
  `BROWSER=none`. **Do not** pass the shell's own env wholesale; no
  `ELECTRON_RUN_AS_NODE` leakage, no Pinokio variables.
- The launcher is **ours but must behave like upstream's
  `pinokio-start.mjs`** (import Vite only after env is final; `root` = cwd;
  `strictPort`; print `[OpenTac] Ready at http://127.0.0.1:PORT/`). It
  resolves `vite` from the checkout's `node_modules` via
  `createRequire(path.join(checkout, 'package.json'))`.
- Readiness: see §3. Also treat the string `EADDRINUSE` in stderr as
  "port stolen" → pick another port and retry once.
- Shutdown: on `before-quit`, send `SIGTERM`, wait up to 5 s, then `SIGKILL`
  the process group (`detached: true` + `process.kill(-pid)` so Vite's own
  worker children die too). Use `tree-kill` as a belt-and-braces fallback.
- Crash: child `exit` with non-zero code while state is `RUNNING` →
  `CRASHED`; show setup window with last 200 lines of `server.log`, buttons
  Restart / Show Logs / Reinstall dependencies. Auto-restart at most once
  within 60 s; never loop.

### 4.4 UpdateManager (upstream checkout)

Flow for `checkForUpdates({interactive})`:
1. `fetch()`; on failure → if interactive, show "Couldn't reach GitHub"
   (non-blocking); else log and continue.
2. `status()`; if `behind === 0` → "Up to date (vX.Y.Z / main @ abc1234)".
3. If `dirty` → disclosure shows the dirty file list and offers **Reset to
   upstream then update** or Cancel. Never ff over a dirty tree.
4. Build disclosure: remote (redacted), channel, `from → to` (tag names when
   on stable), N commits, subjects (newest first, max 200, link to
   `https://github.com/…/compare/from...to`), diffstat, and a flag
   `package-lock.json changed` → "will reinstall dependencies (~1–3 min)".
5. On confirm: `UPDATING`: `git checkout --detach <target>` → if lock changed
   `INSTALLING` → `RESTARTING` (SIGTERM server, wait exit, spawn, readiness)
   → `RUNNING` + `webContents.reload()`. Update `state.json` only after
   readiness succeeds; if start fails after update, offer **Roll back** =
   `git checkout --detach <previousCommit>` + conditional reinstall + start.
   Keep `previousCommit` in memory and in `state.json` as `rollbackCommit`
   until the next successful start.
6. Launch-time check (`updateCheckOnLaunch`): run after `RUNNING`, never
   before (the user should see the app first). Rate-limit to once per 6 h
   unless interactive. If `skippedCommit === target` stay quiet.
7. Channel switch `stable ↔ main`: same flow; switching from `main` back to
   `stable` is usually a *backwards* move (tag is an ancestor of main) →
   goes through `resetToUpstream` with an explicit "you will move to an older
   commit" notice. Caches and `.env` survive.

### 4.5 ShellUpdater (Electron app itself)

- `electron-updater` with `provider: github` pointing at the **wrapper**
  repo; checked once per launch after `RUNNING` + 30 s, and via menu.
- Standard flow: download in background → "Restart to update" dialog.
  Quitting for a shell update must go through the normal `before-quit` path
  so the server is terminated.
- Completely separate UI strings and code paths from §4.4. The About panel
  shows both versions: "OpenTac 1.2.0 · Engine: God's Eye View v0.3.0 (a725178, stable)".

### 4.6 WindowManager and renderer security

- **Setup window**: `BrowserWindow` 560×420, non-resizable, loads
  `app://setup/index.html` (custom scheme registered as privileged,
  `standard`, `secure`) with our own preload. Shows phase, progress bar,
  streaming log tail, and context-appropriate buttons. Also hosts the update
  disclosure, crash view and error view (one page, several panels).
- **Main window**: `BrowserWindow` default 1440×900, min 1024×640,
  `titleBarStyle: 'hiddenInset'` with a small draggable region is tempting
  but upstream's UI is edge-to-edge and we can't add drag regions to its DOM
  → use the **standard title bar**. `backgroundColor: '#0a0a0f'` (upstream's
  theme colour) to avoid white flash. Remember bounds in `state.json`.
- `webPreferences` for both: `contextIsolation: true`, `nodeIntegration:
  false`, `sandbox: true`, `webSecurity: true`, `preload` as appropriate,
  `spellcheck: false`.
- Navigation policy on the main window: `will-navigate` and
  `setWindowOpenHandler` → allow only `http://127.0.0.1:PORT/*`; everything
  else → `shell.openExternal` if `https:`/`mailto:`, else deny. The reload
  that upstream performs after a key save is same-origin → allowed.
- Permissions (`session.setPermissionRequestHandler` and
  `setPermissionCheckHandler`): allow `media` (audio only), `usb`,
  `clipboard-read`/`clipboard-sanitized-write`, `fullscreen`,
  `pointerLock` **only** for the server origin; deny everything else.
  Before the first media grant call `systemPreferences.askForMediaAccess(
  'microphone')` so the macOS TCC prompt appears with our usage string.
- WebUSB: `session.on('select-usb-device', (event, details, callback))` →
  show a native-looking picker (our own small window or a `dialog` with a
  list) listing `details.deviceList` (vendorId/productId/productName), and
  `session.setDevicePermissionHandler` returning `true` for devices the user
  picked (persist picks in `state.json` so `navigator.usb.getDevices()`
  returns remembered dongles, which upstream's `remembered` logic expects).
  Also `session.setUSBProtectedClassesHandler` returning `[]` is **not**
  needed (RTL-SDR is a vendor-specific class). ⚠ Verify against current
  Electron docs; this API has moved between majors.
- CSP: none from Electron for the main window; upstream sets it in headers.
  For the setup window, set a strict CSP meta tag (`default-src 'self'`).
- GPU: do not pass `--disable-gpu`; do not use offscreen rendering. Expose a
  debug menu item "GPU status" that dumps `app.getGPUFeatureStatus()` to the
  log. Consider `app.commandLine.appendSwitch('enable-features',
  'Metal')` only if measured to help; log any such switch in DECISIONS.md.
- Media: `app.commandLine.appendSwitch('autoplay-policy',
  'no-user-gesture-required')` so CCTV/radio streams that upstream starts
  programmatically aren't blocked.

### 4.7 IPC contract (preload → renderer, both windows)

Exposed as `window.openTac` (main window) / `window.openTacSetup` (setup
window). Everything is `invoke`-style with validated payloads (zod or hand-
rolled guards); the renderer can never pass raw paths or commands.

```ts
// shared
getVersions(): Promise<{ app: string; electron: string; node: string;
  upstream: { commit: string; tag: string | null; channel: 'stable'|'main' } }>
openExternal(url: string): Promise<void>           // https/mailto only, validated in main
openLogsFolder(): Promise<void>
// setup window only
onState(cb: (s: PublicState) => void): () => void  // {phase, progress?, message, logTail, disclosure?, error?}
action(name: 'retry' | 'confirmUpdate' | 'laterUpdate' | 'skipUpdate'
            | 'resetAndUpdate' | 'restartServer' | 'reinstall'
            | 'rollback' | 'quit'): Promise<void>
// main window only (used by the menu, not by upstream code)
```

Upstream's page never calls `window.openTac`; it exists for the menu-
driven actions and for a future "OpenTac" badge. Keep it tiny.

### 4.8 Menu

- **App**: About (both versions, licences) · Check for App Updates… ·
  Preferences… (channel, update-on-launch, reset data) · Quit.
- **Engine** (the upstream God's Eye View checkout): Check for Updates… · Open in Browser (opens
  `http://127.0.0.1:PORT/` externally — the escape hatch upstream's README
  recommends for debugging rendering) · Restart Server · Reload Page ·
  Open Provider Settings docs (external) · Show Logs · Reinstall
  Dependencies… · Reset to Upstream… (destructive, confirm).
- **View**: standard zoom/fullscreen; a **Developer** submenu (Toggle
  DevTools, GPU status) always present — this is a tool for one owner.
- **Help**: Upstream README, Report an upstream issue, Report an app issue.

### 4.9 Logging

- `electron-log` for main; levels to file `info`, console `debug` in dev.
- Server stdout/stderr → `server.log` with timestamps and a `[gev]` prefix;
  rotate at 10 MB × 5. The setup window's log tail reads from the in-memory
  ring buffer (last 500 lines), not from disk.
- Redact anything matching `(sk-[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{30,}|
  eyJ[A-Za-z0-9_-]{20,})` before writing to disk; upstream itself tries not
  to log keys but the shell must not be the leak.

## 5. Security model (summary)

| Concern | Control |
|---|---|
| Executing code pulled from the internet | Only from the configured public remote, only refs we resolved ourselves, only after fast-forward check and human confirmation with full disclosure. Default channel = tagged releases. |
| Renderer compromise via upstream page | Sandboxed, isolated renderer; preload exposes 3 harmless calls; no `remote`, no `nodeIntegration`; navigation locked to local origin. |
| Local server exposure | Binds 127.0.0.1 only; upstream's Host and Origin checks remain active. |
| Secrets | Live in `<checkout>/.env` (0600, written by upstream). Shell never reads or logs them. Log redaction as defence in depth. |
| Supply chain of the shell | Lockfile committed; `npm ci` in CI; electron-builder pinned; Node tarball checksum-verified against `SHASUMS256.txt` and the expected hash committed in the repo. |
| Tampering with the bundle | Code-signed, hardened runtime, notarized; `.app` is read-only in practice. |
| Tampering with the checkout | Not defended (it is the user's own data dir, same trust boundary as the user). Dirty check surfaces unexpected edits. |

## 6. Shell project layout

```
opentac/
  package.json  electron-builder.yml  tsconfig*.json  vite.config.ts (for setup UI only, optional)
  build/        entitlements.mac.plist  icon.icns  (generated from upstream logo.svg)
  resources/    launcher/opentac-start.mjs
  vendor/node/  darwin-arm64/ darwin-x64/   (gitignored; fetched by scripts/fetch-node.mjs)
  scripts/      fetch-node.mjs  make-icon.mjs  notarize.cjs
  src/main/     index.ts  controller.ts  state.ts  paths.ts  logger.ts
                checkout.ts  install.ts  server.ts  update.ts  shellUpdate.ts
                windows.ts  menu.ts  permissions.ts  ipc.ts  ports.ts
  src/preload/  main.ts  setup.ts
  src/renderer/ setup/  (index.html, setup.ts, styles.css — plain TS, no framework)
  test/         unit/ (vitest)  e2e/ (playwright _electron)
  docs/         brief/ (this pack)  DECISIONS.md
```
