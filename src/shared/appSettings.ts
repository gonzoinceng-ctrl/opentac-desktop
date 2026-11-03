/**
 * OpenTac's own app settings: defaults, validation and the pure helpers around them.
 * Shared by main (state.ts, controller, git/npm/server env builders), the IPC guards and the
 * renderer. No Node builtins, no electron.
 */
import type {
  AppSettings,
  LogLevelSetting,
  ProxySettings,
  UpdateCheckInterval,
} from './types.js';

export const UPDATE_CHECK_INTERVALS: readonly UpdateCheckInterval[] = ['launch-only', '6h', 'daily'];
export const LOG_LEVEL_SETTINGS: readonly LogLevelSetting[] = ['default', 'error', 'warn', 'info', 'debug'];

/** Largest address or list accepted for the proxy and mirror fields. */
export const MAX_ADDRESS_LENGTH = 512;

/** Shown next to the engine mirror field. */
export const ENGINE_REMOTE_WARNING =
  'Only change this to point at your own mirror; the default is the OpenTac mirror.';

/** Returns a fresh default AppSettings. */
export function defaultAppSettings(): AppSettings {
  return {
    launchAtLogin: false,
    autoRestartOnCrash: true,
    updateCheckInterval: '6h',
    logLevel: 'default',
    proxy: { httpsProxy: null, noProxy: null },
    engineRemoteUrl: null,
  };
}

/** A patch for {@link mergeAppSettings}: every field optional, `proxy` merged field by field. */
export interface AppSettingsPatch {
  launchAtLogin?: boolean;
  autoRestartOnCrash?: boolean;
  updateCheckInterval?: UpdateCheckInterval;
  logLevel?: LogLevelSetting;
  proxy?: { httpsProxy?: string | null; noProxy?: string | null };
  engineRemoteUrl?: string | null;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

const CONTROL = /[\u0000-\u001f\u007f]/;

function parseUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/**
 * Validates a proxy address: an http:// or https:// URL with a host, no whitespace or control
 * characters, no user name or password (state.json is not encrypted). Empty or null clears it.
 */
export function validateProxyUrl(value: string | null): Checked<string | null> {
  if (value === null) return { ok: true, value: null };
  const text = value.trim();
  if (text === '') return { ok: true, value: null };
  if (text.length > MAX_ADDRESS_LENGTH) return { ok: false, reason: 'The proxy address is too long.' };
  if (CONTROL.test(text) || /\s/.test(text)) {
    return { ok: false, reason: 'The proxy address cannot contain spaces or line breaks.' };
  }
  const url = parseUrl(text);
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') {
    return { ok: false, reason: 'The proxy address should look like http://proxy.example.com:8080.' };
  }
  if (url.username !== '' || url.password !== '') {
    return {
      ok: false,
      reason:
        'Proxy addresses with a user name or password are not supported, because OpenTac settings are not encrypted.',
    };
  }
  return { ok: true, value: text };
}

/** Validates a NO_PROXY list: comma separated host names, domains, IPs or CIDR blocks. */
export function validateNoProxy(value: string | null): Checked<string | null> {
  if (value === null) return { ok: true, value: null };
  const text = value.trim();
  if (text === '') return { ok: true, value: null };
  if (text.length > MAX_ADDRESS_LENGTH) return { ok: false, reason: 'The no-proxy list is too long.' };
  if (!/^[A-Za-z0-9.*:_\-/[\], ]+$/.test(text)) {
    return {
      ok: false,
      reason: 'The no-proxy list should be host names, domains or addresses separated by commas.',
    };
  }
  return { ok: true, value: text.replace(/\s*,\s*/g, ',').replace(/^,+|,+$/g, '') };
}

/**
 * Validates an engine mirror override: https:// or file:// only, no credentials, no whitespace.
 * Decision: any https host is accepted (self-hosted mirrors are the point); file:// is honoured
 * only in development builds (see {@link engineRemoteAllowed}). The override is shown with
 * ENGINE_REMOTE_WARNING and applies at the next launch.
 * Empty or null means "use the default".
 */
