# Releasing OpenTac

This is the exact procedure for shipping a new OpenTac **app** (the Electron shell). Engine (God's Eye View) updates ship
separately through the mirror's `stable` tag and never need an app release (`docs/brief/08-STAGED-UPDATES.md`, corrected by
`docs/DECISIONS.md`).

Nothing in CI ever publishes a release. The workflow builds, signs, notarizes and verifies, then leaves a **draft**; a human
publishes it.

## Release procedure

1. **Prepare `main`.** CI (`.github/workflows/ci.yml`) is green on the commit you will tag. Optionally add a
   `## [vX.Y.Z] - YYYY-MM-DD` section to `CHANGELOG.md` for hand-written notes; otherwise the notes are the commit subjects since
   the previous tag.
2. **Bump the version.** `npm version X.Y.Z --no-git-tag-version` updates `package.json` and `package-lock.json`. Commit
   (`Release vX.Y.Z`) and push to `main`. Version numbers are never reused, even after a rollback (see below).
3. **Tag and push.**
   ```
   git tag -a vX.Y.Z -m "OpenTac vX.Y.Z"
   git push origin vX.Y.Z
   ```
   The `preflight` job fails the run if the tag is not `v` + the `package.json` version.
   To rebuild an existing tag without re-pushing it: Actions, "Release", "Run workflow", enter the tag.
4. **CI builds the draft** (`.github/workflows/release.yml`; roughly 20 to 40 minutes, notarization is the slow part):
   - `build` runs twice in parallel on native runners: `macos-15` (arm64) and `macos-15-intel` (x64). Each job runs `npm ci`,
     `npm run fetch-node`, `npm run make-icon`, `npm run build`, then `electron-builder --mac dmg zip --<arch> --publish never` (targets are named on the command line because the explicit `arch` lists in `electron-builder.yml` would otherwise make each runner build both architectures), then
     `scripts/verify-bundle.sh` and `scripts/verify-notarized.sh` (which also mounts the `.dmg` and checks the app inside it).
     Any failure fails the job. A non-fatal `@electron/fuses read` is printed for the log.
   - `publish` merges `latest-mac-arm64.yml` and `latest-mac-x64.yml` into one `latest-mac.yml`
     (`scripts/merge-latest-mac.mjs`), writes `SHA256SUMS.txt` (`scripts/sha256sums.mjs`), generates notes
     (`scripts/release-notes.mjs`), creates or reuses a **draft** release for the tag and uploads every asset with `--clobber`.
     It refuses to touch a release that is already published.
   - Draft assets: `OpenTac-X.Y.Z-arm64.dmg`, `OpenTac-X.Y.Z.dmg` (Intel), `OpenTac-X.Y.Z-arm64-mac.zip`,
     `OpenTac-X.Y.Z-mac.zip` (Intel), their `.blockmap` files, `latest-mac.yml` and `SHA256SUMS.txt`. Keep electron-builder's
     default names: electron-updater picks the Apple Silicon zip by the `arm64` substring.
5. **Owner smoke test on the draft** (a draft is visible only to repository writers):
   1. Download the `.dmg` for your Mac **in a browser** from the draft release page, so it carries the quarantine attribute.
      Files fetched with `gh release download` or `curl` skip Gatekeeper and prove nothing.
   2. Verify the checksum: `shasum -a 256 -c SHA256SUMS.txt --ignore-missing` in the download folder.
   3. Open the dmg, drag to Applications, double-click. Expected: the normal "downloaded from the internet" prompt only; no
      "unidentified developer" or "damaged" dialog. Do this on a second Mac or a fresh user account at least once per release
      (`docs/brief/05-PRODUCTION-READINESS.md`).
   4. Launch: the setup window credits Bilawal Sidhu, the engine installs (first run) or starts, the globe loads, and Quit leaves
      no child processes.
   5. Run the Intel build on an Intel Mac or under Rosetta.
   6. Optional: `scripts/verify-notarized.sh /Applications/OpenTac.app` on that Mac.
6. **Publish.** In the draft release page click "Publish release". Do not tick "pre-release": electron-updater ignores
   pre-releases. Publishing triggers `site.yml`, which rebuilds opentac.icu with the new download links and checksums.
7. **Update-from-previous test.** electron-updater cannot see drafts, so this check happens right after publishing: on a Mac
   running the **previous** release, use "Check for Updates", and confirm it downloads, installs, relaunches into X.Y.Z, and the
   data directory is untouched. If it fails, roll back (below) within minutes.
