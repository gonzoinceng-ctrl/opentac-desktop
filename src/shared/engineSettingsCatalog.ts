/**
 * Catalogue and validation of the engine settings OpenTac writes into the engine's `.env`
 * (docs/SHELL-DESIGN.md section 14). Descriptions come from upstream's `.env.example`, shortened
 * to one sentence. Defaults are upstream's documented defaults (shown as placeholders; nothing is
 * written until the user changes a value).
 *
 * Never listed here: the 11 API-key registry variables (the engine's own endpoint owns those),
 * HOST, PORT, GEV_ALLOWED_HOSTS, GEV_KEY_SETUP_TRUSTED_PEERS, GEV_EMBED_FRAME_ANCESTORS, VITE_*.
 * No Node builtins: the renderer imports this module too.
 */
import { ENGINE_KEY_ENV_VARS, ENGINE_KEY_VALUE_LIMIT } from './engineKeyCatalog.js';

export type SettingType = 'string' | 'number' | 'boolean' | 'enum' | 'list' | 'url' | 'secret';

/** Extra validation applied on top of the type. */
export type SettingCheck =
  | 'bounding-boxes'
  | 'receiver-feeds'
  | 'overpass-urls'
  | 'iso-countries'
  | 'int-list'
  | 'code-list'
  | 'word-list'
  | 'abs-path';

export interface SettingDef {
  key: string;
  label: string;
  /** One sentence, from upstream's .env.example. */
  description: string;
  type: SettingType;
  options?: readonly string[];
  /** Upstream's default, shown as a placeholder and never written unless the user sets it. */
  default?: string;
  min?: number;
  max?: number;
  /** Numbers only: whole numbers only. */
  integer?: boolean;
  placeholder?: string;
  /** Every engine setting is read when the engine starts. */
  requiresRestart: true;
  /** An empty assignment (KEY=) means "turn this off" upstream, so it is a value, not a clear. */
  emptyDisables?: boolean;
  /** URLs: accept https only (the page's Content-Security-Policy allows no plain http). */
  httpsOnly?: boolean;
  /** Booleans: how the value is written. Default is 1/0. */
  booleanStyle?: 'true-false';
  /** A caution shown with the field. */
  warning?: string;
  /**
   * When the warning applies: 'zero' once the value is 0, 'on' once a boolean is switched on. Without
   * it the warning always shows.
   */
  warnWhen?: 'zero' | 'on';
  check?: SettingCheck;
}

/** One camera region of the CCTV layer: an enabled switch, a source cap and optional overrides. */
export interface CctvRegion {
  id: string;
  label: string;
  enabledKey: string | null;
  /** True when the region is on unless switched off, false when it is off unless switched on. */
  enabledDefault: boolean;
  maxKey: string | null;
  maxDefault: number | null;
  maxMin: number;
  maxMax: number;
  urlKey: string | null;
  districtsKey: string | null;
  districtsDefault: string | null;
  note: string | null;
}

export interface SettingGroup {
  id: string;
  title: string;
  /** Lowercase noun phrase for the Save button ("Save camera settings"); defaults to the lowercased title. */
  saveLabel?: string;
  description: string;
  settings: SettingDef[];
  regions?: CctvRegion[];
}

const S = true as const;

