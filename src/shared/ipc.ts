/**
 * Renderer-facing IPC contract shared by main, preloads and the setup renderer.
 * This file is bundled into sandboxed preloads: NO Node builtins, NO electron imports.
 */
import { isAppSettingsPatch } from './appSettings.js';
import type { AppSettingsPatch } from './appSettings.js';
import { isEngineKeyValue } from './engineKeyCatalog.js';
import type { EngineKeyTier } from './engineKeyCatalog.js';
import type { AiProvider, AppSettings, Channel } from './types.js';

export { isAppSettingsPatch };
export type { AppSettingsPatch };

/** Controller phases (docs/SHELL-DESIGN.md §2). */
export type Phase =
  | 'BOOT'
  | 'CLONING'
  | 'INSTALLING'
  | 'STARTING'
  | 'RUNNING'
  | 'CRASHED'
  | 'CHECKING'
  | 'DISCLOSING'
  | 'UPDATING'
  | 'RESTARTING'
  | 'ROLLING_BACK'
  | 'ERROR';

export const PHASES: readonly Phase[] = [
  'BOOT',
  'CLONING',
  'INSTALLING',
  'STARTING',
  'RUNNING',
  'CRASHED',
  'CHECKING',
  'DISCLOSING',
  'UPDATING',
  'RESTARTING',
  'ROLLING_BACK',
  'ERROR',
];

/** Buttons the setup window may show; each maps to an `action()` name. */
export type ActionName =
  | 'retry'
  | 'confirmUpdate'
  | 'laterUpdate'
  | 'skipUpdate'
  | 'resetAndUpdate'
  | 'restartServer'
  | 'reinstall'
  | 'rollback'
  | 'changePort'
  | 'checkForUpdates'
  | 'checkForAppUpdates'
  | 'openPreferences'
  | 'closePreferences'
  | 'showLogs'
  | 'openDataFolder'
  | 'forgetUsbDevices'
  | 'resetCheckout'
  | 'quit';

export const ACTION_NAMES: readonly ActionName[] = [
  'retry',
  'confirmUpdate',
  'laterUpdate',
  'skipUpdate',
  'resetAndUpdate',
  'restartServer',
  'reinstall',
  'rollback',
  'changePort',
  'checkForUpdates',
  'checkForAppUpdates',
  'openPreferences',
  'closePreferences',
  'showLogs',
  'openDataFolder',
  'forgetUsbDevices',
  'resetCheckout',
  'quit',
];

/** A user-facing error: plain sentences, never a stack trace (stacks go to the log). */
export interface UserError {
  /** Stable machine code, e.g. 'NETWORK', 'DISK_SPACE', 'PORT_IN_USE', 'NPM_FAILED'. */
  code: string;
  title: string;
  message: string;
  /** The raw underlying error line (redacted), shown small under the message. */
  detail: string | null;
  actions: ActionName[];
}

export interface DisclosureCommit {
  sha: string;
  short: string;
  subject: string;
  author: string;
  date: string;
}

/** Everything the user sees before confirming an engine update (brief 01 §5, 08 §4). */
export interface Disclosure {
  remote: string;
  channel: Channel;
  fromCommit: string;
  toCommit: string;
  fromLabel: string;
  toLabel: string;
  commitCount: number;
  truncated: boolean;
  commits: DisclosureCommit[];
  diffStat: string;
  lockfileChanged: boolean;
  compareUrl: string | null;
  dirty: { modified: string[]; untracked: string[] };
  needsReset: boolean;
  untested: boolean;
  gate: { gateRun: string | null; canaryDays: string | null; testedOn: string | null } | null;
  minShell: string | null;
  severity: 'normal' | 'security';
  /** Set when minShell > app version: the panel says "Update OpenTac first". */
  blockedByShell: boolean;
  /** For a move to an older version: how many commits are removed (capped at the list limit). */
  removedCommits?: number;
}

export interface Progress {
  pct: number | null;
  label: string;
}

export interface Prefs {
  channel: Channel;
  updateCheckOnLaunch: boolean;
}

