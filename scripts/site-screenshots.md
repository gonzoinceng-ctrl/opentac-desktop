# Website screenshots

`scripts/screenshots.mts` drives the built app with Playwright's `_electron` and writes the images the website
shows. The site build (`site/build.mjs`) picks up whatever PNG/WebP files are in `site/src/assets/screenshots/`
(hero = `01-globe`, the rest in a "Screenshots" section); with none present it keeps the placeholder.

## Real capture (real clone, install and globe)

Run on a Mac with a display, with `dist/` built (`npm run build`; the script runs `node scripts/build.mjs` itself
only if `dist/` is missing). A fresh data directory means a first run, so the setup progress screen is captured too.
This needs internet and takes several minutes.

```sh
OPENTAC_DATA_DIR=$(mktemp -d) OPENTAC_ENGINE_REF=refs/remotes/origin/upstream-main SHOT_SETTLE_MS=45000 npx -y tsx scripts/screenshots.mts
```

(Same thing: `npm run site:screenshots` with those variables set.)

For the update-disclosure shot (`07-update-disclosure.png`) add `SHOT_WITH_UPDATE=1`: the script switches the
channel to `upstream` in Preferences, which makes a real disclosure appear when upstream is ahead of the install.

## Output

`site/src/assets/screenshots/`: `01-globe`, `02-setup-progress` (first run only), `03-preferences-keys`,
`04-preferences-engine`, `05-preferences-app`, `06-about`, `07-update-disclosure` (see above). Each as a 2x PNG
(`SHOT_SCALE`, default 2; the globe window is sized to 1440x900) plus a 1x WebP made with sharp. The script prints
what it wrote and what it skipped, and exits non-zero if `01-globe.png` was not captured.

Then `npm run site:build` and deploy (see `site/README.md`). Look at the images before committing: they must
not show personal paths or keys (the About panel shows the data folder, which is a temp directory in this setup).

## Environment

- `SHOT_SETTLE_MS` (25000): wait after the engine window appears, for the globe to render.
- `SHOT_BOOT_TIMEOUT_MS` (1200000): how long to wait for the engine window.
- `SHOT_WITH_UPDATE=1`, `SHOT_SCALE`, `SHOT_OUT_DIR`: see the header of the script.
- Every `OPENTAC_*` override works as in the e2e: `OPENTAC_DATA_DIR`, `OPENTAC_ENGINE_REMOTE`, `OPENTAC_ENGINE_REF`,
  `OPENTAC_LAUNCHER_OVERRIDE`, `OPENTAC_NODE_OVERRIDE`, `OPENTAC_NPM_CLI_OVERRIDE`, `OPENTAC_E2E_NO_EXTERNAL`, `FAKE_MODE`.

## Dry run against the fake engine (no network, no real clone)

Prepare a warm fixture data directory the way `test/e2e/prepare.ts` does, then run with the fakes:

```sh
npx -y tsx -e '
import { prepareDataDir, FAKE_LAUNCHER, FAKE_NPM_CLI } from "./test/e2e/prepare.ts";
import { spawnSync } from "node:child_process";
const p = await prepareDataDir();
const r = spawnSync("npx", ["-y", "tsx", "scripts/screenshots.mts"], { stdio: "inherit", env: { ...process.env,
  OPENTAC_DATA_DIR: p.dataDir, OPENTAC_ENGINE_REMOTE: p.mirrorUrl, OPENTAC_LAUNCHER_OVERRIDE: FAKE_LAUNCHER,
  OPENTAC_NODE_OVERRIDE: process.execPath, OPENTAC_NPM_CLI_OVERRIDE: FAKE_NPM_CLI, OPENTAC_E2E_NO_EXTERNAL: "1",
  FAKE_MODE: "ok", SHOT_SETTLE_MS: "1000", SHOT_OUT_DIR: process.env.TMPDIR + "/opentac-shots" } });
await p.cleanup(); process.exit(r.status ?? 1);'
```

Dry-run images are not for the site: delete them (they go to `$TMPDIR/opentac-shots` here, not into the repo).
