import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  LOG_LEVEL_SETTINGS,
  UPDATE_CHECK_INTERVALS,
  defaultAppSettings,
  validateEngineRemoteUrl,
  validateNoProxy,
  validateProxyUrl,
} from '../shared/appSettings.js';
import { DEFAULT_REMOTE_URL } from '../shared/types.js';
import type {
  AiProvider,
  AppSettings,
  Channel,
  LogLevelSetting,
  ShellState,
  UpdateCheckInterval,
  UsbDeviceId,
  WindowBounds,
} from '../shared/types.js';

/** Minimal log sink so this module never needs electron-log. */
export interface StateLog {
  warn(m: string): void;
  info(m: string): void;
}

type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

const CHANNELS: readonly Channel[] = ['stable', 'candidate', 'upstream'];
const PROVIDERS: readonly AiProvider[] = ['openai', 'ollama', 'openrouter', 'xai'];
const NULLABLE_STRING_KEYS = [
  'installedCommit',
  'installedLockHash',
  'installedNodeVersion',
  'rollbackCommit',
  'lastUpdateCheck',
  'lastSuccessfulStart',
  'skippedCommit',
] as const;

/** Returns a fresh default ShellState. */
export function defaultState(): ShellState {
  return {
    schemaVersion: 1,
    channel: 'stable',
    remoteUrl: DEFAULT_REMOTE_URL,
    installedCommit: null,
    installedLockHash: null,
    installedNodeVersion: null,
    rollbackCommit: null,
    lastUpdateCheck: null,
    lastSuccessfulStart: null,
    lastPort: null,
    updateCheckOnLaunch: true,
    skippedCommit: null,
    mainWindowBounds: null,
    usbDevices: [],
    // OpenAI is the engine's own path: no gateway, no placeholder key, the engine's OpenAI key row stays
    // editable (voice needs it). Local Ollama is an explicit choice in Preferences (DECISIONS 2026-11-04).
    ai: { provider: 'openai', model: null, ollamaHost: null },
    app: defaultAppSettings(),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function readNullableString(raw: unknown, name: string): Result<string | null> {
  if (raw === undefined || raw === null) return ok(null);
  return typeof raw === 'string' ? ok(raw) : fail(`${name} must be a string or null`);
}

function readLastPort(raw: unknown): Result<number | null> {
  if (raw === undefined || raw === null) return ok(null);
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 65535) return ok(raw);
  return fail('lastPort must be an integer port number or null');
}

function readBounds(raw: unknown): Result<WindowBounds | null> {
  if (raw === undefined || raw === null) return ok(null);
  if (!isRecord(raw)) return fail('mainWindowBounds must be an object or null');
  const { x, y, width, height } = raw;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return fail('mainWindowBounds.width and height must be finite numbers');
  }
  const bounds: WindowBounds = { width: width as number, height: height as number };
  for (const [key, v] of [['x', x], ['y', y]] as const) {
    if (v === undefined) continue;
    if (!Number.isFinite(v)) return fail(`mainWindowBounds.${key} must be a finite number`);
    bounds[key] = v as number;
  }
  return ok(bounds);
}

function readUsbDevices(raw: unknown): Result<UsbDeviceId[]> {
  if (raw === undefined) return ok([]);
  if (!Array.isArray(raw)) return fail('usbDevices must be an array');
  const devices: UsbDeviceId[] = [];
  for (const [i, item] of raw.entries()) {
    if (!isRecord(item)) return fail(`usbDevices[${i}] must be an object`);
    const { vendorId, productId, serialNumber } = item;
    if (!Number.isInteger(vendorId) || !Number.isInteger(productId)) {
      return fail(`usbDevices[${i}] needs integer vendorId and productId`);
    }
    const device: UsbDeviceId = { vendorId: vendorId as number, productId: productId as number };
    if (serialNumber !== undefined) {
      if (typeof serialNumber !== 'string') return fail(`usbDevices[${i}].serialNumber must be a string`);
      device.serialNumber = serialNumber;
    }
    devices.push(device);
  }
  return ok(devices);
}

function readAi(raw: unknown): Result<ShellState['ai']> {
  const base = defaultState().ai;
  if (raw === undefined) return ok(base);
  if (!isRecord(raw)) return fail('ai must be an object');
  const provider = raw['provider'] === undefined ? base.provider : raw['provider'];
  if (typeof provider !== 'string' || !PROVIDERS.includes(provider as AiProvider)) {
    return fail('ai.provider is not a known provider');
  }
  const model = readNullableString(raw['model'], 'ai.model');
  if (!model.ok) return model;
  const ollamaHost = readNullableString(raw['ollamaHost'], 'ai.ollamaHost');
  if (!ollamaHost.ok) return ollamaHost;
  return ok({ provider: provider as AiProvider, model: model.value, ollamaHost: ollamaHost.value });
}

function readBoolean(raw: unknown, fallback: boolean, name: string): Result<boolean> {
  if (raw === undefined) return ok(fallback);
  return typeof raw === 'boolean' ? ok(raw) : fail(`${name} must be a boolean`);
}

