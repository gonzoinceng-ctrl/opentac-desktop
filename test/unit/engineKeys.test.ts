import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ENGINE_KEY_CATALOG,
  EXTERNAL_LOCK_TEXT,
  EngineKeysError,
  PLACEHOLDER_LOCK_TEXT,
  applySavedKeys,
  createEngineKeysClient,
  fallbackEngineKeys,
  liveEngineKeys,
  parseEngineKeyStatus,
} from '../../src/main/engineKeys.js';
import { engineKeyValueProblem, isEngineKeyValue } from '../../src/shared/engineKeyCatalog.js';
import { testLogger } from '../helpers/core-fakes.js';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

const STATUS = {
  keys: [
    {
      id: 'google-maps',
      title: 'GOOGLE MAPS',
      unlocks: 'The photorealistic 3D planet',
      getUrl: 'https://developers.google.com/maps/documentation/tile/get-api-key',
      envVars: ['GOOGLE_MAPS_API_KEY'],
      tier: 'metered',
      clientExposed: true,
      set: true,
      managed: 'file',
    },
    {
      id: 'openai',
      title: 'OPENAI',
      unlocks: 'Voice control',
      getUrl: 'https://platform.openai.com/api-keys',
      envVars: ['OPENAI_API_KEY'],
      tier: 'metered',
      clientExposed: false,
      set: true,
      managed: 'external',
    },
    {
      id: 'opensky',
      title: 'OPENSKY',
      unlocks: 'More flight-polling credits',
      getUrl: 'https://opensky-network.org',
      envVars: ['OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET'],
      tier: 'free',
      clientExposed: false,
      set: false,
      managed: null,
    },
  ],
  setCount: 2,
  total: 3,
  store: 'env-file',
};

let server: Server | null = null;
afterEach(async () => {
  if (server !== null) await new Promise<void>((r) => server?.close(() => r()));
  server = null;
});

