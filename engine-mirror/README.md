# OpenTac engine mirror (`opentac-ci`)

This is the default branch of **OWNER/opentac-engine**, the tested mirror of
[bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view)
that the OpenTac desktop app (OWNER/opentac-desktop) follows for its default update channel.

**The mirror has no engine commits of its own, ever.** Every commit reachable
from `stable` and `candidate` exists in upstream's history. This branch holds
only the pipeline: workflows, the contract-check script, the tag manifest and
the release log. Nothing on it is ever merged into engine history, and engine
refs are pushed separately. OpenTac-specific behaviour lives in the app (launcher
hooks, gateway, settings), never here.

The repository is a plain public repository, not a fork: forks start with
scheduled workflows disabled and cannot change visibility. The invariant is
enforced by `selfcheck.yml` against the real upstream, not by fork status.

## Refs

| Ref | Meaning | Moved by |
|---|---|---|
| `opentac-ci` (default branch) | this directory: workflows, `ci/`, `manifest/tags.json`, `RELEASES.md` | humans; `watch` (manifest) and `promote` (RELEASES.md) commit here |
| `upstream-main` | exact copy of upstream `main` | `watch`, fast-forward only |
| `candidate` | the commit under canary, followed by the owner's Mac ("Canary" channel) | `intake`, only after a green gate |
| `stable` | what every user's default channel follows | `promote`, fast-forward only |
| `stable-YYYY.MM.DD[-N]` | immutable annotated tag per promotion: audit trail, rollback target, release-note anchor | `promote` |
| `v*` | upstream's tags, mirrored by name | `watch` |
| `refs/notes/gate` | git notes on candidate commits holding the gate verdict JSON | `intake` |

There is deliberately **no branch named `main`**: upstream's `ci.yml` triggers on
pushes to `main`, so it can never fire on the mirror. `selfcheck.yml` fails if one appears. That is not the only
guard: see "Third-party workflows must never see the token" below.

A `stable-*` tag message looks like this (the app reads it):

```
OpenTac engine stable-2026.11.12

upstreamTag: v0.4.0
commitRange: <oldstable>..<newstable>
gateRun: https://github.com/OWNER/opentac-engine/actions/runs/123
canaryDays: 3
minShell: 1.0.0
severity: normal
```

## The weekly loop (what the owner does)

1. **Sunday 02:17 UTC, intake.** Picks the tip of `upstream-main` (policy `main`,
   the default; repository variable `INTAKE_POLICY=tags` switches to newest upstream
   semver tag, and `tags` with nothing newer is a one-line no-op, never a fallback to main).
   Runs the gate on that exact SHA.
2. **Monday morning, one message.** Either a `Canary: <sha> (<tag or main>)` issue
   (gate green, `candidate` moved) or a `Gate failed: ...` issue naming the failing job, the
   contract message and the upstream compare link (`candidate` did not move). The weekly
   `OpenTac engine weekly digest` issue gets a comment either way.
3. **Use the candidate.** Your Mac is on the Canary channel and updates itself on next launch.
   Use it normally.
4. **Thursday, promote.** `promote` runs every 6 hours and promotes the canary once
   `readyAt + 72 h` has passed, unless the canary issue has the label `hold` or `reject`.
   Labels are re-read immediately before `stable` is pushed.
5. Users get the update prompt on their next check.

Labels you use on the canary issue:

- `hold`: stop automatic promotion; remove it to resume (the 72 h clock is not restarted).
- `reject`: close this canary without promoting. `stable` stays; the next intake replaces the candidate.
- `canary-ok`: you confirm the canary build was actually launched on your Mac. Required for the
  **first 3 promotions** (repository variable `CANARY_OK_FIRST_N`, default 3, `0` disables). Until
  then `promote` waits quietly with a notice in the run log.
- `superseded`, `gate-failed`, `tag-drift`, `history-rewrite`, `selfcheck-failed`, `workflow-trigger`, `digest`, `canary`
  are applied by the workflows.

### Hotfix (about 20 minutes)

1. Run **watch** (so the mirror has the commit).
2. Run **intake** by hand with `ref` set to the upstream commit or tag. It still has to be a commit of
   upstream main's history. Add `force` only if the commit is not a descendant of `stable`.
3. When the canary issue appears, run **promote** with `force=true` (and `severity=security` for a
   security fix: the app then bypasses its skipped-commit memory). `force` skips the gate-note
   check, the 72 h clock, `hold`/`reject`/`canary-ok`. It never skips: the commit must be in upstream's
   history, and `stable` only ever fast-forwards (no force push exists anywhere in these workflows).

