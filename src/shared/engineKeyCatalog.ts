/**
 * Static catalogue of the API keys the engine's own Provider Settings registers (ids, titles and
 * env var names only, mirroring upstream's `KEY_SETUP_KEYS` in src/keySetupCore.mjs). It is a
 * FALLBACK for display while the engine is not running and the source of the "advanced" row the
 * engine hides; the live list always comes from the engine's `GET /api/setup/status`.
 * No Node builtins: the renderer uses this too.
 */

export type EngineKeyTier = 'free' | 'metered' | 'paid';

/** One catalogue entry. `hidden` rows are accepted by the engine but not listed by its status. */
export interface EngineKeyCatalogEntry {
  id: string;
  title: string;
  unlocks: string;
  getUrl: string;
  envVars: readonly string[];
  tier: EngineKeyTier;
  clientExposed: boolean;
  hidden: boolean;
}

export const ENGINE_KEY_CATALOG: readonly EngineKeyCatalogEntry[] = [
  {
    id: 'google-maps',
    title: 'GOOGLE MAPS',
    unlocks: 'The photorealistic 3D planet, place search + Street View',
    getUrl: 'https://developers.google.com/maps/documentation/tile/get-api-key',
    envVars: ['GOOGLE_MAPS_API_KEY'],
    tier: 'metered',
    clientExposed: true,
    hidden: false,
  },
  {
    id: 'google-maps-server',
    title: 'GOOGLE MAPS — SERVER',
    unlocks: 'Places context + Street View fallback; optional separate key',
    getUrl: 'https://developers.google.com/maps/documentation/places/web-service/get-api-key',
    envVars: ['GOOGLE_MAPS_SERVER_API_KEY'],
    tier: 'metered',
    clientExposed: false,
    hidden: true,
  },
  {
    id: 'openai',
    title: 'OPENAI',
    unlocks: 'Voice control — API key or ChatGPT OAuth',
    getUrl: 'https://platform.openai.com/api-keys',
    envVars: ['OPENAI_API_KEY'],
    tier: 'metered',
    clientExposed: false,
    hidden: false,
  },
  {
    id: 'gemini',
    title: 'GEMINI',
    unlocks: 'Gemini Live voice control',
    getUrl: 'https://aistudio.google.com/apikey',
    envVars: ['GEMINI_API_KEY'],
    tier: 'metered',
    clientExposed: false,
    hidden: false,
  },
  {
    id: 'aisstream',
    title: 'AISSTREAM',
    unlocks: 'Live ships, worldwide',
    getUrl: 'https://aisstream.io',
    envVars: ['AISSTREAM_API_KEY'],
    tier: 'free',
    clientExposed: false,
    hidden: false,
  },
  {
    id: 'firms',
    title: 'NASA FIRMS',
    unlocks: 'Live active-fire detections',
    getUrl: 'https://firms.modaps.eosdis.nasa.gov/api/map_key/',
    envVars: ['FIRMS_MAP_KEY'],
    tier: 'free',
    clientExposed: false,
    hidden: false,
  },
  {
    id: 'tomtom',
    title: 'TOMTOM',
    unlocks: 'Real live traffic (keyless runs a simulation)',
    getUrl: 'https://my.tomtom.com/keys',
    envVars: ['TOMTOM_API_KEY'],
    tier: 'free',
    clientExposed: false,
    hidden: false,
  },
  {
    id: 'cesium-ion',
    title: 'CESIUM ION',
    unlocks: 'Bing imagery map stacks + world terrain',
    getUrl: 'https://ion.cesium.com/tokens',
    envVars: ['CESIUM_ION_TOKEN'],
    tier: 'free',
    clientExposed: true,
    hidden: false,
  },
  {
    id: 'opensky',
    title: 'OPENSKY',
    unlocks: 'More flight-polling credits (anonymous works without)',
    getUrl: 'https://opensky-network.org',
    envVars: ['OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET'],
    tier: 'free',
    clientExposed: false,
    hidden: false,
  },
  {
    id: 'mapillary',
    title: 'MAPILLARY',
    unlocks: 'Street-level imagery and coverage in the Street Level layer',
    getUrl: 'https://www.mapillary.com/dashboard/developers',
    envVars: ['MAPILLARY_CLIENT_TOKEN'],
    tier: 'free',
    clientExposed: true,
    hidden: false,
  },
  {
    id: 'launch-library',
    title: 'LAUNCH LIBRARY',
    unlocks: 'Public space-missions access needs no key; paid tokens only raise request limits',
    getUrl: 'https://thespacedevs.com/supportus',
    envVars: ['LL2_API_TOKEN'],
    tier: 'paid',
    clientExposed: false,
    hidden: false,
  },
];

/** Every env var the engine's key endpoint accepts (the engine refuses all others). */
export const ENGINE_KEY_ENV_VARS: ReadonlySet<string> = new Set(
  ENGINE_KEY_CATALOG.flatMap((e) => [...e.envVars]),
);

/** Longest key value the engine accepts (src/keySetupCore.mjs KEY_SETUP_VALUE_LIMIT). */
export const ENGINE_KEY_VALUE_LIMIT = 512;

/**
 * True when `value` would be accepted by the engine: 1 to 512 printable ASCII characters, no
 * spaces, none of `# " ' $ \ \``. (Mirrors `validateKeySetupUpdates` upstream.)
 */
export function isEngineKeyValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= ENGINE_KEY_VALUE_LIMIT &&
    /^[\x21-\x7e]+$/.test(value) &&
    !/[#"'$\\`]/.test(value)
  );
}

/** A plain sentence for why `value` cannot be saved, or null when it can. */
export function engineKeyValueProblem(value: string): string | null {
  if (value === '') return 'Type or paste a key first.';
  if (value.length > ENGINE_KEY_VALUE_LIMIT) return 'That is longer than any real key.';
  if (!/^[\x21-\x7e]+$/.test(value)) return 'A key cannot contain spaces, line breaks or non-ASCII characters.';
  if (/[#"'$\\`]/.test(value)) return 'A key cannot contain # quotes $ backslash or backtick.';
  return null;
}
