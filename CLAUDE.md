# CLAUDE.md — OpenTac

OpenTac is an **unofficial** desktop app for *God's Eye View* by Bilawal
Sidhu (MIT, https://github.com/bilawalsidhu/gods-eye-view). Credit him in the
About panel, setup window, README, website and THIRD_PARTY_NOTICES.md. Not
affiliated with him; distributed as a non-commercial project (upstream's
licence covers source code only, not its data and models).

Electron 45 (macOS) shell that runs the upstream open-source project from a
live git checkout in the user's Application Support directory, using a bundled
Node 24 runtime, and updates that checkout from GitHub in place.

The full brief lives in `docs/brief/` (01–08). Read `01-BRIEF.md` and
`03-ARCHITECTURE.md` before changing anything structural.
**`docs/SHELL-DESIGN.md` and `docs/DECISIONS.md` override the brief where they
differ.** Read both first; `08-STAGED-UPDATES.md` is the update model but
DECISIONS corrects its mechanics.

GitHub names: app repo `gonzoinceng-ctrl/opentac-desktop` (NOT
`gonzoinceng-ctrl/opentac`, an unrelated project), engine mirror
`gonzoinceng-ctrl/opentac-engine`, upstream `bilawalsidhu/gods-eye-view`, site
https://opentac.icu.

## Non-negotiables

- Never vendor, fork or patch the upstream checkout. If upstream needs a
  change, note it in `docs/DECISIONS.md` and work around it on the shell side.
- The upstream server runs under the **bundled** Node (`Resources/node/bin/
  node`), never Electron's Node, never `node` on PATH.
- Git operations go through `dugite`. Never shell out to `git` on PATH.
- Renderers: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`. The preload surface is the one in `docs/SHELL-DESIGN.md §8`
  and nothing more.
- Updates: the default channel (`stable`) follows the OpenTac mirror, never
  upstream directly. Channels are `stable | candidate | upstream`. The mirror
  carries no engine commits of its own. Fast-forward only, full disclosure,
  explicit confirmation. Two separate mechanisms (engine checkout vs Electron
  shell via electron-updater); keep their code and UI strings separate.
- Never write inside the `.app` bundle. Never log secrets (redaction in
  `src/shared/redact.ts`, applied by `src/main/logger.ts`, is mandatory for
  anything that touches the server's output or `.env`).
- Bind the local server and the AI gateway to `127.0.0.1` only. The engine
  port is pinned per install (browser state is keyed by origin).
- AI providers: only the HUD-summary endpoint may be rerouted (launcher fetch
  interceptor + `src/main/aiGateway.ts`, per-launch gateway token). Never
  reroute the Realtime voice endpoints. Gateway keys live in `secrets.json`
  encrypted via `safeStorage`, never in the engine's `.env`.
- Settings (docs/SHELL-DESIGN.md §14): engine keys are written **by the engine** through its own
  endpoint; engine settings are written by the shell into `.env` line by line (never the 12 registry
  variables, `HOST`, `PORT`, `VITE_*`); app settings live in `state.json` `app`. Never log or return a
  key or secret setting value.
- The engine child env is built clean: none of the engine's provider keys
  (see DECISIONS "Engine contract drift"), no `PINOKIO_SHARE_*`, no
  `ELECTRON_*`/`npm_config_*`.

## Commands

```
npm ci                      # install shell deps (postinstall downloads dugite's git)
npm run fetch-node          # download + SHA-256-verify bundled Node (both arches) into vendor/
npm run build               # tsc main, esbuild preloads (.cjs) + setup renderer -> dist/
npm run dev                 # build, then `electron .` against vendor/ node
npm run typecheck           # tsc --noEmit for main, preload, renderer (also `npm run lint`)
npm test                    # vitest run: unit + integration (temp dirs, fixture git repo)
npm run e2e                 # playwright _electron smoke (unpackaged build, OPENTAC_DATA_DIR)
npm run pack                # build + unsigned --dir app in release/
npm run dist                # build + dmg/zip, no publish (signs/notarizes if CSC_*/APPLE_* set)
npm run release             # build + dmg/zip, --publish always (manual only; CI builds with --publish never and leaves a draft)
```

Also `test:watch`, `make-icon`; mirror tests: `npm test` in `engine-mirror/`.
Website: `site/build.mjs` builds `site/dist/` (`site:build`/`site:dev` wrap it).

Unpackaged runs are named "OpenTac Dev" (own Keychain item and default data dir; never collide
with the installed app). Dev env overrides: `OPENTAC_DATA_DIR=/tmp/gev-data` (fresh first run),
`OPENTAC_ENGINE_REMOTE`, `OPENTAC_ENGINE_REF` (point at another remote/ref for
one run), `OPENTAC_LAUNCHER_OVERRIDE`, `OPENTAC_NODE_OVERRIDE`,
`OPENTAC_NPM_CLI_OVERRIDE` (fakes for tests; unpackaged builds only),
`OPENTAC_E2E_NO_EXTERNAL=1` (logs instead of opening external links; unpackaged builds only),
`OPENTAC_FAIL_START_ONCE=1` (consumed by the first server start made while
`rollbackCommit` is set, i.e. an update apply or a staged marker; passed to
that one spawn then stripped; a plain launch ignores it).
`OPENTAC_AI_GATEWAY_URL`/`_TOKEN` are set by the shell for non-OpenAI providers.

## Layout

- `src/main/` — main process, one module per responsibility. Pure/engine:
  `paths`, `state`, `logger`, `ringBuffer`, `ports`, `git`, `checkout`,
  `install`, `envFile`, `envSettings` (engine `.env` settings writer), `engineKeys` (client for the
  engine's `/api/setup/*`), `server`, `aiGateway`, `secrets`, `errors`,
  `policy` (pure navigation/permission/USB/bounds decisions), `contracts`
  (internal interfaces). Electron-bound: `index` (entry), `controller`
  (state machine), `update` (engine updates), `shellUpdate` (electron-updater),
  `windows`, `menu`, `permissions`, `ipc`.
- `src/preload/` — `main.ts` (main window), `setup.ts` (setup window),
  `usb.ts` (USB picker); bundled by esbuild to sandbox-safe `.cjs`.
- `src/renderer/setup/` — our only UI; plain TypeScript, no framework
  (`index.html`, `setup.ts`, `view.ts`, `styles.css`, `usb-picker.*`).
- `src/shared/` — `types.ts`, `ipc.ts` (channels + guards), `redact.ts`, `appSettings.ts`,
  `engineKeyCatalog.ts`, `engineSettingsCatalog.ts` (settings catalogues and validators). No
  Node builtins (it is bundled into the preloads and the renderer).
- `resources/launcher/opentac-start.mjs` — runs inside the checkout under the
  bundled Node; mirrors upstream's `scripts/pinokio-start.mjs`. Keep it tiny
  and dependency-free (it may only import from the checkout's `node_modules`).
- `scripts/` — `build.mjs`, `fetch-node.mjs` + `node-version.json` (single
  source of Node version/SHA-256, also read by the mirror), `make-icon.mjs`,
  release tooling (`merge-latest-mac.mjs`, `release-notes.mjs`,
  `sha256sums.mjs`, `verify-bundle.sh`, `verify-notarized.sh`),
  `check-toolchain-updates.mjs`; tests in `scripts/test/`.
- `test/` — `unit/`, `integration/` (fixture git repo, fake launcher/npm),
  `e2e/` (Playwright `_electron`), `fixtures/`, `helpers/`.
- `engine-mirror/` — the **mirror repo's contents** (default branch
  `opentac-ci`): workflows, `ci/` contract checks and tests, `manifest/`,
  `RELEASES.md`, `bootstrap.sh`. Published to `opentac-engine`, never run from
  here; engine refs are pushed separately and carry no OpenTac code.
- `site/` — the website (https://opentac.icu): `src/`, `build.mjs`, output in
  `site/dist/` (gitignored). Build-time data only, no third-party requests.
- `.github/workflows/` — `ci`, `release` (draft only), `site`, `deadman`,
  `shell-maintenance`.
- `build/` — icon, entitlements. `vendor/node/` — fetched, gitignored.
- `docs/` — `brief/` (01–08), `SHELL-DESIGN.md`, `DECISIONS.md`, `QA.md`
  (manual script), `DATA-DIR.md`, `TROUBLESHOOTING.md`.

## Conventions

- TypeScript strict, ESM, Node 24 for tooling. Prettier defaults, 2 spaces.
  Scripts are `.mjs` with no dependencies beyond Node builtins. GitHub Actions
  pinned to major tags, explicit `permissions:`, secrets never echoed, no
  inline `${{ }}` of untrusted strings inside `run:` (use `env:`).
- Every git/npm/network operation has a timeout and a log line at start and
  end with duration.
- Every state transition goes through `controller.transition(to, reason)` and
  is logged. No direct state mutation elsewhere.
- Errors shown to users are plain sentences plus the raw error line; never
  a stack trace in the UI (stacks go to the log). Map via `src/main/errors.ts`.
- **Electron 45 rules** (DECISIONS "round two"):
  - Never `await app.whenReady()` at top level (it never resolves). Register
    schemes and command-line switches synchronously, then
    `app.whenReady().then(boot)`.
  - `electron-updater` is CJS: `import updater from 'electron-updater'; const
    { autoUpdater } = updater;` (a named import crashes at load).
  - Sandboxed preloads cannot be ESM: bundle each to one `.cjs` with esbuild
    (`external: ['electron']`, no `node:` builtins).
  - WebUSB goes through `setPermissionCheckHandler` (return true for `usb` on
    the engine origin); `select-usb-device` must `event.preventDefault()`.
  - Navigation guards and `setWindowOpenHandler` live on `webContents`.
    `safeStorage`: use the async `encryptStringAsync`/`decryptStringAsync`.
- Deviating from the brief needs a dated paragraph in `docs/DECISIONS.md`;
  silent deviation is not allowed. Re-verify upstream behaviour against the
  live checkout when something upstream-dependent breaks.

## Things that look like bugs but aren't

- After saving an API key in the app, the page reloads and the server
  restarts internally. The child process does **not** exit. This is upstream
  behaviour (`server/standalone/key-setup.js` → `server.restart()`).
- First start after `npm ci` is slow (Vite dependency optimisation, up to
  ~60 s). Subsequent starts are fast.
- `npm run doctor` (upstream) reports "not ready" when optional keys are
  missing. We log it; we do not block on it.
- `vite` is a devDependency upstream but required at runtime. `npm ci` must
  install devDependencies.
- The default summary provider for new installs is OpenAI (no gateway, the engine's OpenAI key row is editable); Ollama, OpenRouter and xAI are opt-in.
- With a non-OpenAI summary provider chosen the engine's OpenAI key row is locked:
  the launcher passes a placeholder `OPENAI_API_KEY` and upstream treats env
  keys as "external". Intentional; documented in `docs/TROUBLESHOOTING.md`.
- Readiness is the `[OpenTac] Ready at http://127.0.0.1:PORT/` line only;
  Vite's own `Local:` line is deliberately ignored.
