# Decisions log

Append-only. One dated paragraph per decision or deviation from `docs/brief/`.

## Phase 0 facts (2026-11-03)

- Electron version: **45.2.1** (embedded Node 24.22.1, Chromium 156.0.8078.75, released 2026-10-30).
- Bundled Node version: **24.22.2** (24.x "Krypton" LTS, released 2026-10-27).
  - SHA-256 `node-v24.22.2-darwin-arm64.tar.gz`: `aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a`
  - SHA-256 `node-v24.22.2-darwin-x64.tar.gz`: `d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52`
  - Both verified from `https://nodejs.org/dist/v24.22.2/SHASUMS256.txt`; `scripts/fetch-node.mjs` fails on mismatch.
  - npm ships inside the tarball at `lib/node_modules/npm/bin/npm-cli.js` (confirmed after extraction).
- dugite version: **3.3.2** (postinstall downloads its own git binary into `node_modules/dugite/git/`).
- electron-builder **26.18.0**, electron-updater **6.8.11**, electron-log **5.4.4**, semver **7.8.6**, tree-kill **1.2.2**.
- vitest **5.1.0**, @playwright/test **1.64.1**, sharp **0.35.5**, esbuild (see package.json).
- TypeScript pinned to **5.9.3**, not 7.0.2: 7.x is the native-port line and its tooling compatibility with vitest/electron typings is unproven at this date. Revisit when the ecosystem has caught up.
- @types/node pinned to **24.19.2** to match the bundled/toolchain Node major (26.x is "latest" but targets Node 26).
- Upstream HEAD at first clone: `48146f8e5befe7ea5e0c886149f4a6de825f6ebb` (2026-11-03, "Merge pull request #1522"), **446 commits after** the brief's reference commit `a725178`. Latest tag: `v0.3.0` (unchanged since the brief). `engines.node` unchanged: `>=24.14.0 <25 || >=26 <27`. `.git` is now ≈194 MB and `src/` ≈72 MB (brief said 114 MB / 42 MB).
- `extractOpenAiResponseText` accepted shape: see Phase 0 validation findings (recorded below once verified against the live checkout).

## 2026-11-03 — Project root name

The brief (`00-README.md`) suggests a directory named `opentac`. The owner created `opentac_project` as the root; the wrapper lives there. The GitHub repository name is a separate decision: `gonzoinceng-ctrl/opentac` already exists and is an unrelated Python project ("OpenTAC — self-hosted operator console", June 2026), so the wrapper repo cannot take that name without the owner's explicit say-so.

## 2026-11-03 — Orchestration

Built with Claude Code "ultracode" workflows: Fable 5.1 orchestrates; Sonnet 5.5 and Haiku subagents do investigation, implementation and review stages, chosen per task. Owner's instruction.

## 2026-11-03 — Phase 0 validation: what the live checkout and live services changed

Validation ran as parallel investigations against upstream HEAD `48146f8e` and the live Ollama / OpenRouter / xAI / GitHub docs. Facts that override the brief:

- **Launcher stdin watchdog (scaffold bug, confirmed by running it).** The scaffold launcher exited within ~2 s with "stdin closed" whenever stdin was `/dev/null` or a closed descriptor, so it never served HTTP when run from a non-interactive shell. Fixed: the watchdog only arms when fd 0 is a FIFO or socket (what Electron's `stdio: 'pipe'` gives us), and `OPENTAC_NO_STDIN_WATCHDOG=1` disables it for tests. The shell **must** spawn the launcher with stdin as a pipe and hold it open for the life of the server; an integration test pins this.
- **Upstream runs cleanly under Node 24.22.2.** `npm ci` (`PUPPETEER_SKIP_DOWNLOAD=1`) installs 223 packages, 409 MB. Cold start to HTTP 200 is ~0.5 s with a warm Vite cache, warm start ~0.4 s. The ready line is `[OpenTac] Ready at http://127.0.0.1:PORT/` and it is printed **after** Vite's own `➜  Local: http://127.0.0.1:PORT/` line, which contains the same URL; readiness parsing matches the `[OpenTac] Ready at ` prefix only. Stdout carries everything; stderr was empty. The checkout writes `.gev-cache/` into `process.cwd()`, so cwd must be the writable checkout.
- **Keyless smoke endpoint for the gate:** `GET /api/celestrak/stations` returns live TLE text with no keys (`server/providers/space/celestrak.js`). `/api/setup/status` answers 200 with or without an `Origin` header and 403 for a foreign origin.
- **npm 11 `allowScripts`.** npm 11.19 warns about install scripts not on an allow-list but still runs the engine's install fine (esbuild uses its optional platform package). The shell's own `package.json` carries `allowScripts` approvals for dugite, esbuild and electron-winstaller so CI is quiet and deterministic. The InstallManager must tolerate these warnings on stderr.
- **HUD summary contract has drifted (07-AI-PROVIDERS.md).** `server/providers/openai/hud-summary.js` now sends `max_output_tokens: 200` (not 100) and a **strict JSON schema** via `text.format` (`{summary, feedState}`); the reply text must itself be JSON or `parseHudSummaryReply` yields an empty summary. `toFiveWordHudSummary` does not exist; it is `toHudSummary` with an 80-character cap. `extractOpenAiResponseText` accepts either top-level `output_text` or `output[].content[].text|output_text`; emit exactly one message item with one content part, never several (they are joined with spaces and break `JSON.parse`).
- **The handler short-circuits before `fetch` when `OPENAI_API_KEY` is empty** (`keylessHudSummaryResponse`). For a non-OpenAI summary provider the launcher must inject a placeholder `OPENAI_API_KEY` **only if** the checkout's `.env` does not already define one (so a real key for voice still loads), and the gateway must drop the incoming `Authorization` header and use its own backend key. The interceptor matches only `POST https://api.openai.com/v1/responses`; the Realtime `client_secrets` URL goes through the same global `fetch` and is never rewritten.
- **Ollama 0.40, OpenRouter and xAI all serve the Responses API natively** (`/v1/responses`; xAI marks chat-completions as legacy). Verified live against Ollama (`qwen3:8b`): the upstream request shape, including `text.format` json_schema, is honoured. The gateway therefore becomes a **pass-through with origin, key and model rewrite** for these three, plus a floor on `max_output_tokens` and `reasoning` forced off; the chat-completions translation stays only as a fallback adapter. Thinking models (`qwen3:8b`) spend the whole token budget on reasoning and return empty content unless reasoning is disabled; the Preferences "Test" button reports `finish_reason`/empty output plainly.
- **xAI now has a WebSocket realtime voice API** (`wss://api.x.ai/v1/realtime`, "compatible with the OpenAI Realtime API"). Upstream's voice is WebRTC (`/v1/realtime/calls`), so it is still not a drop-in; the brief's "no realtime voice" statement is simply stale and the UI copy says "voice control uses OpenAI or Gemini" without claiming xAI cannot.

## 2026-11-03 — Staged update pipeline: design corrections to 08-STAGED-UPDATES.md

The gate-and-canary shape is kept. These mechanics change because GitHub would not run 08 as written:

1. **Mirror is a plain public repository, not a fork**, named `opentac-engine`. Forks start with scheduled workflows disabled and cannot change visibility; "zero engine commits of its own" is enforced by CI with `git merge-base --is-ancestor <stable> <live upstream main>` against the real upstream remote, not fork status.
2. **The workflows live on the mirror's default branch.** GitHub only runs `schedule`, `repository_dispatch` and the "Run workflow" button from the default branch. The orphan branch `opentac-ci` (workflows, `ci/contracts.mjs`, tag manifest, `RELEASES.md`) **is** the default branch; engine refs (`upstream-main`, `candidate`, `stable`, `v*`, `stable-*`) are ordinary non-default refs. No branch named `main` is ever pushed to the mirror, so upstream's own `ci.yml` cannot fire there.
3. **Ref pushes use a dedicated token, not `GITHUB_TOKEN`.** Upstream edits `.github/workflows/ci.yml` regularly (twice between v0.3.0 and HEAD) and `GITHUB_TOKEN` has no `workflows` scope, so the first fast-forward past v0.3.0 would be rejected. A fine-grained PAT or GitHub App token with Contents + Workflows + Issues write on the mirror (secret `ENGINE_PUSH_TOKEN`) does every push and every cross-repo dispatch. Every workflow declares `permissions:` explicitly.
4. **Intake policy.** The owner asked for a weekly pull of all new upstream commits, and upstream tags only roughly monthly, so `INTAKE_POLICY` defaults to `main` (tip of `upstream-main` each Sunday), gated and canaried exactly as before. `tags` remains available and, when chosen and no newer tag exists, intake is a **no-op that says so**, never a silent fallback to main.
5. **`candidate` only moves after the gate is green.** The gate receives an explicit SHA, never the ref name. The per-SHA verdict is recorded in the canary issue body as JSON (`{sha, upstreamTag, readyAt, gateRunUrl, minShell}`) and as a git note under `refs/notes/gate`. `promote` promotes the SHA recorded in the issue, re-checks `hold`/`reject` labels immediately before pushing, requires `readyAt + 72 h`, and runs under `concurrency: engine-refs` with intake. A newer intake closes the old canary issue as `superseded` and restarts the clock.
6. **Promotion tags** are `stable-YYYY.MM.DD` with a `-N` suffix when a day has more than one; the app orders them by commit ancestry, not name. The annotation carries the upstream tag (if any), commit range, gate run URL, canary days, `minShell` and `severity: normal|security`.
7. **Tag drift:** `opentac-ci/manifest/tags.json` records object and peeled SHA for every upstream tag mirrored; `watch` compares `git ls-remote --tags` against it before fetching and fails loudly on any change. A tag ruleset on the mirror forbids updating or deleting `v*` and `stable-*`.
8. **Runners:** contract checks and upstream's own `npm test`/`build` on `ubuntu-latest`; the Electron smoke on `macos-15` (arm64) and `macos-15-intel` (x64). `macos-latest` is arm64-only and `macos-14` was retired on 2026-11-02. Public repos make these free.
9. **Cross-repo triggers:** the site rebuild in the app repo runs on a 6-hourly schedule plus `workflow_dispatch`, polling the mirror's newest `stable-*` tag; `promote` additionally fires a `repository_dispatch` with `ENGINE_PUSH_TOKEN`. Release-published site rebuilds depend on the owner publishing the draft by hand, which 05 already requires.
10. **Shell/engine compatibility contract:** each `stable-*` annotation carries `minShell`; the shell refuses an engine update whose `minShell` exceeds its own version and offers "Update OpenTac first". The gate smoke runs against the latest released shell and app `main`.
11. **Delivery latency:** in addition to the launch check, the shell re-checks every 6 h while running, on `powerMonitor` resume and on window focus (rate-limited), using `git ls-remote` (no API quota). A `severity: security` promotion bypasses `skippedCommit`.
12. **Shell-side weekly maintenance** in the app repo: a scheduled job compares `scripts/node-version.json` against nodejs.org's 24.x line and Electron 45.x patches and opens an issue/PR; a dead-man check opens an issue if the mirror's `upstream-main` is more than 48 h stale or `watch.yml` is disabled. Node version and checksums move to `scripts/node-version.json` so both repos read one machine-readable file.
13. **Notification noise:** `watch` is silent except on anomalies; intake sends one weekly digest; the Thursday promote message states whether the candidate build was ever launched on the owner's Mac (local marker the candidate-channel app writes and the owner confirms via a `canary-ok` label for the first promotions).

## 2026-11-03 — Foundation modules

- `Channel` is `'stable' | 'candidate' | 'upstream'` (08-STAGED-UPDATES.md §4), not the `'stable' | 'main'` of 03-ARCHITECTURE.md §2; 03 is superseded on this point. `state.json` keeps `schemaVersion: 1`; the AI preference (`provider`, `model`, `ollamaHost`) lives there while provider keys live in Keychain.
- Log redaction treats a `KEY=VALUE` assignment as secret only when the key **ends** in `API_KEY`, `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `PASS` (whole-word suffix), so `max_tokens=200` in a Vite or upstream log line is not blanked. Token-shaped values (OpenAI, Google, GitHub, OpenRouter, xAI, JWTs, Bearer headers, URL credentials) are redacted regardless of context.
- `saveState` is atomic (tmp + fsync + rename, mode 0600) but not serialised; the controller is the single writer and awaits each save, which is the invariant that keeps this safe.