const voice: SettingGroup = {
  id: 'voice',
  title: 'Voice',
  saveLabel: 'voice',
  description: 'Models and behaviour of voice control (OpenAI Realtime and Gemini Live).',
  settings: [
    {
      key: 'OPENAI_REALTIME_MODEL',
      label: 'Realtime voice model',
      description: 'The OpenAI Realtime model used for voice control.',
      type: 'string',
      default: 'gpt-realtime-2',
      requiresRestart: S,
    },
    {
      key: 'OPENAI_REALTIME_MODEL_MINI',
      label: 'Cheaper voice model',
      description: "The cheaper voice tier, used when the engine's MINI toggle is on.",
      type: 'string',
      default: 'gpt-realtime-2.1-mini',
      requiresRestart: S,
    },
    {
      key: 'OPENAI_REALTIME_VOICE',
      label: 'Voice',
      description: 'The voice the assistant speaks with.',
      type: 'enum',
      options: ['alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse'],
      default: 'marin',
      requiresRestart: S,
    },
    {
      key: 'OPENAI_REALTIME_TRANSCRIBE_MODEL',
      label: 'Caption model',
      description: 'The model that captions what you said; billed separately by OpenAI, and "off" disables the captions.',
      type: 'string',
      default: 'gpt-4o-mini-transcribe',
      placeholder: 'gpt-4o-mini-transcribe, or off',
      requiresRestart: S,
    },
    {
      key: 'OPENAI_REALTIME_REASONING_EFFORT',
      label: 'Reasoning effort',
      description: 'How much the voice model thinks before it answers.',
      type: 'enum',
      options: ['minimal', 'low', 'medium', 'high'],
      default: 'low',
      requiresRestart: S,
    },
    {
      key: 'OPENAI_REALTIME_CONTEXT_TOKENS',
      label: 'Conversation window (tokens)',
      description: 'How many tokens of conversation the voice session keeps; current map state is fetched live.',
      type: 'number',
      integer: true,
      min: 1000,
      max: 12000,
      default: '3000',
      requiresRestart: S,
    },
    {
      key: 'OPENAI_REALTIME_CONTEXT_RETENTION',
      label: 'Conversation retention',
      description: 'The share of the window kept when the conversation is trimmed, from 0.1 to 1.',
      type: 'number',
      min: 0.1,
      max: 1,
      default: '0.5',
      requiresRestart: S,
    },
    {
      key: 'GEMINI_LIVE_MODEL',
      label: 'Gemini Live model',
      description: 'The Gemini Live model used when Gemini is chosen in the voice provider chooser.',
      type: 'string',
      default: 'gemini-3.8-live',
      requiresRestart: S,
    },
    {
      key: 'GEV_PREFER_CODEX_OAUTH',
      label: 'Only use the ChatGPT sign-in for voice',
      description:
        'Forbids API-key voice sessions; a missing or expired ChatGPT/Codex sign-in then makes voice fail instead of using your key.',
      type: 'boolean',
      booleanStyle: 'true-false',
      default: 'false',
      requiresRestart: S,
    },
    {
      key: 'GEV_VOICE_LOG_CONTENT',
      label: 'Keep voice transcripts in the debug log',
      description:
        'Keeps what you said, typed text and tool results in .gev-logs/realtime-conversations.jsonl, which is never expired.',
      type: 'boolean',
      default: 'false',
      warning:
        'Privacy: this writes your spoken and typed words to a file on this Mac that is never deleted automatically. Turn it off and delete the file when you are done debugging.',
      warnWhen: 'on',
      requiresRestart: S,
    },
    {
      key: 'OPENAI_HUD_SUMMARY_MODEL',
      label: 'Summary model (OpenAI)',
      description: 'The model for the short heads-up display summary when the summary provider is OpenAI.',
      type: 'string',
      default: 'gpt-5-nano',
      requiresRestart: S,
    },
  ],
};

const spend: SettingGroup = {
  id: 'limits',
  title: 'Spend and rate limits',
  saveLabel: 'spend and rate limit',
  description: 'Guards against runaway requests. They are per-install safety nets, not billing caps.',
  settings: [
    {
      key: 'GEV_RATELIMIT_OPENAI_PER_MIN',
      label: 'OpenAI requests per minute',
      description: 'Per-IP limit on the OpenAI cost endpoints (voice tokens and HUD summaries); 0 means unthrottled.',
      type: 'number',
      integer: true,
      min: 0,
      max: 100000,
      default: '30',
      warning: '0 turns the guard off completely.',
      warnWhen: 'zero',
      requiresRestart: S,
    },
    {
      key: 'GEV_RATELIMIT_GEMINI_PER_MIN',
      label: 'Gemini token starts per minute',
      description: 'Gemini token starts allowed per IP per minute; 0 disables the throttle, not the provider quotas.',
      type: 'number',
      integer: true,
      min: 0,
      max: 100000,
      default: '30',
      warning: '0 turns the guard off completely.',
      warnWhen: 'zero',
      requiresRestart: S,
    },
    {
      key: 'GEV_RATELIMIT_GOOGLE_PER_MIN',
      label: 'Google Places requests per minute',
      description: 'Per-IP limit on the Google Places cost endpoints; 0 means unthrottled.',
      type: 'number',
      integer: true,
      min: 0,
      max: 100000,
      default: '120',
      warning: '0 turns the guard off completely.',
      warnWhen: 'zero',
      requiresRestart: S,
    },
    {
      key: 'TOMTOM_DAILY_TILE_BUDGET',
      label: 'TomTom tiles per day',
      description: 'A soft cap on upstream TomTom tile fetches per UTC day; over the cap the engine serves cached tiles.',
      type: 'number',
      integer: true,
      min: 0,
      max: 10000000,
      default: '6000',
      requiresRestart: S,
    },
    {
      key: 'NOMINATIM_DAILY_CAP',
      label: 'Public Nominatim lookups per day',
      description: 'Public-instance lookups allowed per UTC day; not applied to your own Nominatim URL.',
      type: 'number',
      integer: true,
      min: 0,
      max: 1000000,
      default: '50',
      requiresRestart: S,
    },
  ],
};

