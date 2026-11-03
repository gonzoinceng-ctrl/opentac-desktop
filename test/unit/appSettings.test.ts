import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkIntervalMs,
  defaultAppSettings,
  isAppSettingsPatch,
  mergeAppSettings,
  proxyEnvFor,
  engineRemoteAllowed,
  validateEngineRemoteUrl,
  validateNoProxy,
  validateProxyUrl,
} from '../../src/shared/appSettings.js';
import { buildServerEnv } from '../../src/main/server.js';
import { readLogLevelSetting, updateState, validateState, defaultState } from '../../src/main/state.js';
import { resolveLogLevels } from '../../src/main/logger.js';
import { CHECK_INTERVAL_MS, isAutomaticCheckDue } from '../../src/main/controller.js';

describe('defaults', () => {
  it('match the design', () => {
    expect(defaultAppSettings()).toEqual({
      launchAtLogin: false,
      autoRestartOnCrash: true,
      updateCheckInterval: '6h',
      logLevel: 'default',
      proxy: { httpsProxy: null, noProxy: null },
      engineRemoteUrl: null,
    });
    expect(defaultAppSettings().proxy).not.toBe(defaultAppSettings().proxy);
  });

  it('checkIntervalMs maps the setting', () => {
    expect(checkIntervalMs('launch-only')).toBeNull();
    expect(checkIntervalMs('6h')).toBe(6 * 3600_000);
    expect(checkIntervalMs('daily')).toBe(24 * 3600_000);
  });
});

describe('validators', () => {
  it('proxy: http(s) only, no credentials, no whitespace, empty clears', () => {
    expect(validateProxyUrl('http://proxy.example.com:8080')).toEqual({ ok: true, value: 'http://proxy.example.com:8080' });
    expect(validateProxyUrl(' https://p.example:3128 ')).toEqual({ ok: true, value: 'https://p.example:3128' });
    expect(validateProxyUrl('')).toEqual({ ok: true, value: null });
    expect(validateProxyUrl(null)).toEqual({ ok: true, value: null });
    for (const bad of ['proxy.example.com:8080', 'socks5://p:1080', 'ftp://p', 'http://', 'http://u:p@proxy:1', 'http://a b', 'http://p\nx', 'x'.repeat(600)]) {
      expect(validateProxyUrl(bad).ok, bad).toBe(false);
    }
  });

  it('no-proxy: host list characters only, normalised', () => {
    expect(validateNoProxy('localhost, 127.0.0.1 ,.internal.example')).toEqual({ ok: true, value: 'localhost,127.0.0.1,.internal.example' });
    expect(validateNoProxy('')).toEqual({ ok: true, value: null });
    expect(validateNoProxy('a b!')).toMatchObject({ ok: false });
    expect(validateNoProxy('a;rm -rf')).toMatchObject({ ok: false });
  });

  it('engine mirror: https:// or file:// only, no credentials', () => {
    expect(validateEngineRemoteUrl('https://example.org/mirror.git')).toEqual({ ok: true, value: 'https://example.org/mirror.git' });
    expect(validateEngineRemoteUrl('file:///Users/me/mirror.git')).toEqual({ ok: true, value: 'file:///Users/me/mirror.git' });
    expect(validateEngineRemoteUrl('')).toEqual({ ok: true, value: null });
    for (const bad of ['http://example.org/x.git', 'git@github.com:o/r.git', 'ssh://git@example.org/r.git', 'https://u:p@example.org/r.git', 'https://', '/local/path', 'https://a b/c']) {
      expect(validateEngineRemoteUrl(bad).ok, bad).toBe(false);
    }
  });
});

