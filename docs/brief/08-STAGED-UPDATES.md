# 08 — Staged Engine Updates (the gate)

**This document supersedes the "follow upstream tags directly" model in
`03-ARCHITECTURE.md §4.1/§4.4` and `04-IMPLEMENTATION-PLAN.md Phase 4`.**
Where they conflict, this file wins. The app never follows upstream directly
on its default channel; it follows a `stable` ref on an OpenTac-controlled
mirror that only advances after automated tests and a human canary period.

## 1. Repositories

| Repo | Role | Contains |
|---|---|---|
| `bilawalsidhu/gods-eye-view` | upstream | the engine (not ours) |
| `OWNER/opentac-engine` | **mirror + gate** | a fork of upstream with **zero commits of its own**. Only extra refs (`upstream-main`, `candidate`, `stable`, `stable-YYYY.MM.DD` tags) plus the gate's workflows on a separate orphan branch `opentac-ci` so they never touch engine history. |
| `OWNER/opentac` | the app | Electron shell, website, this brief |

**Inviolable rule:** no engine code changes in the mirror, ever. Every commit
reachable from `stable` must exist in upstream's history. This is what keeps
the app's fast-forward update model valid and keeps the project an honest
redistribution of upstream rather than a hidden fork. OpenTac-specific
behaviour lives in the shell (launcher hooks, gateway, settings).

## 2. Refs on the mirror

- `upstream-main` — exact mirror of upstream `main`. Advanced by the watcher.
- `candidate` — the commit currently under test / in canary.
- `stable` — the commit the app's default channel follows. Only advanced by
  the promote job.
- `stable-YYYY.MM.DD` — immutable tag created at every promotion (audit
  trail, rollback target, release-note anchor). Also carries the upstream
  tag name in its annotation when the candidate was a tagged upstream
  release.

## 3. Workflows (GitHub Actions on the mirror, branch `opentac-ci`)

### 3.1 `watch.yml` — hourly
- `git fetch upstream --tags --prune`; fast-forward `upstream-main`.
- If upstream's `main` is not a descendant of our `upstream-main` (history
  rewrite) → **fail loudly**, open an issue, do not move anything.
