import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultState, loadState, saveState, updateState, validateState } from '../../src/main/state.js';
import { DEFAULT_REMOTE_URL } from '../../src/shared/types.js';

let dir: string;
let file: string;
let backup: string;

function makeLog() {
  return { warn: vi.fn<(m: string) => void>(), info: vi.fn<(m: string) => void>() };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opentac-state-'));
  file = join(dir, 'state.json');
  backup = join(dir, 'state.json.bak');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('defaultState', () => {
  it('has the documented defaults', () => {
    const s = defaultState();
    expect(s.schemaVersion).toBe(1);
    expect(s.channel).toBe('stable');
    expect(s.remoteUrl).toBe(DEFAULT_REMOTE_URL);
    expect(DEFAULT_REMOTE_URL).toBe('https://github.com/gonzoinceng-ctrl/opentac-engine.git');
    expect(s.updateCheckOnLaunch).toBe(true);
    expect(s.ai).toEqual({ provider: 'openai', model: null, ollamaHost: null });
    expect(s.usbDevices).toEqual([]);
    expect(s.mainWindowBounds).toBeNull();
    expect(defaultState().usbDevices).not.toBe(s.usbDevices);
  });
});

describe('loadState / saveState', () => {
  it('returns defaults for a missing file without writing a backup', async () => {
    const log = makeLog();
    expect(await loadState(file, backup, log)).toEqual(defaultState());
    expect(await readdir(dir)).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('round-trips a full state', async () => {
    const state = {
      ...defaultState(),
      channel: 'candidate' as const,
      installedCommit: 'abc123',
      lastPort: 4173,
      mainWindowBounds: { x: 10, y: 20, width: 800, height: 600 },
      usbDevices: [{ vendorId: 1, productId: 2, serialNumber: 'S1' }, { vendorId: 3, productId: 4 }],
      ai: { provider: 'ollama' as const, model: 'qwen3:8b', ollamaHost: 'http://127.0.0.1:11434' },
    };
    await saveState(file, state);
    expect(await loadState(file, backup, makeLog())).toEqual(state);
    const text = await readFile(file, 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "schemaVersion": 1');
  });

  it('creates the parent directory when missing', async () => {
    const nested = join(dir, 'a', 'b', 'state.json');
    await saveState(nested, defaultState());
    expect(await loadState(nested, backup, makeLog())).toEqual(defaultState());
  });

  it('backs up corrupt JSON byte-for-byte, warns and returns defaults', async () => {
    const bad = '{ "schemaVersion": 1, "channel": ';
    await writeFile(file, bad);
    const log = makeLog();
    expect(await loadState(file, backup, log)).toEqual(defaultState());
    expect(await readFile(backup, 'utf8')).toBe(bad);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('overwrites an existing backup', async () => {
    await writeFile(backup, 'old');
    await writeFile(file, 'not json');
    await loadState(file, backup, makeLog());
    expect(await readFile(backup, 'utf8')).toBe('not json');
  });

  it('rejects a wrong schemaVersion, backing up the file', async () => {
    const bad = JSON.stringify({ schemaVersion: 2, channel: 'candidate' });
    await writeFile(file, bad);
    const log = makeLog();
    expect(await loadState(file, backup, log)).toEqual(defaultState());
    expect(await readFile(backup, 'utf8')).toBe(bad);
    expect(log.warn.mock.calls[0]?.[0]).toContain('schemaVersion');
  });

  it('fills a partial file from defaults', async () => {
    await writeFile(file, JSON.stringify({ schemaVersion: 1, channel: 'upstream' }));
    const log = makeLog();
    expect(await loadState(file, backup, log)).toEqual({ ...defaultState(), channel: 'upstream' });
    expect(log.warn).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(['state.json']);
  });

  it('leaves no .tmp- files behind and sets mode 0600', async () => {
    await saveState(file, defaultState());
    await saveState(file, { ...defaultState(), lastPort: 1234 });
    const names = await readdir(dir);
    expect(names.filter((n) => n.includes('.tmp-'))).toEqual([]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe('validateState', () => {
  it('drops unknown extra keys', () => {
    const r = validateState({ ...defaultState(), bogus: 1, ai: { ...defaultState().ai, extra: true } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state).toEqual(defaultState());
      expect('bogus' in r.state).toBe(false);
      expect('extra' in r.state.ai).toBe(false);
    }
  });

  it('rejects non-objects and missing schemaVersion', () => {
    expect(validateState(null).ok).toBe(false);
    expect(validateState([]).ok).toBe(false);
    expect(validateState({ channel: 'stable' }).ok).toBe(false);
  });

  it.each([
    ['channel', { channel: 'main' }],
    ['remoteUrl', { remoteUrl: 5 }],
    ['remoteUrl empty', { remoteUrl: '' }],
    ['updateCheckOnLaunch', { updateCheckOnLaunch: 'yes' }],
    ['ai not object', { ai: 'openai' }],
    ['ai.provider', { ai: { provider: 'gemini' } }],
    ['ai.model', { ai: { provider: 'xai', model: 7 } }],
    ['lastPort', { lastPort: 70000 }],
    ['installedCommit', { installedCommit: 12 }],
    ['bounds', { mainWindowBounds: { width: 'a', height: 2 } }],
    ['usb', { usbDevices: [{ vendorId: 'x', productId: 1 }] }],
    ['usb not array', { usbDevices: {} }],
    ['null channel', { channel: null }],
    ['null remoteUrl', { remoteUrl: null }],
    ['null updateCheckOnLaunch', { updateCheckOnLaunch: null }],
    ['null ai.provider', { ai: { provider: null, model: null, ollamaHost: null } }],
  ])('rejects bad %s', (_name, patch) => {
    expect(validateState({ ...defaultState(), ...patch }).ok).toBe(false);
  });

  it('accepts bounds without x/y', () => {
    const r = validateState({ ...defaultState(), mainWindowBounds: { width: 1, height: 2 } });
    expect(r.ok && r.state.mainWindowBounds).toEqual({ width: 1, height: 2 });
  });
});

describe('updateState', () => {
  it('returns a new object without mutating the input', () => {
    const before = defaultState();
    const snapshot = structuredClone(before);
    const after = updateState(before, { channel: 'candidate', lastPort: 99 });
    expect(after).not.toBe(before);
    expect(after.channel).toBe('candidate');
    expect(after.lastPort).toBe(99);
    expect(before).toEqual(snapshot);
  });

  it('throws on an invalid patch', () => {
    expect(() => updateState(defaultState(), { channel: 'nope' as never })).toThrow(/channel/);
    expect(() => updateState(defaultState(), { schemaVersion: 2 as never })).toThrow(/schemaVersion/);
  });
});