describe('mergeAppSettings and isAppSettingsPatch', () => {
  it('merges field by field and validates', () => {
    const a = defaultAppSettings();
    const b = mergeAppSettings(a, { launchAtLogin: true, updateCheckInterval: 'daily', proxy: { httpsProxy: 'http://p:1' } });
    expect(b.launchAtLogin).toBe(true);
    expect(b.updateCheckInterval).toBe('daily');
    expect(b.proxy).toEqual({ httpsProxy: 'http://p:1', noProxy: null });
    expect(a).toEqual(defaultAppSettings()); // input untouched
    expect(mergeAppSettings(b, { proxy: { noProxy: 'localhost' } }).proxy).toEqual({ httpsProxy: 'http://p:1', noProxy: 'localhost' });
    expect(mergeAppSettings(b, { proxy: { httpsProxy: null } }).proxy.httpsProxy).toBeNull();
    expect(() => mergeAppSettings(a, { proxy: { httpsProxy: 'http://u:p@x:1' } })).toThrow(/user name/);
    expect(() => mergeAppSettings(a, { engineRemoteUrl: 'http://x' })).toThrow(/https:\/\/ or file:\/\//);
  });

  it('the guard accepts valid patches and rejects everything else', () => {
    expect(isAppSettingsPatch({})).toBe(true);
    expect(isAppSettingsPatch({ launchAtLogin: true, autoRestartOnCrash: false, updateCheckInterval: 'launch-only', logLevel: 'debug' })).toBe(true);
    expect(isAppSettingsPatch({ proxy: { httpsProxy: 'http://p:1', noProxy: null }, engineRemoteUrl: null })).toBe(true);
    expect(isAppSettingsPatch({ engineRemoteUrl: 'file:///x.git' })).toBe(true);
    for (const bad of [
      null, 'x', [], { launchAtLogin: 'yes' }, { updateCheckInterval: 'hourly' }, { logLevel: 'trace' },
      { unknown: 1 }, { proxy: 'http://p' }, { proxy: { extra: 1 } }, { proxy: { httpsProxy: 5 } },
      { proxy: { httpsProxy: 'socks5://p:1' } }, { engineRemoteUrl: 'http://x/y.git' }, { engineRemoteUrl: 5 },
    ]) {
      expect(isAppSettingsPatch(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('proxyEnvFor and the engine environment', () => {
  it('produces only the documented variables', () => {
    expect(proxyEnvFor({ httpsProxy: null, noProxy: null })).toEqual({});
    expect(proxyEnvFor({ httpsProxy: 'http://p:1', noProxy: null })).toEqual({
      HTTPS_PROXY: 'http://p:1',
      HTTP_PROXY: 'http://p:1',
      NO_PROXY: '127.0.0.1,localhost,::1,[::1]',
    });
    expect(proxyEnvFor({ httpsProxy: 'http://p:1', noProxy: 'a,b' }, { nodeEnvProxy: true })).toEqual({
      HTTPS_PROXY: 'http://p:1',
      HTTP_PROXY: 'http://p:1',
      NO_PROXY: 'a,b,127.0.0.1,localhost,::1,[::1]',
      NODE_USE_ENV_PROXY: '1',
    });
    expect(proxyEnvFor({ httpsProxy: null, noProxy: 'a' }, { nodeEnvProxy: true })).toEqual({ NO_PROXY: 'a' });
  });

  it('NO_PROXY always contains the loopback names when a proxy is set, without duplicates', () => {
    for (const noProxy of [null, '', 'LOCALHOST,.corp', '127.0.0.1']) {
      for (const nodeEnvProxy of [true, false]) {
        const list = (proxyEnvFor({ httpsProxy: 'http://p:1', noProxy }, { nodeEnvProxy })['NO_PROXY'] ?? '').split(',');
        for (const name of ['127.0.0.1', 'localhost', '::1']) expect(list.map((x) => x.toLowerCase())).toContain(name);
        expect(new Set(list.map((x) => x.toLowerCase())).size).toBe(list.length);
      }
    }
    expect(proxyEnvFor({ httpsProxy: 'http://p:1', noProxy: '.corp' })['NO_PROXY']).toMatch(/^\.corp,/);
  });

  it('engineRemoteAllowed refuses file:// mirrors in packaged builds only', () => {
    expect(engineRemoteAllowed('file:///x.git', true)).toBe(false);
    expect(engineRemoteAllowed('file:///x.git', false)).toBe(true);
    expect(engineRemoteAllowed('https://m.example/x.git', true)).toBe(true);
    expect(engineRemoteAllowed(null, true)).toBe(true);
  });

  const base = { port: 4200, nodeBinDir: '/res/node/bin', home: '/Users/me', tmpdir: '/tmp/x', shellVersion: '1.2.3' };

  it('buildServerEnv adds the proxy fields and nothing else; without a proxy none appear', () => {
    const plain = buildServerEnv(base);
    expect(Object.keys(plain).some((k) => /PROXY/.test(k))).toBe(false);
    const env = buildServerEnv({ ...base, proxy: { httpsProxy: 'http://p:1', noProxy: 'localhost' } });
    expect(env['HTTPS_PROXY']).toBe('http://p:1');
    expect(env['HTTP_PROXY']).toBe('http://p:1');
    expect(env['NO_PROXY']).toBe('localhost,127.0.0.1,::1,[::1]');
    expect(env['NODE_USE_ENV_PROXY']).toBe('1');
    const { HTTPS_PROXY: _a, HTTP_PROXY: _b, NO_PROXY: _c, NODE_USE_ENV_PROXY: _d, ...rest } = env;
    expect(rest).toEqual(plain);
  });

  it('a caller cannot smuggle proxy variables in through extra', () => {
    const env = buildServerEnv({ ...base, extra: { HTTPS_PROXY: 'http://evil:1', NO_PROXY: 'x', NODE_USE_ENV_PROXY: '1' } });
    expect(Object.keys(env).some((k) => /PROXY/.test(k))).toBe(false);
  });
});

describe('state.json app object', () => {
  it('fills missing fields from defaults and keeps schemaVersion 1', () => {
    const r = validateState({ schemaVersion: 1 });
    expect(r.ok && r.state.app).toEqual(defaultAppSettings());
    const partial = validateState({ schemaVersion: 1, app: { launchAtLogin: true } });
    expect(partial.ok && partial.state.app).toEqual({ ...defaultAppSettings(), launchAtLogin: true });
    expect(partial.ok && partial.state.schemaVersion).toBe(1);
  });

  it('drops unknown app keys and rejects wrong types or bad addresses', () => {
    const r = validateState({ schemaVersion: 1, app: { launchAtLogin: true, mystery: 1 } });
    expect(r.ok && Object.keys(r.state.app).sort()).toEqual(Object.keys(defaultAppSettings()).sort());
    for (const app of [
      'x', { launchAtLogin: 'yes' }, { autoRestartOnCrash: 1 }, { updateCheckInterval: 'weekly' }, { logLevel: 'trace' },
      { proxy: 'x' }, { proxy: { httpsProxy: 'socks5://p' } }, { proxy: { noProxy: 5 } }, { engineRemoteUrl: 'http://x' }, { engineRemoteUrl: 3 },
    ]) {
      expect(validateState({ schemaVersion: 1, app }).ok, JSON.stringify(app)).toBe(false);
    }
  });

  it('updateState applies and validates an app patch', () => {
    const s = updateState(defaultState(), { app: { ...defaultAppSettings(), logLevel: 'debug' } });
    expect(s.app.logLevel).toBe('debug');
    expect(() => updateState(defaultState(), { app: { ...defaultAppSettings(), logLevel: 'loud' as never } })).toThrow(/invalid state update/);
  });
});

describe('log level setting', () => {
  it('resolveLogLevels: env var wins, then the setting, then defaults', () => {
    expect(resolveLogLevels({}, true, 'debug')).toEqual({ fileLevel: 'debug', consoleLevel: 'debug' });
    expect(resolveLogLevels({}, false, 'error')).toEqual({ fileLevel: 'error', consoleLevel: 'error' });
    expect(resolveLogLevels({ OPENTAC_LOG_LEVEL: 'warn' }, true, 'debug')).toEqual({ fileLevel: 'warn', consoleLevel: 'warn' });
    expect(resolveLogLevels({ OPENTAC_LOG_LEVEL: 'bogus' }, true, 'info')).toEqual({ fileLevel: 'info', consoleLevel: 'info' });
    expect(resolveLogLevels({}, true, 'default')).toEqual({ fileLevel: 'info', consoleLevel: 'warn' });
    expect(resolveLogLevels({}, false)).toEqual({ fileLevel: 'info', consoleLevel: 'debug' });
  });

  describe('readLogLevelSetting', () => {
    let dir = '';
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'opentac-loglevel-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    it('reads app.logLevel and falls back to default for anything odd', async () => {
      const f = join(dir, 'state.json');
      expect(await readLogLevelSetting(f)).toBe('default');
      await writeFile(f, JSON.stringify({ schemaVersion: 1, app: { logLevel: 'debug' } }));
      expect(await readLogLevelSetting(f)).toBe('debug');
      await writeFile(f, JSON.stringify({ schemaVersion: 1, app: { logLevel: 'nope' } }));
      expect(await readLogLevelSetting(f)).toBe('default');
      await writeFile(f, 'not json');
      expect(await readLogLevelSetting(f)).toBe('default');
    });
  });
});

describe('isAutomaticCheckDue with an interval', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  it('defaults to six hours and accepts a longer interval', () => {
    const fiveHours = new Date(now - 5 * 3600_000).toISOString();
    const twentyHours = new Date(now - 20 * 3600_000).toISOString();
    expect(isAutomaticCheckDue(twentyHours, now)).toBe(true);
    expect(isAutomaticCheckDue(fiveHours, now)).toBe(false);
    expect(isAutomaticCheckDue(twentyHours, now, 24 * 3600_000)).toBe(false);
    expect(isAutomaticCheckDue(twentyHours, now, CHECK_INTERVAL_MS)).toBe(true);
    expect(isAutomaticCheckDue(null, now, 24 * 3600_000)).toBe(true);
  });
});