/** Reads `app`: missing object or fields fill from defaults, wrong types are rejected. */
function readApp(raw: unknown): Result<AppSettings> {
  const base = defaultAppSettings();
  if (raw === undefined) return ok(base);
  if (!isRecord(raw)) return fail('app must be an object');
  const launch = readBoolean(raw['launchAtLogin'], base.launchAtLogin, 'app.launchAtLogin');
  if (!launch.ok) return launch;
  const restart = readBoolean(raw['autoRestartOnCrash'], base.autoRestartOnCrash, 'app.autoRestartOnCrash');
  if (!restart.ok) return restart;
  const interval = raw['updateCheckInterval'] === undefined ? base.updateCheckInterval : raw['updateCheckInterval'];
  if (typeof interval !== 'string' || !UPDATE_CHECK_INTERVALS.includes(interval as UpdateCheckInterval)) {
    return fail('app.updateCheckInterval must be launch-only, 6h or daily');
  }
  const level = raw['logLevel'] === undefined ? base.logLevel : raw['logLevel'];
  if (typeof level !== 'string' || !LOG_LEVEL_SETTINGS.includes(level as LogLevelSetting)) {
    return fail('app.logLevel is not a known log level');
  }
  let proxy = base.proxy;
  if (raw['proxy'] !== undefined) {
    const rp = raw['proxy'];
    if (!isRecord(rp)) return fail('app.proxy must be an object');
    const https = readNullableString(rp['httpsProxy'], 'app.proxy.httpsProxy');
    if (!https.ok) return https;
    const no = readNullableString(rp['noProxy'], 'app.proxy.noProxy');
    if (!no.ok) return no;
    const httpsChecked = validateProxyUrl(https.value);
    if (!httpsChecked.ok) return fail(`app.proxy.httpsProxy: ${httpsChecked.reason}`);
    const noChecked = validateNoProxy(no.value);
    if (!noChecked.ok) return fail(`app.proxy.noProxy: ${noChecked.reason}`);
    proxy = { httpsProxy: httpsChecked.value, noProxy: noChecked.value };
  }
  const remote = readNullableString(raw['engineRemoteUrl'], 'app.engineRemoteUrl');
  if (!remote.ok) return remote;
  const remoteChecked = validateEngineRemoteUrl(remote.value);
  if (!remoteChecked.ok) return fail(`app.engineRemoteUrl: ${remoteChecked.reason}`);
  return ok({
    launchAtLogin: launch.value,
    autoRestartOnCrash: restart.value,
    updateCheckInterval: interval as UpdateCheckInterval,
    logLevel: level as LogLevelSetting,
    proxy,
    engineRemoteUrl: remoteChecked.value,
  });
}

function readScalars(rec: Record<string, unknown>, defaults: ShellState): Result<ShellState> {
  const state = defaults;
  if (rec['schemaVersion'] !== 1) return fail('schemaVersion must be 1');

  const channel = rec['channel'] === undefined ? defaults.channel : rec['channel'];
  if (typeof channel !== 'string' || !CHANNELS.includes(channel as Channel)) {
    return fail('channel must be stable, candidate or upstream');
  }
  state.channel = channel as Channel;

  const remoteUrl = rec['remoteUrl'] === undefined ? defaults.remoteUrl : rec['remoteUrl'];
  if (typeof remoteUrl !== 'string' || remoteUrl.length === 0) {
    return fail('remoteUrl must be a non-empty string');
  }
  state.remoteUrl = remoteUrl;

  const onLaunch = rec['updateCheckOnLaunch'] === undefined ? defaults.updateCheckOnLaunch : rec['updateCheckOnLaunch'];
  if (typeof onLaunch !== 'boolean') return fail('updateCheckOnLaunch must be a boolean');
  state.updateCheckOnLaunch = onLaunch;

  for (const key of NULLABLE_STRING_KEYS) {
    const r = readNullableString(rec[key], key);
    if (!r.ok) return r;
    state[key] = r.value;
  }
  return ok(state);
}

/**
 * Validates an unknown value as ShellState: drops unknown keys, fills missing fields from
 * defaults, rejects wrong types and any schemaVersion other than 1.
 */
