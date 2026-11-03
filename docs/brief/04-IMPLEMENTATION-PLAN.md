# 04 — Implementation Plan

Work the phases in order. Each phase ends with acceptance criteria; run them
and record the result in `docs/DECISIONS.md` (one line per phase is enough,
plus any deviations). Do not start Phase N+1 with Phase N red.

Time estimates are for orientation only.

---

## Phase 0 — Verify assumptions (½ day)

1. Clone upstream into a scratch dir. Confirm every ⚠ line in
   `02-UPSTREAM-FINDINGS.md`: current tags, `engines.node`, the launcher
   scripts still exist with the described behaviour, `key-setup.js` still
   writes `<root>/.env` when `GEV_LAUNCHER` is unset, `.gitignore` contents.
2. Determine the current Electron stable major and the Node version it
   embeds. Record both. Regardless of the embedded version, the design uses
   bundled standalone Node for the server (see Brief §Hard requirements).
3. Determine the latest Node **24.x** release ≥ 24.14.0 (24.x is LTS). Record
   the version and the SHA-256 from `SHASUMS256.txt` for
   `node-v24.x.y-darwin-arm64.tar.gz` and `…-darwin-x64.tar.gz`.
4. Check `dugite`'s current version, how it locates its git binary
   (`dugite/git/` under `node_modules`), and whether electron-builder needs
   it in `asarUnpack` (it does — binaries can't run from inside an asar).
5. With plain Node 24 on the dev machine, run upstream manually:
   `npm ci` (with `PUPPETEER_SKIP_DOWNLOAD=1`), then a one-off script that
   does what `pinokio-start.mjs` does with `PORT=4199`. Confirm the ready
   line, confirm `curl http://127.0.0.1:4199/` is 200, confirm
   `GET /api/setup/status` works from a same-origin page.

**Accept:** `docs/DECISIONS.md` has a "Phase 0 facts" section with all
versions and hashes; `scripts/fetch-node.mjs` has the hashes hard-coded.

---

## Phase 1 — Project skeleton and bundled runtime (1 day)

1. Initialise the wrapper repo from `scaffold/`. TypeScript, ESM, strict.
   `electron`, `electron-builder`, `electron-updater`, `electron-log`,
   `dugite`, `tree-kill`, `semver`, `vitest`, `@playwright/test`.
2. `scripts/fetch-node.mjs`: download both Node tarballs into
   `vendor/node/darwin-{arm64,x64}/`, verify SHA-256, extract, strip docs
   (`share/`, `include/`), keep `bin/node` and `lib/node_modules/npm`. Make
   `npm run fetch-node` idempotent. `vendor/` is gitignored.
3. `electron-builder.yml`: mac targets `dmg` + `zip`, arch `arm64` + `x64`
   (separate artifacts; a universal binary doubles the Node payload for no
   gain), `extraResources` mapping `vendor/node/darwin-${arch}` →
   `Resources/node` (use builder's `${arch}` substitution), `resources/
   launcher` → `Resources/launcher`, `asarUnpack` for dugite's git.
   `hardenedRuntime: true`, `entitlements`/`entitlementsInherit` →
   `build/entitlements.mac.plist`, `gatekeeperAssess: false`,
   `notarize` configured (see 05). `appId` placeholder
   `icu.opentac.app`, `productName: "OpenTac"`.
4. `scripts/make-icon.mjs`: render upstream `public/logo.svg` (fetch at build
   time or vendor a copy with attribution) to `build/icon.icns` via `sharp`
   + `iconutil`.
5. `src/main/paths.ts`: single source of truth for every path in
   `03-ARCHITECTURE.md §2`, with dev-mode overrides (`OPENTAC_DATA_DIR`
   env to point at a scratch dir; `Resources` resolves to `vendor/…` when
   `!app.isPackaged`).
6. `src/main/logger.ts` with redaction; `src/main/state.ts` with schema
   validation, atomic write (`write tmp → rename`), defaults.

**Accept:** `npm run dev` opens an empty window; `npm run pack` (unsigned
`--dir`) produces an `.app` containing `Resources/node/bin/node` that runs
`--version` and prints the pinned version; unit tests for `state.ts`
(defaults, corrupt file → defaults + backup, atomic write) pass.

---

## Phase 2 — Checkout and install (1–2 days)

1. `checkout.ts` (dugite): `ensureCheckout`, `resolveTarget`, `fetch`,
   `status` + `DirtyReport`, `checkoutDetached`, `isAncestor`,
   `resetToUpstream`, `commitLog`, `redactRemoteUrl`. Clone progress parsing
   (`Receiving objects: 45%`). All commands with timeouts and
   `GIT_TERMINAL_PROMPT=0`.
2. `install.ts`: `needsInstall`, `install` with streamed output and the
   network-retry policy. Lock hash and node version recorded in state only
   after success. Run upstream doctor afterwards; log report.
3. Setup window: `src/renderer/setup/` — phase title, progress bar
   (determinate when we have a %, indeterminate otherwise), log tail (mono,
   auto-scroll, 500 lines), buttons area. Preload `setup.ts` with
   `onState`/`action`. Custom `app://` scheme registration.
4. `controller.ts`: the state machine from `03 §3` as an explicit enum +
   transition table; every transition logged. First-run path only for now
   (`BOOT → CLONING → INSTALLING → ERROR/…`), no server yet.

**Accept:** Unit tests: `resolveTarget` picks `v0.10.0` over `v0.9.9` and
ignores `v1.0.0-rc.1`; `DirtyReport` parsing; `redactRemoteUrl` cases copied
from upstream's tests. Integration test (vitest, real dugite, temp dir): clone
a tiny local fixture repo with tags, resolve stable, detach, modify a tracked
file → dirty, `resetToUpstream` → clean and an ignored `.env` file survives.
Manual: `npm run dev` with empty data dir clones upstream and runs `npm ci`
with live progress; the window shows the doctor report at the end.

---

## Phase 3 — Server lifecycle and main window (1–2 days)

1. `resources/launcher/opentac-start.mjs` (see scaffold). Import `vite` from the
   checkout's `node_modules`; `createServer({root: cwd, server: {host:
   '127.0.0.1', port, strictPort: true}})`; print the ready line; clean
   shutdown on signals; exit non-zero on any error with the message on stderr.
2. `ports.ts` (free-port probe on 127.0.0.1), `server.ts`
   (spawn/readiness/crash/shutdown exactly as `03 §4.3`), including the
   `EADDRINUSE` retry and the process-group kill.
3. `windows.ts`: main window creation, `backgroundColor`, bounds persistence,
   navigation lock, `setWindowOpenHandler`. Show main window only on
   `RUNNING`; hide (not close) the setup window.
4. `permissions.ts`: media (mic) + `askForMediaAccess`, USB handlers with
   persistence, deny-by-default for all else. `autoplay-policy` switch.
5. `menu.ts`: everything in `03 §4.8` except update items (Phase 4).
6. `before-quit`/`will-quit` wiring: terminate server, flush logs.
7. Add `NSMicrophoneUsageDescription` (and only that usage string) via
   `electron-builder.yml` `extendInfo`.

**Accept:** Playwright `_electron` smoke test (uses an already-prepared data
dir to skip clone/install, or a fixture flag): app reaches `RUNNING` within
120 s, main window URL matches `http://127.0.0.1:\d+/`, a `<canvas>` exists,
`fetch('/api/setup/status')` from the page returns 200 JSON. Kill the child
process externally → app shows CRASHED panel with Restart; Restart works.
Quit → no orphan `node` processes (assert via `pgrep -f opentac-start`).
Manual: mic prompt appears on first voice use; after granting, the voice
session connects. Clicking an external link opens Safari/default browser,
not a new Electron window. Key entry in POWER UP restarts server and reloads
without the shell flinching.