export function validateEngineRemoteUrl(value: string | null): Checked<string | null> {
  if (value === null) return { ok: true, value: null };
  const text = value.trim();
  if (text === '') return { ok: true, value: null };
  if (text.length > MAX_ADDRESS_LENGTH) return { ok: false, reason: 'The mirror address is too long.' };
  if (CONTROL.test(text) || /\s/.test(text)) {
    return { ok: false, reason: 'The mirror address cannot contain spaces or line breaks.' };
  }
  const url = parseUrl(text);
  if (url === null || (url.protocol !== 'https:' && url.protocol !== 'file:')) {
    return { ok: false, reason: 'The mirror address must start with https:// or file://.' };
  }
  if (url.protocol === 'https:' && url.hostname === '') {
    return { ok: false, reason: 'The mirror address needs a host name.' };
  }
  if (url.username !== '' || url.password !== '') {
    return {
      ok: false,
      reason: 'Mirror addresses with a user name or password are not supported. Use a public or file:// mirror.',
    };
  }
  return { ok: true, value: text };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Applies a patch to settings and validates the result. Throws an Error with a plain sentence
 * when a field is invalid; the input is never modified.
 */
export function mergeAppSettings(current: AppSettings, patch: AppSettingsPatch): AppSettings {
  const next: AppSettings = { ...current, proxy: { ...current.proxy } };
  if (patch.launchAtLogin !== undefined) next.launchAtLogin = patch.launchAtLogin;
  if (patch.autoRestartOnCrash !== undefined) next.autoRestartOnCrash = patch.autoRestartOnCrash;
  if (patch.updateCheckInterval !== undefined) {
    if (!UPDATE_CHECK_INTERVALS.includes(patch.updateCheckInterval)) throw new Error('That update interval is not one OpenTac knows.');
    next.updateCheckInterval = patch.updateCheckInterval;
  }
  if (patch.logLevel !== undefined) {
    if (!LOG_LEVEL_SETTINGS.includes(patch.logLevel)) throw new Error('That log level is not one OpenTac knows.');
    next.logLevel = patch.logLevel;
  }
  if (patch.proxy !== undefined) {
    if (patch.proxy.httpsProxy !== undefined) {
      const r = validateProxyUrl(patch.proxy.httpsProxy);
      if (!r.ok) throw new Error(r.reason);
      next.proxy.httpsProxy = r.value;
    }
    if (patch.proxy.noProxy !== undefined) {
      const r = validateNoProxy(patch.proxy.noProxy);
      if (!r.ok) throw new Error(r.reason);
      next.proxy.noProxy = r.value;
    }
  }
  if (patch.engineRemoteUrl !== undefined) {
    const r = validateEngineRemoteUrl(patch.engineRemoteUrl);
    if (!r.ok) throw new Error(r.reason);
    next.engineRemoteUrl = r.value;
  }
  return next;
}

/** Guard for a setAppSettings payload: known keys, right types, valid addresses. */
export function isAppSettingsPatch(v: unknown): v is AppSettingsPatch {
  if (!isRecord(v)) return false;
  for (const [k, val] of Object.entries(v)) {
    switch (k) {
      case 'launchAtLogin':
      case 'autoRestartOnCrash':
        if (typeof val !== 'boolean') return false;
        break;
      case 'updateCheckInterval':
        if (typeof val !== 'string' || !(UPDATE_CHECK_INTERVALS as readonly string[]).includes(val)) return false;
        break;
      case 'logLevel':
        if (typeof val !== 'string' || !(LOG_LEVEL_SETTINGS as readonly string[]).includes(val)) return false;
        break;
      case 'engineRemoteUrl':
        if (val !== null && (typeof val !== 'string' || !validateEngineRemoteUrl(val).ok)) return false;
        break;
      case 'proxy': {
        if (!isRecord(val)) return false;
        for (const [pk, pv] of Object.entries(val)) {
          if (pk === 'httpsProxy') {
            if (pv !== null && (typeof pv !== 'string' || !validateProxyUrl(pv).ok)) return false;
          } else if (pk === 'noProxy') {
            if (pv !== null && (typeof pv !== 'string' || !validateNoProxy(pv).ok)) return false;
          } else {
            return false;
          }
        }
        break;
      }
      default:
        return false;
    }
  }
  return true;
}

/**
 * The environment variables a proxy setting adds to a child process. Only these names are ever
 * produced: HTTPS_PROXY, HTTP_PROXY, NO_PROXY and (engine only) NODE_USE_ENV_PROXY.
 */
export function proxyEnvFor(proxy: ProxySettings, opts: { nodeEnvProxy?: boolean } = {}): Record<string, string> {
  const env: Record<string, string> = {};
  const hasUser = proxy.noProxy !== null && proxy.noProxy !== '';
  if (proxy.httpsProxy !== null && proxy.httpsProxy !== '') {
    env['HTTPS_PROXY'] = proxy.httpsProxy;
    env['HTTP_PROXY'] = proxy.httpsProxy;
    if (opts.nodeEnvProxy === true) env['NODE_USE_ENV_PROXY'] = '1';
    // Loopback must never go through the proxy: the AI gateway token and prompts travel to 127.0.0.1.
    env['NO_PROXY'] = withLoopback(hasUser ? proxy.noProxy : null);
  } else if (hasUser) {
    env['NO_PROXY'] = proxy.noProxy as string;
  }
  return env;
}

/** Loopback names always kept out of the proxy. */
export const LOOPBACK_NO_PROXY: readonly string[] = ['127.0.0.1', 'localhost', '::1', '[::1]'];

/** Appends the loopback names to a NO_PROXY list, skipping ones already present. */
export function withLoopback(list: string | null): string {
  const parts = (list ?? '').split(',').map((x) => x.trim()).filter((x) => x !== '');
  const have = new Set(parts.map((x) => x.toLowerCase()));
  for (const name of LOOPBACK_NO_PROXY) if (!have.has(name)) parts.push(name);
  return parts.join(',');
}

/** True when this mirror override may be used: file:// mirrors are for development builds only. */
export function engineRemoteAllowed(url: string | null, isPackaged: boolean): boolean {
  if (url === null) return true;
  return !(isPackaged && url.toLowerCase().startsWith('file:'));
}

/** Interval in ms between background engine checks, or null when only the launch check runs. */
export function checkIntervalMs(setting: UpdateCheckInterval): number | null {
  switch (setting) {
    case 'launch-only':
      return null;
    case '6h':
      return 6 * 60 * 60 * 1000;
    case 'daily':
      return 24 * 60 * 60 * 1000;
  }
}
