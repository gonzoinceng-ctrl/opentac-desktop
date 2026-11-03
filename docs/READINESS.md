# Production readiness — status against `docs/brief/05-PRODUCTION-READINESS.md`

Updated 2026-11-03. Three states: **done** (proven on this machine or by tests in the repo),
**pending-owner** (needs an account, credential, hardware or wall-clock only the owner has),
**pending-CI** (wired up, proven locally where possible, but not yet executed on GitHub).

## Needs a human (owner)

| Item | State | Notes |
|---|---|---|
| Apple Developer ID Application certificate | **present** | "Developer ID Application: Simon Tucker (QR97D7QRX8)" is in the login keychain; `npm run pack` already signs with it. Export as `.p12` → base64 for `CSC_LINK` + `CSC_KEY_PASSWORD` in GitHub secrets. |
| App Store Connect API key for notarization | pending-owner | `.p8` content → `APPLE_API_KEY_P8`, plus `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`. See `docs/RELEASE.md`. |
| Wrapper GitHub repository | pending-owner | Decided name `gonzoinceng-ctrl/opentac-desktop` (public). `gonzoinceng-ctrl/opentac` is an unrelated project. Nothing has been pushed yet. |
| Engine mirror repository + push token | pending-owner | `engine-mirror/bootstrap.sh` creates `gonzoinceng-ctrl/opentac-engine`; add `ENGINE_PUSH_TOKEN` (Contents + Workflows + Issues write on the mirror, Contents write on the app repo) as an *environment* secret `engine-push`. |
| Bundle id / display name | done | `icu.opentac.app`, "OpenTac". |
| DNS for opentac.icu | pending-owner | Cloudflare Pages project `opentac`; records and the www redirect rule in `site/README.md`. Secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. |
| Test keys: OpenRouter, xAI, Ollama | partial | Ollama 0.40.14 with `qwen3:8b` and `qwen3.5:9b-mlx` is on this Mac (gateway verified against it live). OpenRouter and xAI keys pending-owner. |
| Second Mac / fresh user account | pending-owner | For Gatekeeper and first-run QA (`docs/QA.md` §1, §13). |
| RTL-SDR dongle | pending-owner | WebUSB manual test; may be recorded as "not executed". |
| Default channel decision | done | `stable` (tested main tip, weekly) per `docs/DECISIONS.md`. |
| Commercial-use decision | pending-owner | Upstream data licences are non-commercial; OpenTac is documented as non-commercial until the owner decides otherwise. |

## Build and supply chain

| Item | State |
|---|---|
| `package-lock.json` committed; CI uses `npm ci` | done |
| Electron, electron-builder, electron-updater, dugite pinned exact | done (45.2.1 / 26.18.0 / 6.8.11 / 3.3.2) |
| Node tarball SHA-256 for both arches committed and enforced | done (`scripts/node-version.json`, `fetch-node.mjs` fails on mismatch) |
| `vendor/` gitignored; CI fetches Node fresh | done |
| `npm audit` reviewed | pending-owner (run `npm audit` before first release; record exceptions in DECISIONS) |
| Reproducibility | redefined as manifest-level determinism (`verify-bundle.sh` checks file list + arch) |

## Signing and notarization

All pending-CI: `scripts/verify-notarized.sh` enforces `codesign --verify --deep --strict`, the JIT and
disable-library-validation entitlements on the bundled Node, `spctl -a -vv -t install` = accepted /
Notarized Developer ID, and `xcrun stapler validate`; `release.yml` fails the job otherwise. The negative
path (unsigned app → script fails) was exercised locally; the positive path needs the owner's secrets.
Fresh-Mac open test and x64-under-Intel test: pending-owner.

## Runtime behaviour

