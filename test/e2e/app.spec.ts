import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { FAKE_LAUNCHER, FAKE_NPM_CLI, prepareDataDir, type PreparedDataDir } from './prepare.js';

const execFileAsync = promisify(execFile);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = createRequire(join(projectRoot, 'package.json'))('electron') as string;

const ENGINE_URL = /^http:\/\/127\.0\.0\.1:\d+\/$/;

let prepared: PreparedDataDir;
let app: ElectronApplication;
let main: Page;
let appExited = false;

interface WindowInfo {
  url: string;
  visible: boolean;
}

async function windowInfos(): Promise<WindowInfo[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({ url: w.webContents.getURL(), visible: w.isVisible() })),
  );
}

async function pgrepLauncher(): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', FAKE_LAUNCHER]);
    return stdout.split('\n').filter((l) => l.trim() !== '').map(Number);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

async function findWindow(match: (url: string) => boolean, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const page of app.windows()) {
      if (match(page.url())) return page;
    }
    if (Date.now() > deadline) throw new Error(`no window matched within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  prepared = await prepareDataDir();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  }
  Object.assign(env, {
    OPENTAC_DATA_DIR: prepared.dataDir,
    OPENTAC_ENGINE_REMOTE: prepared.mirrorUrl,
    OPENTAC_LAUNCHER_OVERRIDE: FAKE_LAUNCHER,
    OPENTAC_NODE_OVERRIDE: process.execPath,
    OPENTAC_NPM_CLI_OVERRIDE: FAKE_NPM_CLI,
    OPENTAC_E2E_NO_EXTERNAL: '1',
    FAKE_MODE: 'ok',
    NO_COLOR: '1',
  });
  app = await electron.launch({ executablePath: electronPath, args: ['.'], cwd: projectRoot, env });
  app.process().once('exit', () => {
    appExited = true;
  });
});

test.afterAll(async () => {
  if (!appExited) {
    try {
      await app.close();
    } catch {
      /* already gone */
    }
  }
  // Safety net: no fake launcher may outlive the suite.
  for (const pid of await pgrepLauncher()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  await prepared.cleanup();
});

test('reaches RUNNING and shows the engine page', async () => {
  main = await findWindow((u) => ENGINE_URL.test(u), 90_000);
  await main.waitForSelector('canvas', { state: 'attached', timeout: 30_000 });
  const versions = await main.evaluate(() =>
    (window as unknown as { openTac: { getVersions(): Promise<{ app: string; engine: { commit: string | null } }> } }).openTac.getVersions(),
  );
  expect(versions.app).toMatch(/^\d+\.\d+\.\d+/);
  expect(versions.engine.commit).toBe(prepared.fixture.commits.c2);
});

test('the setup window is hidden while RUNNING', async () => {
  const infos = await windowInfos();
  const setup = infos.filter((w) => w.url.startsWith('app://'));
  expect(setup.length).toBeGreaterThan(0);
  expect(setup.every((w) => !w.visible)).toBe(true);
  const engine = infos.filter((w) => ENGINE_URL.test(w.url));
  expect(engine).toHaveLength(1);
  expect(engine[0]?.visible).toBe(true);
});

test('window.open to https goes to the system browser, not a new window', async () => {
  const before = app.windows().length;
  await main.evaluate(() => {
    window.open('https://example.com');
  });
  await new Promise((r) => setTimeout(r, 2000));
  expect(app.windows().length).toBe(before);
  const log = await readFile(join(prepared.dataDir, 'logs', 'main.log'), 'utf8');
  expect(log).toContain('E2E: openExternal suppressed for https://example.com');
});

test('an engine update shows its disclosure; Later hides the setup window again', async () => {
  await prepared.fixture.moveStable(prepared.fixture.commits.c3);

  await app.evaluate(({ Menu }) => {
    type Item = Electron.MenuItem;
    const find = (items: Item[], label: string): Item | undefined => {
      for (const item of items) {
        if (item.label === label) return item;
        if (item.submenu !== undefined && item.submenu !== null) {
          const hit = find(item.submenu.items, label);
          if (hit !== undefined) return hit;
        }
      }
      return undefined;
    };
    const menu = Menu.getApplicationMenu();
    const item = menu === null ? undefined : find(menu.items, 'Check for Engine Updates…');
    if (item === undefined) throw new Error('menu item "Check for Engine Updates…" not found');
    item.click();
  });

  const setup = await findWindow((u) => u.startsWith('app://'), 10_000);
  await expect(setup.locator('#panel-disclosure')).toBeVisible({ timeout: 30_000 });
  await expect(setup.locator('#commit-list li')).not.toHaveCount(0);
  await expect(setup.locator('#disclosure-buttons button', { hasText: 'Update' }).first()).toBeVisible();
  const visibleNow = (await windowInfos()).filter((w) => w.url.startsWith('app://')).some((w) => w.visible);
  expect(visibleNow).toBe(true);

  await setup.locator('#disclosure-buttons button', { hasText: 'Later' }).click();

  await expect
    .poll(async () => (await windowInfos()).filter((w) => w.url.startsWith('app://')).some((w) => w.visible), {
      timeout: 15_000,
    })
    .toBe(false);
  // The engine was not touched.
  expect(main.url()).toMatch(ENGINE_URL);
});

test('quitting stops the engine process', async () => {
  const pids = await pgrepLauncher();
  expect(pids.length).toBeGreaterThan(0);

  const exited = new Promise<void>((resolve) => {
    if (appExited) resolve();
    else app.process().once('exit', () => resolve());
  });
  await app.evaluate(({ app: electronApp }) => {
    setTimeout(() => electronApp.quit(), 0);
  });
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('the app did not quit within 20 s')), 20_000)),
  ]);

  await expect.poll(pgrepLauncher, { timeout: 10_000 }).toEqual([]);
  for (const pid of pids) {
    expect(() => process.kill(pid, 0)).toThrow();
  }
});
