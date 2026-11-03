import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { SecretsApi } from './contracts.js';
import type { Logger } from './logger.js';

/** The slice of Electron's safeStorage this module needs (async API only). */
export interface SafeStorageLike {
  isEncryptionAvailable(): Promise<boolean> | boolean;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

/** Construction options for {@link createSecrets}. */
export interface CreateSecretsOptions {
  /** Absolute path of secrets.json. */
  file: string;
  safeStorage: SafeStorageLike;
  log: Logger;
}

type SecretName = 'openrouter' | 'xai';

interface SecretsFile {
  version: 1;
  entries: Record<string, string>;
}

const SECRET_NAMES: readonly string[] = ['openrouter', 'xai'];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/**
 * Parses secrets.json; returns null when the content is not a version-1 file.
 * Only string-valued entries with known names survive.
 */
function parseFile(text: string): SecretsFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj['version'] !== 1) return null;
  const entries = obj['entries'];
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) return null;
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(entries as Record<string, unknown>)) {
    if (SECRET_NAMES.includes(name) && typeof value === 'string') out[name] = value;
  }
  return { version: 1, entries: out };
}

/**
 * Secret storage backed by safeStorage: values are encrypted individually and kept as base64 in a
 * 0600 file written atomically (tmp + fsync + rename). Values are never logged. A corrupt file is
 * treated as empty (with a warning) and replaced on the next write. Writes are serialised.
 */
export function createSecrets(opts: CreateSecretsOptions): SecretsApi {
  const { file, safeStorage } = opts;
  const log = opts.log.scope('secrets');
  let writeChain: Promise<unknown> = Promise.resolve();

  async function isAvailable(): Promise<boolean> {
    try {
      return (await safeStorage.isEncryptionAvailable()) === true;
    } catch (err) {
      log.warn(`encryption availability check failed: ${errorMessage(err)}`);
      return false;
    }
  }

  async function readFileOrEmpty(): Promise<SecretsFile> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if (!isNotFound(err)) log.warn(`secrets file unreadable (${errorMessage(err)}); treating as empty`);
      return { version: 1, entries: Object.create(null) as Record<string, string> };
    }
    const parsed = parseFile(text);
    if (parsed === null) {
      log.warn('secrets file is corrupt; treating it as empty');
      return { version: 1, entries: Object.create(null) as Record<string, string> };
    }
    return parsed;
  }

  async function writeAtomic(data: SecretsFile): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      const handle = await open(tmp, 'w', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  /** Runs `fn` after every earlier write finished, whatever their outcome. */
  function serialised<T>(fn: () => Promise<T>): Promise<T> {
    const run = writeChain.then(fn, fn);
    writeChain = run.catch(() => undefined);
    return run;
  }

  function assertName(name: string): asserts name is SecretName {
    if (!SECRET_NAMES.includes(name)) throw new Error('unknown secret name');
  }

  async function getValue(name: SecretName): Promise<string | null> {
    const data = await readFileOrEmpty();
    const encoded = data.entries[name];
    if (encoded === undefined) return null;
    let decrypted: { result: string; shouldReEncrypt: boolean };
    try {
      decrypted = await safeStorage.decryptStringAsync(Buffer.from(encoded, 'base64'));
    } catch (err) {
      log.warn(`could not decrypt the ${name} secret (${errorMessage(err)})`);
      return null;
    }
    if (decrypted.shouldReEncrypt) {
      await serialised(async () => {
        try {
          // Re-read inside the lock so a concurrent set() is not overwritten.
          const current = await readFileOrEmpty();
          if (current.entries[name] !== encoded) return;
          const fresh = await safeStorage.encryptStringAsync(decrypted.result);
          current.entries[name] = fresh.toString('base64');
          await writeAtomic(current);
          log.info(`re-encrypted the ${name} secret`);
        } catch (err) {
          log.warn(`could not re-encrypt the ${name} secret (${errorMessage(err)})`);
        }
      });
    }
    return decrypted.result;
  }

  return {
    available: isAvailable,

    async get(name) {
      assertName(name);
      return getValue(name);
    },

    async has(name) {
      assertName(name);
      const data = await readFileOrEmpty();
      return data.entries[name] !== undefined;
    },

    async set(name, value) {
      assertName(name);
      if (value !== null && !(await isAvailable())) {
        throw new Error('Secure storage is not available, so the key was not saved.');
      }
      const encrypted = value === null ? null : await safeStorage.encryptStringAsync(value);
      await serialised(async () => {
        const data = await readFileOrEmpty();
        if (encrypted === null) {
          if (data.entries[name] === undefined) return;
          delete data.entries[name];
        } else {
          data.entries[name] = encrypted.toString('base64');
        }
        await writeAtomic(data);
      });
      log.info(value === null ? `removed the ${name} secret` : `stored the ${name} secret`);
    },
  };
}
