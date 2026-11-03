# 01 — The Brief

## Goal

Build **OpenTac** (product name, fixed; bundle id `icu.opentac.app`; domain `opentac.icu`): a native macOS application (Electron) that
runs the upstream open-source project
`https://github.com/bilawalsidhu/gods-eye-view` exactly as its maintainer
intends it to run — as a local Vite server with its bundled data-provider
middleware — inside a Chromium window, with no terminal, no Node install and no
Pinokio required by the end user.

The app must **update the upstream project in place from GitHub** (fetch,
fast-forward, reinstall dependencies, restart) so the owner can keep it
maintained for as long as the upstream repository is alive, without
re-packaging the app for every upstream commit.

The deliverables are: (1) a signed, notarized, auto-updating `.dmg` that a
non-technical person can download, open and use; (2) the CI pipeline that
produces it; (3) the marketing/download website at **opentac.icu**
(`06-WEBSITE.md`), which must credit the upstream author prominently;
(4) the optional AI-provider gateway (`07-AI-PROVIDERS.md`) so HUD summaries
can use Ollama, OpenRouter or xAI instead of OpenAI.

## Who this is for

A single owner (the person who commissioned this) who wants a maintained desktop
copy of the project. Not a mass-market product. Still: production quality,
because "it works on my machine once" is not the bar. The bar is: it works after
a reboot, after an OS update, after the upstream pushes 40 commits, after the
network drops mid-update, and after the user clicks the wrong thing.

## The one architectural decision that is already made

**Do not fork, vendor, or pre-build the upstream project.** The desktop app is
a thin shell around a *live git checkout* that lives in the user's Application
Support directory. The shell owns three things: the checkout, a bundled Node.js
runtime that runs it, and the window that displays it. This is deliberate:

- The upstream's in-app Provider Settings panel (where API keys are entered)
  only exists in the Vite **dev** server and writes `.env` into the checkout
  root, then restarts the server. A pre-built `dist/` loses that panel.
- The upstream already ships a launcher contract for exactly this model
  (`scripts/pinokio-start.mjs`, `pinokio-install.mjs`, `pinokio-update.mjs`).
  The desktop app is "Pinokio for one app". Mirror that contract; don't invent
  a new one.
- Upstream moves daily (1,472 PRs merged as of 2026-10-30) and the README warns
  that stale versions break (Overpass refuses old clients). Staying current is
  a feature, not a chore.

See `03-ARCHITECTURE.md` for the full design. It is not optional reading.

## Hard requirements (non-negotiable)

1. **Electron**, current stable major at the time of implementation. Verify the
   exact version and pin it.
2. **Bundle a standalone Node.js 24.14.x runtime** inside the app (per-arch,
   from nodejs.org, checksum-verified at build time). The upstream server runs
   under *this* Node, never under Electron's embedded Node. Reasons: upstream
   pins `>=24.14.0 <25 || >=26 <27` and its setup doctor enforces it; native
   npm packages (`sharp`) are built against plain Node's ABI, not Electron's.
3. **Git via `dugite`** (the git binary bundle used by GitHub Desktop). Do not
   depend on the user's machine having git / Xcode Command Line Tools.
4. **Gated updates** (`08-STAGED-UPDATES.md`): the default `stable` channel
   follows a ref on an OpenTac-controlled mirror that only advances after
   automated tests and a canary period. `candidate` (canary) and `upstream`
   (raw) channels exist for the owner, with explicit "untested" warnings.
5. **Disclosure before applying any update**: show the remote URL, the commit
   range, the commit subjects and a diffstat, and require a click. The upstream
   `pinokio-update.mjs` does this non-interactively; we can do better because
   we have a UI. Never apply an update silently.
6. **Fast-forward only.** Never merge, never rebase, never force. If the
   checkout cannot fast-forward (local edits outside the allowed set), offer
   "Reset to upstream" with a clear explanation of what is lost (nothing the
   user entered: `.env` and caches are preserved).
7. **Renderer security**: `contextIsolation: true`, `nodeIntegration: false`,
   `sandbox: true`, a minimal preload exposing only the IPC surface in
   `03-ARCHITECTURE.md`. The app window navigates only to the local server
   origin; every other navigation/window-open goes to the system browser.
8. **Microphone and WebUSB must work.** Voice control (OpenAI Realtime over
   WebRTC) and the RTL-SDR layer (WebUSB) are upstream features; they are the
   reason Electron was chosen over Tauri. Implement the permission handlers and
   prove them in manual QA.