export interface AiPrefsPublic {
  provider: AiProvider;
  model: string | null;
  ollamaHost: string | null;
  hasOpenRouterKey: boolean;
  hasXaiKey: boolean;
  /** null until the Keychain has been asked (it is only asked when a key is needed or Preferences opens). */
  encryptionAvailable: boolean | null;
}

export interface EngineInfo {
  commit: string | null;
  short: string | null;
  upstreamTag: string | null;
  stableTag: string | null;
  channel: Channel;
  remote: string;
}

export interface Versions {
  app: string;
  /** True in the installed (packaged) app; false under `electron .`. */
  packaged: boolean;
  electron: string;
  chromium: string;
  bundledNode: string;
  engine: EngineInfo;
  dataDir: string;
}

/** Who supplies an engine key: its own `.env` ('file', editable) or the environment ('external'). */
export type EngineKeyManaged = 'file' | 'external' | null;

/** One row of the engine's key registry, as reported by `GET /api/setup/status` (no values). */
export interface EngineKeyInfo {
  id: string;
  title: string;
  unlocks: string;
  getUrl: string;
  envVars: string[];
  tier: EngineKeyTier;
  clientExposed: boolean;
  set: boolean;
  managed: EngineKeyManaged;
}

/** The parsed status payload of the engine's key setup endpoint. */
export interface EngineKeyStatus {
  keys: EngineKeyInfo[];
  setCount: number;
  total: number;
  store: string;
}

/** Outcome of saving or clearing engine keys. Never carries a value. */
export interface EngineKeySaveResult {
  ok: boolean;
  /** True when the engine accepted the change and restarts itself (the page reloads). */
  restarting: boolean;
  /** Machine code such as 'external', 'unreachable', 'invalid'; null on success. */
  code: string | null;
  /** A plain sentence for the user; null on success. */
  message: string | null;
}

/** A key row as the setup window shows it. */
export interface EngineKeyRow extends EngineKeyInfo {
  /** Why the row cannot be edited, or null. */
  lock: string | null;
  /** True for a row the engine hides from its own panel (shown here under Advanced). */
  advanced: boolean;
}

/** Engine key list for the API keys tab. */
export interface EngineKeysPublic {
  /** 'engine' when read live from the running engine, else 'fallback' from the catalogue and .env. */
  source: 'engine' | 'fallback';
  keys: EngineKeyRow[];
  setCount: number;
  total: number;
  store: string | null;
  /** A plain sentence about where the list came from; null when nothing needs saying. */
  note: string | null;
}

/** Engine settings as stored in `.env`: only catalogue keys; secret values are always ''. */
export interface EngineSettingsPublic {
  values: Record<string, string>;
  /** True per key that has an active assignment (secrets: a non-empty one). */
  set: Record<string, boolean>;
}

/** Outcome of saving engine settings. */
export interface SaveEngineSettingsResult {
  ok: boolean;
  /** True when the engine is restarting to apply the change. */
  restarting: boolean;
  /** Keys that were refused, with a plain sentence each. */
  invalid: Record<string, string>;
  message: string | null;
}

/** What the setup renderer renders. Pushed on every transition and progress tick. */
export interface PublicState {
  phase: Phase;
  progress: Progress | null;
  message: string;
  logTail: string[];
  disclosure: Disclosure | null;
  error: UserError | null;
  port: number | null;
  prefs: Prefs;
  ai: AiPrefsPublic;
  app: AppSettings;
  engineKeys: EngineKeysPublic;
  engineSettings: EngineSettingsPublic;
  versions: Versions | null;
  /** Non-blocking notices (e.g. "Couldn't reach GitHub"), newest last. */
  notices: string[];
  /** True while the Preferences panel should be shown (menu ⌘, or action). */
  preferencesOpen: boolean;
  /** True while the About panel should be shown. */
  aboutOpen: boolean;
  /** True while an update is being rolled back (including the reinstall it needs). */
  rollingBack?: boolean;
}

export interface AiTestResultPublic {
  ok: boolean;
  text: string;
  latencyMs: number;
  finishReason: string | null;
  error: string | null;
}

export interface SetAiPayload {
  provider: AiProvider;
  model: string | null;
  ollamaHost: string | null;
}

