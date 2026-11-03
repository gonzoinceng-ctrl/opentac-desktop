import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENGINE_KEY_CATALOG } from '../../src/main/engineKeys.js';
import {
  CCTV_REGIONS,
  ENGINE_SETTINGS_CATALOG,
  EnvSettingsError,
  SETTINGS_APPEND_HEADER,
  allSettingFields,
  catalogKeys,
  findSetting,
  isForbiddenSettingKey,
  parseEngineSettings,
  readEngineSettings,
  readEngineSettingsPublic,
  upsertSettingLines,
  validateSetting,
  writeEngineSettings,
} from '../../src/main/envSettings.js';

// test/fixtures/gev-env-example.txt is upstream's .env.example at commit 48146f8e.
const EXAMPLE = await readFile(fileURLToPath(new URL('../fixtures/gev-env-example.txt', import.meta.url)), 'utf8');

let dir = '';
let file = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opentac-envsettings-'));
  file = join(dir, '.env');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Every variable named in the example, as an active or commented-out assignment. */
function exampleVars(): Set<string> {
  const names = new Set<string>();
  for (const line of EXAMPLE.split('\n')) {
    const m = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (m?.[1] !== undefined) names.add(m[1]);
  }
  return names;
}

describe('catalogue sanity', () => {
  it('has unique keys', () => {
    const keys = allSettingFields().map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(80);
  });

  it('never lists a forbidden variable, a VITE_ variable or one of the 12 registry variables', () => {
    const registry = new Set(ENGINE_KEY_CATALOG.flatMap((e) => [...e.envVars]));
    for (const key of catalogKeys()) {
      expect(isForbiddenSettingKey(key), key).toBe(false);
      expect(registry.has(key), key).toBe(false);
      expect(key.startsWith('VITE_'), key).toBe(false);
      for (const bad of ['HOST', 'PORT', 'GEV_ALLOWED_HOSTS', 'GEV_KEY_SETUP_TRUSTED_PEERS', 'GEV_EMBED_FRAME_ANCESTORS']) {
        expect(key).not.toBe(bad);
      }
    }
    for (const bad of ['HOST', 'PORT', 'GEV_ALLOWED_HOSTS', 'GEV_KEY_SETUP_TRUSTED_PEERS', 'GEV_EMBED_FRAME_ANCESTORS', 'VITE_AIS_LIVE_API_URL', 'OPENAI_API_KEY', 'LL2_API_TOKEN']) {
      expect(isForbiddenSettingKey(bad), bad).toBe(true);
      expect(findSetting(bad), bad).toBeUndefined();
    }
  });

  it('covers the settings the owner asked for', () => {
    const want = [
      'OPENAI_REALTIME_MODEL', 'OPENAI_REALTIME_MODEL_MINI', 'OPENAI_REALTIME_VOICE', 'OPENAI_REALTIME_TRANSCRIBE_MODEL',
      'OPENAI_REALTIME_REASONING_EFFORT', 'OPENAI_REALTIME_CONTEXT_TOKENS', 'OPENAI_REALTIME_CONTEXT_RETENTION',
      'GEMINI_LIVE_MODEL', 'GEV_PREFER_CODEX_OAUTH', 'GEV_VOICE_LOG_CONTENT', 'OPENAI_HUD_SUMMARY_MODEL',
      'GEV_RATELIMIT_OPENAI_PER_MIN', 'GEV_RATELIMIT_GEMINI_PER_MIN', 'GEV_RATELIMIT_GOOGLE_PER_MIN',
      'TOMTOM_DAILY_TILE_BUDGET', 'NOMINATIM_DAILY_CAP', 'AISSTREAM_BOUNDING_BOXES', 'AISSTREAM_MESSAGE_TYPES',
      'AISSTREAM_SILENCE_TIMEOUT_MS', 'OPENSKY_AUTH_MODE', 'OPENSKY_CREDENTIALS_FILE', 'LOCAL_RECEIVER_FEEDS',
      'OVERPASS_UPSTREAMS', 'NOMINATIM_URL', 'PHOTON_URL', 'RADIO_PRIORITY_COUNTRIES', 'ONTARIO_511_API_KEY', 'CCTV_MAX_SOURCES',
    ];
    const have = new Set(catalogKeys());
    for (const k of want) expect(have.has(k), k).toBe(true);
    expect(ENGINE_SETTINGS_CATALOG.map((g) => g.id)).toEqual(['voice', 'limits', 'feeds', 'cctv']);
    expect(findSetting('ONTARIO_511_API_KEY')?.type).toBe('secret');
    expect(findSetting('GEV_VOICE_LOG_CONTENT')?.warning).toContain('Privacy');
    for (const f of allSettingFields()) expect(f.requiresRestart, f.key).toBe(true);
  });

  it("every variable in the catalogue exists in upstream's .env.example", () => {
    const known = exampleVars();
    const unknown = catalogKeys().filter((key) => !known.has(key));
    expect(unknown).toEqual([]);
  });

  it('has one region row for every CCTV_<REGION>_ variable in .env.example', () => {
    // Variables of the example that are deliberately not offered (advanced file/JSON source packs,
    // the Austin priority switches, and two Vegvesen sub-switches).
    const excluded = new Set([
      'CCTV_SOURCES_FILE', 'CCTV_SOURCES_JSON', 'CCTV_PREFER_AUSTIN', 'CCTV_FORCE_AUSTIN',
      'CCTV_VEGVESEN_VIDEO', 'CCTV_VEGVESEN_HEIGHTS',
    ]);
    const cctvVars = [...exampleVars()].filter((v) => v.startsWith('CCTV_'));
    expect(cctvVars.length).toBe(59);
    const have = new Set(catalogKeys());
    const missing = cctvVars.filter((v) => !excluded.has(v) && !have.has(v));
    expect(missing).toEqual([]);
    // Region ids from the example, derived independently of the catalogue.
    const regionIds = new Set<string>();
    for (const v of cctvVars) {
      const m = /^CCTV_([A-Z0-9]+)_(ENABLED|MAX_SOURCES|ROWS_URL|CAMERAS_URL|LIST_URL|URL|DISTRICTS)$/.exec(v);
      if (m?.[1] !== undefined && m[1] !== 'SOURCES') regionIds.add(m[1]);
    }
    expect(CCTV_REGIONS.map((r) => r.id).sort()).toEqual([...regionIds].sort());
    expect(CCTV_REGIONS).toHaveLength(23);
    // Off-by-default regions are exactly the ones whose example line is empty.
    expect(CCTV_REGIONS.filter((r) => !r.enabledDefault).map((r) => r.id).sort()).toEqual(['FLORIDA', 'LITHUANIA', 'NYC']);
  });

  it('descriptions are single plain sentences', () => {
    for (const f of allSettingFields()) {
      expect(f.description.length, f.key).toBeGreaterThan(10);
      expect(f.description, f.key).not.toMatch(/\n/);
      expect(f.label.length, f.key).toBeGreaterThan(2);
    }
  });
});

