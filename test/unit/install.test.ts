import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildNpmEnv,
  classifyNpmFailure,
  createInstallManager,
  InstallError,
} from '../../src/main/install.js';
import {
  arrayLogger,
  makeInstallFixture,
  type InstallFixture,
} from '../helpers/install-fixtures.js';

describe('classifyNpmFailure', () => {
  const cases: Array<[string, 'network' | 'disk' | 'other']> = [
    ['npm ERR! code ECONNRESET', 'network'],
    ['npm error code ETIMEDOUT', 'network'],
    ['npm ERR! code ENOTFOUND\nnpm ERR! errno ENOTFOUND', 'network'],
    ['npm error code EAI_AGAIN', 'network'],
    ['npm ERR! network This is a problem related to network connectivity.', 'network'],
    ['npm error network This is a problem related to network connectivity.', 'network'],
    ['request to https://registry.npmjs.org/foo failed, reason: socket hang up', 'network'],
    ['npm ERR! code ENOSPC\nnpm ERR! nospc ENOSPC: no space left on device', 'disk'],
    ['ENOSPC and also ECONNRESET', 'disk'],
    ['npm ERR! code E404', 'other'],
    ['npm error code EACCES', 'other'],
    ['npm warn install-scripts something', 'other'],
    ['', 'other'],
  ];
  it.each(cases)('classifies %j as %s', (output, expected) => {
    expect(classifyNpmFailure(output)).toBe(expected);
  });
});

describe('buildNpmEnv', () => {
  const env = buildNpmEnv({
    nodeBinDir: '/res/node/bin',
    home: '/Users/x',
    tmpdir: '/var/tmp/x',
    npmCacheDir: '/data/npm-cache',
  });

  it('sets the documented variables', () => {
    expect(env).toEqual({
      PATH: '/res/node/bin:/usr/bin:/bin',
      HOME: '/Users/x',
      TMPDIR: '/var/tmp/x',
      LANG: 'en_US.UTF-8',
      PUPPETEER_SKIP_DOWNLOAD: '1',
      CI: '1',
      npm_config_cache: '/data/npm-cache',
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      NO_COLOR: '1',
    });
  });

  it('does not copy anything from the parent environment', () => {
    process.env['npm_config_registry'] = 'http://evil.invalid';
    try {
      const e = buildNpmEnv({ nodeBinDir: '/n', home: '/h', tmpdir: '/t', npmCacheDir: '/c' });
      expect(
        Object.keys(e)
          .filter((k) => k.startsWith('npm_config_'))
          .sort(),
      ).toEqual([
        'npm_config_audit',
        'npm_config_cache',
        'npm_config_fund',
        'npm_config_update_notifier',
      ]);
    } finally {
      delete process.env['npm_config_registry'];
    }
  });
});

describe('InstallError', () => {
  it('carries a code and optional detail', () => {
    const e = new InstallError('NETWORK', 'No network.', 'ECONNRESET');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('NETWORK');
    expect(e.detail).toBe('ECONNRESET');
    expect(new InstallError('ABORTED', 'x').detail).toBeUndefined();
  });
});

describe('proxyEnv', () => {
  let fx: InstallFixture | null = null;
  afterEach(async () => {
    await fx?.cleanup();
    fx = null;
  });

  it('reaches the npm child as HTTPS_PROXY, HTTP_PROXY and NO_PROXY only', async () => {
    fx = await makeInstallFixture();
    await mkdir(join(fx.checkoutDir, 'scripts'), { recursive: true });
    const out = join(fx.root, 'env.json');
    await writeFile(
      join(fx.checkoutDir, 'scripts', 'setup-doctor.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify({ a: process.env.HTTPS_PROXY ?? null, b: process.env.HTTP_PROXY ?? null, c: process.env.NO_PROXY ?? null, d: process.env.NODE_USE_ENV_PROXY ?? null, e: process.env.GIT_SSH_COMMAND ?? null }));\n`,
    );
    const mgr = createInstallManager({
      paths: {
        checkoutDir: fx.checkoutDir,
        nodeBin: process.execPath,
        npmCli: '/nope',
        npmCacheDir: fx.npmCacheDir,
        nodeModulesDir: fx.nodeModulesDir,
      },
      log: arrayLogger().log,
      env: { HOME: fx.home },
      proxyEnv: () => ({ HTTPS_PROXY: 'http://p:1', HTTP_PROXY: 'http://p:1', NO_PROXY: 'localhost', GIT_SSH_COMMAND: 'evil' }),
    });
    const res = await mgr.runDoctor();
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual({
      a: 'http://p:1',
      b: 'http://p:1',
      c: 'localhost',
      d: null,
      e: null,
    });
  });
});

describe('createInstallManager (no processes)', () => {
  let fx: InstallFixture | null = null;
  afterEach(async () => {
    await fx?.cleanup();
    fx = null;
  });

  it('lockHash is null when package-lock.json is missing', async () => {
    fx = await makeInstallFixture();
    const mgr = createInstallManager({
      paths: {
        checkoutDir: join(fx.root, 'empty'),
        nodeBin: process.execPath,
        npmCli: '/nope',
        npmCacheDir: fx.npmCacheDir,
        nodeModulesDir: join(fx.root, 'empty', 'node_modules'),
      },
      log: arrayLogger().log,
    });
    expect(await mgr.lockHash()).toBeNull();
  });

  it('install throws NO_LOCKFILE before spawning anything', async () => {
    fx = await makeInstallFixture();
    const dir = join(fx.root, 'nolock');
    await mkdir(dir, { recursive: true });
    const npmCli = join(fx.root, 'npm-cli.js');
    await writeFile(npmCli, '');
    const mgr = createInstallManager({
      paths: {
        checkoutDir: dir,
        nodeBin: process.execPath,
        npmCli,
        npmCacheDir: fx.npmCacheDir,
        nodeModulesDir: join(dir, 'node_modules'),
      },
      log: arrayLogger().log,
    });
    await expect(mgr.install(() => {})).rejects.toMatchObject({ code: 'NO_LOCKFILE' });
  });

  it('install throws NPM_FAILED with a clear detail when node or npm is missing', async () => {
    fx = await makeInstallFixture();
    const base = {
      checkoutDir: fx.checkoutDir,
      npmCacheDir: fx.npmCacheDir,
      nodeModulesDir: fx.nodeModulesDir,
    };
    const missingNode = createInstallManager({
      paths: { ...base, nodeBin: join(fx.root, 'no-node'), npmCli: '/x' },
      log: arrayLogger().log,
    });
    const e1 = await missingNode.install(() => {}).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(InstallError);
    expect((e1 as InstallError).code).toBe('NPM_FAILED');
    expect((e1 as InstallError).detail).toContain('no-node');

    const missingNpm = createInstallManager({
      paths: { ...base, nodeBin: process.execPath, npmCli: join(fx.root, 'no-npm.js') },
      log: arrayLogger().log,
    });
    const e2 = await missingNpm.install(() => {}).catch((e: unknown) => e);
    expect((e2 as InstallError).code).toBe('NPM_FAILED');
    expect((e2 as InstallError).detail).toContain('no-npm.js');
  });

  it('install rejects ABORTED immediately for an already-aborted signal', async () => {
    fx = await makeInstallFixture();
    const mgr = createInstallManager({
      paths: {
        checkoutDir: fx.checkoutDir,
        nodeBin: process.execPath,
        npmCli: '/x',
        npmCacheDir: fx.npmCacheDir,
        nodeModulesDir: fx.nodeModulesDir,
      },
      log: arrayLogger().log,
    });
    await expect(mgr.install(() => {}, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'ABORTED',
    });
  });
});