export function validateState(
  value: unknown,
): { ok: true; state: ShellState } | { ok: false; reason: string } {
  if (!isRecord(value)) return fail('state must be a JSON object');
  const scalars = readScalars(value, defaultState());
  if (!scalars.ok) return scalars;
  const state = scalars.value;

  const port = readLastPort(value['lastPort']);
  if (!port.ok) return port;
  const bounds = readBounds(value['mainWindowBounds']);
  if (!bounds.ok) return bounds;
  const usb = readUsbDevices(value['usbDevices']);
  if (!usb.ok) return usb;
  const ai = readAi(value['ai']);
  if (!ai.ok) return ai;
  const app = readApp(value['app']);
  if (!app.ok) return app;

  state.lastPort = port.value;
  state.mainWindowBounds = bounds.value;
  state.usbDevices = usb.value;
  state.ai = ai.value;
  state.app = app.value;
  return { ok: true, state };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

async function backUpBadFile(file: string, backupFile: string, log: StateLog): Promise<void> {
  try {
    await mkdir(dirname(backupFile), { recursive: true });
    await copyFile(file, backupFile);
  } catch (err) {
    log.warn(`could not back up bad state file to ${backupFile}: ${errorMessage(err)}`);
  }
}

/** What {@link loadStateReport} found. `reset` is true when a damaged file was replaced by defaults. */
export interface LoadStateReport {
  state: ShellState;
  reset: boolean;
  /** Names of settings recovered from the damaged file (channel, port, AI choice, app settings). */
  salvaged: string[];
}

/**
 * Best effort recovery from a damaged state file: the pieces that matter to the user (the channel,
 * the pinned port that browser state is keyed to, the summary provider and the App settings) are
 * validated one by one and kept when they are fine. Unparseable text falls back to a pattern match
 * for the channel and port. Never throws.
 */
function salvageState(text: string): { state: ShellState; salvaged: string[] } {
  const state = defaultState();
  const salvaged: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = undefined;
  }
  if (isRecord(parsed)) {
    const ch = parsed['channel'];
    if (typeof ch === 'string' && CHANNELS.includes(ch as Channel)) {
      state.channel = ch as Channel;
      salvaged.push('update channel');
    }
    const port = readLastPort(parsed['lastPort']);
    if (port.ok && port.value !== null) {
      state.lastPort = port.value;
      salvaged.push('port');
    }
    if (parsed['ai'] !== undefined) {
      const ai = readAi(parsed['ai']);
      if (ai.ok) {
        state.ai = ai.value;
        salvaged.push('summary provider');
      }
    }
    if (parsed['app'] !== undefined) {
      const app = readApp(parsed['app']);
      if (app.ok) {
        state.app = app.value;
        salvaged.push('App settings');
      }
    }
  } else {
    const ch = /"channel"\s*:\s*"(stable|candidate|upstream)"/.exec(text);
    if (ch?.[1] !== undefined) {
      state.channel = ch[1] as Channel;
      salvaged.push('update channel');
    }
    const port = /"lastPort"\s*:\s*(\d{1,5})\b/.exec(text);
    const n = port?.[1] === undefined ? NaN : Number(port[1]);
    if (Number.isInteger(n) && n > 0 && n <= 65535) {
      state.lastPort = n;
      salvaged.push('port');
    }
  }
  return { state, salvaged };
}

/**
 * Loads state from disk. Missing file gives defaults; unreadable or invalid content is copied
 * to backupFile, a warning is logged and defaults (plus whatever could be salvaged) are returned.
 */
export async function loadStateReport(file: string, backupFile: string, log: StateLog): Promise<LoadStateReport> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (isNotFound(err)) {
      log.info(`no state file at ${file}; using defaults`);
      return { state: defaultState(), reset: false, salvaged: [] };
    }
    log.warn(`state file unreadable (${errorMessage(err)}); using defaults`);
    await backUpBadFile(file, backupFile, log);
    return { state: defaultState(), reset: true, salvaged: [] };
  }

  let reason: string;
  try {
    const result = validateState(JSON.parse(text) as unknown);
    if (result.ok) return { state: result.state, reset: false, salvaged: [] };
    reason = result.reason;
  } catch (err) {
    reason = `invalid JSON: ${errorMessage(err)}`;
  }
  const { state, salvaged } = salvageState(text);
  log.warn(
    `state file rejected (${reason}); backed up to ${backupFile}; using defaults${salvaged.length > 0 ? ` and keeping ${salvaged.join(', ')}` : ''}`,
  );
  await backUpBadFile(file, backupFile, log);
  return { state, reset: true, salvaged };
}

/** {@link loadStateReport} without the report. */
export async function loadState(file: string, backupFile: string, log: StateLog): Promise<ShellState> {
  return (await loadStateReport(file, backupFile, log)).state;
}

/**
 * Reads only `app.logLevel` from state.json, early in boot (before the logger
 * exists). Anything unreadable or invalid yields 'default'; this never throws.
 */
export async function readLogLevelSetting(file: string): Promise<LogLevelSetting> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
    if (isRecord(raw) && isRecord(raw['app'])) {
      const level = raw['app']['logLevel'];
      if (typeof level === 'string' && LOG_LEVEL_SETTINGS.includes(level as LogLevelSetting)) {
        return level as LogLevelSetting;
      }
    }
  } catch {
    // Missing or corrupt: loadState deals with it later.
  }
  return 'default';
}

/** Atomically writes state: temp file (0600) in the same dir, fsync, rename over the target. */
export async function saveState(file: string, state: ShellState): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
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

/** Returns a new validated state with the patch applied; throws if the result is invalid. */
export function updateState(state: ShellState, patch: Partial<ShellState>): ShellState {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const result = validateState({ ...state, ...defined });
  if (!result.ok) throw new Error(`invalid state update: ${result.reason}`);
  return result.state;
}