export interface SetAiKeyPayload {
  provider: 'openrouter' | 'xai';
  /** Empty string clears the key. */
  key: string;
}

export interface SaveEngineKeyPayload {
  /** Env var name to new value, for example { AISSTREAM_API_KEY: '…' }. Values are never empty. */
  values: Record<string, string>;
}

export interface ClearEngineKeyPayload {
  /** Registry id such as 'aisstream'. */
  id: string;
}

export interface SaveEngineSettingsPayload {
  /** Variable name to new value; null removes the setting (comments the line out). */
  patch: Record<string, string | null>;
}

export interface UsbDevicePublic {
  deviceId: string;
  vendorId: number;
  productId: number;
  productName: string | null;
  serialNumber: string | null;
}

/** ipcMain.handle channel names. Every channel is prefixed so nothing else can collide. */
export const IPC = {
  getVersions: 'opentac:getVersions',
  openExternal: 'opentac:openExternal',
  openLogsFolder: 'opentac:openLogsFolder',
  /** One-way (ipcRenderer.send) from the engine page only: Cesium's render-error overlay appeared. */
  renderError: 'opentac:renderError',
  getState: 'opentac:getState',
  action: 'opentac:action',
  setPrefs: 'opentac:setPrefs',
  setAi: 'opentac:setAi',
  setAiKey: 'opentac:setAiKey',
  testAi: 'opentac:testAi',
  setAppSettings: 'opentac:setAppSettings',
  getEngineKeys: 'opentac:getEngineKeys',
  saveEngineKey: 'opentac:saveEngineKey',
  clearEngineKey: 'opentac:clearEngineKey',
  getEngineSettings: 'opentac:getEngineSettings',
  saveEngineSettings: 'opentac:saveEngineSettings',
  listOllamaModels: 'opentac:listOllamaModels',
  usbPickerList: 'opentac:usbPicker:list',
  usbPickerChoose: 'opentac:usbPicker:choose',
  /** main → setup renderer push */
  stateEvent: 'opentac:state',
  /** main → usb picker push */
  usbPickerEvent: 'opentac:usbPicker:devices',
} as const;

/** Exposed in the main (engine) window as `window.openTac`. */
export interface OpenTacMainApi {
  getVersions(): Promise<Versions>;
  openExternal(url: string): Promise<void>;
  openLogsFolder(): Promise<void>;
}

/** Exposed in the setup window as `window.openTacSetup`. */
export interface OpenTacSetupApi extends OpenTacMainApi {
  getState(): Promise<PublicState>;
  onState(cb: (state: PublicState) => void): () => void;
  action(name: ActionName): Promise<void>;
  setPrefs(patch: Partial<Prefs>): Promise<void>;
  setAi(payload: SetAiPayload): Promise<void>;
  setAiKey(payload: SetAiKeyPayload): Promise<void>;
  testAi(): Promise<AiTestResultPublic>;
  setAppSettings(patch: AppSettingsPatch): Promise<void>;
  getEngineKeys(): Promise<EngineKeysPublic>;
  saveEngineKey(payload: SaveEngineKeyPayload): Promise<EngineKeySaveResult>;
  clearEngineKey(payload: ClearEngineKeyPayload): Promise<EngineKeySaveResult>;
  getEngineSettings(): Promise<EngineSettingsPublic>;
  saveEngineSettings(payload: SaveEngineSettingsPayload): Promise<SaveEngineSettingsResult>;
  listOllamaModels(): Promise<{ models: string[]; error: string | null }>;
}

/** Exposed in the USB picker page as `window.openTacUsb`. */
export interface OpenTacUsbApi {
  list(): Promise<UsbDevicePublic[]>;
  onDevices(cb: (devices: UsbDevicePublic[]) => void): () => void;
  choose(deviceId: string | null): Promise<void>;
}

// ---------------------------------------------------------------------------
// Guards (hand-rolled; used by main before acting on any renderer payload)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True when `v` is one of ACTION_NAMES. */
export function isActionName(v: unknown): v is ActionName {
  return typeof v === 'string' && (ACTION_NAMES as readonly string[]).includes(v);
}

