# CLAUDE.md — OpenTac

OpenTac is an **unofficial** desktop app for *God's Eye View* by Bilawal
Sidhu (MIT, https://github.com/bilawalsidhu/gods-eye-view). Credit him in the
About panel, setup window, README, website and THIRD_PARTY_NOTICES.md.

Electron (macOS) shell that runs the upstream open-source project
https://github.com/bilawalsidhu/gods-eye-view from a live git checkout in the
user's Application Support directory, using a bundled Node 24 runtime, and
updates that checkout from GitHub in place.

The full brief lives in `docs/brief/` (01–08). Read `01-BRIEF.md` and
`03-ARCHITECTURE.md` before changing anything structural.

## Non-negotiables

- Never vendor, fork or patch the upstream checkout. If upstream needs a
  change, note it in `docs/DECISIONS.md` and work around it on the shell side.
- The upstream server runs under the **bundled** Node (`Resources/node/bin/
  node`), never Electron's Node, never `node` on PATH.
- Git operations go through `dugite`. Never shell out to `git` on PATH.
- Renderers: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`. Preload surfaces are the ones in `03-ARCHITECTURE.md §4.7`
  and nothing more.
- Updates: the default channel follows `stable` on the OpenTac mirror
  (`08-STAGED-UPDATES.md`), never upstream directly. The mirror carries no
  engine commits of its own. Fast-forward only, full disclosure, explicit
  confirmation. Two
  separate mechanisms (upstream checkout vs Electron shell); keep their code
  and UI strings separate.
- Never write inside the `.app` bundle. Never log secrets (redaction in
  `src/main/logger.ts` is mandatory for anything that touches the server's
  output or `.env`).
- Bind the local server to `127.0.0.1` only.
- AI providers: only the HUD-summary endpoint may be rerouted (via the
  launcher's single-URL fetch interceptor + `src/main/aiGateway.ts`). Never
  reroute the Realtime voice endpoints. Provider keys for the gateway live in
  Keychain (`safeStorage`), never in the engine's `.env`.

## Commands

```
npm ci                      # install shell deps
npm run fetch-node          # download + verify bundled Node (both arches) into vendor/
npm run dev                 # run the shell against vendor/ node; data dir from OPENTAC_DATA_DIR if set
npm run typecheck
npm test                    # vitest unit + integration (uses temp dirs and a fixture git repo)
npm run e2e                 # playwright _electron smoke (needs a prepared data dir; see test/e2e/README)
npm run pack                # unsigned --dir build for local inspection
npm run dist                # signed + notarized dmg/zip (needs CSC_* and APPLE_* env)
```

Useful env in dev: `OPENTAC_DATA_DIR=/tmp/gev-data` (fresh first-run),
`OPENTAC_FAIL_START_ONCE=1` (simulate a post-update start failure to test
rollback), `OPENTAC_LOG_LEVEL=debug`, `OPENTAC_AI_GATEWAY_URL=http://127.0.0.1:PORT`
(set automatically by `server.ts` when a non-OpenAI summary provider is chosen).

## Layout

- `src/main/` — main process. One module per responsibility: `controller`
  (state machine), `checkout` (git), `install` (npm ci), `server` (spawn/
  readiness), `update` (upstream updates), `shellUpdate` (electron-updater),
  `windows`, `menu`, `permissions`, `ipc`, `state`, `paths`, `logger`,
  `ports`, `aiGateway`.
- `src/preload/` — `main.ts` (main window) and `setup.ts` (setup window).
- `src/renderer/setup/` — our only UI; plain TypeScript, no framework.
- `resources/launcher/opentac-start.mjs` — runs inside the checkout under bundled
  Node; mirrors upstream's `scripts/pinokio-start.mjs`. Keep it tiny and
  dependency-free (it may only import from the checkout's `node_modules`).
- `vendor/node/` — fetched, gitignored. `build/` — icon, entitlements.
- `test/unit`, `test/e2e`, `docs/`.

## Conventions

- TypeScript strict, ESM, Node 24 for tooling. Prettier defaults, 2 spaces.
- Every git/npm/network operation has a timeout and a log line at start and
  end with duration.
- Every state transition goes through `controller.transition(to, reason)` and
  is logged. No direct state mutation elsewhere.
- Errors shown to users are plain sentences plus the raw error line; never
  a stack trace in the UI (stacks go to the log).
- When you deviate from the brief, add a dated paragraph to
  `docs/DECISIONS.md`. Deviation is fine; silent deviation is not.
- Re-verify upstream behaviour against the live checkout when something
  upstream-dependent breaks; the brief's findings are from 2026-10-30.

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