const feeds: SettingGroup = {
  id: 'feeds',
  title: 'Data feeds',
  saveLabel: 'data feed',
  description: 'Where live data comes from and how it is filtered.',
  settings: [
    {
      key: 'AISSTREAM_BOUNDING_BOXES',
      label: 'Ship feed area',
      description: 'Limits the AISStream subscription to boxes written as [[[lat,lon],[lat,lon]]].',
      type: 'list',
      check: 'bounding-boxes',
      default: '[[[-90,-180],[90,180]]]',
      requiresRestart: S,
    },
    {
      key: 'AISSTREAM_MESSAGE_TYPES',
      label: 'Ship message types',
      description: 'Comma-separated AISStream message types to subscribe to.',
      type: 'list',
      check: 'word-list',
      default:
        'PositionReport,StandardClassBPositionReport,ExtendedClassBPositionReport,ShipStaticData,StaticDataReport',
      requiresRestart: S,
    },
    {
      key: 'AISSTREAM_SILENCE_TIMEOUT_MS',
      label: 'Ship feed silence timeout (ms)',
      description: 'Silence after which the ship feed is reported stale and the socket recycled at 2.5 times that; 0 disables the watch.',
      type: 'number',
      integer: true,
      min: 0,
      max: 86400000,
      default: '120000',
      requiresRestart: S,
    },
    {
      key: 'OPENSKY_AUTH_MODE',
      label: 'OpenSky sign-in mode',
      description: 'How the engine signs in to OpenSky: oauth needs the client credentials, anon is rate-limited but works.',
      type: 'enum',
      options: ['oauth', 'auto', 'anon'],
      default: 'oauth',
      requiresRestart: S,
    },
    {
      key: 'OPENSKY_CREDENTIALS_FILE',
      label: 'OpenSky credentials file',
      description: 'The credentials.json from your OpenSky account page, used when the two OpenSky keys are empty.',
      type: 'string',
      check: 'abs-path',
      placeholder: '/Users/you/credentials.json',
      requiresRestart: S,
    },
    {
      key: 'LOCAL_RECEIVER_FEEDS',
      label: 'Local ADS-B receivers',
      description: 'Comma-separated band=url entries (band 1090 or 978) for receivers on this machine or your network.',
      type: 'list',
      check: 'receiver-feeds',
      placeholder: '1090=http://localhost:8080/data/aircraft.json',
      requiresRestart: S,
    },
    {
      key: 'OVERPASS_UPSTREAMS',
      label: 'Overpass servers',
      description: 'Comma-separated Overpass URLs; use only instances you run or pay for.',
      type: 'list',
      check: 'overpass-urls',
      placeholder: 'https://overpass.example.org/api/interpreter',
      requiresRestart: S,
    },
    {
      key: 'NOMINATIM_URL',
      label: 'Nominatim search URL',
      description: 'Last-resort place search and voice outlines; nothing is used unless you set an endpoint you operate or may use.',
      type: 'url',
      placeholder: 'https://nominatim.example.org/search',
      requiresRestart: S,
    },
    {
      key: 'PHOTON_URL',
      label: 'Photon search URL',
      description: 'Keyless place search used by the browser; unset uses photon.komoot.io and an empty value turns it off.',
      type: 'url',
      httpsOnly: true,
      emptyDisables: true,
      placeholder: 'https://photon.komoot.io/ (default)',
      requiresRestart: S,
    },
    {
      key: 'RADIO_PRIORITY_COUNTRIES',
      label: 'Radio priority countries',
      description: 'Up to 8 two-letter country codes whose stations are reserved a share of the radio directory.',
      type: 'list',
      check: 'iso-countries',
      placeholder: 'IN,PL',
      requiresRestart: S,
    },
    {
      key: 'ONTARIO_511_API_KEY',
      label: 'Ontario 511 API key',
      description: 'A free developer key from 511on.ca that the Ontario traffic cameras need.',
      type: 'secret',
      requiresRestart: S,
    },
  ],
};