const CHANNELS: readonly string[] = ['stable', 'candidate', 'upstream'];
const PROVIDERS: readonly string[] = ['openai', 'ollama', 'openrouter', 'xai'];

/** Validates a Prefs patch: only known keys with the right types. */
export function isPrefsPatch(v: unknown): v is Partial<Prefs> {
  if (!isRecord(v)) return false;
  for (const [k, val] of Object.entries(v)) {
    if (k === 'channel') {
      if (typeof val !== 'string' || !CHANNELS.includes(val)) return false;
    } else if (k === 'updateCheckOnLaunch') {
      if (typeof val !== 'boolean') return false;
    } else {
      return false;
    }
  }
  return true;
}

/** Validates a SetAiPayload. Model and host are bounded, printable strings or null. */
export function isSetAiPayload(v: unknown): v is SetAiPayload {
  if (!isRecord(v)) return false;
  if (typeof v['provider'] !== 'string' || !PROVIDERS.includes(v['provider'])) return false;
  const model = v['model'];
  const host = v['ollamaHost'];
  const okStr = (s: unknown, max: number): boolean =>
    s === null || (typeof s === 'string' && s.length <= max && !/[\u0000-\u001f]/.test(s));
  if (!okStr(model, 200)) return false;
  if (!okStr(host, 300)) return false;
  if (typeof host === 'string' && host !== '' && !/^https?:\/\/[^\s/@]+(?::\d{1,5})?\/?$/.test(host)) {
    return false;
  }
  return Object.keys(v).every((k) => k === 'provider' || k === 'model' || k === 'ollamaHost');
}

/** Validates a SetAiKeyPayload. Keys are bounded printable strings; empty clears. */
export function isSetAiKeyPayload(v: unknown): v is SetAiKeyPayload {
  if (!isRecord(v)) return false;
  if (v['provider'] !== 'openrouter' && v['provider'] !== 'xai') return false;
  const key = v['key'];
  if (typeof key !== 'string' || key.length > 512 || /[\s\u0000-\u001f]/.test(key)) return false;
  return Object.keys(v).every((k) => k === 'provider' || k === 'key');
}

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Validates a SaveEngineKeyPayload: known-shaped env names, values the engine would accept. */
export function isSaveEngineKeyPayload(v: unknown): v is SaveEngineKeyPayload {
  if (!isRecord(v)) return false;
  if (!Object.keys(v).every((k) => k === 'values')) return false;
  const values = v['values'];
  if (!isRecord(values)) return false;
  const entries = Object.entries(values);
  if (entries.length === 0 || entries.length > 16) return false;
  return entries.every(([name, value]) => ENV_NAME.test(name) && typeof value === 'string' && isEngineKeyValue(value));
}

/** Validates a ClearEngineKeyPayload. */
export function isClearEngineKeyPayload(v: unknown): v is ClearEngineKeyPayload {
  if (!isRecord(v)) return false;
  if (!Object.keys(v).every((k) => k === 'id')) return false;
  return typeof v['id'] === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(v['id']);
}

/** Validates a SaveEngineSettingsPayload shape; the catalogue check happens in the controller. */
export function isSaveEngineSettingsPayload(v: unknown): v is SaveEngineSettingsPayload {
  if (!isRecord(v)) return false;
  if (!Object.keys(v).every((k) => k === 'patch')) return false;
  const patch = v['patch'];
  if (!isRecord(patch)) return false;
  const entries = Object.entries(patch);
  if (entries.length === 0 || entries.length > 200) return false;
  return entries.every(
    ([name, value]) =>
      ENV_NAME.test(name) &&
      (value === null || (typeof value === 'string' && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value))),
  );
}

/** Only https: and mailto: URLs may be handed to the system (brief 01 §7). */
export function isExternalUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 2048) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'mailto:';
  } catch {
    return false;
  }
}

/** Device ids are opaque Chromium strings; bound them. */
export function isUsbChoice(v: unknown): v is string | null {
  return v === null || (typeof v === 'string' && v.length > 0 && v.length <= 256);
}
