/**
 * Client for the engine's own key setup endpoints (upstream `server/standalone/key-setup.js`):
 *   GET  <engine>/api/setup/status  -> which keys exist and whether each is set (never a value)
 *   POST <engine>/api/setup/keys    -> {ENV_VAR: value | null}; null removes
 * The engine writes its own `.env`, restarts itself about 250 ms after a successful save and the
 * page reloads. The child process does not exit, so the controller treats the short window of
 * refused connections as normal and never as a crash.
 *
 * Values are only ever placed in the request body. They are not logged, not kept, and never
 * appear in a returned object or error message; callers get booleans, ids and plain sentences.
 * No electron import: the controller injects the engine URL and the fetch implementation.
 */
import {
  ENGINE_KEY_CATALOG,
  ENGINE_KEY_ENV_VARS,
  type EngineKeyCatalogEntry,
  type EngineKeyTier,
} from '../shared/engineKeyCatalog.js';
import type {
  EngineKeyInfo,
  EngineKeyManaged,
  EngineKeyRow,
  EngineKeySaveResult,
  EngineKeyStatus,
  EngineKeysPublic,
} from '../shared/ipc.js';
import type { Logger } from './logger.js';

export { ENGINE_KEY_CATALOG, ENGINE_KEY_ENV_VARS };

/** Timeout of every request to the engine. */
export const ENGINE_KEYS_TIMEOUT_MS = 8000;

/** Thrown by {@link EngineKeysClient.status}; `message` is a plain sentence. */
export class EngineKeysError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EngineKeysError';
    this.code = code;
  }
}

export interface EngineKeysClientOptions {
  /** The running engine's URL (any path), or null while it is not running. */
  engineUrl: () => string | null;
  fetchImpl?: typeof fetch | undefined;
  log: Logger;
}

export interface EngineKeysClient {
  /** Reads the registry status. Throws {@link EngineKeysError} when the engine cannot answer. */
  status(): Promise<EngineKeyStatus>;
  /** Saves `{ENV_VAR: value}`; a null value removes the key. Never throws; see the result. */
  save(updates: Record<string, string | null>): Promise<EngineKeySaveResult>;
}

/** Sentences for the refusal codes of upstream's `admitKeySetupRequest` / `validateKeySetupUpdates`. */
const REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  proxied: "The engine refused the request because it looked like it came through a proxy.",
  sharing: 'The engine turned key entry off because sharing is enabled.',
  'not-loopback': 'The engine only accepts key changes from this Mac.',
  'not-local-host': 'The engine only accepts key changes on a local address.',
  'origin-required': 'The engine refused the request because it had no local origin.',
  'origin-unrecognized': 'The engine did not recognise where the request came from.',
  'cross-origin': 'The engine refused a request from a different origin.',
  'content-type': 'The engine refused the request format.',
  'invalid-json': 'The engine could not read the request.',
  'not-object': 'The engine could not read the request.',
  'no-keys': 'There was no key to save.',
  'too-many': 'Too many keys were sent at once.',
  'unknown-key': 'The engine does not know that key.',
  'not-string': 'The engine could not read that key.',
  empty: 'The key was empty.',
  'too-long': 'That is longer than any real key.',
  'not-printable': 'A key cannot contain spaces or line breaks.',
  'invalid-char': 'A key cannot contain # quotes $ backslash or backtick.',
  'too-large': 'The request was too large.',
  'harden-failed': 'The engine could not restrict its .env file to your account, so nothing was saved.',
  'store-unreadable': 'The engine could not read its existing .env file, so nothing was changed.',
  'write-failed': 'The engine could not write its .env file.',
  method: 'The engine did not accept that request.',
};