## Workflows

| File | When | What it does |
|---|---|---|
| `watch.yml` | hourly (`:23`) | checks upstream tags against `manifest/tags.json` (object and peeled SHA) and fails with a `tag-drift` issue on deletion or change; checks upstream `main` descends from `upstream-main` and fails with a `history-rewrite` issue otherwise; fast-forwards `upstream-main`; pushes NEW tags by name; records them in the manifest. Silent on success. |
| `intake.yml` | Sunday 02:17 UTC, manual | chooses the candidate SHA, runs the gate, on green opens the canary issue (JSON block + report), then moves `candidate`, writes the git note and supersedes older canaries; on red opens/updates `gate-failed`. |
| `gate.yml` | called by intake, or manual | upstream `npm ci`, `doctor`, `test`, `build` under the Node version read from the app repo's `scripts/node-version.json`; `ci/contracts.mjs`; size and dependency diff against `stable`; OpenTac Playwright smoke on macOS arm64 and Intel (see below); produces `gate-report.md`. |
| `promote.yml` | every 6 h (`:41`), manual | the promotion described above, then `RELEASES.md` entry and a `repository_dispatch` (`engine-promoted`) to the app repo. Idempotent. |
| `selfcheck.yml` | weekly (Monday 04:31 UTC) | verifies the zero-engine-commits invariant and that no `main` branch exists; opens `selfcheck-failed` on violation. |

All five share `concurrency: engine-refs` (no cancellation). GitHub keeps one running and at most one
pending run per group, so a newer pending run replaces an older pending one; the schedules are spaced so
this does not bite, and a replaced scheduled run simply happens at its next slot. Gate runs inside intake and
holds the group for its whole duration.

The compatibility smoke is **pending until the app has an e2e suite**: the `smoke` job checks whether the
app's `package.json` has an `e2e` script. Without one it reports `PENDING` in the gate report and passes. As soon
as the script exists it runs `npm run e2e` with `OPENTAC_E2E_APP`, `OPENTAC_ENGINE_REMOTE`
(this mirror), `OPENTAC_ENGINE_REF` (the candidate SHA) and a temporary `OPENTAC_DATA_DIR`, and gates on it.
The app's `test/e2e/gate.spec.ts` is the suite that honours those variables: it spawns the built .app against the
candidate SHA from an empty data directory and checks clone, install, start, the key-setup contract and a clean quit. The Intel
leg (`macos-15-intel`) is `continue-on-error` until it has been stable for a while.

## Secrets and variables

| Name | Where | Purpose |
|---|---|---|
| `ENGINE_PUSH_TOKEN` | **environment secret** on the `engine-push` environment (not a repository secret) | **Fine-grained PAT or GitHub App token** with **Contents, Workflows and Issues write on this repository** and **Contents write on OWNER/opentac-desktop**. Used for every push of engine refs and tags, for committing the manifest and `RELEASES.md`, and for the cross-repo dispatch. |
| `INTAKE_POLICY` | variable, optional | `main` (default) or `tags` |
| `MIN_SHELL` | variable, optional | fallback `minShell` for the very first promotion (later ones carry over from the previous `stable-*` tag). The `min_shell` input on a manual intake overrides. |
| `CANARY_OK_FIRST_N` | variable, optional | how many first promotions require the `canary-ok` label (default 3) |
| `TRUSTED_WORKFLOW_TREES` | variable, optional | comma-separated `.github/workflows` tree ids you reviewed after a `workflow-trigger` issue (see below) |

### Third-party workflows must never see the token

The mirror pushes upstream-authored commits and tags with a PAT, and PAT pushes fire workflows: the workflow files
that run are the ones inside the pushed commit, i.e. upstream's code. Two layers keep the token away from them:

1. `ENGINE_PUSH_TOKEN` is an **environment secret** on an environment named `engine-push` whose deployment branches
   are restricted to `opentac-ci`. Only jobs that declare `environment: engine-push` (the `watch`, `intake` pick and
   finish, and `promote` jobs) can read it, and only when running on `opentac-ci`. Upstream workflows triggered by a push
   to `upstream-main`, `candidate`, `stable` or a tag run on those refs and cannot. `bootstrap.sh` creates the
   environment; set the secret with `gh secret set ENGINE_PUSH_TOKEN --repo OWNER/opentac-engine --env engine-push`.
   The gate (which runs `npm ci`/`npm test` from the engine) is called without `secrets: inherit` and gets no token.