---

## Phase 4 — Engine updates (1–2 days)

> Implement the channel/ref model from `08-STAGED-UPDATES.md §4`, not the
> upstream-tag model; keep `OPENTAC_ENGINE_REMOTE` / `OPENTAC_ENGINE_REF`
> overrides for CI.

1. `update.ts`: `checkForUpdates`, disclosure object, `applyUpdate`,
   `rollback`, launch-time check with rate limit and `skippedCommit`,
   channel switching. Transitions wired into the controller.
2. Setup window disclosure panel: remote, channel, from → to, commit count,
   diffstat, "dependencies will be reinstalled" flag, scrollable commit list,
   "View on GitHub" (compare URL) button, **Update** / **Later** / **Skip
   this version** / **Reset to upstream then update** (only when dirty).
3. Menu: Check for Updates…, Preferences (channel radio with warning text for
   `main`, update-on-launch checkbox).
4. State persistence and rollback marker as specified.

**Accept:** Unit tests with a mocked `CheckoutManager`: behind=0 → up to
date; dirty → reset option; lock changed → install step; start failure →
rollback path invoked. Integration (fixture repo): checkout at tag A, push
tag B upstream, check → disclosure lists the commits, confirm → HEAD == B,
`.env` and a file in `.gev-cache/` untouched. Manual against the real
upstream: pin checkout to `v0.2.1`, run Check for Updates → disclosure shows
the real commit range, update applies, server restarts, page reloads, About
shows the new tag.

---

## Phase 4b — AI provider gateway (1–2 days)

See `07-AI-PROVIDERS.md` for the full design.

1. Phase 0 addendum (do it now if not done): read `extractOpenAiResponseText`
   and `server/providers/openai/hud-summary.js` in the live checkout; record
   the exact response shape it accepts. Verify current Ollama, OpenRouter and
   xAI chat-completions request/response shapes. Open the upstream PR adding
   `OPENAI_BASE_URL` (Route A).
2. `src/main/aiGateway.ts`: local HTTP server on 127.0.0.1, Responses-API
   shape in, backend adapters (`openai` pass-through, `ollama`, `openrouter`,
   `xai`), Responses-API shape out, 10 s timeout, fail-soft, no prompt/key
   logging.