8. **Confirm the site:** opentac.icu shows X.Y.Z and its checksums equal `SHA256SUMS.txt`. If it did not rebuild, run the "Site"
   workflow manually.

## Toolchain bumps (Node, Electron)

`shell-maintenance.yml` runs every Monday at 06:37 UTC and opens or updates a `toolchain` issue when a newer Node 24.x or Electron
45.x patch exists. The issue includes the SHA-256 lines for the new Node tarballs.

- **Node:** edit `scripts/node-version.json` (`version`, both `sha256` values, `source`, `updated`), run `npm run fetch-node` locally
  (it fails on a checksum mismatch), run the unit and e2e suites, add a dated paragraph to `docs/DECISIONS.md`, then cut a release.
  The same file is read by CI and by the engine mirror's gate.
- **Electron, electron-builder, electron-updater, dugite:** change the exact pin in `package.json`, `npm install`, then
  `npm run typecheck`, `npx vitest run`, `npm run e2e`, `npm run pack` and `scripts/verify-bundle.sh`; note it in `docs/DECISIONS.md`.
  `npm run pack` output has no `app-update.yml` (only `npm run dist` dmg/zip builds write it), so shell auto-update can only be tested from a `dist` build or the draft release.
  Dependabot (weekly) proposes routine npm and Actions bumps and ignores Electron, TypeScript and @types/node majors.

Run the check locally with `node scripts/check-toolchain-updates.mjs` (exit code 2 means "update available").

## Secrets and how to produce them

Set these in the app repo (Settings, Secrets and variables, Actions) or with `gh secret set NAME --repo gonzoinceng-ctrl/opentac-desktop`.

Shortcut: `bash scripts/owner-setup.sh secrets` reads every value from 1Password (desktop app session, Personal vault) and pipes it straight into `gh secret set`, including the mirror's `ENGINE_PUSH_TOKEN`; `bash scripts/owner-setup.sh dns` repoints opentac.icu to the Pages site. Nothing is printed or written to disk.
Never commit them; `.gitignore` already excludes `*.p12` and `*.p8`.

| Secret | Used by | How to produce it |
| --- | --- | --- |
| `CSC_LINK` | release | Developer ID Application certificate **with its private key**, exported as `.p12`: Keychain Access, My Certificates, right-click "Developer ID Application: ...", Export. Then `base64 -i DeveloperID.p12 \| gh secret set CSC_LINK --repo gonzoinceng-ctrl/opentac-desktop`. electron-builder accepts the base64 string directly. |
| `CSC_KEY_PASSWORD` | release | The password chosen during the `.p12` export. |
| `APPLE_API_KEY_P8` | release | App Store Connect, Users and Access, Integrations, Team Keys: generate a key with the **Developer** role and download `AuthKey_XXXXXXXXXX.p8` (downloadable once). `gh secret set APPLE_API_KEY_P8 --repo gonzoinceng-ctrl/opentac-desktop < AuthKey_XXXXXXXXXX.p8`. The workflow writes it to a temp file, exports that file's **path** as `APPLE_API_KEY` (electron-builder needs a path, not contents) and deletes it afterwards. |
| `APPLE_API_KEY_ID` | release | The 10-character Key ID shown next to the key. |
| `APPLE_API_ISSUER` | release | The Issuer ID (a UUID) shown at the top of the Team Keys page. |
| `CLOUDFLARE_API_TOKEN` | site | Cloudflare dashboard, My Profile, API Tokens, custom token with **Account, Cloudflare Pages, Edit**, scoped to the one account. |
| `CLOUDFLARE_ACCOUNT_ID` | site | Cloudflare dashboard, account overview. Create the Pages project `opentac` first (Direct Upload, production branch `main`, custom domains `opentac.icu` and `www`). Without these two secrets `site.yml` still builds and skips the deploy with a notice. |
| `ENGINE_READ_TOKEN` (optional) | deadman | Fine-grained PAT, resource owner `gonzoinceng-ctrl`, only repository `opentac-engine`, permission **Actions: read** (Metadata read is implicit). Lets `deadman.yml` read the state of the mirror's `watch.yml`; without it that one check is skipped with a notice. |
| `ENGINE_PUSH_TOKEN` | **mirror repo** | Stored as a secret on `opentac-engine`, not here. Fine-grained PAT or GitHub App token for `opentac-engine` with **Contents: write, Workflows: write, Issues: write**, and **Contents: write on `opentac-desktop`** so `promote` can send the `engine-promoted` `repository_dispatch` that triggers `site.yml`. `GITHUB_TOKEN` cannot do this: it has no `workflows` scope and upstream edits its own workflow files (`docs/DECISIONS.md`, staged update pipeline item 3). |