describe('validateSetting', () => {
  const ok = (key: string, value: string, expected: string): void => {
    expect(validateSetting(key, value), `${key}=${value}`).toEqual({ ok: true, value: expected });
  };
  const bad = (key: string, value: string, reason?: RegExp): void => {
    const r = validateSetting(key, value);
    expect(r.ok, `${key}=${value}`).toBe(false);
    if (!r.ok && reason !== undefined) expect(r.reason).toMatch(reason);
  };

  it('numbers: integer, range, canonical form', () => {
    ok('OPENAI_REALTIME_CONTEXT_TOKENS', '3000', '3000');
    ok('OPENAI_REALTIME_CONTEXT_TOKENS', ' 05000 ', '5000');
    bad('OPENAI_REALTIME_CONTEXT_TOKENS', '999', /smallest/);
    bad('OPENAI_REALTIME_CONTEXT_TOKENS', '12001', /largest/);
    bad('OPENAI_REALTIME_CONTEXT_TOKENS', '3000.5', /whole number/);
    bad('OPENAI_REALTIME_CONTEXT_TOKENS', '3k', /number/);
    ok('OPENAI_REALTIME_CONTEXT_RETENTION', '0.5', '0.5');
    bad('OPENAI_REALTIME_CONTEXT_RETENTION', '0.05');
    bad('OPENAI_REALTIME_CONTEXT_RETENTION', '1.5');
    ok('GEV_RATELIMIT_OPENAI_PER_MIN', '0', '0');
    bad('GEV_RATELIMIT_OPENAI_PER_MIN', '-1');
    ok('CCTV_HK_MAX_SOURCES', '8', '8');
    bad('CCTV_HK_MAX_SOURCES', '7');
    bad('CCTV_HK_MAX_SOURCES', '1201');
    bad('CCTV_TORONTO_MAX_SOURCES', '501');
    bad('AISSTREAM_SILENCE_TIMEOUT_MS', '1e5');
  });

  it('booleans normalise to the setting\'s own spelling', () => {
    ok('GEV_VOICE_LOG_CONTENT', 'on', '1');
    ok('GEV_VOICE_LOG_CONTENT', 'FALSE', '0');
    ok('CCTV_TFL_ENABLED', 'yes', '1');
    ok('CCTV_TFL_ENABLED', '0', '0');
    ok('GEV_PREFER_CODEX_OAUTH', '1', 'true');
    ok('GEV_PREFER_CODEX_OAUTH', 'off', 'false');
    bad('CCTV_TFL_ENABLED', 'maybe', /on or off/);
  });

  it('enums accept only listed options (case-insensitive input, canonical output)', () => {
    ok('OPENSKY_AUTH_MODE', 'ANON', 'anon');
    ok('OPENAI_REALTIME_VOICE', 'marin', 'marin');
    bad('OPENSKY_AUTH_MODE', 'basic', /oauth, auto, anon/);
    bad('OPENAI_REALTIME_REASONING_EFFORT', 'extreme');
  });

  it('urls: scheme, host, no credentials, https-only where required', () => {
    ok('NOMINATIM_URL', 'https://nominatim.example.org/search', 'https://nominatim.example.org/search');
    ok('NOMINATIM_URL', 'http://10.0.0.5:8080/search', 'http://10.0.0.5:8080/search');
    bad('NOMINATIM_URL', 'ftp://example.org/');
    bad('NOMINATIM_URL', 'https://user:pw@example.org/');
    bad('NOMINATIM_URL', 'not a url');
    bad('NOMINATIM_URL', 'https://example.org/a#frag');
    ok('PHOTON_URL', 'https://photon.example.org/api/', 'https://photon.example.org/api/');
    bad('PHOTON_URL', 'http://photon.example.org/api/', /https/);
    ok('PHOTON_URL', '', ''); // empty turns Photon off upstream
    bad('NOMINATIM_URL', '', /Enter a value/);
    ok('CCTV_HK_CAMERAS_URL', 'https://example.org/cams.xml', 'https://example.org/cams.xml');
  });

  it('lists: bounding boxes, message types, countries, feeds, overpass, districts', () => {
    ok('AISSTREAM_BOUNDING_BOXES', '[[[-90,-180],[90,180]]]', '[[[-90,-180],[90,180]]]');
    ok('AISSTREAM_BOUNDING_BOXES', '[[[50.1, -5.2], [58.9, 2.3]]]', '[[[50.1,-5.2],[58.9,2.3]]]');
    bad('AISSTREAM_BOUNDING_BOXES', '[[[-91,0],[90,180]]]');
    bad('AISSTREAM_BOUNDING_BOXES', 'not json');
    bad('AISSTREAM_BOUNDING_BOXES', '[]');
    ok('AISSTREAM_MESSAGE_TYPES', 'PositionReport, ShipStaticData', 'PositionReport,ShipStaticData');
    bad('AISSTREAM_MESSAGE_TYPES', 'Position Report');
    ok('RADIO_PRIORITY_COUNTRIES', 'in, pl', 'IN,PL');
    bad('RADIO_PRIORITY_COUNTRIES', 'IND');
    bad('RADIO_PRIORITY_COUNTRIES', 'AA,BB,CC,DD,EE,FF,GG,HH,II');
    ok('LOCAL_RECEIVER_FEEDS', '1090=http://localhost:8080/data/aircraft.json', '1090=http://localhost:8080/data/aircraft.json');
    ok('LOCAL_RECEIVER_FEEDS', '1090=http://192.168.1.4/aircraft.json,978=http://pi.local/aircraft.json', '1090=http://192.168.1.4/aircraft.json,978=http://pi.local/aircraft.json');
    bad('LOCAL_RECEIVER_FEEDS', '1090=http://example.org/aircraft.json', /private network/);
    bad('LOCAL_RECEIVER_FEEDS', '1090=http://localhost:8080/data/other.json', /aircraft\.json/);
    bad('LOCAL_RECEIVER_FEEDS', '433=http://localhost/aircraft.json');
    ok('OVERPASS_UPSTREAMS', 'https://a.example/api/interpreter, https://b.example/api/interpreter', 'https://a.example/api/interpreter,https://b.example/api/interpreter');
    bad('OVERPASS_UPSTREAMS', 'overpass.example');
    ok('CCTV_CALTRANS_DISTRICTS', '4,7, 11,3', '4,7,11,3');
    ok('CCTV_CALTRANS_DISTRICTS', '', '');
    bad('CCTV_CALTRANS_DISTRICTS', 'four');
    ok('CCTV_TXDOT_DISTRICTS', 'aus,sat', 'AUS,SAT');
  });

  it('strings and paths: absolute path, spaces only in paths, no dotenv metacharacters', () => {
    ok('OPENAI_REALTIME_MODEL', 'gpt-realtime-2', 'gpt-realtime-2');
    bad('OPENAI_REALTIME_MODEL', 'gpt realtime');
    ok('OPENSKY_CREDENTIALS_FILE', '/Users/Jane Doe/credentials.json', '/Users/Jane Doe/credentials.json');
    bad('OPENSKY_CREDENTIALS_FILE', 'credentials.json', /absolute/);
    bad('OPENSKY_CREDENTIALS_FILE', '/tmp/a#b.json');
    for (const meta of ['a#b', 'a"b', "a'b", 'a$b', 'a\\b', 'a`b']) {
      bad('OPENAI_REALTIME_MODEL', meta, /cannot contain/);
    }
  });

  it('secrets follow the engine key rules', () => {
    ok('ONTARIO_511_API_KEY', 'abcDEF123-_', 'abcDEF123-_');
    bad('ONTARIO_511_API_KEY', 'has space');
    bad('ONTARIO_511_API_KEY', 'a$b');
    bad('ONTARIO_511_API_KEY', 'x'.repeat(513));
  });

  it('rejects control characters and newlines everywhere, and unknown keys', () => {
    for (const key of catalogKeys()) {
      expect(validateSetting(key, 'a\nB=injected').ok, key).toBe(false);
      expect(validateSetting(key, 'a\rb').ok, key).toBe(false);
      expect(validateSetting(key, 'a\u0000b').ok, key).toBe(false);
      expect(validateSetting(key, 'a\u001bb').ok, key).toBe(false);
    }
    expect(validateSetting('HOST', '0.0.0.0').ok).toBe(false);
    expect(validateSetting('OPENAI_API_KEY', 'sk-x').ok).toBe(false);
    expect(validateSetting('NOT_A_SETTING', '1').ok).toBe(false);
    expect(validateSetting('OPENAI_REALTIME_MODEL', 'x'.repeat(2000)).ok).toBe(false);
  });

  it('every default in the catalogue is itself valid', () => {
    for (const f of allSettingFields()) {
      if (f.default === undefined || f.type === 'secret') continue;
      expect(validateSetting(f.key, f.default).ok, `${f.key}=${f.default}`).toBe(true);
    }
  });
});