2. `ci/trigger-scan.mjs` reads the `on:` block of every upstream workflow before `watch` pushes anything (and weekly in
   `selfcheck`, over the upstream tip, `candidate`, `stable` and every `v*`/`stable-*` tag). If a `push` trigger has no
   filter, or its branch/tag filters could match `upstream-main`, `candidate`, `stable`, `v*` or `stable-*`, or the
   workflow uses `workflow_run`, `create` or `delete`, or the block cannot be parsed, `watch` pushes nothing, opens a
   `workflow-trigger` issue and fails. Upstream's current `ci.yml` (`push: [main]`, `pull_request`) is safe. After you
   review a flagged workflow, add the printed tree id to `TRUSTED_WORKFLOW_TREES`. `bootstrap.sh` runs the same scan
   before its first push and refuses unless given `--trust-upstream-workflows`.

Why not `GITHUB_TOKEN`: upstream edits `.github/workflows/ci.yml` regularly, and `GITHUB_TOKEN` has no
`workflows` scope, so the first fast-forward past such a commit would be rejected. Every workflow declares its
`permissions:` explicitly; the token is only attached to requests for this repository's own URL, never to fetches
from upstream, and upstream is always addressed by its literal URL, never by an input.

`gate.yml` reads `https://raw.githubusercontent.com/OWNER/opentac-desktop/main/scripts/node-version.json` anonymously
and fails if it is missing, so the app repository must be public (or that line changed).

## If a scheduled workflow stops running

GitHub disables scheduled workflows in a public repository after 60 days without repository activity, and a repository
started from a fork has them disabled to begin with. Cron runs alone do not count as activity. `watch.yml` commits to this
branch only when upstream publishes a tag, and `promote.yml` only when it promotes. The app repository's weekly
dead-man check opens an issue when `upstream-main` is more than 48 hours stale or `watch.yml` is disabled.

To re-enable (the banner on the Actions tab says "This scheduled workflow is disabled because there hasn't been activity..."):

```
gh workflow enable watch.yml   --repo OWNER/opentac-engine
gh workflow enable intake.yml  --repo OWNER/opentac-engine
gh workflow enable promote.yml --repo OWNER/opentac-engine
gh workflow enable selfcheck.yml --repo OWNER/opentac-engine
gh workflow run watch.yml --repo OWNER/opentac-engine      # and check it is green
```

or Actions tab, pick the workflow, "Enable workflow". Any commit to this branch also resets the 60-day clock.

## Tag ruleset (create once; `bootstrap.sh` tries to do it)

Settings > Rules > Rulesets > New tag ruleset:

- Name: `opentac-immutable-tags`, Enforcement: **Active**
- Target tags: include pattern `v*` and `stable-*`
- Rules: **Restrict updates** and **Restrict deletions** (do not restrict creations; `watch` and `promote` create tags)
- No bypass actors

This is the server-side half of the tag-drift protection. `watch.yml` is the detection half: it compares
`git ls-remote --tags` of upstream to `manifest/tags.json` and refuses to continue on any change.

## Local checks

```
node --test "ci/test/*.test.mjs"                 # semver matcher, manifest diff, canary JSON, tag naming, contracts
node ci/contracts.mjs <engineDir> --node 24.22.2 # exit 1 on any failed contract; --json and --md also available
node ci/manifest.mjs check https://github.com/bilawalsidhu/gods-eye-view
```

(`node --test ci/test` with a bare directory does not work on Node 24; use the glob. `npm test` in this directory does it for you.)
The contracts test run against a live upstream checkout reads `UPSTREAM_DIR` and is skipped if there is none.

## Files

```
.github/workflows/{watch,intake,gate,promote,selfcheck}.yml
ci/contracts.mjs    the 08 section 3.3 contracts as named checks (no dependencies)
ci/manifest.mjs     upstream tag manifest: check / update
ci/canary.mjs       canary issue JSON, 72 h clock, stable tag names, RELEASES.md entries, report template
ci/depdiff.mjs      lockfile diff summary
ci/lib.sh           shared shell helpers for the workflows
ci/test/            node:test suites
manifest/tags.json  object + peeled SHA of every mirrored upstream tag
RELEASES.md         one entry per promotion
gate-report.template.md
```

`bootstrap.sh` (in the app repository, not pushed here) creates the repository, pushes this directory as the orphan branch,
sets it as default, mirrors upstream, seeds `stable` and `candidate`, and creates labels and the ruleset.
