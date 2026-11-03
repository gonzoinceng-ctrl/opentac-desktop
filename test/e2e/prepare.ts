import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createCheckoutManager } from '../../src/main/checkout.js';
import { defaultState, saveState } from '../../src/main/state.js';
import { createCheckoutFixture, type CheckoutFixture } from '../helpers/checkout-fixture.js';

const execFileAsync = promisify(execFile);

/** Absolute path of the fake npm-cli used for engine updates that change the lockfile. */
export const FAKE_NPM_CLI = fileURLToPath(new URL('../helpers/core-fake-npm-cli.cjs', import.meta.url));
/** Absolute path of the fake launcher (serves a page with a canvas, prints the Ready line). */
export const FAKE_LAUNCHER = fileURLToPath(new URL('../fixtures/fake-launcher.mjs', import.meta.url));

/** A data directory that boots straight to RUNNING, plus the fixture it was made from. */
export interface PreparedDataDir {
  /** Value for OPENTAC_DATA_DIR. */
  dataDir: string;
  /** Value for OPENTAC_ENGINE_REMOTE (file:// URL of the fixture mirror). */
  mirrorUrl: string;
  fixture: CheckoutFixture;
  /** Removes the whole temp tree. */
  cleanup(): Promise<void>;
}

/**
 * Builds a warm install in a temp folder: a fixture mirror, a checkout cloned from it at `stable`
 * with a fake node_modules, and a state.json that says the install is current. A boot from it goes
 * BOOT -> STARTING -> RUNNING with no clone and no install.
 */
export async function prepareDataDir(): Promise<PreparedDataDir> {
  const fixture = await createCheckoutFixture();
  try {
    const dataDir = join(fixture.root, 'data');
    const checkoutDir = fixture.checkoutDir;
    await mkdir(dataDir, { recursive: true });

    const checkout = createCheckoutManager({ checkoutDir, git: fixture.git, log: fixture.log });
    await checkout.clone(fixture.mirrorUrl, () => undefined);
    await checkout.fetch();
    const stable = fixture.commits.c2;
    await checkout.checkoutDetached(stable);

    // What the fake npm-cli leaves behind. The inner .gitignore keeps the dirty report clean, like
    // upstream's real .gitignore does for node_modules.
    const modules = join(checkoutDir, 'node_modules');
    await mkdir(modules, { recursive: true });
    await writeFile(join(modules, '.gitignore'), '*\n');
    await writeFile(join(modules, '.fake-install'), await readFile(join(checkoutDir, 'package-lock.json')));

    const lock = await readFile(join(checkoutDir, 'package-lock.json'));
    const { stdout } = await execFileAsync(process.execPath, ['--version']);
    const state = {
      ...defaultState(),
      channel: 'stable' as const,
      remoteUrl: fixture.mirrorUrl,
      installedCommit: stable,
      installedLockHash: createHash('sha256').update(lock).digest('hex'),
      installedNodeVersion: stdout.trim().replace(/^v/, ''),
      lastPort: null,
    };
    await saveState(join(dataDir, 'state.json'), state);

    return { dataDir, mirrorUrl: fixture.mirrorUrl, fixture, cleanup: () => fixture.cleanup() };
  } catch (err) {
    await fixture.cleanup();
    throw err;
  }
}
