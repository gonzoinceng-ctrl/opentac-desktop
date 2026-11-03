import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, type Logger, type LogSink } from '../../src/main/logger.js';

/** Logger writing to an array, for assertions on what was logged. */
export function arrayLogger(): { log: Logger; out: string[] } {
  const out: string[] = [];
  const sink: LogSink = {
    info: (m) => out.push(`info:${m}`),
    warn: (m) => out.push(`warn:${m}`),
    error: (m) => out.push(`error:${m}`),
    debug: (m) => out.push(`debug:${m}`),
  };
  return { log: createLogger(sink), out };
}

/** A throwaway directory tree for one install test. */
export interface InstallFixture {
  root: string;
  checkoutDir: string;
  nodeModulesDir: string;
  npmCacheDir: string;
  home: string;
  cleanup(): Promise<void>;
}

/** Minimal valid lockfile (v3, no dependencies) matching {@link FIXTURE_PACKAGE_JSON}. */
export const FIXTURE_LOCKFILE = {
  name: 'fixture',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: { '': { name: 'fixture', version: '1.0.0' } },
};

/** package.json of the fixture checkout. */
export const FIXTURE_PACKAGE_JSON = { name: 'fixture', version: '1.0.0', private: true };

/** Creates a temp checkout with a package.json and lockfile. */
export async function makeInstallFixture(): Promise<InstallFixture> {
  const root = await mkdtemp(join(tmpdir(), 'opentac-install-'));
  const checkoutDir = join(root, 'checkout');
  const npmCacheDir = join(root, 'npm-cache');
  const home = join(root, 'home');
  await mkdir(checkoutDir, { recursive: true });
  await mkdir(npmCacheDir, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(checkoutDir, 'package.json'), JSON.stringify(FIXTURE_PACKAGE_JSON));
  await writeFile(
    join(checkoutDir, 'package-lock.json'),
    JSON.stringify(FIXTURE_LOCKFILE, null, 2),
  );
  return {
    root,
    checkoutDir,
    nodeModulesDir: join(checkoutDir, 'node_modules'),
    npmCacheDir,
    home,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