describe('parse and write', () => {
  const SAMPLE = [
    '# God\'s Eye View environment',
    'GOOGLE_MAPS_API_KEY=AIzaRegistryKeyValue',
    'OPENAI_API_KEY=',
    '',
    '# Voice',
    'OPENAI_REALTIME_VOICE=marin   # trailing comment',
    '# GEV_RATELIMIT_OPENAI_PER_MIN=30   # the default; uncomment only to change it',
    'CUSTOM_USER_VAR=keep me',
    'export TOMTOM_DAILY_TILE_BUDGET=5000',
    '',
  ].join('\n');

  it('reads only catalogue keys, strips comments and quotes, never returns secrets', async () => {
    await writeFile(
      file,
      [
        'OPENAI_REALTIME_VOICE=cedar # comment',
        'OPENAI_REALTIME_MODEL="gpt custom"',
        'GOOGLE_MAPS_API_KEY=AIzaRegistry',
        'ONTARIO_511_API_KEY=super-secret-value',
        'PHOTON_URL=',
        'OVERPASS_UPSTREAMS=',
        'TOMTOM_DAILY_TILE_BUDGET=1',
        'TOMTOM_DAILY_TILE_BUDGET=2',
        'UNRELATED=1',
        '',
      ].join('\n'),
    );
    const values = await readEngineSettings(file);
    expect(values).toEqual({
      OPENAI_REALTIME_VOICE: 'cedar',
      OPENAI_REALTIME_MODEL: 'gpt custom',
      PHOTON_URL: '',
      OVERPASS_UPSTREAMS: '',
      TOMTOM_DAILY_TILE_BUDGET: '2',
    });
    expect(JSON.stringify(values)).not.toContain('super-secret-value');
    expect(JSON.stringify(values)).not.toContain('AIzaRegistry');
    const pub = await readEngineSettingsPublic(file);
    expect(pub.set['ONTARIO_511_API_KEY']).toBe(true);
    expect(pub.values['ONTARIO_511_API_KEY']).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain('super-secret-value');
    expect(pub.set['PHOTON_URL']).toBe(true); // empty means "off" upstream
    expect(pub.set['OVERPASS_UPSTREAMS']).toBe(false); // empty means unset
    expect(pub.set['OPENAI_REALTIME_MODEL_MINI']).toBeUndefined();
  });

  it('a missing file reads as empty', async () => {
    expect(await readEngineSettings(join(dir, 'nope'))).toEqual({});
    expect(parseEngineSettings('')).toEqual({ values: {}, set: {} });
  });

  it('write preserves unrelated lines, comments and the registry lines byte for byte', async () => {
    await writeFile(file, SAMPLE);
    await writeEngineSettings(file, {
      OPENAI_REALTIME_VOICE: 'cedar',
      GEV_RATELIMIT_OPENAI_PER_MIN: '60',
      CCTV_MAX_SOURCES: '2000',
    });
    const text = await readFile(file, 'utf8');
    expect(text).toBe(
      [
        '# God\'s Eye View environment',
        'GOOGLE_MAPS_API_KEY=AIzaRegistryKeyValue',
        'OPENAI_API_KEY=',
        '',
        '# Voice',
        'OPENAI_REALTIME_VOICE=cedar',
        'GEV_RATELIMIT_OPENAI_PER_MIN=60',
        'CUSTOM_USER_VAR=keep me',
        'export TOMTOM_DAILY_TILE_BUDGET=5000',
        '',
        SETTINGS_APPEND_HEADER,
        'CCTV_MAX_SOURCES=2000',
        '',
      ].join('\n'),
    );
  });

  it('replaces the last active assignment and uncomments the last commented one', () => {
    const text = 'OPENAI_REALTIME_VOICE=a\nOPENAI_REALTIME_VOICE=b\n# CCTV_MAX_SOURCES=4000\n# CCTV_MAX_SOURCES=3000\n';
    expect(upsertSettingLines(text, { OPENAI_REALTIME_VOICE: 'marin', CCTV_MAX_SOURCES: '10' })).toBe(
      'OPENAI_REALTIME_VOICE=a\nOPENAI_REALTIME_VOICE=marin\n# CCTV_MAX_SOURCES=4000\nCCTV_MAX_SOURCES=10\n',
    );
  });

  it('clearing comments the assignment out and leaves everything else', async () => {
    await writeFile(file, SAMPLE);
    await writeEngineSettings(file, { OPENAI_REALTIME_VOICE: null, TOMTOM_DAILY_TILE_BUDGET: null, CCTV_MAX_SOURCES: null });
    const text = await readFile(file, 'utf8');
    expect(text).toContain('# OPENAI_REALTIME_VOICE=\n');
    expect(text).toContain('# TOMTOM_DAILY_TILE_BUDGET=\n');
    expect(text).not.toContain('CCTV_MAX_SOURCES'); // nothing to clear: file untouched for it
    expect(text).toContain('GOOGLE_MAPS_API_KEY=AIzaRegistryKeyValue');
    expect(text).toContain('CUSTOM_USER_VAR=keep me');
    expect(await readEngineSettings(file)).toEqual({});
  });

  it('writes an empty assignment for "turn this off" and quotes values with spaces', async () => {
    await writeEngineSettings(file, { PHOTON_URL: '', OPENSKY_CREDENTIALS_FILE: '/Users/Jane Doe/c.json' });
    const text = await readFile(file, 'utf8');
    expect(text).toContain('PHOTON_URL=\n');
    expect(text).toContain('OPENSKY_CREDENTIALS_FILE="/Users/Jane Doe/c.json"\n');
    const back = await readEngineSettings(file);
    expect(back['PHOTON_URL']).toBe('');
    expect(back['OPENSKY_CREDENTIALS_FILE']).toBe('/Users/Jane Doe/c.json');
  });

  it('creates the file with mode 0600 and keeps 0600 on rewrite, leaving no temp files', async () => {
    await writeEngineSettings(file, { CCTV_MAX_SOURCES: '100' });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await writeEngineSettings(file, { CCTV_MAX_SOURCES: '200' });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['.env']);
  });

  it('rewrites a world-readable file as 0600', async () => {
    await writeFile(file, 'A=1\n', { mode: 0o644 });
    await writeEngineSettings(file, { CCTV_MAX_SOURCES: '5' });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('refuses everything and writes nothing when any entry is invalid', async () => {
    await writeFile(file, SAMPLE);
    const err = await writeEngineSettings(file, {
      OPENAI_REALTIME_VOICE: 'cedar',
      CCTV_MAX_SOURCES: 'many',
      OPENAI_API_KEY: 'sk-nope',
      HOST: '0.0.0.0',
      NOT_A_SETTING: '1',
      VITE_AIS_LIVE_API_URL: 'x',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvSettingsError);
    const invalid = (err as EnvSettingsError).invalid;
    expect(Object.keys(invalid).sort()).toEqual(['CCTV_MAX_SOURCES', 'HOST', 'NOT_A_SETTING', 'OPENAI_API_KEY', 'VITE_AIS_LIVE_API_URL']);
    expect(await readFile(file, 'utf8')).toBe(SAMPLE);
  });

  it('never lets a value inject another line', async () => {
    await writeFile(file, SAMPLE);
    await expect(writeEngineSettings(file, { OPENAI_REALTIME_MODEL: 'x\nOPENAI_API_KEY=stolen' })).rejects.toBeInstanceOf(EnvSettingsError);
    await expect(writeEngineSettings(file, { OPENAI_REALTIME_MODEL: 'x\r\nHOST=0.0.0.0' })).rejects.toBeInstanceOf(EnvSettingsError);
    expect(await readFile(file, 'utf8')).toBe(SAMPLE);
  });

  it('does not write through a symbolic link', async () => {
    const real = join(dir, 'real-env');
    await writeFile(real, 'A=1\n');
    await symlink(real, file);
    await expect(writeEngineSettings(file, { CCTV_MAX_SOURCES: '5' })).rejects.toThrow(/symbolic link/);
    expect(await readFile(real, 'utf8')).toBe('A=1\n');
  });

  it('serialises concurrent writes so none is lost', async () => {
    await Promise.all([
      writeEngineSettings(file, { CCTV_MAX_SOURCES: '1' }),
      writeEngineSettings(file, { TOMTOM_DAILY_TILE_BUDGET: '2' }),
      writeEngineSettings(file, { NOMINATIM_DAILY_CAP: '3' }),
    ]);
    expect(await readEngineSettings(file)).toEqual({ CCTV_MAX_SOURCES: '1', TOMTOM_DAILY_TILE_BUDGET: '2', NOMINATIM_DAILY_CAP: '3' });
  });

  it('round-trips every non-secret default through write and read', async () => {
    const patch: Record<string, string | null> = {};
    for (const f of allSettingFields()) {
      if (f.default === undefined || f.type === 'secret') continue;
      const v = validateSetting(f.key, f.default);
      if (v.ok) patch[f.key] = v.value;
    }
    await writeEngineSettings(file, patch);
    const back = await readEngineSettings(file);
    for (const [k, v] of Object.entries(patch)) expect(back[k], k).toBe(v);
    const text = await readFile(file, 'utf8');
    expect(text.split('\n').every((l) => !/[\u0000-\u0008\u000b-\u001f]/.test(l))).toBe(true);
  });

  it('stores the Ontario key but reports only that it is set', async () => {
    await writeEngineSettings(file, { ONTARIO_511_API_KEY: 'key-12345' });
    expect(await readFile(file, 'utf8')).toContain('ONTARIO_511_API_KEY=key-12345');
    const pub = await readEngineSettingsPublic(file);
    expect(pub.set['ONTARIO_511_API_KEY']).toBe(true);
    expect(JSON.stringify(pub)).not.toContain('key-12345');
    await writeEngineSettings(file, { ONTARIO_511_API_KEY: null });
    expect((await readEngineSettingsPublic(file)).set['ONTARIO_511_API_KEY']).toBeUndefined();
  });
});
