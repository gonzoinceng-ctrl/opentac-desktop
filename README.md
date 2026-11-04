# OpenTac

OpenTac is an **unofficial** macOS desktop app for **God's Eye View**, the open-source real-time
globe created by [Bilawal Sidhu](https://github.com/bilawalsidhu/gods-eye-view) (MIT). All of the
globe, its data layers and its voice control are his work; OpenTac only wraps it so it opens with a
double-click: it bundles a Node runtime and git, keeps a live checkout of the project in your
Application Support folder, and updates that checkout from GitHub with full disclosure before
anything changes. OpenTac is independent. It is **not affiliated with, endorsed by, or supported
by** the upstream author.

Website: <https://opentac.icu> · Upstream: <https://github.com/bilawalsidhu/gods-eye-view>

> **Non-commercial.** Upstream's MIT licence covers its *source code only*. The data and assets it
> ships (TeleGeography submarine cables, CC BY-NC-SA; Bhote Koshi imagery, CC BY-NC; OpenStreetMap
> extracts, ODbL; third-party 3D models) and the live feeds it reads (for example Google Maps and
> OpenSky) carry their own terms, several of them non-commercial. OpenTac is distributed as a
> non-commercial project. The complete upstream `LICENSE`, including that data note, is reproduced
> in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## System requirements

- macOS 13.5 or later, Apple Silicon or Intel (separate builds for each).
- About 1 GB of free disk after the first run (the app itself is small; the engine checkout and its
  dependencies are not). The app refuses to start the first-run download with less than 2 GB free.
- An internet connection: the first run downloads the engine, and the globe reads live feeds.
- A Mac with working WebGL. OpenTac needs no developer tools, no Node, no git and no Xcode.

## Install

1. Download the `.dmg` for your Mac (Apple Silicon or Intel) from <https://opentac.icu> or from
   [GitHub Releases](https://github.com/gonzoinceng-ctrl/opentac-desktop/releases).
2. Open it and drag **OpenTac** to **Applications**, then launch it.
3. **First run downloads the engine from GitHub**: the God's Eye View source (about 200 MB git
   clone) and its dependencies (about 400 MB from npm). The setup window shows progress and the
   log. This takes a few minutes and needs the network. Later launches start in seconds and need no
   download.

No API keys are needed to see the globe. Keys unlock extra layers (see below).

## How updates work

There are **two independent update mechanisms**, kept separate in the code and in the UI.

**Engine updates** (the God's Eye View checkout). OpenTac follows the `stable` ref of the OpenTac
engine mirror, [`gonzoinceng-ctrl/opentac-engine`](https://github.com/gonzoinceng-ctrl/opentac-engine).
The mirror carries zero engine commits of its own: every commit on it exists in upstream's history.
It only advances after automated contract checks, upstream's own tests, an Electron smoke test and a
3-day canary period (a 72-hour trial period where a new engine version is run and checked before it is promoted to everyone). Before applying anything OpenTac shows a **disclosure**: the remote, the
commits (newest first), the diffstat, whether dependencies change, and for `stable` the gate run
and canary length. Nothing is applied until you click. Updates are fast-forward only; if the
update fails to start, OpenTac rolls the checkout back to the previous commit. Checks run shortly
after launch, every 6 hours while running, after sleep/wake and on window focus (rate limited);
**Engine › Check for Engine Updates…** checks immediately.

**App updates** (the Electron shell). OpenTac checks the GitHub Releases of
[`gonzoinceng-ctrl/opentac-desktop`](https://github.com/gonzoinceng-ctrl/opentac-desktop)
(`electron-updater`), asks before downloading, and asks again before restarting. Use
**OpenTac › Check for App Updates…**. A new engine release can require a newer app; OpenTac then
tells you to update the app first.

### Channels (Preferences › Updates)

| Channel | Follows | Meaning |
|---|---|---|
| `stable` (default) | `stable` on the mirror | Passed the gate and the canary. What everyone should use. |
| `candidate` | `candidate` on the mirror | Passed the gate, canary under way. "Canary: may break". For the owner's Mac. |
| `upstream` | `upstream-main` on the mirror | Raw upstream `main`, untested. Use it to find out whether a problem is OpenTac's or upstream's. |

`candidate` and `upstream` show a yellow "untested" banner in the disclosure. Switching to an older
commit (for example `candidate` to `stable`) is offered as a reset and says so.

## Settings

Preferences (⌘,) is the one place for every key and setting. Six tabs: **General** (a map of where
things live), **Updates** (channel and update checks), **API keys**, **AI summaries**,
**Engine settings** and **App settings**. Each kind of setting is stored where the part that uses it
looks for it, and nothing is stored twice:

| Tab | What | Where it is stored | How it is written |
|---|---|---|---|
| API keys: engine keys (Google Maps, OpenAI, Gemini, AISStream, NASA FIRMS, TomTom, Cesium ion, OpenSky, Mapillary, Launch Library) | The keys the engine's own POWER UP panel knows. The list is read live from the running engine, so it always matches the engine version. | `<data dir>/checkout/.env`, mode 0600 | By the **engine itself**, through its own `/api/setup/keys` endpoint. OpenTac only relays the request. The engine restarts itself and the page reloads (not a crash). Rows the environment manages are shown **Locked**. |
| API keys: OpenRouter and xAI (under "OpenTac AI summaries") | The optional HUD-summary providers | `<data dir>/secrets.json`, encrypted with Electron `safeStorage` | By OpenTac. Never in the engine's `.env`. |
| Engine settings | Voice models, spend and rate limits, data feeds, CCTV camera packs, the Ontario 511 key | `<data dir>/checkout/.env`, mode 0600 | By **OpenTac**, one line at a time, leaving every other line and comment alone. Saving a group restarts the engine so it re-reads the file. |
| App settings, Updates, AI summaries | Launch at login, crash restarts, update timing, log level, proxy, engine mirror, channel, summary provider | `<data dir>/state.json` | By OpenTac, immediately. |

Values you type are never logged and never read back into the window: a saved key shows only
"Set". See `docs/SHELL-DESIGN.md` section 14 for the design and `docs/QA.md` section 16 for the
manual checks. Every key and setting is optional; see upstream's "Keys & Costs" section for what each key
unlocks. Keys survive engine updates.

## AI providers and voice

HUD summaries can use **OpenAI** (the default for new installs: the engine's own path, with its own editable key row), or, if you opt in, **Ollama** (local),
**OpenRouter** or **xAI**, chosen in Preferences › AI summaries. For the non-OpenAI options OpenTac runs a
small gateway bound to `127.0.0.1` and reroutes only the engine's single HUD-summary request; the
OpenRouter and xAI keys are stored encrypted (`secrets.json`, protected by a Keychain key) and never
in the engine's `.env`.

**Voice control is not rerouted.** It uses OpenAI (Realtime over WebRTC) or Gemini (Live), with the
key entered under Preferences › API keys (or in the engine's POWER UP panel). While a non-OpenAI
summary provider is active, the engine's OpenAI key row is **Locked** (the engine sees a placeholder
key supplied by OpenTac and treats it as set by the environment); switch back to OpenAI to edit it,
and enter any voice key before you switch away. The Ollama, OpenRouter and xAI options do
not make voice local.

## Build from source

Requires Node 24 (`>=24.14.0 <25`) and macOS. Commands are the scripts in `package.json`:

```
npm ci                # install shell dependencies (also downloads dugite's git)
npm run fetch-node    # download + SHA-256-verify the bundled Node into vendor/ (both arches)
npm run build         # tsc main process, esbuild preloads (.cjs) and the setup renderer -> dist/
npm run dev           # build, then run the shell with Electron against vendor/ Node
npm run typecheck     # tsc --noEmit for main, preload and renderer
npm test              # vitest: unit + integration (temp dirs and a fixture git repo)
npm run e2e           # Playwright _electron smoke (unpackaged build; see test/e2e)
npm run pack          # build + unsigned .app in release/ (electron-builder --dir)
npm run dist          # build + dmg/zip for arm64 and x64 (signed/notarized when credentials exist)
```

Releases: CI builds each architecture on its own native runner with `--publish never` on a `v*`
tag, merges the two `latest-mac.yml` files and uploads a **draft** GitHub release; nothing in CI
publishes it, the owner does that by hand. The full procedure is in
[`docs/RELEASE.md`](docs/RELEASE.md). `npm run release` (`--publish always`) is for manual use only.

> **Warning:** a local `npm run dist` is not a valid release for the non-host architecture. dugite
> downloads git for the host architecture only, so building the other arch from the same
> `node_modules` yields an app that carries the wrong `git`. Build each arch on a matching Mac (or use
> CI).

Signing needs
`CSC_LINK`/`CSC_KEY_PASSWORD`; notarization needs `APPLE_API_KEY` (a **path** to the `.p8`),
`APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. A missing credential only warns, so CI verifies with
`xcrun stapler validate` and `spctl -a -vv -t install`. Each architecture is built on a native
runner because dugite downloads git for one architecture only.

### Development environment overrides

| Variable | Effect |
|---|---|
| `OPENTAC_DATA_DIR` | Use this directory instead of `~/Library/Application Support/OpenTac` (fresh first run). Unpackaged builds also move Chromium's profile and the logs under it (fully isolated); a packaged app does not, see [`docs/DATA-DIR.md`](docs/DATA-DIR.md). |
| `OPENTAC_ENGINE_REMOTE` | Override the engine remote URL for this run (not saved to `state.json`). |
| `OPENTAC_ENGINE_REF` | Override channel resolution with this ref for this run. |
| `OPENTAC_LAUNCHER_OVERRIDE` | Path to an alternative launcher script (tests use a fake). Unpackaged builds only. |
| `OPENTAC_NODE_OVERRIDE` | Path to an alternative `node` binary. Unpackaged builds only. |
| `OPENTAC_NPM_CLI_OVERRIDE` | Path to an alternative `npm-cli.js` (tests use a fake). Unpackaged builds only. |
| `OPENTAC_FAIL_START_ONCE` | Set to `1`. Consumed by the first server start made while a rollback marker exists (`rollbackCommit` in `state.json`), that is, during an update apply or a manually staged marker; that one start fails, so rollback runs. A plain launch ignores it. |

## Data directory

Everything OpenTac writes lives outside the signed app bundle:

- Data: `~/Library/Application Support/OpenTac/` (checkout, `.env`, caches, `state.json`)
- Logs: `~/Library/Logs/OpenTac/` (`main.log`, `server.log`)

Layout, what each path is for, and what is safe to delete: [`docs/DATA-DIR.md`](docs/DATA-DIR.md).

## Debugging

- **Logs**: *Engine › Show Logs* (or *View › Developer › Open Data Folder*). `main.log` is the shell's
  log (info level, rotated at 10 MB), including the engine launcher's start, ready and exit lines.
  The engine's stdout/stderr goes to `server.log` in the same folder (timestamped, with ready/exit
  markers, rotated at 10 MB, five archives kept); the last 200 lines are also in the setup window's
  log tail and crash panel, and the engine keeps its own files in `checkout/.gev-logs/`. Secrets are
  redacted before anything reaches either log. Set `OPENTAC_LOG_LEVEL` (`error`, `warn`, `info`,
  `debug`) to change `main.log` verbosity for one run.
- **Open in Browser**: *Engine › Open in Browser* loads the same local engine URL in your default
  browser, which separates "the engine is broken" from "the Electron window is broken".
- **DevTools**: *View › Developer › Toggle DevTools*; *GPU status* and *Copy Diagnostics* are in the
  same submenu.
- Symptom-by-symptom fixes: [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md). Manual test script:
  [`docs/QA.md`](docs/QA.md).

## Pointing at a fork

OpenTac follows whatever remote is in `state.json` (`remoteUrl`, in the data directory). To follow
your own mirror or fork, quit OpenTac, set `remoteUrl` (and `channel` to match a ref your remote has),
then relaunch; or try one without saving it using `OPENTAC_ENGINE_REMOTE` (and `OPENTAC_ENGINE_REF`).
The remote must carry the refs the channel names (`stable`, `candidate`, `upstream-main`) or you
can pin a ref with `OPENTAC_ENGINE_REF`. If the new remote does not share history with the current
checkout, use *Reset engine files* in the error panel (or *Engine › Download Engine Again…*, which only
acts while the app is in the ERROR state). It deletes the checkout, re-clones and reinstalls, and keeps
only your `.env`; `.gev-cache` and `node_modules` are not kept. To move an existing checkout to a
different commit on the same remote, use *Reset and update* in the update disclosure, which keeps
`.env`, caches and `node_modules`.

## Reporting issues

- Problems with the globe itself (layers, data, voice behaviour, rendering): the upstream project,
  <https://github.com/bilawalsidhu/gods-eye-view/issues>.
- Problems with the app (install, updates, windows, permissions, the AI gateway, packaging):
  <https://github.com/gonzoinceng-ctrl/opentac-desktop/issues>. Use *View › Developer › Copy
  Diagnostics* and attach the relevant `main.log` lines.

Not sure which? Switch to the `upstream` channel and see whether it reproduces.

## Licence

OpenTac's own source code is MIT, see [`LICENSE`](LICENSE) (also declared in `package.json`). God's Eye View is MIT, copyright (c)
2026 Bilawal Sidhu; that grant covers its source code only and **does not extend to third-party
data or 3D models**, which keep their own licences (several are non-commercial, see above). OpenTac
also redistributes Node.js, npm, git (GPLv2, as a separate executable), Electron and Chromium. All
notices, with upstream's `LICENSE` reproduced verbatim, are in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), the website's `/licenses` page and the app's About
panel.