function region(r: Partial<CctvRegion> & { id: string; label: string }): CctvRegion {
  const id = r.id;
  return {
    id,
    label: r.label,
    enabledKey: r.enabledKey === undefined ? `CCTV_${id}_ENABLED` : r.enabledKey,
    enabledDefault: r.enabledDefault ?? true,
    maxKey: r.maxKey === undefined ? `CCTV_${id}_MAX_SOURCES` : r.maxKey,
    maxDefault: r.maxDefault ?? null,
    maxMin: r.maxMin ?? 1,
    maxMax: r.maxMax ?? 4000,
    urlKey: r.urlKey ?? null,
    districtsKey: r.districtsKey ?? null,
    districtsDefault: r.districtsDefault ?? null,
    note: r.note ?? null,
  };
}

/** Camera regions, derived from upstream's .env.example (every CCTV_<REGION>_* variable there). */
export const CCTV_REGIONS: readonly CctvRegion[] = [
  region({ id: 'AUSTIN', label: 'Austin, Texas', enabledKey: null, maxDefault: 250, urlKey: 'CCTV_AUSTIN_ROWS_URL' }),
  region({
    id: 'CALTRANS',
    label: 'Caltrans, California',
    enabledKey: null,
    maxDefault: 300,
    districtsKey: 'CCTV_CALTRANS_DISTRICTS',
    districtsDefault: '4,7,11,3',
  }),
  region({ id: 'TFL', label: 'Transport for London JamCams', maxDefault: 250 }),
  region({ id: 'ONTARIO', label: 'Ontario 511', maxDefault: 1000, note: 'Needs the Ontario 511 API key under Data feeds.' }),
  region({ id: 'FINTRAFFIC', label: 'Fintraffic, Finland', maxDefault: 300 }),
  region({ id: 'DRIVEBC', label: 'DriveBC, British Columbia', maxDefault: 250 }),
  region({
    id: 'TXDOT',
    label: 'TxDOT, Texas',
    maxDefault: 500,
    districtsKey: 'CCTV_TXDOT_DISTRICTS',
    districtsDefault: 'AUS,SAT',
  }),
  region({ id: 'TALLINN', label: 'Tallinn intersections, Estonia', maxDefault: 255 }),
  region({ id: 'TARKTEE', label: 'Tarktee road weather, Estonia', maxDefault: 179 }),
  region({ id: 'WARENDORF', label: 'Warendorf webcams, Germany', maxKey: null }),
  region({ id: 'NSW', label: 'Live Traffic NSW, Australia', maxDefault: 250 }),
  region({ id: 'CALGARY', label: 'Open Calgary, Alberta', maxDefault: 220, urlKey: 'CCTV_CALGARY_ROWS_URL' }),
  region({ id: 'CATALONIA', label: 'Servei Català de Trànsit, Catalonia', maxDefault: 150 }),
  region({
    id: 'HK',
    label: 'Hong Kong Transport Department',
    maxDefault: 1100,
    maxMin: 8,
    maxMax: 1200,
    urlKey: 'CCTV_HK_CAMERAS_URL',
  }),
  region({ id: 'KINGCOUNTY', label: 'King County, Washington', maxDefault: 125 }),
  region({ id: 'WSDOT', label: 'WSDOT, Washington State', maxDefault: 250, maxMin: 8, maxMax: 1200 }),
  region({
    id: 'VEGVESEN',
    label: 'Statens vegvesen, Norway',
    maxDefault: 900,
    maxMax: 1000,
    urlKey: 'CCTV_VEGVESEN_URL',
  }),
  region({
    id: 'NYC',
    label: 'NYC DOT',
    enabledDefault: false,
    maxDefault: 250,
    urlKey: 'CCTV_NYC_CAMERAS_URL',
    note: 'Off by default: only turn it on if you hold a NYC DOT data-sharing agreement for the camera feed.',
  }),
  region({
    id: 'TORONTO',
    label: 'City of Toronto RESCU',
    maxDefault: 336,
    maxMin: 8,
    maxMax: 500,
    urlKey: 'CCTV_TORONTO_LIST_URL',
  }),
  region({
    id: 'LITHUANIA',
    label: 'Via Lietuva, Lithuania',
    enabledDefault: false,
    maxDefault: 400,
    note: 'Off by default: the photo licence is unconfirmed (see upstream DATA_SOURCES.md).',
  }),
  region({
    id: 'FLORIDA',
    label: 'FL511, Florida',
    enabledDefault: false,
    maxDefault: 500,
    note: 'Off by default: individual, personal use only; any other use needs FDOT written consent.',
  }),
  region({ id: 'TAIWAN', label: 'Taiwan Freeway Bureau', maxDefault: 600, maxMax: 2000, urlKey: 'CCTV_TAIWAN_URL' }),
  region({ id: 'A22', label: 'Autostrada del Brennero A22, Italy', maxKey: null, urlKey: 'CCTV_A22_URL' }),
];

