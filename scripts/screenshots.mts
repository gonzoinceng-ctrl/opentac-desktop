// Captures the website screenshots from the real (or fake-engine) OpenTac app.
//
//   OPENTAC_DATA_DIR=$(mktemp -d) OPENTAC_ENGINE_REF=refs/remotes/origin/upstream-main SHOT_SETTLE_MS=45000 \
//     npx -y tsx scripts/screenshots.mts          (see scripts/site-screenshots.md)
//
// Launches the built app from dist/ with Playwright's _electron (same approach as test/e2e/app.spec.ts),
// waits for the engine window, lets the globe settle, then writes PNGs (2x) and 1x WebP copies to
// site/src/assets/screenshots/. Every OPENTAC_* variable the e2e uses is passed through untouched.
//
// Env: SHOT_SETTLE_MS (default 25000)   extra wait after the engine window appears
//      SHOT_BOOT_TIMEOUT_MS (1200000)   how long to wait for the engine window (first run clones + installs)
//      SHOT_WITH_UPDATE=1               switch the channel to `upstream` in Preferences so a real update
//                                       disclosure appears (captured as 07-update-disclosure.png)
//      SHOT_OUT_DIR                     output directory (default site/src/assets/screenshots)
//      SHOT_SCALE (2)                   device scale factor
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(projectRoot, 'package.json'));
const electronPath = require('electron') as string;
const sharp = require('sharp') as typeof import('sharp');

const num = (v: string | undefined, d: number): number => (v !== undefined && /^\d+$/.test(v) ? Number(v) : d);
const SETTLE_MS = num(process.env.SHOT_SETTLE_MS, 25_000);
const BOOT_TIMEOUT_MS = num(process.env.SHOT_BOOT_TIMEOUT_MS, 1_200_000);
const SCALE = num(process.env.SHOT_SCALE, 2);
const OUT = resolve(process.env.SHOT_OUT_DIR ?? join(projectRoot, 'site', 'src', 'assets', 'screenshots'));
const WITH_UPDATE = process.env.SHOT_WITH_UPDATE === '1';
const ENGINE_URL = /^http:\/\/127\.0\.0\.1:\d+\//;
const SETUP_URL = (u: string): boolean => u.startsWith('app://');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]): void => console.log('[shots]', ...a);
const written: string[] = [];
const skipped: string[] = [];

if (!existsSync(join(projectRoot, 'dist', 'main'))) {
  log('dist/ is missing: running node scripts/build.mjs');
  execFileSync(process.execPath, [join(projectRoot, 'scripts', 'build.mjs')], { cwd: projectRoot, stdio: 'inherit' });
}
mkdirSync(OUT, { recursive: true });

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
env.NO_COLOR = '1';

const app: ElectronApplication = await electron.launch({
  executablePath: electronPath,
  args: ['.', `--force-device-scale-factor=${SCALE}`],
  cwd: projectRoot,
  env,
});

function pageWhere(match: (u: string) => boolean): Page | undefined {
  return app.windows().find((p) => match(p.url()));
}

async function save(page: Page, name: string): Promise<void> {
  const png = join(OUT, `${name}.png`);
  await page.screenshot({ path: png });
  const meta = await sharp(png).metadata();
  const w1x = Math.round((meta.width ?? 1440 * SCALE) / SCALE);
  await sharp(png).resize({ width: w1x }).webp({ quality: 82, effort: 5 }).toFile(join(OUT, `${name}.webp`));
  written.push(`${name}.png (${meta.width}x${meta.height}) + ${name}.webp (${w1x}px)`);
  log('wrote', name);
}

async function clickMenu(label: string): Promise<void> {
  // No named inner functions here: tsx/esbuild would inject a __name() helper that does not exist in Electron's main process.
  await app.evaluate(({ Menu }, wanted) => {
    const menu = Menu.getApplicationMenu();
    const stack: Electron.MenuItem[] = menu ? [...menu.items] : [];
    while (stack.length > 0) {
      const item = stack.shift() as Electron.MenuItem;
      if (item.label === wanted) {
        item.click();
        return;
      }
      if (item.submenu) stack.push(...item.submenu.items);
    }
    throw new Error(`menu item "${wanted}" not found`);
  }, label);
}