9. **Signed and notarized** with hardened runtime, including the bundled Node
   binary with the entitlements it needs (JIT). Gatekeeper must accept the
   `.dmg` on a fresh Mac with no warnings.
10. **Shell self-update** via `electron-updater` against GitHub Releases of the
    *wrapper* repository (not the upstream). Two independent update mechanisms,
    clearly separated in code and in UI: "Update engine" (the upstream
    checkout) vs "Update the app" (Electron shell).
11. **No telemetry, no analytics, no phone-home** beyond: GitHub for the
    checkout/updates, nodejs.org at build time, and whatever upstream itself
    contacts. The app owner's keys live in the checkout's `.env` and nowhere
    else.
12. **Attribution everywhere.** OpenTac is an unofficial wrapper of
    *God's Eye View* by Bilawal Sidhu (MIT). The About panel, the setup
    window's first screen, the README, the website and `THIRD_PARTY_NOTICES.md`
    all say so with a link to https://github.com/bilawalsidhu/gods-eye-view.
    Never present upstream's work as OpenTac's.
13. **Everything upstream touches must be writable and outside the bundle**:
    the checkout, `node_modules`, `.env`, `.gev-cache/`, `.gev-logs/`. The
    `.app` bundle is read-only and signed; never write into it.

## Explicit non-goals

- Windows and Linux builds. Design nothing that *prevents* them, but ship macOS
  only (arm64 and x64).
- Changing upstream behaviour or UI. If something upstream is broken in
  Electron, prefer a shell-side workaround or an upstream PR over patching the
  checkout. Patching the checkout breaks fast-forward updates.
- Exposing the local server on the LAN. Bind `127.0.0.1` only.
- A plugin system, multiple checkouts, or multiple windows per server.

## Definition of done

The work is complete when **all** of the following are true:

- `npm run dist` on a clean clone of the wrapper repo produces signed,
  notarized `.dmg` + `.zip` for arm64 and x64, and CI does the same on a tag.
- On a fresh macOS user account with no developer tools: open the `.dmg`, drag
  to Applications, launch. The setup window shows clone → install → start
  progress. Within a few minutes the globe is rendering live aircraft.
- Quit and relaunch: starts in under ~15 s with no re-install (dependency
  optimisation cache warm).
- Enter a Cesium ion token in the in-app POWER UP panel: the server restarts,
  the page reloads, photorealistic tiles appear. The token is in
  `<AppSupport>/checkout/.env` and nowhere else. The token survives an update.
- The mirror's weekly intake has run green at least twice; one deliberate
  contract break made the gate fail loudly; one forced promote worked.
- Menu → "Check for Updates…" with a stale checkout: shows the disclosure,
  applies, reinstalls only if `package-lock.json` changed, restarts, reloads.
  The app does not need to quit.
- Simulate failures and recover gracefully with a visible, actionable error
  and logs: no network during clone; no network during update; `npm ci` fails;
  server crashes after start; port stolen; user deletes `node_modules`;
  user edits a tracked file in the checkout.
- Voice: click the mic, macOS prompts for microphone once, voice control works.
- RTL-SDR: plugging a dongle and opening the SDR layer shows the Chromium
  device picker and the stream plays. (Manual QA, needs hardware.)
- The AI gateway routes HUD summaries to a local Ollama model when selected,
  with OpenAI untouched when not; the UI states plainly that voice control
  remains OpenAI/Gemini.
- opentac.icu is live, serves the latest release for the right architecture,
  and credits Bilawal Sidhu above the fold (`06-WEBSITE.md` acceptance).
- Every item in `05-PRODUCTION-READINESS.md` is ticked.
- `CLAUDE.md` in the project is accurate for the final code.

## Working agreement for Claude Code

- Work through `04-IMPLEMENTATION-PLAN.md` phase by phase. Each phase has
  acceptance criteria; run them before starting the next phase.
- Keep a `docs/DECISIONS.md` log: whenever you deviate from this pack, write
  one paragraph saying what and why. Deviation is allowed; silent deviation
  is not.
- Re-verify upstream facts against the live repo when you first clone it.
  `02-UPSTREAM-FINDINGS.md` was written against commit `a725178`; upstream will
  have moved. Anything marked ⚠ there is the most likely to have changed.
- Ask the owner only for the items under "Needs a human" in
  `05-PRODUCTION-READINESS.md`. Everything else, decide and log.
- TypeScript throughout the shell. ESM. Node 24 for the shell's own tooling.
- Tests are part of the work, not an afterthought: unit tests for update
  logic and state machine, a Playwright-for-Electron smoke test for launch.