const cctv: SettingGroup = {
  id: 'cctv',
  title: 'CCTV cameras',
  saveLabel: 'camera',
  description: 'Which public camera packs load and how many cameras each may contribute.',
  settings: [
    {
      key: 'CCTV_MAX_SOURCES',
      label: 'Total camera cap',
      description: 'A catalogue-wide ceiling on cameras, shared round-robin across the packs.',
      type: 'number',
      integer: true,
      min: 1,
      max: 20000,
      default: '4000',
      requiresRestart: S,
    },
  ],
  regions: [...CCTV_REGIONS],
};

export const ENGINE_SETTINGS_CATALOG: SettingGroup[] = [voice, spend, feeds, cctv];

/** Variables that must never be writable through the settings catalogue. */
export const FORBIDDEN_SETTING_KEYS: readonly string[] = [
  'HOST',
  'PORT',
  'GEV_ALLOWED_HOSTS',
  'GEV_KEY_SETUP_TRUSTED_PEERS',
  'GEV_EMBED_FRAME_ANCESTORS',
  'NODE_ENV',
  'PATH',
  'HOME',
];

/** True for a key that the settings catalogue refuses by name (forbidden, VITE_*, or an API key). */
export function isForbiddenSettingKey(key: string): boolean {
  return FORBIDDEN_SETTING_KEYS.includes(key) || key.startsWith('VITE_') || ENGINE_KEY_ENV_VARS.has(key);
}

/** One flat settings field, whichever group or region it came from. */
export interface SettingField extends SettingDef {
  groupId: string;
}

function regionFields(r: CctvRegion, groupId: string): SettingField[] {
  const out: SettingField[] = [];
  if (r.enabledKey !== null) {
    out.push({
      key: r.enabledKey,
      label: `${r.label}: enabled`,
      description: `Turns the ${r.label} camera pack ${r.enabledDefault ? 'off' : 'on'}.`,
      type: 'boolean',
      default: r.enabledDefault ? 'true' : 'false',
      requiresRestart: true,
      groupId,
    });
  }
  if (r.maxKey !== null) {
    out.push({
      key: r.maxKey,
      label: `${r.label}: camera cap`,
      description: `Caps the cameras loaded for ${r.label}.`,
      type: 'number',
      integer: true,
      min: r.maxMin,
      max: r.maxMax,
      ...(r.maxDefault !== null ? { default: String(r.maxDefault) } : {}),
      requiresRestart: true,
      groupId,
    });
  }
  if (r.urlKey !== null) {
    out.push({
      key: r.urlKey,
      label: `${r.label}: catalogue URL`,
      description: `Overrides the ${r.label} catalogue URL.`,
      type: 'url',
      requiresRestart: true,
      groupId,
    });
  }
  if (r.districtsKey !== null) {
    out.push({
      key: r.districtsKey,
      label: `${r.label}: districts`,
      description: `Districts to load for ${r.label}; an empty value turns the pack off.`,
      type: 'list',
      check: r.districtsKey === 'CCTV_CALTRANS_DISTRICTS' ? 'int-list' : 'code-list',
      emptyDisables: true,
      ...(r.districtsDefault !== null ? { default: r.districtsDefault } : {}),
      requiresRestart: true,
      groupId,
    });
  }
  return out;
}

/** Every field in the catalogue (group settings and region fields), keyed by variable name. */
export function allSettingFields(): SettingField[] {
  const out: SettingField[] = [];
  for (const g of ENGINE_SETTINGS_CATALOG) {
    for (const s of g.settings) out.push({ ...s, groupId: g.id });
    for (const r of g.regions ?? []) out.push(...regionFields(r, g.id));
  }
  return out;
}

