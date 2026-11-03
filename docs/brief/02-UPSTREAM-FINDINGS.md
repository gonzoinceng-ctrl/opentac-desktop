# 02 — Upstream Findings

Everything below was established by reading the upstream repository at commit
`a725178e0f9f2748fcf5c6d09f66f74b1626d599` (2026-10-30, "Merge pull request
#1472"). Lines marked ⚠ are the ones most likely to drift; re-check them
against the live checkout before relying on them.

## Identity

- Repo: `https://github.com/bilawalsidhu/gods-eye-view` — MIT licence, author
  Bilawal Sidhu. `package.json` name `gods-eye-view`, version `0.3.0`.
- Tags: `v0.1.1`, `v0.2.0`, `v0.2.1`, `v0.3.0` (v0.3.0 dated 2026-10-27). ⚠
- **No GitHub Releases, no release workflow.** `.github/workflows/` contains
  only `ci.yml`. Updates therefore come from git refs (tags or `main`), not
  from release assets.
- Full clone: `.git` ≈ 114 MB, 2,370 commits. `src/` ≈ 42 MB (24 MB of that is
  bundled data under `src/data/`), `public/` ≈ 5.4 MB, `server/` ≈ 1.2 MB.
  `.gitattributes` forces LF on checkout and marks `.gif .png .glb .wav .pbf`
  binary.

## Runtime shape (the single most important fact)

**The Vite dev server is the whole application.** There is no separate
backend process.

- `vite.config.js` → `server/standalone/vite.config.js` →
  `createBrowserViteConfig()` in `build/vite.js`.
- `server/providers/local.js` exports `localProviderPlugins()` which attaches
  ~31 Vite plugins, each a middleware proxy for an upstream feed: OpenSky,
  adsb.lol, aisstream (AIS), CelesTrak, Launch Library 2, FIRMS, TomTom,
  Overpass, military installations, regional briefings, CCTV catalogues,
  radio-browser, GBFS, transit, OpenAI Realtime (ephemeral client secrets),
  Gemini Live, Google Places, Mapillary, weather/wind (GFS/ECMWF via
  eccodes-wasm), cyclones, fire perimeters, GNSS integrity, ghost maps.
- Additional plugins: `server/mcp/plugin.js` (local MCP server),
  `server/standalone/key-setup.js` (Provider Settings endpoints),
  `api-not-found.js`, `google-token-unavailable.js`,
  `unwatched-cache.js`, plus `build/allowedHosts.js` (Host header check),
  `build/embed-framing.js`, `build/panel.js`.
- The client is **vanilla JS ES modules** (no framework) with CesiumJS
  (`cesium ^1.124`), `mapillary-js`, `hls.js`, `satellite.js`,
  `@jtarrio/webrtlsdr` (WebUSB RTL-SDR), `@meri-imperiumi/eccodes-wasm`.
  Entry: `index.html` → `/src/main.js`. HTML templates are injected by
  `build/application-html.js` at `<!-- gev:template … -->` markers.
- The client calls the API at **relative paths** (`/api/overpass`,
  `/api/terrain/heights`, `/api/openai/…`, see `src/services/requests.js`).
  Client and API must share an origin. ⇒ The Electron window must load
  `http://127.0.0.1:<port>/`, not a `file://` or custom-scheme URL.

## Build vs preview vs dev

- `npm run dev` = `vite` — full app incl. Provider Settings.
- `npm run build` = `vite build` → `dist/`; `npm run preview` = `vite preview`.
  Preview serves `dist/` and 31 of the 32 provider middlewares (they implement
  both `configureServer` and `configurePreviewServer`), **but not**
  `key-setup.js`, which is pinned with
  `apply: (_, {command, isPreview}) => command === 'serve' && !isPreview`.
  CONTRIBUTING.md: "Provider Settings and `/api/setup/*` are development-only
  … Vite preview is for checking a local build; it is not a production
  server."
- Client-exposed keys (`GOOGLE_MAPS_API_KEY`, `CESIUM_ION_TOKEN`,
  `MAPILLARY_CLIENT_TOKEN`) are injected at config time via Vite `define`
  (`import.meta.env.*`). Changing them requires a server restart (dev) or a
  rebuild (preview). ⇒ **We run the dev server.**
- Dev server first start runs Vite dependency optimisation; the Dockerfile's
  health check allows a 30 s start period. `optimizeDeps.include` pre-bundles
  the SDR demodulator, `egm96-universal` and `mapillary-js`.
- `build.chunkSizeWarningLimit: 1500`; `cacheDir` for builds is
  `node_modules/.vite-build` so a build never invalidates a running dev
  server's cache.

## Configuration and secrets

- Vite `loadEnv(mode, root, '')` loads `.env` from the **checkout root** into
  `process.env` (only for keys not already set in the environment).
- `server/standalone/key-setup.js`:
  - `GET /api/setup/status` and `POST /api/setup/keys`.
  - Writes to `<root>/.env` (created if absent, hardened to 0600 via
    `key-setup-hardening.mjs`), **or** to `pinokio/ENVIRONMENT` when
    `process.env.GEV_LAUNCHER === 'pinokio'` *at boot*. We will **not** set
    `GEV_LAUNCHER`, so keys go to `<checkout>/.env`.
  - Sets `process.env` live for server-side proxies, responds `{restarting:
    true}`, then after 250 ms calls `server.restart()` (Vite dev server). The
    client reloads itself after the restart.
  - **Loopback-only** and **Origin-checked**: requests must come from a
    loopback `remoteAddress` (or a peer listed in
    `GEV_KEY_SETUP_TRUSTED_PEERS`) with a same-origin `Origin` header. An
    Electron window loaded from `http://127.0.0.1:<port>` satisfies both.
  - Removal writes `''` rather than deleting the line.
- `.env.example` (19 KB) documents every variable. The keys the Pinokio
  launcher forwards (`scripts/pinokio-environment.mjs`
  `PINOKIO_CONFIG_FIELDS`): `GOOGLE_MAPS_API_KEY`,
  `GOOGLE_MAPS_SERVER_API_KEY`, `CESIUM_ION_TOKEN`, `OPENAI_API_KEY`,
  `AISSTREAM_API_KEY`, `FIRMS_MAP_KEY`, `TOMTOM_API_KEY`, `OPENSKY_CLIENT_ID`,
  `OPENSKY_CLIENT_SECRET`, `LL2_API_TOKEN`, `GEV_RATELIMIT_OPENAI_PER_MIN`,
  `GEV_RATELIMIT_GOOGLE_PER_MIN`. Other knobs of note: `HOST`, `PORT`,
  `GEV_ALLOWED_HOSTS`, `GEV_PREFER_CODEX_OAUTH`, `OPENAI_REALTIME_*`,
  `GEV_VOICE_LOG_CONTENT`, `GEV_KEY_SETUP_EXTERNAL_KEYS`.
- The app works **with no keys at all** (Esri imagery, keyless terrain, free
  feeds). Keys unlock Google 3D tiles, Cesium ion, voice, AIS, FIRMS, TomTom.

## Writable state the server creates (all relative to `process.cwd()`)

- `.gev-cache/` — disk caches: `overpass/`, `tomtom/` (incl. `budget.json`
  quota counter), `terrain-heights.json`, `firms.json`, `ghostmaps/`,
  military installations. `unwatched-cache.js` keeps Vite from watching them.
- `.gev-logs/` — e.g. `realtime-conversations.jsonl` (voice debug log).
- `.env` — see above.
- `node_modules/.vite/` — dep-optimiser cache (warm restarts depend on it).
- `pinokio/.installed` — Pinokio's own marker; irrelevant for us.
- `.gitignore` already ignores `.env`, `.gev-cache`, `.gev-logs`, `dist`,
  `node_modules`, `pinokio/ENVIRONMENT`. ⚠ Verify the ignore list each
  update; our "is the tree dirty?" check must treat ignored paths as clean.

## Node, npm, native dependencies

- `engines.node`: `>=24.14.0 <25 || >=26 <27`. `npm run doctor`
  (`scripts/setup-doctor.mjs`) reports Node version and sets `exitCode = 1`
  when not ready; it warns specifically about Node 25 (EOL). CI and the
  Dockerfile use `node:24.14.0`.
- `npm ci` installs 243 packages. **devDependencies are required at runtime**
  (`vite`, `vite-plugin-cesium`, `ws`) — never `--omit=dev`.
- `puppeteer` is a devDependency used only by QA scripts; set
  `PUPPETEER_SKIP_DOWNLOAD=1` during install (upstream's own
  `pinokio-install.mjs` does exactly this) to skip the ~150 MB Chromium
  download.
- `sharp` downloads a prebuilt native binary for the host arch during install.
  Needs network at install time. Built against plain Node ABI.
- `npm test` shells out to `git` (fixtures use `git init`). We don't run
  tests in the desktop app, but note it if ever adding a "run self-check"
  feature.

## The upstream launcher contract (mirror this)

`scripts/pinokio-start.mjs` (ESM):
1. `applyPinokioEnvironment()`; `validatePinokioSharing()`; parse `PORT`.
2. Set `process.env.GEV_LAUNCHER = 'pinokio'` (we skip this).
3. `process.chdir(realpath(ROOT))`, then `const { createServer } = await
   import('vite')` — **import Vite only after the environment is final**,
   because Vite snapshots `process.env` during config.
4. `createServer({ root: ROOT, server: { host: '127.0.0.1', port, strictPort:
   true } })`, `await server.listen()`, `server.printUrls()`, then
   `console.log('[Pinokio] Ready at http://127.0.0.1:<port>/')`.
5. On `SIGINT`/`SIGTERM`: `await server.close(); process.exit(0)`.

`scripts/pinokio-install.mjs`: `npm ci` with `PUPPETEER_SKIP_DOWNLOAD=1`, then
runs the setup doctor and writes `pinokio/.installed`.

`scripts/pinokio-update.mjs`: `git fetch` once, print the (credential-
redacted) remote URL, the incoming commit list and diffstat, then fast-forward
and reinstall. Its header comment explains the philosophy: the only safety a
non-interactive updater can offer is disclosure. We add a confirmation step.

The Host allowlist (`build/allowedHosts.js`) always accepts `localhost` and
`127.0.0.1`; IP addresses are always accepted. No `GEV_ALLOWED_HOSTS` needed.

## Browser capabilities the client needs

- WebGL 2 (Cesium), GLSL post-processing, Web Workers via `blob:` URLs,
  `'unsafe-eval'` (Knockout inside Cesium widgets), WASM.
- **WebRTC + `getUserMedia`** — `src/voice/realtimeConnection.js` requires
  `window.RTCPeerConnection` and `navigator.mediaDevices.getUserMedia`;
  voice control uses `RTCPeerConnection` to OpenAI Realtime.
- **WebUSB** — `src/sdr/usbDevices.js` uses `navigator.usb.getDevices()` and
  `navigator.usb.requestDevice({filters})`. Chromium shows a device picker that
  Electron must handle via `session.on('select-usb-device')` and
  `session.setDevicePermissionHandler`.
- `hls.js` for CCTV streams; `<video>` playback; `media-src https:`.
- External network from the page itself: Google Fonts (`fonts.googleapis.com`,
  `fonts.gstatic.com` — Inter, JetBrains Mono, Material Symbols subset),
  optional YouTube/Facebook/X embeds (Bhote Koshi scene), Google Maps JS API
  (Street View), Esri/OSM tiles, Cesium ion, Google 3D tiles.
- The server sends its own CSP header (`BROWSER_CSP` in `build/vite.js`)
  including `frame-ancestors 'none'`, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`. Do not inject a second CSP from Electron.
- PWA manifest and icons exist (`public/manifest.webmanifest`,
  `public/icons/icon-*.png`, `public/logo.svg`). Use `logo.svg` as the source
  for the app icon (regenerate via `scripts/generate-icons.mjs` logic or
  `sharp`) — licence is MIT, attribute upstream.

## Known upstream gotchas relevant to the shell

- README warns of severe stutter inside Pinokio's embedded Electron view that
  vanished when the same server was opened in a normal browser (#365). Root
  cause unknown; most likely hardware acceleration/offscreen rendering in that
  host. Our window must have GPU acceleration enabled and should be verified
  by checking `chrome://gpu` equivalents (`app.getGPUFeatureStatus()`) in a
  debug menu.
- `server.restart()` after a key save re-reads `.env` and reloads the page.
  The shell must not treat that reload as a crash or a navigation violation.
- Vite's own `.env` file watcher may also trigger a restart; "a second queued
  restart is harmless" per upstream.
- Upstream cold start on first run after install is slow (dep optimisation);
  show progress, don't time out early (120 s budget).
- Overpass/ALPR/Installations go empty on stale versions because public
  Overpass mirrors refuse old user agents — a concrete reason to nudge users to
  update on launch.