`GITHUB_TOKEN` (automatic) is used for the draft release (`contents: write`, only in the `publish` job), for issues, and for the
site build's release lookups. Workflows never echo secrets; they reach scripts only through `env:`.

If any of the five signing secrets is missing, the release workflow stops in its first build step with a clear error.
(electron-builder alone would only warn about missing notarization credentials and still succeed with an un-notarized app.)

### How signing works in CI

electron-builder reads `CSC_LINK` and `CSC_KEY_PASSWORD` itself, imports the certificate into a temporary keychain on the runner and
removes it afterwards. No manual `security import` step is used. `hardenedRuntime`, the entitlements
(`build/entitlements.mac.plist`, including `disable-library-validation` for the engine's native addons) and notarization
(`mac.notarize: true` with the App Store Connect API key) come from `electron-builder.yml`. The `.dmg` container itself is not
signed (`dmg.sign: false`); the app inside it is signed, notarized and stapled, which is what Gatekeeper evaluates.

## Why one native job per architecture

- dugite's `postinstall` downloads **one** git build, for the machine running `npm ci`. Building both architectures from one
  `node_modules` would ship arm64 git inside the x64 app (or the reverse). Each architecture therefore installs and builds on its
  own native runner, and `verify-bundle.sh` asserts with `file` that both `Resources/node/bin/node` and the unpacked dugite `git`
  match the target architecture (and that `git --version` and `npm --version` actually run).
- Both `electron-builder` runs write a file called `latest-mac.yml`; uploaded as is, the second would overwrite the first and
  electron-updater would lose one architecture. Each job renames its file to `latest-mac-<arch>.yml` and `publish` merges them.
- Runners: `macos-15` is arm64; `macos-15-intel` is x64. `macos-latest` is arm64 only and `macos-14` is retired.

## Rollback

Prefer fixing forward: ship `vX.Y.(Z+1)`. Clients never downgrade (`allowDowngrade: false`), so a bad release that users already
installed can only be superseded by a higher version. Never reuse a version number.

To stop distribution of a bad published release quickly:

1. **Unpublish:** `gh release edit vX.Y.Z --draft --repo gonzoinceng-ctrl/opentac-desktop` (or "Edit", then "Set as a draft", in the
   UI). The release disappears from `releases/latest`, so running apps see the previous release's `latest-mac.yml` again and nobody
   new is offered X.Y.Z.
2. **Delete assets or the release** if the files themselves are bad (for example mis-signed):
   `gh release delete-asset vX.Y.Z <asset> --yes` per file, or `gh release delete vX.Y.Z --yes`. Remove the tag if it must not be
   rebuilt as is: `git push origin :refs/tags/vX.Y.Z`, then `git tag -d vX.Y.Z`.
3. **Refresh the site:** unpublishing does not trigger a rebuild. Run Actions, "Site", "Run workflow", so the download page returns
   to the previous version.
4. **Fix forward:** bump to the next patch, tag, and repeat the procedure. If the bad version was already installed by users, say so
   in the next release notes.

If only the engine (not the app) is bad, do not roll back the app: use the mirror's `hold`/`reject` labels or re-point `stable`
(`docs/brief/08-STAGED-UPDATES.md`).

## Workflows at a glance

| File | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | push to `main`, pull requests | `unit` (ubuntu): typecheck, vitest, script tests. `mac` (macos-15): build, Playwright e2e, unsigned arm64 pack, `verify-bundle.sh`. |
| `release.yml` | tag `v*`, manual with a tag | Per-arch signed and notarized build and verification, then the draft release. |
| `shell-maintenance.yml` | Mondays 06:37 UTC, manual | Node 24.x and Electron 45.x patch check; `toolchain` issue. |
| `deadman.yml` | every 12 h (minute 53), manual | Mirror `upstream-main` freshness and `watch.yml` state; `mirror-stale` issue. |
| `site.yml` | every 6 h (minute 11), manual, `engine-promoted` dispatch, release published | `npm run site:build`, then Cloudflare Pages deploy. |
| `dependabot.yml` | weekly | npm and GitHub Actions update PRs. |

Local checks for the release tooling: `node --test 'scripts/test/*.test.mjs'` (quote the glob; `node --test scripts/test` fails on
Node 24), `actionlint`, `shellcheck scripts/*.sh`.