- If a tag we previously mirrored now points elsewhere → same.
- Post a short summary (new commits since last run, new tags) to a
  `#opentac-engine` notification channel (GitHub issue comment, email, or
  Slack — owner's choice). No other side effects.

### 3.2 `intake.yml` — weekly (Sunday 02:00 UTC) and `workflow_dispatch`
- Choose the candidate commit: by default the **latest upstream semver tag**
  newer than `stable`; if none, the tip of `upstream-main` (configurable:
  `INTAKE_POLICY=tags|main`). `workflow_dispatch` accepts an explicit
  commit/tag for hotfix promotion.
- Move `candidate` to it. Run the **gate** (3.3). On green: mark the
  candidate "ready for canary", start the canary clock (default 3 days).
  On red: leave `candidate` in place, open/update a "Gate failed" issue with
  the failing job, logs excerpt and the upstream compare link.

### 3.3 `gate.yml` — the tests (macOS runner, both arches where feasible)
Runs against the candidate commit with the **same bundled Node version the
app ships** (read from the app repo's `fetch-node.mjs` to keep them in sync).

1. **Upstream's own checks**: `npm ci` (with `PUPPETEER_SKIP_DOWNLOAD=1`),
   `npm run doctor` (report only), `npm test`, `npm run build`.
2. **Contract checks** (fast, pure assertions; each has a one-line
   failure message naming what changed upstream):
   - `engines.node` is satisfiable by the bundled Node version.
   - `scripts/pinokio-start.mjs` still exists and still: imports Vite after
     env is final, uses `strictPort`, prints a ready line (regex).
   - `server/standalone/key-setup.js` still writes `<root>/.env` when
     `GEV_LAUNCHER` is unset and still registers only in dev (`apply`).
   - `.gitignore` still ignores `.env`, `.gev-cache`, `.gev-logs`,
     `node_modules`, `dist`.
   - `build/allowedHosts.js` still accepts `127.0.0.1`.
   - `server/providers/openai/hud-summary.js` still posts to the exact URL
     the launcher interceptor rewrites, and `extractOpenAiResponseText`
     still accepts the gateway's response shape (run it directly).
   - Client still requires `RTCPeerConnection` + `getUserMedia` (voice) and
     `navigator.usb` (SDR) — informational, flags new browser APIs.
3. **OpenTac compatibility smoke** (Playwright `_electron`, built from the
   app repo's `main` at a pinned app version): launch OpenTac with
   `OPENTAC_ENGINE_REMOTE=<mirror>` and `OPENTAC_ENGINE_REF=candidate`
   against an empty data dir; assert clone → install → start → `RUNNING`
   within budget; main window URL on 127.0.0.1; `<canvas>` present;
   `/api/setup/status` 200; one free feed endpoint (e.g. `/api/satellites`
   or `/api/opensky` — whichever upstream exposes keylessly) returns data or
   a well-formed keyless response; POST a dummy key → restart → reload
   without the shell entering `CRASHED`; **upgrade test**: start from a data
   dir prepared at current `stable`, trigger update → disclosure → apply →
   `RUNNING`; then force `OPENTAC_FAIL_START_ONCE=1` on a second run →
   rollback path reaches `RUNNING` at the old commit.
4. **Size and dependency diff**: `node_modules` size, new native modules,
   new top-level deps (`npm ls --depth=0` diff), lockfile diff summary —
   attached to the run summary for the human to glance at.
5. Produce `gate-report.md` (versions, timings, results, compare link) as an
   artifact and as the body of the canary issue.

GPU note: CI WebGL is software-rendered. The smoke test proves the engine
boots and the shell's contracts hold; it cannot prove rendering performance.
That is what the canary is for.

### 3.4 `promote.yml` — manual button, or automatic after canary
- Preconditions: gate green for this exact candidate commit; canary period
  elapsed (default 3 days) **and** no `hold` label on the canary issue; or
  owner runs it manually with `force=true` for hotfixes.
- Actions: fast-forward `stable` to `candidate`; create tag
  `stable-YYYY.MM.DD` (annotated with upstream tag name, commit range, gate
  run URL); close the canary issue; post release notes (commit subjects
  grouped, diffstat, "dependencies changed: yes/no") to a `RELEASES.md` on
  `opentac-ci` and to the notification channel.
- Also triggers the website rebuild (engine version shown on `/changelog`).

## 4. Changes in the app

- `state.json`: `remoteUrl` defaults to the **mirror**; `channel` ∈
  `stable | candidate | upstream`:
  - `stable` → `refs/heads/stable` on the mirror (default for everyone).
  - `candidate` → `refs/heads/candidate` on the mirror (the owner's Mac;
    label it "Canary — may break" in Preferences).
  - `upstream` → `refs/remotes/origin/upstream-main` on the mirror (raw
    upstream, for diagnosing "is this us or them").
- `resolveTarget()` resolves branch heads instead of scanning `v*` tags; the
  semver tag logic is kept only to display the upstream version name in the
  UI (map commit → upstream tag via `git describe --tags --exact-match`).
- Disclosure panel additionally shows: "Tested by OpenTac on <date>, gate run
  <link>, canary <N> days" for `stable`; a yellow "untested" banner for the
  other two channels.
- Everything else (fast-forward only, dirty check, conditional reinstall,
  restart, rollback, 6-hour launch check) is unchanged.
- Rollback target list now includes the previous `stable-*` tags, so a user
  can roll back one promotion even if the automatic rollback marker is gone.

## 5. The human's weekly loop

1. Sunday night: intake runs. Monday morning you get one message: either
   "Candidate v0.4.0 passed the gate — canary started" or "Gate failed:
   contract check `key-setup writes root .env` — upstream changed X".
2. Your Mac is on `candidate`; it updates itself on next launch. Use it
   normally.
3. Thursday: promote runs automatically unless you added `hold` to the
   canary issue. Users get the prompt on next launch.
4. Hotfix: run `intake.yml` by hand with a commit, let the gate run, promote
   with `force=true`. ~20 minutes end to end.

## 6. Failure modes this does and doesn't cover

Covers: upstream breaking the launcher contract, Node version bumps,
dependency install failures, build/test regressions, update-path
regressions, the engine failing to boot in Electron, silent changes to the
pieces OpenTac hooks into.

Does not cover: rendering/perf regressions (canary covers), feature-level
regressions inside the globe (upstream's problem; report upstream), API
provider changes on OpenAI/Google's side (not version-related).

## 7. Tasks to add

- **Phase 2/4 changes**: implement channel/ref model per §4; keep the
  `OPENTAC_ENGINE_REMOTE` / `OPENTAC_ENGINE_REF` env overrides for CI and
  for pointing at a different mirror.
- **Phase 5b — mirror repo**: create `opentac-engine` as a fork; add the
  `opentac-ci` orphan branch with `watch.yml`, `intake.yml`, `gate.yml`,
  `promote.yml`, the contract-check script (`ci/contracts.mjs`), and the
  gate report template. Seed `stable` and `candidate` at the current
  upstream tag. Document the `hold` label and the manual promote in the
  mirror's `opentac-ci/README.md`.
- **Readiness additions**: gate green on at least two consecutive weekly
  intakes before first public release; one deliberate contract break (edit
  a check's expectation) proves the gate fails loudly; one forced promote
  exercised; the app's About panel shows the `stable-*` tag and gate link.