async function visible(page: Page, selector: string, timeout: number): Promise<boolean> {
  try {
    await page.locator(selector).waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    skipped.push(`${name}: ${(e as Error).message.split('\n')[0]}`);
    log('SKIPPED', name, '-', (e as Error).message.split('\n')[0]);
  }
}

async function setupWindow(): Promise<Page> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const p = pageWhere(SETUP_URL);
    if (p) return p;
    if (Date.now() > deadline) throw new Error('setup window not found');
    await sleep(200);
  }
}

async function openPreferencesTab(tabText: string): Promise<Page> {
  const setup = await setupWindow();
  if (!(await visible(setup, '#panel-preferences', 500))) {
    await clickMenu('Preferences…');
    if (!(await visible(setup, '#panel-preferences', 15_000))) throw new Error('Preferences panel did not open');
  }
  await setup.locator('button[role="tab"]', { hasText: tabText }).first().click();
  await sleep(1500); // let the tab's content (key rows etc.) load
  return setup;
}

try {
  // 1. Boot. The setup window shows progress on a first run; grab it once while it is visible.
  let gotProgress = false;
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let main: Page | undefined;
  for (;;) {
    main = pageWhere((u) => ENGINE_URL.test(u));
    if (main) break;
    const setup = pageWhere(SETUP_URL);
    if (setup && !gotProgress && (await visible(setup, '#panel-progress', 200))) {
      await sleep(4000); // let some log lines appear
      if (await visible(setup, '#panel-progress', 200)) {
        await step('02-setup-progress', async () => save(setup, '02-setup-progress'));
        gotProgress = true;
      }
    }
    if (Date.now() > deadline) throw new Error(`the engine window did not appear within ${BOOT_TIMEOUT_MS} ms`);
    await sleep(1000);
  }
  if (!gotProgress) skipped.push('02-setup-progress: not on a first run (no progress panel seen while booting)');

  // 2. The globe.
  await main.waitForSelector('canvas', { state: 'attached', timeout: 120_000 });
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => /^http:\/\/127\.0\.0\.1:\d+\//.test(x.webContents.getURL()));
    if (w) {
      w.setContentSize(1440, 900);
      w.center();
    }
  });
  log(`engine window up; settling ${SETTLE_MS} ms for the globe to render`);
  await sleep(SETTLE_MS);
  await save(main, '01-globe');

  // 3. Preferences tabs, About.
  await step('03-preferences-keys', async () => save(await openPreferencesTab('API keys'), '03-preferences-keys'));
  await step('04-preferences-engine', async () => save(await openPreferencesTab('Engine settings'), '04-preferences-engine'));
  await step('05-preferences-app', async () => save(await openPreferencesTab('App settings'), '05-preferences-app'));
  await step('06-about', async () => {
    const setup = await setupWindow();
    if (await visible(setup, '#btn-prefs-close', 300)) await setup.locator('#btn-prefs-close').click();
    await sleep(800);
    await clickMenu('About OpenTac…');
    if (!(await visible(setup, '#panel-about', 15_000))) throw new Error('About panel did not open');
    await sleep(800);
    await save(setup, '06-about');
    if (await visible(setup, '#btn-about-close', 300)) await setup.locator('#btn-about-close').click();
  });

  // 4. Update disclosure: only if one is on screen, or if SHOT_WITH_UPDATE=1 provokes one.
  await step('07-update-disclosure', async () => {
    const setup = await setupWindow();
    if (WITH_UPDATE) {
      await openPreferencesTab('Updates');
      await setup.locator('input[name="channel"][value="upstream"]').check();
      log('channel switched to upstream; waiting for the update disclosure');
    } else if (!(await visible(setup, '#panel-disclosure', 500))) {
      throw new Error('no disclosure panel is showing (set SHOT_WITH_UPDATE=1 to provoke one)');
    }
    if (!(await visible(setup, '#panel-disclosure', 120_000))) throw new Error('no update disclosure appeared');
    await sleep(1500);
    await save(setup, '07-update-disclosure');
  });
} finally {
  log(`written (${written.length}):`);
  for (const w of written) log('  ', w);
  if (skipped.length) {
    log(`skipped (${skipped.length}):`);
    for (const s of skipped) log('  ', s);
  }
  log('output directory:', OUT);
  try {
    await app.close();
  } catch {
    /* already gone */
  }
}
if (!written.some((w) => w.startsWith('01-globe'))) process.exitCode = 1;
process.exit(process.exitCode ?? 0);