const TIERS: readonly string[] = ['free', 'metered', 'paid'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseRow(raw: unknown): EngineKeyInfo | null {
  if (!isRecord(raw)) return null;
  const { id, title, unlocks, getUrl, envVars, tier, clientExposed, set, managed } = raw;
  if (typeof id !== 'string' || id === '' || typeof title !== 'string') return null;
  if (!Array.isArray(envVars) || envVars.length === 0 || !envVars.every((e) => typeof e === 'string')) return null;
  const mgd: EngineKeyManaged = managed === 'file' || managed === 'external' ? managed : null;
  return {
    id,
    title,
    unlocks: typeof unlocks === 'string' ? unlocks : '',
    getUrl: typeof getUrl === 'string' ? getUrl : '',
    envVars: envVars as string[],
    tier: (typeof tier === 'string' && TIERS.includes(tier) ? tier : 'free') as EngineKeyTier,
    clientExposed: clientExposed === true,
    set: set === true,
    managed: mgd,
  };
}

/** Parses the status body of `GET /api/setup/status`. Throws {@link EngineKeysError} on junk. */
export function parseEngineKeyStatus(body: unknown): EngineKeyStatus {
  if (!isRecord(body) || !Array.isArray(body['keys'])) {
    throw new EngineKeysError('bad-response', 'The engine sent a key list that OpenTac could not read.');
  }
  const keys: EngineKeyInfo[] = [];
  for (const raw of body['keys']) {
    const row = parseRow(raw);
    if (row !== null) keys.push(row);
  }
  const setCount = typeof body['setCount'] === 'number' ? body['setCount'] : keys.filter((k) => k.set).length;
  const total = typeof body['total'] === 'number' ? body['total'] : keys.length;
  const store = typeof body['store'] === 'string' ? body['store'] : 'env-file';
  return { keys, setCount, total, store };
}

function originOf(url: string): string {
  return new URL(url).origin;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Creates the client. The engine URL is read on every call, so it follows restarts and port moves. */
export function createEngineKeysClient(opts: EngineKeysClientOptions): EngineKeysClient {
  const log = opts.log.scope('engine-keys');
  const doFetch: typeof fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));

  function target(path: string): { url: string; origin: string } | null {
    const base = opts.engineUrl();
    if (base === null) return null;
    try {
      const origin = originOf(base);
      return { url: `${origin}${path}`, origin };
    } catch {
      return null;
    }
  }

  return {
    async status() {
      const t = target('/api/setup/status');
      if (t === null) throw new EngineKeysError('not-running', 'The engine is not running.');
      let res: Response;
      try {
        res = await doFetch(t.url, {
          method: 'GET',
          headers: { Origin: t.origin, Accept: 'application/json' },
          signal: AbortSignal.timeout(ENGINE_KEYS_TIMEOUT_MS),
        });
      } catch (err) {
        log.debug(`key status request failed: ${errText(err)}`);
        throw new EngineKeysError('unreachable', "The engine didn't answer the key list request.");
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        log.debug(`key status answered HTTP ${res.status}`);
        throw new EngineKeysError(
          'refused',
          res.status === 404
            ? 'This engine version has no key setup endpoint.'
            : `The engine refused the key list request (HTTP ${res.status}).`,
        );
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new EngineKeysError('bad-response', 'The engine sent a key list that OpenTac could not read.');
      }
      return parseEngineKeyStatus(json);
    },

    async save(updates) {
      const names = Object.keys(updates);
      const t = target('/api/setup/keys');
      if (t === null) {
        return {
          ok: false,
          restarting: false,
          code: 'not-running',
          message: 'The engine is not running, so keys cannot be saved right now.',
        };
      }
      const unknown = names.filter((n) => !ENGINE_KEY_ENV_VARS.has(n));
      if (unknown.length > 0) {
        return { ok: false, restarting: false, code: 'unknown-key', message: 'That is not a key the engine knows.' };
      }
      log.info(`sending ${names.length} key change${names.length === 1 ? '' : 's'} to the engine: ${names.join(', ')}`);
      let res: Response;
      try {
        res = await doFetch(t.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: t.origin, Accept: 'application/json' },
          body: JSON.stringify(updates),
          signal: AbortSignal.timeout(ENGINE_KEYS_TIMEOUT_MS),
        });
      } catch (err) {
        log.warn(`key save request failed: ${errText(err)}`);
        return {
          ok: false,
          restarting: false,
          code: 'unreachable',
          message: "The engine didn't answer, so nothing was saved. Try again once it is running.",
        };
      }
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (res.ok) {
        const restarting = isRecord(body) ? body['restarting'] !== false : true;
        log.info('the engine accepted the key change' + (restarting ? ' and is restarting itself' : ''));
        return { ok: true, restarting, code: null, message: null };
      }
      const code = isRecord(body) && typeof body['code'] === 'string' ? body['code'] : `http-${res.status}`;
      if (code === 'external') {
        const name = isRecord(body) && isRecord(body['params']) && typeof body['params']['name'] === 'string'
          ? body['params']['name']
          : null;
        log.info(`the engine refused a change to ${name ?? 'a key'}: managed outside Provider Settings`);
        return {
          ok: false,
          restarting: false,
          code: 'external',
          message: `${name ?? 'That key'} is managed outside Provider Settings, so it can only be changed where it was set.`,
        };
      }
      log.warn(`the engine refused the key change: ${code}`);
      return {
        ok: false,
        restarting: false,
        code,
        message: REFUSAL_MESSAGES[code] ?? `The engine refused the change (HTTP ${res.status}).`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers: fallback list, hidden rows, locks
// ---------------------------------------------------------------------------

function rowFromCatalog(e: EngineKeyCatalogEntry, set: boolean): EngineKeyRow {
  return {
    id: e.id,
    title: e.title,
    unlocks: e.unlocks,
    getUrl: e.getUrl,
    envVars: [...e.envVars],
    tier: e.tier,
    clientExposed: e.clientExposed,
    set,
    managed: set ? 'file' : null,
    lock: null,
    advanced: e.hidden,
  };
}

/** True when every variable of the entry has a non-empty value in the `.env` file. */
function setInEnv(e: EngineKeyCatalogEntry, envKeys: ReadonlySet<string>): boolean {
  return e.envVars.every((v) => envKeys.has(v));
}

/** Text of the lock on the OpenAI row while a non-OpenAI summary provider holds the placeholder. */
export const PLACEHOLDER_LOCK_TEXT =
  'Locked: while summaries use another provider, OpenTac gives the engine a placeholder OpenAI key, so the engine treats this row as set from the environment. Switch the summary provider back to OpenAI to edit it, and enter your real key before switching away.';

/** Text of the lock on a row whose value comes from the environment. */
export const EXTERNAL_LOCK_TEXT =
  'Managed outside Provider Settings: this value comes from the environment (a shell variable or the Keychain), so it can only be changed where it was set.';

/**
 * The list to show while the engine is not running (or did not answer): the catalogue with
 * set/unset taken from the names of non-empty variables in the `.env` file. No values are read.
 */
export function fallbackEngineKeys(envKeys: ReadonlySet<string>, note: string | null): EngineKeysPublic {
  const keys = ENGINE_KEY_CATALOG.map((e) => rowFromCatalog(e, setInEnv(e, envKeys)));
  return {
    source: 'fallback',
    keys,
    setCount: keys.filter((k) => !k.advanced && k.set).length,
    total: keys.filter((k) => !k.advanced).length,
    store: 'env-file',
    note,
  };
}

/**
 * Builds the list from a live engine status: rows the engine hides (such as the separate Google
 * server key) are added from the catalogue as Advanced, with set/unset taken from `.env`; locks
 * are applied for rows the environment manages.
 */
export function liveEngineKeys(
  status: EngineKeyStatus,
  envKeys: ReadonlySet<string>,
  aiProvider: string,
): EngineKeysPublic {
  const listed = new Set(status.keys.map((k) => k.id));
  const rows: EngineKeyRow[] = status.keys.map((k) => {
    let lock: string | null = null;
    if (k.managed === 'external') {
      lock = k.id === 'openai' && aiProvider !== 'openai' ? PLACEHOLDER_LOCK_TEXT : EXTERNAL_LOCK_TEXT;
    }
    return { ...k, envVars: [...k.envVars], lock, advanced: false };
  });
  for (const e of ENGINE_KEY_CATALOG) {
    if (!listed.has(e.id) && e.hidden) rows.push(rowFromCatalog(e, setInEnv(e, envKeys)));
  }
  return {
    source: 'engine',
    keys: rows,
    setCount: status.setCount,
    total: status.total,
    store: status.store,
    note: null,
  };
}

/**
 * Applies the result of a successful save to a list without asking the engine (it is restarting):
 * a non-empty value counts as set once every variable of the row has one, a null clears the row.
 */
export function applySavedKeys(list: EngineKeysPublic, updates: Record<string, string | null>): EngineKeysPublic {
  const keys = list.keys.map((row) => {
    const touched = row.envVars.some((v) => v in updates);
    if (!touched) return row;
    const cleared = row.envVars.some((v) => updates[v] === null);
    if (cleared) return { ...row, set: false, managed: null as EngineKeyManaged };
    const allNowSet = row.envVars.every((v) => (v in updates ? updates[v] !== null : row.set));
    return allNowSet ? { ...row, set: true, managed: 'file' as EngineKeyManaged } : row;
  });
  const visible = keys.filter((k) => !k.advanced);
  return { ...list, keys, setCount: visible.filter((k) => k.set).length, total: visible.length };
}