3. `server.ts`: pass `OPENTAC_AI_GATEWAY_URL` to the launcher only when a
   non-OpenAI provider is selected (the launcher's interceptor is already in
   the scaffold).
4. Preferences → AI panel in the setup window (provider, model, Ollama host,
   keys in Keychain via `safeStorage`, Test button, the voice caveat line).
5. Tests: unit for each adapter's translation; integration running upstream's
   real `hud-summary` handler through the gateway against a mocked Ollama.

**Accept:** With Ollama running a small instruct model, the HUD summary text
changes to the local model's output (verify via the gateway log); switching
back to OpenAI removes the interceptor (env var absent) and upstream calls
`api.openai.com` directly; killing Ollama mid-session yields upstream's
degraded/keyless behaviour, not a crash.

---

## Phase 5 — Shell self-update, packaging, signing (1 day + waiting on human)

1. `shellUpdate.ts` with `electron-updater` (GitHub provider), checked after
   `RUNNING` + 30 s and from the menu; download → prompt → quit-and-install
   via the normal quit path.
2. `scripts/notarize.cjs` (or electron-builder's built-in `notarize` with
   API key env vars). Entitlements: main app and inherit —
   `com.apple.security.cs.allow-jit`,
   `com.apple.security.cs.allow-unsigned-executable-memory`,
   `com.apple.security.cs.disable-library-validation` (only if sharp/dugite
   dylibs require it — test without first),
   `com.apple.security.device.audio-input`,
   `com.apple.security.network.client`,
   `com.apple.security.network.server` (local listener).
3. Verify electron-builder signs the bundled `node` binary and dugite's git
   (it signs every Mach-O it finds under the bundle; confirm with
   `codesign -dvv --deep` and `codesign --verify --deep --strict`).
4. GitHub Actions `release.yml`: on tag `v*`, `macos-latest` matrix arm64/x64,
   `npm ci`, `npm run fetch-node`, `npm run dist`, upload artifacts, create a
   draft release with `latest-mac.yml`. Secrets: `CSC_LINK`,
   `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
   `APPLE_API_ISSUER`.

**Accept:** On a second Mac (or a fresh user account): download the `.dmg`
from a draft release, open with no Gatekeeper warning (`spctl -a -vv` passes),
first run completes, voice prompt appears with the correct usage string.
Publish a second release with a bumped version → running app offers the
update, installs it, relaunches, the checkout and keys are intact.

---

## Phase 5b — Mirror repo and the gate (1–2 days)

Build `08-STAGED-UPDATES.md §3` and §7: fork upstream as `opentac-engine`,
add the `opentac-ci` orphan branch with `watch.yml`, `intake.yml`, `gate.yml`,
`promote.yml`, `ci/contracts.mjs` and the report template; seed `stable` and
`candidate` at the current upstream tag.

**Accept:** watch runs hourly and mirrors; a manual intake runs the full
gate green on the current upstream tag; editing one contract expectation
makes the gate fail with a clear message; promote advances `stable`, creates
`stable-YYYY.MM.DD`, and the app on `stable` offers exactly that update.

---

## Phase 6 — Hardening and polish (1 day)

1. Failure drills from the Brief's definition of done, each with an explicit
   test or a documented manual script in `docs/QA.md`: offline clone,
   offline update, `npm ci` failure, server crash loop guard, port stolen,
   deleted `node_modules`, dirty tracked file, corrupt `state.json`.
2. Disk-space pre-check before clone/install (≥ 2 GB free; warn below).
3. First-run copy: short, honest text in the setup window about what is
   being downloaded (upstream repo ≈ 150 MB + dependencies ≈ 600 MB) and
   that it comes from GitHub.
4. About panel with licences: upstream MIT, Electron, Node, dugite/git
   (GPLv2 — dugite ships git as a separate binary; note the licence in
   About and in `THIRD_PARTY_NOTICES.md`), bundled third-party notices of
   the shell's own deps (`electron-builder`'s licence collection or a
   script).
5. Accessibility basics for the setup window (labels, focus order, Esc).
6. Final pass on `CLAUDE.md` and `README.md` of the wrapper repo: how to
   build, how to release, how to debug, the data-dir layout, how to point at
   a fork (`remoteUrl` in `state.json` or a Preferences field).

**Accept:** `docs/QA.md` executed end to end with every item marked pass;
`05-PRODUCTION-READINESS.md` fully ticked; `npm test` and `npm run e2e`
green in CI.

---

## Phase 7 — Website opentac.icu (1–2 days)

Build exactly what `06-WEBSITE.md` specifies: static site, build-time
release data from the OpenTac GitHub Releases API, rebuild on
`release: published`, attribution above the fold, `/licenses` with upstream's
MIT text, no third-party requests. Add `SHA256SUMS.txt` generation to the
release workflow (Phase 5) so the site can show checksums.

**Accept:** `06-WEBSITE.md` acceptance list, plus the owner has pointed DNS
and HTTPS works on apex and `www`.