| Item | State |
|---|---|
| Binds only 127.0.0.1 | done (launcher refuses any other host; server env builder cannot be widened; gateway binds 127.0.0.1) |
| No orphan processes after Quit / Force Quit | done (process-group SIGTERM→SIGKILL + tree-kill; stdin watchdog in the launcher; integration + e2e tests assert no leftover) |
| Sleep/wake | partial (powerMonitor resume triggers a check; feed reconnect is upstream's; manual QA §11) |
| Two instances | done (single-instance lock; second launch focuses) |
| Memory bound | pending-owner (manual QA §12) |
| GPU acceleration | partial (Developer › GPU status menu logs `getGPUFeatureStatus`; verified `webgl: enabled` on this Mac in Electron 45; manual QA §10) |
| Autoplay | done in config (`autoplayPolicy: no-user-gesture-required`); manual QA §8 |
| Microphone prompt / denial handling | done in code (askForMediaAccess + guidance dialog); manual QA §6 |
| WebUSB picker + remembered device | done in code (check handler, select-usb-device picker, persisted identity incl. productName/serial); needs hardware |
| External links open in the default browser | done (e2e test 3) |
| Provider Settings save → restart → reload without shell error | done in code (ECONNREFUSED retry loop; child exit is the only crash signal); manual QA §3 |
| Log redaction unit-tested | done (31 tests incl. OpenAI/Google/JWT/GitHub/OpenRouter/xAI shapes) |

## Updates

| Item | State |
|---|---|
| Mirror has zero engine commits of its own | done by design + `selfcheck.yml` |
| Two consecutive weekly intakes green; one deliberate contract break; one forced promote | pending-owner / pending-CI (contract breaks are proven by 33 local tests; the weekly soak needs calendar time) |
| Disclosure shows gate run + canary days on `stable`; untested banner elsewhere | done (renderer + update manager tests) |
| Engine update: disclosure, ff, conditional reinstall, restart, reload | done (integration `update-flow` + e2e test 4 against the fixture mirror); manual against the real mirror pending-owner |
| Dirty tree blocks ff; Reset preserves `.env` and `.gev-cache` | done (integration tests) |
| Rollback after failed post-update start | done (integration test with `OPENTAC_FAIL_START_ONCE`) |
| Channel switch both directions | done in code + unit tests; manual QA §4 |
| Launch check rate-limited; skip honoured; interactive ignores skip | done (unit tests) |
| Offline update check fails softly | done (unit tests: offline → notice, app keeps running) |
| Shell update via `latest-mac.yml` | pending-CI / pending-owner (needs a published release and a second version) |
| Downgrade protection | done (`allowDowngrade: false`, `allowPrerelease: false`) |

## Failure handling

| Item | State |
|---|---|
| ERROR panels: plain message, raw line, Retry / Show Logs / Reset | done (`errors.ts` mapping, 34 tests; renderer) |
| Crash-loop guard: one auto-restart per 60 s | done (unit tests) |
| Corrupt `state.json` → `.bak` + defaults | done (unit tests) |
| Disk-space check before clone/install | done (`DISK_SPACE` error when < 2 GB and a clone/install is needed) |
| Timeouts on every git/npm/readiness operation | done (every runner has a timeout; tested) |

## Attribution and website

| Item | State |
|---|---|
| About panel + setup first screen credit Bilawal Sidhu with link | done |
| `THIRD_PARTY_NOTICES.md` has upstream MIT text verbatim (incl. data note) | done |
| opentac.icu live on HTTPS, credit above the fold, arch-aware download, checksums, `/licenses`, zero third-party requests | site built and verified locally (9 pages, no external resources); hosting pending-owner |
| Site rebuild on release published | pending-CI (`site.yml`) |

## AI providers

| Item | State |
|---|---|
| Default OpenAI path leaves engine network calls untouched | done (gateway and interceptor only exist when a non-OpenAI provider is selected; unit tests) |
| Ollama / OpenRouter / xAI summaries work; keys encrypted locally | done (gateway tests against mock backends; live Ollama verified during validation); OpenRouter/xAI live test pending-owner keys |
| UI and website say voice is OpenAI/Gemini only | done |
| Upstream PR for `OPENAI_BASE_URL` | pending-owner (needs the owner's GitHub identity; a draft patch is a follow-up) |

## Documentation

`README.md`, `THIRD_PARTY_NOTICES.md`, `docs/DECISIONS.md`, `docs/QA.md` (111 steps, unticked), `docs/RELEASE.md`,
`docs/DATA-DIR.md`, `docs/TROUBLESHOOTING.md`, `docs/SHELL-DESIGN.md`, `CLAUDE.md`: done. `docs/QA.md` execution: pending-owner.