const FIELD_INDEX: ReadonlyMap<string, SettingField> = new Map(allSettingFields().map((f) => [f.key, f]));

/** The catalogue entry for `key`, or undefined when OpenTac does not manage that variable. */
export function findSetting(key: string): SettingField | undefined {
  return FIELD_INDEX.get(key);
}

/** Every variable name the catalogue manages. */
export function catalogKeys(): string[] {
  return [...FIELD_INDEX.keys()];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type SettingCheckResult = { ok: true; value: string } | { ok: false; reason: string };

const MAX_VALUE_LENGTH = 1024;
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Characters that would be read back differently by dotenv parsing and expansion. */
const DOTENV_META = /[#"'$\\`]/;

const BOOL_TRUE = new Set(['1', 'true', 'yes', 'on']);
const BOOL_FALSE = new Set(['0', 'false', 'no', 'off']);

/** Reads an on-disk boolean spelling; null when it is not one. */
export function parseBoolean(text: string): boolean | null {
  const t = text.trim().toLowerCase();
  if (BOOL_TRUE.has(t)) return true;
  if (BOOL_FALSE.has(t)) return false;
  return null;
}

/** The text written for a boolean. */
export function formatBoolean(def: Pick<SettingDef, 'booleanStyle'>, on: boolean): string {
  if (def.booleanStyle === 'true-false') return on ? 'true' : 'false';
  return on ? '1' : '0';
}

function fail(reason: string): SettingCheckResult {
  return { ok: false, reason };
}

function isPrivateOrLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.endsWith('.local')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m === null) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function splitList(text: string): string[] {
  return text.split(',').map((s) => s.trim());
}

function checkUrlText(text: string, httpsOnly: boolean): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'That is not a web address. It should look like https://example.org/path.';
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !httpsOnly)) {
    return httpsOnly ? 'Only https:// addresses are accepted here.' : 'The address must start with http:// or https://.';
  }
  if (url.hostname === '') return 'The address needs a host name.';
  if (url.username !== '' || url.password !== '') return 'Do not put a user name or password in the address.';
  return null;
}

function checkList(def: SettingDef, text: string): SettingCheckResult {
  switch (def.check) {
    case 'bounding-boxes': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return fail('Write the boxes as JSON, for example [[[-90,-180],[90,180]]].');
      }
      const ok =
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.length <= 50 &&
        parsed.every(
          (box: unknown) =>
            Array.isArray(box) &&
            box.length === 2 &&
            box.every(
              (pt: unknown) =>
                Array.isArray(pt) &&
                pt.length === 2 &&
                typeof pt[0] === 'number' &&
                typeof pt[1] === 'number' &&
                Math.abs(pt[0]) <= 90 &&
                Math.abs(pt[1]) <= 180,
            ),
        );
      if (!ok) return fail('Each box needs two [latitude,longitude] corners, latitude within 90 and longitude within 180.');
      return { ok: true, value: JSON.stringify(parsed) };
    }
    case 'word-list': {
      const items = splitList(text);
      if (items.some((i) => !/^[A-Za-z][A-Za-z0-9]*$/.test(i))) {
        return fail('Use comma-separated names made of letters and digits.');
      }
      return { ok: true, value: items.join(',') };
    }
    case 'iso-countries': {
      const items = splitList(text.toUpperCase());
      if (items.length > 8) return fail('At most 8 countries are allowed.');
      if (items.some((i) => !/^[A-Z]{2}$/.test(i))) return fail('Use two-letter country codes separated by commas, such as IN,PL.');
      return { ok: true, value: items.join(',') };
    }
    case 'int-list': {
      const items = splitList(text);
      if (items.some((i) => !/^\d{1,3}$/.test(i))) return fail('Use district numbers separated by commas, such as 4,7,11,3.');
      return { ok: true, value: items.join(',') };
    }
    case 'code-list': {
      const items = splitList(text.toUpperCase());
      if (items.some((i) => !/^[A-Z0-9]{2,6}$/.test(i))) return fail('Use district codes separated by commas, such as AUS,SAT.');
      return { ok: true, value: items.join(',') };
    }
    case 'overpass-urls': {
      const items = splitList(text);
      if (items.length > 8) return fail('At most 8 servers are allowed.');
      for (const item of items) {
        const problem = checkUrlText(item, false);
        if (problem !== null) return fail(problem);
      }
      return { ok: true, value: items.join(',') };
    }
    case 'receiver-feeds': {
      const items = splitList(text);
      if (items.length > 8) return fail('At most 8 receivers are allowed.');
      for (const item of items) {
        const m = /^(1090|978)=(.+)$/.exec(item);
        if (m === null) return fail('Write each receiver as 1090=http://host/data/aircraft.json or 978=…, separated by commas.');
        const problem = checkUrlText(m[2] ?? '', false);
        if (problem !== null) return fail(problem);
        const url = new URL(m[2] ?? '');
        if (!isPrivateOrLocalHost(url.hostname)) {
          return fail('The receiver must be on this Mac, localhost, a *.local name or a private network address.');
        }
        if (!url.pathname.endsWith('aircraft.json')) return fail('The receiver address must end in aircraft.json.');
      }
      return { ok: true, value: items.join(',') };
    }
    default: {
      const parts = splitList(text);
      if (parts.some((i) => i === '')) return fail('Remove the empty item between commas.');
      return { ok: true, value: parts.join(',') };
    }
  }
}

