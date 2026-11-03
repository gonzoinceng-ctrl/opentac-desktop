import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDataDirs, resolvePaths, type PathsInput } from '../../src/main/paths.js';

const base: PathsInput = {
  userData: '/Users/u/Library/Application Support/OpenTac',
  logs: '/Users/u/Library/Logs/OpenTac',
  resourcesPath: '/Applications/OpenTac.app/Contents/Resources',
  appRoot: '/work/opentac',
  isPackaged: true,
  arch: 'arm64',
  env: {},
};

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('resolvePaths', () => {
  it('derives the user-data layout from userData', () => {
    const p = resolvePaths(base);
    expect(p.dataDir).toBe(base.userData);
    expect(p.checkoutDir).toBe(join(base.userData, 'checkout'));
    expect(p.envFile).toBe(join(base.userData, 'checkout', '.env'));
    expect(p.gevCacheDir).toBe(join(base.userData, 'checkout', '.gev-cache'));
    expect(p.gevLogsDir).toBe(join(base.userData, 'checkout', '.gev-logs'));
    expect(p.nodeModulesDir).toBe(join(base.userData, 'checkout', 'node_modules'));
    expect(p.viteCacheDir).toBe(join(base.userData, 'checkout', 'node_modules', '.vite'));
    expect(p.stateFile).toBe(join(base.userData, 'state.json'));
    expect(p.stateBackupFile).toBe(join(base.userData, 'state.json.bak'));
    expect(p.npmCacheDir).toBe(join(base.userData, 'npm-cache'));
  });

  it('places logs in the Electron logs dir', () => {
    const p = resolvePaths(base);
    expect(p.logsDir).toBe(base.logs);
    expect(p.mainLog).toBe(join(base.logs, 'main.log'));
    expect(p.serverLog).toBe(join(base.logs, 'server.log'));
  });

  it('uses bundle resources when packaged', () => {
    const p = resolvePaths(base);
    const r = base.resourcesPath;
    expect(p.nodeBin).toBe(join(r, 'node', 'bin', 'node'));
    expect(p.npmCli).toBe(join(r, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    expect(p.launcherScript).toBe(join(r, 'launcher', 'opentac-start.mjs'));
    expect(p.gitDir).toBe(join(r, 'app.asar.unpacked', 'node_modules', 'dugite', 'git'));
  });

  it('uses vendor/ and the repo tree when not packaged', () => {
    const p = resolvePaths({ ...base, isPackaged: false });
    const a = base.appRoot;
    expect(p.nodeBin).toBe(join(a, 'vendor', 'node', 'darwin-arm64', 'bin', 'node'));
    expect(p.npmCli).toBe(
      join(a, 'vendor', 'node', 'darwin-arm64', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    );
    expect(p.launcherScript).toBe(join(a, 'resources', 'launcher', 'opentac-start.mjs'));
    expect(p.gitDir).toBe(join(a, 'node_modules', 'dugite', 'git'));
  });

  it('switches the vendored node directory with arch in dev', () => {
    const p = resolvePaths({ ...base, isPackaged: false, arch: 'x64' });
    expect(p.nodeBin).toBe(join(base.appRoot, 'vendor', 'node', 'darwin-x64', 'bin', 'node'));
    expect(p.npmCli).toContain(join('darwin-x64', 'lib', 'node_modules', 'npm'));
  });

  it('ignores arch when packaged (resources are already per-arch)', () => {
    const a = resolvePaths({ ...base, arch: 'arm64' });
    const b = resolvePaths({ ...base, arch: 'x64' });
    expect(a).toEqual(b);
  });

  it('honours OPENTAC_DATA_DIR and resolves it to an absolute path', () => {
    const p = resolvePaths({ ...base, env: { OPENTAC_DATA_DIR: '/tmp/gev-data/../gev-data2' } });
    expect(p.dataDir).toBe('/tmp/gev-data2');
    expect(p.checkoutDir).toBe('/tmp/gev-data2/checkout');
    expect(p.stateFile).toBe('/tmp/gev-data2/state.json');
    expect(p.npmCacheDir).toBe('/tmp/gev-data2/npm-cache');
    expect(p.logsDir).toBe(base.logs);
  });

  it('resolves a relative OPENTAC_DATA_DIR against the cwd', () => {
    const p = resolvePaths({ ...base, env: { OPENTAC_DATA_DIR: 'rel-data' } });
    expect(p.dataDir).toBe(resolve('rel-data'));
  });

  it('treats an empty OPENTAC_DATA_DIR as unset', () => {
    const p = resolvePaths({ ...base, env: { OPENTAC_DATA_DIR: '' } });
    expect(p.dataDir).toBe(base.userData);
  });
});

describe('ensureDataDirs', () => {
  it('creates dataDir, npmCacheDir and logsDir recursively and is idempotent', () => {
    const root = mkdtempSync(join(tmpdir(), 'opentac-paths-'));
    tmpDirs.push(root);
    const p = resolvePaths({
      ...base,
      logs: join(root, 'logs', 'OpenTac'),
      env: { OPENTAC_DATA_DIR: join(root, 'deep', 'data') },
    });
    ensureDataDirs(p);
    ensureDataDirs(p);
    for (const d of [p.dataDir, p.npmCacheDir, p.logsDir]) {
      expect(statSync(d).isDirectory()).toBe(true);
    }
    expect(existsSync(p.checkoutDir)).toBe(false);
  });
});
