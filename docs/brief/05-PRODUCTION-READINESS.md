# 05 — Production Readiness Checklist

The app is not finished until every box is ticked. Claude Code ticks the ones
it can prove; the owner ticks the "Needs a human" ones.

## Needs a human (ask the owner once, early)

- [ ] **Apple Developer Program** membership and a **Developer ID
      Application** certificate exported as `.p12` (→ `CSC_LINK` base64 +
      `CSC_KEY_PASSWORD`).
- [ ] **App Store Connect API key** with Developer access (`.p8` →
      `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) for
      notarization. (Alternative: Apple ID + app-specific password + team ID.)
- [ ] **Wrapper GitHub repository** (name, public/private). Private repos
      work with `electron-updater` only with a token baked in — recommend
      **public** for the wrapper; it contains no secrets.
- [ ] **Bundle identifier** (default `icu.opentac.app`) and
      **display name** (fixed: "OpenTac"). Note: the upstream name is
      the maintainer's project name; the About panel and README must state
      that this is an unofficial desktop wrapper of the MIT-licensed project
      by Bilawal Sidhu.
- [ ] DNS control for **opentac.icu** (and a choice of GitHub Pages vs
      Cloudflare Pages).
- [ ] Accounts/keys for testing: OpenRouter key, xAI key, Ollama installed
      locally with one small instruct model.
- [ ] A **second Mac or fresh user account** for Gatekeeper verification.
- [ ] An **RTL-SDR dongle** for the WebUSB manual test (optional feature;
      if unavailable, document the test as "not executed").
- [ ] Decision: default channel `stable` (recommended) or `main`.

## Build and supply chain

- [ ] `package-lock.json` committed; CI uses `npm ci`.
- [ ] Electron, electron-builder, electron-updater, dugite versions pinned
      (exact, no `^`).
- [ ] Node tarball SHA-256 for both arches committed and verified in
      `fetch-node.mjs`; build fails on mismatch.
- [ ] `vendor/` gitignored; CI fetches Node fresh.
- [ ] `npm audit` reviewed; no high/critical in production deps without a
      written justification in DECISIONS.md.
- [ ] Reproducible: two consecutive `npm run dist` runs produce bundles that
      differ only in signatures/timestamps.

## Signing and notarization

- [ ] `codesign --verify --deep --strict --verbose=2 OpenTac.app`
      passes.
- [ ] `codesign -d --entitlements - Resources/node/bin/node` shows JIT and
      unsigned-executable-memory entitlements.
- [ ] `spctl -a -vv -t install OpenTac.app` → `accepted`,
      `source=Notarized Developer ID`.
- [ ] `xcrun stapler validate` passes on the `.app` inside the `.dmg`.
- [ ] Fresh-Mac open test: no "unidentified developer" or "damaged" dialog.
- [ ] Both arm64 and x64 artifacts tested (x64 at least under Rosetta).

## Runtime behaviour

- [ ] Binds only `127.0.0.1` (verify with `lsof -iTCP -sTCP:LISTEN -P`).
- [ ] No orphan processes after Quit, after Force Quit of the shell (child
      dies with parent — verify `detached` + kill-on-exit handling; if the
      shell is SIGKILLed the child is reparented: add a watchdog in the
      launcher that exits when `process.ppid` changes / stdin closes).
- [ ] Sleep/wake: server survives, page reconnects feeds.
- [ ] Two instances: `app.requestSingleInstanceLock()`; second launch focuses
      the first.
- [ ] Memory: idle at the globe < 1.5 GB total across processes on an M-series
      Mac (sanity bound, not a hard SLA); no unbounded growth in `server.log`
      ring buffer.
- [ ] GPU acceleration confirmed on (`app.getGPUFeatureStatus().webgl ===
      'enabled'`; `gpu_compositing` enabled).
- [ ] Autoplay: a CCTV stream and a radio station start without a click.
- [ ] Microphone: TCC prompt once, usage string correct, voice works; denial
      is handled (upstream shows its own error; the shell doesn't crash).
- [ ] WebUSB: device picker appears; pick is remembered across restarts.
- [ ] External links open in the default browser; no stray windows.
- [ ] Provider Settings: save key → restart → reload, no shell error state;
      key present in `<checkout>/.env`, mode 0600, absent from both logs.
- [ ] Log redaction unit-tested with sample OpenAI/Google/JWT-shaped strings.

## Updates

- [ ] Mirror repo has zero engine commits of its own (CI check: every
      commit on `stable` is reachable from `upstream-main`).
- [ ] Two consecutive weekly intakes green; one deliberate contract break
      fails loudly; one forced promote exercised.
- [ ] Disclosure on `stable` shows the gate run link and canary duration;
      `candidate`/`upstream` show the untested banner.

- [ ] Upstream update: disclosure correct, ff applies, conditional reinstall,
      restart, reload — tested against real upstream from an old tag.
- [ ] Dirty tree blocks ff and the Reset path preserves `.env`, `.gev-cache`.
- [ ] Rollback after a failed post-update start tested (simulate by making
      the launcher fail once via an env flag in dev).
- [ ] Channel switch both directions tested.
- [ ] Launch check rate-limited; "Skip this version" honoured; interactive
      check ignores the skip.
- [ ] Offline: update check fails softly, app keeps running.
- [ ] Shell update: `latest-mac.yml` in the release, running app detects,
      downloads, installs, relaunches; data dir untouched.
- [ ] Downgrade protection: `electron-updater` `allowDowngrade: false`.

## Failure handling

- [ ] Every ERROR panel has: a plain-language message, the underlying error
      line, Retry, Show Logs, and (where sensible) Reset.
- [ ] Crash-loop guard: max one auto-restart per 60 s, then manual.
- [ ] Corrupt `state.json` → backed up to `state.json.bak`, defaults used,
      logged.
- [ ] Disk-space check before clone/install.
- [ ] Timeouts on every git/npm/readiness operation; nothing can hang the UI
      forever.

## Attribution and website

- [ ] About panel: "OpenTac is an unofficial desktop app for God's Eye View by
      Bilawal Sidhu (MIT)" with repo link; engine version/commit shown.
- [ ] Setup window first screen carries the same credit line.
- [ ] `THIRD_PARTY_NOTICES.md` includes upstream's MIT licence text verbatim.
- [ ] opentac.icu live on HTTPS (apex + www), credit above the fold, download
      auto-detects arch, checksums match release assets, `/licenses` present,
      zero third-party requests.
- [ ] Site rebuild triggered by `release: published` verified end to end.

## AI providers

- [ ] Default (OpenAI) path leaves the engine's network calls untouched
      (interceptor absent; verified by log and by a packet capture or proxy).
- [ ] Ollama / OpenRouter / xAI summaries work; keys in Keychain only.
- [ ] UI and website state clearly that voice control is OpenAI/Gemini only.
- [ ] Upstream PR for `OPENAI_BASE_URL` opened; link recorded in DECISIONS.md.

## Documentation

- [ ] Wrapper `README.md`: what it is, attribution, install, build, release,
      data-dir layout, how to debug (logs, Open in Browser, DevTools), how to
      point at a fork.
- [ ] `THIRD_PARTY_NOTICES.md` incl. git (GPLv2, via dugite) and upstream MIT.
- [ ] `docs/DECISIONS.md` complete; `docs/QA.md` executed.
- [ ] `CLAUDE.md` reflects the final layout and commands.

## Release process (document and follow)

1. Bump `version` in `package.json`; commit; tag `vX.Y.Z`; push tag.
2. CI builds, signs, notarizes, uploads a **draft** release with `.dmg`,
   `.zip`, `latest-mac.yml`, `.blockmap` files for both arches.
3. Owner smoke-tests the draft artifacts (Gatekeeper + launch + update from
   previous version), then publishes the release.
4. Running apps pick it up on next launch or via the menu.
