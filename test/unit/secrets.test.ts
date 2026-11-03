import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSecrets } from '../../src/main/secrets.js';
import type { SafeStorageLike } from '../../src/main/secrets.js';
import { createLogger } from '../../src/main/logger.js';

let dir: string;
let file: string;
let lines: string[];

function logger() {
  lines = [];
  const push = (l: string): void => void lines.push(l);
  return createLogger({ info: push, warn: push, error: push, debug: push });
}

/** XOR "encryption" with a key byte, so ciphertext differs from plaintext. */
function fakeStorage(opts: { available?: boolean; keyByte?: number; reEncryptBelow?: number } = {}) {
  const state = { keyByte: opts.keyByte ?? 0x5a, available: opts.available ?? true, reEncryptBelow: opts.reEncryptBelow ?? 0, encrypts: 0 };
  const storage: SafeStorageLike = {
    isEncryptionAvailable: () => state.available,
    async encryptStringAsync(s) {
      state.encrypts++;
      const out = Buffer.from(s, 'utf8');
      for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) ^ state.keyByte;
      return Buffer.concat([Buffer.from([state.keyByte]), out]);
    },
    async decryptStringAsync(b) {
      const kb = b[0] ?? 0;
      const body = Buffer.from(b.subarray(1));
      for (let i = 0; i < body.length; i++) body[i] = (body[i] ?? 0) ^ kb;
      return { result: body.toString('utf8'), shouldReEncrypt: kb < state.reEncryptBelow };
    },
  };
  return { storage, state };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opentac-secrets-'));
  file = join(dir, 'sub', 'secrets.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createSecrets', () => {
  it('round-trips values and reports presence', async () => {
    const { storage } = fakeStorage();
    const s = createSecrets({ file, safeStorage: storage, log: logger() });
    expect(await s.available()).toBe(true);
    expect(await s.has('xai')).toBe(false);
    expect(await s.get('xai')).toBeNull();
    await s.set('xai', 'xai-secret-value');
    await s.set('openrouter', 'sk-or-v1-abcdef');
    expect(await s.get('xai')).toBe('xai-secret-value');
    expect(await s.get('openrouter')).toBe('sk-or-v1-abcdef');
    expect(await s.has('xai')).toBe(true);
  });

  it('persists across instances in the documented format, encrypted, with mode 0600', async () => {
    const { storage } = fakeStorage();
    await createSecrets({ file, safeStorage: storage, log: logger() }).set('xai', 'plain-text-key');
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as { version: number; entries: Record<string, string> };
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.entries)).toEqual(['xai']);
    expect(raw).not.toContain('plain-text-key');
    expect(Buffer.from(parsed.entries['xai'] ?? '', 'base64').toString('utf8')).not.toContain('plain-text-key');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const again = createSecrets({ file, safeStorage: storage, log: logger() });
    expect(await again.get('xai')).toBe('plain-text-key');
  });

  it('removes a value with set(name, null) and leaves the other', async () => {
    const { storage } = fakeStorage();
    const s = createSecrets({ file, safeStorage: storage, log: logger() });
    await s.set('xai', 'a');
    await s.set('openrouter', 'b');
    await s.set('xai', null);
    expect(await s.has('xai')).toBe(false);
    expect(await s.get('xai')).toBeNull();
    expect(await s.get('openrouter')).toBe('b');
    await s.set('xai', null); // removing a missing value is fine
  });

  it('re-encrypts when decrypt says shouldReEncrypt and keeps the value', async () => {
    const old = fakeStorage({ keyByte: 0x11 });
    await createSecrets({ file, safeStorage: old.storage, log: logger() }).set('xai', 'rotate-me');
    const next = fakeStorage({ keyByte: 0x77, reEncryptBelow: 0x40 });
    const s = createSecrets({ file, safeStorage: next.storage, log: logger() });
    expect(await s.get('xai')).toBe('rotate-me');
    expect(next.state.encrypts).toBe(1);
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { entries: Record<string, string> };
    expect(Buffer.from(parsed.entries['xai'] ?? '', 'base64')[0]).toBe(0x77);
    // Second read: no longer needs re-encryption.
    expect(await s.get('xai')).toBe('rotate-me');
    expect(next.state.encrypts).toBe(1);
  });

  it('treats a corrupt file as empty with a warning and recovers on the next set', async () => {
    const { storage } = fakeStorage();
    await createSecrets({ file, safeStorage: storage, log: logger() }).set('xai', 'x');
    await writeFile(file, '{not json');
    const log = logger();
    const s = createSecrets({ file, safeStorage: storage, log });
    expect(await s.get('xai')).toBeNull();
    expect(await s.has('xai')).toBe(false);
    expect(lines.join('\n')).toMatch(/corrupt/);
    await s.set('openrouter', 'fresh');
    expect(await s.get('openrouter')).toBe('fresh');
    await writeFile(file, JSON.stringify({ version: 2, entries: {} }));
    expect(await s.get('openrouter')).toBeNull();
  });

  it('ignores unknown entries and non-string values in the file', async () => {
    const { storage } = fakeStorage();
    const s = createSecrets({ file, safeStorage: storage, log: logger() });
    await s.set('xai', 'k');
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { version: number; entries: Record<string, unknown> };
    parsed.entries['__proto__x'] = 'a';
    parsed.entries['openrouter'] = 42;
    await writeFile(file, JSON.stringify(parsed));
    expect(await s.has('openrouter')).toBe(false);
    expect(await s.get('xai')).toBe('k');
  });

  it('returns null and warns when one entry cannot be decrypted', async () => {
    const { storage } = fakeStorage();
    const s = createSecrets({ file, safeStorage: storage, log: logger() });
    await s.set('xai', 'k');
    const broken: SafeStorageLike = {
      ...storage,
      decryptStringAsync: () => Promise.reject(new Error('keychain locked')),
    };
    const s2 = createSecrets({ file, safeStorage: broken, log: logger() });
    expect(await s2.get('xai')).toBeNull();
    expect(lines.join('\n')).toMatch(/could not decrypt/);
  });

  it('refuses to store when encryption is unavailable, but still allows removal', async () => {
    const { storage, state } = fakeStorage();
    const s = createSecrets({ file, safeStorage: storage, log: logger() });
    await s.set('xai', 'k');
    state.available = false;
    expect(await s.available()).toBe(false);
    await expect(s.set('openrouter', 'v')).rejects.toThrow(/not available/);
    await s.set('xai', null);
    expect(await s.has('xai')).toBe(false);
  });

  it('never logs values', async () => {
    const { storage } = fakeStorage();
    const s = createSecrets({ file, safeStorage: storage, log: logger() });
    await s.set('xai', 'super-secret-value-123');
    await s.get('xai');
    await s.set('xai', null);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('super-secret-value-123');
  });

  it('rejects unknown names', async () => {
    const { storage } = fakeStorage();
    const s = createSecrets({ file, safeStorage: storage, log: logger() });
    await expect(s.get('constructor' as 'xai')).rejects.toThrow();
    await expect(s.set('__proto__' as 'xai', 'v')).rejects.toThrow();
  });

  it('serialises concurrent sets without losing entries', async () => {
    const { storage } = fakeStorage();
    const s = createSecrets({ file, safeStorage: storage, log: logger() });
    await Promise.all([s.set('xai', 'one'), s.set('openrouter', 'two')]);
    expect(await s.get('xai')).toBe('one');
    expect(await s.get('openrouter')).toBe('two');
  });
});