async function startEngine(
  handler: (seen: Seen, respond: (status: number, body: unknown) => void) => void,
): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += String(c);
    });
    req.on('end', () => {
      const s: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      seen.push(s);
      handler(s, (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
    });
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/`, seen };
}

function client(url: string | null) {
  const t = testLogger();
  return { client: createEngineKeysClient({ engineUrl: () => url, log: t.log }), logs: t.out };
}

describe('createEngineKeysClient.status', () => {
  it('GETs /api/setup/status with the engine Origin and parses the registry', async () => {
    const engine = await startEngine((_s, respond) => respond(200, STATUS));
    const { client: c } = client(engine.url);
    const status = await c.status();
    expect(engine.seen).toHaveLength(1);
    expect(engine.seen[0]?.method).toBe('GET');
    expect(engine.seen[0]?.url).toBe('/api/setup/status');
    expect(engine.seen[0]?.headers['origin']).toBe(engine.url.replace(/\/$/, ''));
    expect(engine.seen[0]?.headers['accept']).toBe('application/json');
    expect(status.keys.map((k) => k.id)).toEqual(['google-maps', 'openai', 'opensky']);
    expect(status.setCount).toBe(2);
    expect(status.total).toBe(3);
    expect(status.store).toBe('env-file');
    expect(status.keys[1]?.managed).toBe('external');
    expect(status.keys[2]?.envVars).toEqual(['OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET']);
    // The parsed object carries no value-like field.
    expect(Object.keys(status.keys[0] ?? {}).sort()).toEqual(
      ['clientExposed', 'envVars', 'getUrl', 'id', 'managed', 'set', 'tier', 'title', 'unlocks'].sort(),
    );
  });

  it('follows the engine URL on every call (port moves and restarts)', async () => {
    const engine = await startEngine((_s, respond) => respond(200, STATUS));
    let url: string | null = null;
    const t = testLogger();
    const c = createEngineKeysClient({ engineUrl: () => url, log: t.log });
    await expect(c.status()).rejects.toMatchObject({ code: 'not-running' });
    url = `${engine.url}some/page?x=1`;
    await expect(c.status()).resolves.toMatchObject({ total: 3 });
    expect(engine.seen[0]?.url).toBe('/api/setup/status');
  });

  it('maps a refusal, a missing endpoint and junk to plain EngineKeysErrors', async () => {
    const refused = await startEngine((_s, respond) => respond(403, { error: 'x', code: 'sharing' }));
    await expect(client(refused.url).client.status()).rejects.toMatchObject({ code: 'refused' });
    await new Promise<void>((r) => server?.close(() => r()));
    server = null;
    const missing = await startEngine((_s, respond) => respond(404, {}));
    await expect(client(missing.url).client.status()).rejects.toThrow('no key setup endpoint');
    await new Promise<void>((r) => server?.close(() => r()));
    server = null;
    const junk = await startEngine((_s, respond) => respond(200, { nope: true }));
    await expect(client(junk.url).client.status()).rejects.toBeInstanceOf(EngineKeysError);
  });

  it('reports an unreachable engine without a stack or URL noise', async () => {
    const { client: c } = client('http://127.0.0.1:1/');
    await expect(c.status()).rejects.toMatchObject({ code: 'unreachable' });
  });
});

describe('createEngineKeysClient.save', () => {
  it('POSTs JSON with the exact Origin and returns restarting on 200', async () => {
    const engine = await startEngine((_s, respond) =>
      respond(200, { ok: true, saved: ['AISSTREAM_API_KEY'], status: STATUS, restarting: true }),
    );
    const { client: c, logs } = client(engine.url);
    const secret = 'sk-test-ABCDEFGH1234567890';
    const result = await c.save({ AISSTREAM_API_KEY: secret });
    expect(result).toEqual({ ok: true, restarting: true, code: null, message: null });
    expect(engine.seen[0]?.method).toBe('POST');
    expect(engine.seen[0]?.url).toBe('/api/setup/keys');
    expect(engine.seen[0]?.headers['content-type']).toBe('application/json');
    expect(engine.seen[0]?.headers['origin']).toBe(engine.url.replace(/\/$/, ''));
    expect(JSON.parse(engine.seen[0]?.body ?? '')).toEqual({ AISSTREAM_API_KEY: secret });
    // Names may be logged, values never.
    expect(logs.join('\n')).toContain('AISSTREAM_API_KEY');
    expect(logs.join('\n')).not.toContain(secret);
  });

  it('sends null to remove a key and both variables of a two-variable key', async () => {
    const engine = await startEngine((_s, respond) => respond(200, { ok: true, restarting: true }));
    const { client: c } = client(engine.url);
    await c.save({ OPENSKY_CLIENT_ID: null, OPENSKY_CLIENT_SECRET: null });
    expect(JSON.parse(engine.seen[0]?.body ?? '')).toEqual({ OPENSKY_CLIENT_ID: null, OPENSKY_CLIENT_SECRET: null });
  });

  it('maps the 409 external refusal to a plain sentence that names the variable', async () => {
    const engine = await startEngine((_s, respond) =>
      respond(409, {
        error: 'OPENAI_API_KEY is configured outside Provider Settings and can only be changed where it was set',
        code: 'external',
        params: { name: 'OPENAI_API_KEY' },
      }),
    );
    const { client: c } = client(engine.url);
    const result = await c.save({ OPENAI_API_KEY: 'sk-test-ABCDEFGH1234567890' });
    expect(result.ok).toBe(false);
    expect(result.restarting).toBe(false);
    expect(result.code).toBe('external');
    expect(result.message).toContain('OPENAI_API_KEY');
    expect(result.message).toContain('managed outside Provider Settings');
  });

  it('maps validation and gate refusals to sentences, never the raw body', async () => {
    const engine = await startEngine((_s, respond) => respond(400, { error: 'raw english', code: 'not-printable' }));
    const { client: c } = client(engine.url);
    const r = await c.save({ GEMINI_API_KEY: 'x' });
    expect(r).toMatchObject({ ok: false, code: 'not-printable' });
    expect(r.message).toBe('A key cannot contain spaces or line breaks.');
  });

  it('refuses unknown variables locally and never calls the engine', async () => {
    const engine = await startEngine((_s, respond) => respond(200, { ok: true }));
    const { client: c } = client(engine.url);
    const r = await c.save({ HOST: '0.0.0.0' });
    expect(r).toMatchObject({ ok: false, code: 'unknown-key' });
    expect(engine.seen).toHaveLength(0);
  });

  it('returns not-running without a URL and unreachable when the connection is refused', async () => {
    expect(await client(null).client.save({ GEMINI_API_KEY: 'abc' })).toMatchObject({ ok: false, code: 'not-running' });
    expect(await client('http://127.0.0.1:1/').client.save({ GEMINI_API_KEY: 'abc' })).toMatchObject({
      ok: false,
      code: 'unreachable',
    });
  });
});

describe('parseEngineKeyStatus', () => {
  it('drops malformed rows and defaults the tier', () => {
    const parsed = parseEngineKeyStatus({
      keys: [{ id: 'a', title: 'A', envVars: ['A_KEY'], tier: 'weird', set: true }, { id: 'b' }, 7],
    });
    expect(parsed.keys).toHaveLength(1);
    expect(parsed.keys[0]).toMatchObject({ id: 'a', tier: 'free', set: true, managed: null, clientExposed: false });
    expect(parsed.setCount).toBe(1);
    expect(parsed.store).toBe('env-file');
  });
});

describe('list builders', () => {
  it('the catalogue holds the 11 registry keys and 12 variables, with google-maps-server hidden', () => {
    expect(ENGINE_KEY_CATALOG.map((e) => e.id)).toEqual([
      'google-maps',
      'google-maps-server',
      'openai',
      'gemini',
      'aisstream',
      'firms',
      'tomtom',
      'cesium-ion',
      'opensky',
      'mapillary',
      'launch-library',
    ]);
    expect(ENGINE_KEY_CATALOG.flatMap((e) => [...e.envVars])).toHaveLength(12);
    expect(ENGINE_KEY_CATALOG.filter((e) => e.hidden).map((e) => e.id)).toEqual(['google-maps-server']);
  });

  it('fallback shows set/unset from .env names only and counts the visible rows', () => {
    const list = fallbackEngineKeys(new Set(['AISSTREAM_API_KEY', 'OPENSKY_CLIENT_ID']), 'note');
    expect(list.source).toBe('fallback');
    expect(list.note).toBe('note');
    const byId = Object.fromEntries(list.keys.map((k) => [k.id, k]));
    expect(byId['aisstream']?.set).toBe(true);
    expect(byId['opensky']?.set).toBe(false); // needs both variables
    expect(byId['google-maps-server']?.advanced).toBe(true);
    expect(list.total).toBe(10);
    expect(list.setCount).toBe(1);
  });

  it('live list adds the hidden server key as Advanced and locks externally managed rows', () => {
    const status = parseEngineKeyStatus(STATUS);
    const list = liveEngineKeys(status, new Set(['GOOGLE_MAPS_SERVER_API_KEY']), 'openai');
    expect(list.source).toBe('engine');
    const server = list.keys.find((k) => k.id === 'google-maps-server');
    expect(server).toMatchObject({ advanced: true, set: true });
    expect(list.keys.find((k) => k.id === 'openai')?.lock).toBe(EXTERNAL_LOCK_TEXT);
    expect(list.keys.find((k) => k.id === 'google-maps')?.lock).toBeNull();
    expect(list.total).toBe(3);
  });

  it('explains the placeholder when a non-OpenAI summary provider holds the OpenAI row', () => {
    const list = liveEngineKeys(parseEngineKeyStatus(STATUS), new Set(), 'ollama');
    const lock = list.keys.find((k) => k.id === 'openai')?.lock;
    expect(lock).toBe(PLACEHOLDER_LOCK_TEXT);
    expect(lock).toContain('placeholder');
    expect(lock).toContain('Switch the summary provider back to OpenAI');
  });

  it('applySavedKeys marks rows set or unset without asking the engine', () => {
    const base = liveEngineKeys(parseEngineKeyStatus(STATUS), new Set(), 'openai');
    const one = applySavedKeys(base, { OPENSKY_CLIENT_ID: 'abc' });
    expect(one.keys.find((k) => k.id === 'opensky')?.set).toBe(false); // secret still missing
    const both = applySavedKeys(base, { OPENSKY_CLIENT_ID: 'abc', OPENSKY_CLIENT_SECRET: 'def' });
    expect(both.keys.find((k) => k.id === 'opensky')).toMatchObject({ set: true, managed: 'file' });
    expect(both.setCount).toBe(base.setCount + 1);
    const cleared = applySavedKeys(base, { GOOGLE_MAPS_API_KEY: null });
    expect(cleared.keys.find((k) => k.id === 'google-maps')).toMatchObject({ set: false, managed: null });
    expect(cleared.setCount).toBe(base.setCount - 1);
  });
});

describe('engine key value rules', () => {
  it('matches upstream: printable, no spaces, none of # " \' $ \\ `', () => {
    expect(isEngineKeyValue('AIzaSyD-abc_123')).toBe(true);
    expect(isEngineKeyValue('')).toBe(false);
    expect(isEngineKeyValue('has space')).toBe(false);
    expect(isEngineKeyValue('new\nline')).toBe(false);
    expect(isEngineKeyValue('a#b')).toBe(false);
    expect(isEngineKeyValue('a$b')).toBe(false);
    expect(isEngineKeyValue('a"b')).toBe(false);
    expect(isEngineKeyValue('x'.repeat(513))).toBe(false);
    expect(isEngineKeyValue('x'.repeat(512))).toBe(true);
    expect(engineKeyValueProblem('a b')).toContain('spaces');
    expect(engineKeyValueProblem('a$b')).toContain('$');
    expect(engineKeyValueProblem('ok')).toBeNull();
  });
});