/**
 * Validates and normalises one setting value. An empty string is accepted only where upstream
 * defines it ("turn this off"); to remove a setting, pass null to the writer instead.
 */
export function validateSetting(key: string, value: string): SettingCheckResult {
  const def = findSetting(key);
  if (def === undefined) return fail('OpenTac does not manage that setting.');
  if (typeof value !== 'string') return fail('The value must be text.');
  if (CONTROL.test(value)) return fail('The value cannot contain line breaks or control characters.');
  const text = value.trim();
  if (text.length > MAX_VALUE_LENGTH) return fail('That value is too long.');
  if (text === '') {
    return def.emptyDisables === true
      ? { ok: true, value: '' }
      : fail('Enter a value, or use Reset to remove the setting.');
  }
  switch (def.type) {
    case 'boolean': {
      const b = parseBoolean(text);
      return b === null ? fail('Choose on or off.') : { ok: true, value: formatBoolean(def, b) };
    }
    case 'number': {
      if (!/^-?\d+(\.\d+)?$/.test(text)) return fail('Enter a number.');
      const n = Number(text);
      if (def.integer === true && !Number.isInteger(n)) return fail('Enter a whole number.');
      if (def.min !== undefined && n < def.min) return fail(`The smallest allowed value is ${def.min}.`);
      if (def.max !== undefined && n > def.max) return fail(`The largest allowed value is ${def.max}.`);
      return { ok: true, value: String(n) };
    }
    case 'enum': {
      const options = def.options ?? [];
      const hit = options.find((o) => o === text.toLowerCase());
      return hit === undefined ? fail(`Choose one of: ${options.join(', ')}.`) : { ok: true, value: hit };
    }
    case 'url': {
      if (DOTENV_META.test(text)) return fail('The address cannot contain # quotes $ backslash or backtick.');
      if (/\s/.test(text)) return fail('The address cannot contain spaces.');
      const problem = checkUrlText(text, def.httpsOnly === true);
      return problem === null ? { ok: true, value: text } : fail(problem);
    }
    case 'secret': {
      if (text.length > ENGINE_KEY_VALUE_LIMIT) return fail('That is longer than any real key.');
      if (!/^[\x21-\x7e]+$/.test(text)) return fail('A key cannot contain spaces, line breaks or non-ASCII characters.');
      if (DOTENV_META.test(text)) return fail('A key cannot contain # quotes $ backslash or backtick.');
      return { ok: true, value: text };
    }
    case 'list': {
      if (DOTENV_META.test(text)) return fail('The value cannot contain # quotes $ backslash or backtick.');
      if (def.check !== 'bounding-boxes' && /\s/.test(text.replace(/\s*,\s*/g, ','))) {
        return fail('Separate items with commas and no spaces inside an item.');
      }
      return checkList(def, text);
    }
    case 'string': {
      if (DOTENV_META.test(text)) return fail('The value cannot contain # quotes $ backslash or backtick.');
      if (def.check === 'abs-path') {
        if (!text.startsWith('/')) return fail('Use an absolute path that starts with /.');
        return { ok: true, value: text };
      }
      if (/\s/.test(text)) return fail('The value cannot contain spaces.');
      return { ok: true, value: text };
    }
  }
}
