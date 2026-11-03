/**
 * Pure render helpers for the setup renderer. No DOM, no Node builtins, no electron:
 * everything here is a function of its arguments so it can be unit tested in a node environment.
 */
import { ENGINE_KEY_CATALOG } from '../../shared/engineKeyCatalog.js';
import type { EngineKeyTier } from '../../shared/engineKeyCatalog.js';
import { formatBoolean, parseBoolean } from '../../shared/engineSettingsCatalog.js';
import type { CctvRegion, SettingDef, SettingGroup } from '../../shared/engineSettingsCatalog.js';
import type {
  ActionName,
  Disclosure,
  EngineKeyRow,
  EngineKeySaveResult,
  EngineKeysPublic,
  EngineSettingsPublic,
  Phase,
  PublicState,
  SaveEngineSettingsResult,
  UsbDevicePublic,
} from '../../shared/ipc.js';
import { isExternalUrl } from '../../shared/ipc.js';
import type { Channel, LogLevelSetting, UpdateCheckInterval } from '../../shared/types.js';

/** The attribution line required on the setup window, About panel, README and website. */
export const ATTRIBUTION =
  "OpenTac is an unofficial desktop app for God's Eye View by Bilawal Sidhu (MIT)";

export const LICENSES_URL = 'https://opentac.icu/licenses';

export const VOICE_CAVEAT =
  "Voice control uses OpenAI or Gemini — configure those in the engine's POWER UP panel.";
export const KEY_LOCK_CAVEAT =
  "While a non-OpenAI summary provider is active, the engine's OpenAI key row is locked; switch back to OpenAI to edit it.";

export type PanelId = 'progress' | 'disclosure' | 'crash' | 'error' | 'about' | 'preferences';

/** Subset of PublicState that decides which panel is visible. */
export type PanelInput = Pick<
  PublicState,
  'phase' | 'preferencesOpen' | 'aboutOpen' | 'disclosure' | 'error'
>;

/**
 * Which panel to show. Preferences and About are overlays that win over the phase panel
 * (Preferences first). A phase panel whose payload is missing falls back to progress so the
 * window is never blank.
 */
export function panelForPhase(state: PanelInput): PanelId {
  if (state.preferencesOpen) return 'preferences';
  if (state.aboutOpen) return 'about';
  switch (state.phase) {
    case 'DISCLOSING':
      return state.disclosure === null ? 'progress' : 'disclosure';
    case 'CRASHED':
      return 'crash';
    case 'ERROR':
      return state.error === null ? 'progress' : 'error';
    case 'BOOT':
    case 'CLONING':
    case 'INSTALLING':
    case 'STARTING':
    case 'RUNNING':
    case 'CHECKING':
    case 'UPDATING':
    case 'RESTARTING':
    case 'ROLLING_BACK':
      return 'progress';
  }
}

/**
 * The shell actions that close whatever overlay is showing. The shell has one close action,
 * 'closePreferences', which clears Preferences but leaves About open; 'openPreferences' clears
 * About. So closing About runs the pair, which leaves both closed (and hides the window when the
 * app is running). Closing Preferences, or any state with no About open, is a single action.
 */
export function closeOverlayActions(
  state: Pick<PublicState, 'preferencesOpen' | 'aboutOpen'>,
): ActionName[] {
  if (state.aboutOpen && !state.preferencesOpen) return ['openPreferences', 'closePreferences'];
  return ['closePreferences'];
}

/** A plain-sentence title for the progress panel. */
export function phaseTitle(phase: Phase): string {
  switch (phase) {
    case 'BOOT':
      return 'Getting ready';
    case 'CLONING':
      return "Downloading God's Eye View";
    case 'INSTALLING':
      return 'Installing dependencies';
    case 'STARTING':
      return 'Starting the engine';
    case 'RUNNING':
      return 'God’s Eye View is running';
    case 'CRASHED':
      return 'The engine stopped unexpectedly';
    case 'CHECKING':
      return 'Checking for engine updates';
    case 'DISCLOSING':
      return 'An engine update is available';
    case 'UPDATING':
      return 'Updating the engine';
    case 'RESTARTING':
      return 'Restarting the engine';
    case 'ROLLING_BACK':
      return 'Going back to the previous version';
    case 'ERROR':
      return 'Something went wrong';
  }
}

/** Honest, plain explanation shown under the progress bar. Null when there is nothing to add. */
export function phaseNote(phase: Phase): string | null {
  switch (phase) {
    case 'CLONING':
      return "First launch downloads the God's Eye View source (~200 MB) and its dependencies (~400 MB) from GitHub and npm. This happens once and can take several minutes on a slow connection.";
    case 'INSTALLING':
      return 'Installing the dependencies (~400 MB) with npm. The first time can take a few minutes; afterwards this only runs when the dependencies change.';
    case 'STARTING':
      return 'The first start after an install can take up to a minute while the engine prepares its browser bundle.';
    case 'UPDATING':
      return 'Keep OpenTac open. If anything fails, the previous version is restored automatically.';
    case 'ROLLING_BACK':
      return 'The update did not work, so OpenTac is restoring the version that was running before.';
    case 'RESTARTING':
      return 'The engine is restarting. The map window comes back when it is ready.';
    default:
      return null;
  }
}

const ACTION_LABELS: Readonly<Record<ActionName, string>> = {
  retry: 'Retry',
  confirmUpdate: 'Update',
  laterUpdate: 'Later',
  skipUpdate: 'Skip this version',
  resetAndUpdate: 'Reset and update',
  restartServer: 'Restart',
  reinstall: 'Reinstall dependencies',
  rollback: 'Go back to the previous version',
  changePort: 'Use a different port',
  checkForUpdates: 'Check for engine updates',
  checkForAppUpdates: 'Check for OpenTac updates',
  openPreferences: 'Open Preferences',
  closePreferences: 'Close',
  showLogs: 'Show Logs',
  openDataFolder: 'Open data folder',
  forgetUsbDevices: 'Forget remembered USB devices',
  resetCheckout: 'Reset engine files',
  quit: 'Quit OpenTac',
};

/** Human label for an action button. */
export function labelForAction(name: ActionName): string {
  return ACTION_LABELS[name];
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** 1024-based, one decimal from KB upward (e.g. 1.5 KB, 400 MB). Invalid input yields "0 B". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < UNITS.length - 1) {
    value /= 1024;
    i += 1;
  }
  if (i === 0) return `${Math.round(value)} B`;
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${UNITS[i]}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** ISO-8601 date or timestamp → "3 Nov 2026" (UTC, locale independent). Unparseable input is returned as is. */
export function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "1 commit" / "12 commits". */
export function formatCommitCount(n: number, truncated = false): string {
  const base = n === 1 ? '1 commit' : `${n} commits`;
  return truncated ? `${base} (list shortened)` : base;
}

/** One-line summary above the commit list, e.g. "From v0.3.0 to stable-2026.11.01: 12 commits". */
export function formatDisclosureSummary(d: Disclosure): string {
  return `From ${d.fromLabel} to ${d.toLabel}: ${formatCommitCount(d.commitCount, d.truncated)}`;
}

/** Plain name of a channel for headings and summaries. */
export function channelName(channel: Channel): string {
  switch (channel) {
    case 'stable':
      return 'Stable';
    case 'candidate':
      return 'Canary';
    case 'upstream':
      return 'Raw upstream';
  }
}

export const LOCKFILE_NOTE = 'Dependencies will be reinstalled (~1–3 min).';
export const UNTESTED_BANNER_UPSTREAM =
  'Untested: this is raw upstream code that OpenTac has not run through its checks. It may not start.';
export const UNTESTED_BANNER_CANDIDATE =
  'Untested: this is a canary build that is still being checked by OpenTac. It may break.';

/** Text for the yellow banner on non-stable channels; null when the update is tested. */
export function untestedBanner(d: Disclosure): string | null {
  if (!d.untested) return null;
  return d.channel === 'candidate' ? UNTESTED_BANNER_CANDIDATE : UNTESTED_BANNER_UPSTREAM;
}

/** The gate line for stable updates, as parts so the renderer can make the run a link. */
export interface GateLine {
  before: string;
  link: { text: string; url: string } | null;
  after: string;
}

/**
 * "Tested by OpenTac on <date>, gate run <link>, canary N days". Null when the update is untested
 * or no gate information is attached. Missing pieces are left out rather than invented.
 */
export function formatGateLine(d: Disclosure): GateLine | null {
  if (d.untested || d.gate === null) return null;
  const { gateRun, canaryDays, testedOn } = d.gate;
  const date = formatDate(testedOn);
  let before = date === '' ? 'Tested by OpenTac' : `Tested by OpenTac on ${date}`;
  let link: GateLine['link'] = null;
  if (gateRun !== null && gateRun !== '') {
    if (isExternalUrl(gateRun)) {
      before += ', gate run ';
      link = { text: 'view gate run', url: gateRun };
    } else {
      before += `, gate run ${gateRun}`;
    }
  }
  let after = '';
  if (canaryDays !== null && canaryDays !== '') {
    const n = Number(canaryDays);
    after = Number.isFinite(n) ? `, canary ${n} ${n === 1 ? 'day' : 'days'}` : `, canary ${canaryDays}`;
  }
  return { before, link, after };
}

/** Plain-text version of the gate line (used for tests and screen-reader fallbacks). */
export function gateLineText(d: Disclosure): string | null {
  const g = formatGateLine(d);
  if (g === null) return null;
  return `${g.before}${g.link === null ? '' : g.link.text}${g.after}`;
}

/** Dirty files as "Changed: path" / "New: path" lines. */
export function dirtyFileLines(d: Disclosure): string[] {
  return [...d.dirty.modified.map((f) => `Changed: ${f}`), ...d.dirty.untracked.map((f) => `New: ${f}`)];
}

/** Whether the checkout has local changes or the update moves backwards. */
export function needsResetPath(d: Disclosure): boolean {
  return d.needsReset || d.dirty.modified.length > 0 || d.dirty.untracked.length > 0;
}

/** Buttons for the disclosure panel, primary first. */
export function disclosureButtons(d: Disclosure): ActionName[] {
  if (d.blockedByShell) return ['checkForAppUpdates', 'laterUpdate'];
  return [needsResetPath(d) ? 'resetAndUpdate' : 'confirmUpdate', 'laterUpdate', 'skipUpdate'];
}

/** Explanation shown above the buttons when the update cannot be applied directly. */
export function disclosureBlockNote(d: Disclosure): string | null {
  if (d.blockedByShell) {
    return d.minShell === null
      ? 'Update OpenTac first. This engine update needs a newer version of the app.'
      : `Update OpenTac first. This engine update needs OpenTac ${d.minShell} or newer.`;
  }
  if (d.needsReset && d.dirty.modified.length === 0 && d.dirty.untracked.length === 0) {
    return 'This moves the engine to an older version than the one installed. The engine files will be reset to match; your settings and keys are kept.';
  }
  if (d.dirty.modified.length > 0 || d.dirty.untracked.length > 0) {
    return 'The engine files have local changes. Resetting discards them; your settings and keys are kept.';
  }
  return null;
}

/** Panel heading for the disclosure. */
export function disclosureHeading(d: Disclosure): string {
  if (d.blockedByShell) return 'Update OpenTac first';
  return d.severity === 'security' ? 'A security update is available' : 'An engine update is available';
}

/** Convert a Progress to a bar value. `null` means indeterminate. */
export function progressValue(pct: number | null | undefined): number | null {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return null;
  return Math.min(100, Math.max(0, pct));
}

/** True when a scroll position is within `slack` pixels of the bottom (auto-scroll stays on). */
export function isNearBottom(scrollTop: number, clientHeight: number, scrollHeight: number, slack = 8): boolean {
  return scrollHeight - scrollTop - clientHeight <= slack;
}

/** Short hex like "0bda". */
export function hex4(n: number): string {
  return (n & 0xffff).toString(16).padStart(4, '0');
}

/** "0bda:2838" */
export function formatUsbIds(d: Pick<UsbDevicePublic, 'vendorId' | 'productId'>): string {
  return `${hex4(d.vendorId)}:${hex4(d.productId)}`;
}

/** Title for a picker row. */
export function usbDeviceTitle(d: Pick<UsbDevicePublic, 'productName'>): string {
  return d.productName !== null && d.productName.trim() !== '' ? d.productName : 'Unknown USB device';
}

/** Second line for a picker row: ids and serial. */
export function usbDeviceDetail(d: UsbDevicePublic): string {
  const serial = d.serialNumber !== null && d.serialNumber !== '' ? `serial ${d.serialNumber}` : 'no serial number';
  return `Vendor ${hex4(d.vendorId)}, product ${hex4(d.productId)}, ${serial}`;
}

/** Move a listbox selection with wrap-around; `count` 0 yields -1. */
export function moveSelection(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta >= 0 ? 0 : count - 1;
  return (((current + delta) % count) + count) % count;
}

// ---------------------------------------------------------------------------
// Preferences tabs
// ---------------------------------------------------------------------------

export type TabName = 'general' | 'channel' | 'keys' | 'ai' | 'engine' | 'app';

/** Tabs in display order with their visible names. */
export const PREFERENCE_TABS: ReadonlyArray<{ id: TabName; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'channel', label: 'Updates' },
  { id: 'keys', label: 'API keys' },
  { id: 'ai', label: 'AI summaries' },
  { id: 'engine', label: 'Engine settings' },
  { id: 'app', label: 'App settings' },
];

/** Where each kind of setting lives, for the General tab. */
export const SETTINGS_MAP: ReadonlyArray<{ tab: TabName; title: string; text: string }> = [
  { tab: 'keys', title: 'API keys', text: "The engine's provider keys, saved in the engine's own .env file. OpenRouter and xAI keys for summaries are kept encrypted by OpenTac." },
  { tab: 'engine', title: 'Engine settings', text: "Models, rate limits, data feeds and camera packs, written to the engine's .env file. Saving restarts the engine." },
  { tab: 'app', title: 'App settings', text: "OpenTac's own behaviour: login item, crash restarts, update timing, logging, proxy and folders." },
  { tab: 'channel', title: 'Updates', text: 'Which engine versions to follow and when to check for updates.' },
  { tab: 'ai', title: 'AI summaries', text: 'Which provider writes the short summary line in the heads-up display.' },
];

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export const ENGINE_KEYS_RESTART_NOTE =
  'Saving a key makes the engine restart itself and reload the page. That is expected, not a crash.';

/** Plain label for a key tier. */
export function keyTierLabel(tier: EngineKeyTier): string {
  switch (tier) {
    case 'free':
      return 'Free key';
    case 'metered':
      return 'Billing account';
    case 'paid':
      return 'Optional paid';
  }
}

export interface KeyRowState {
  kind: 'set' | 'unset' | 'locked';
  /** Visible state text. */
  label: string;
}

/** The state shown on a key row: locked wins over set, which wins over not set. */
export function keyRowState(row: Pick<EngineKeyRow, 'set' | 'lock'>): KeyRowState {
  if (row.lock !== null) return { kind: 'locked', label: 'Locked' };
  return row.set ? { kind: 'set', label: 'Set' } : { kind: 'unset', label: 'Not set' };
}

/** Rows can be edited only against a live engine and only when nothing locks them. */
export function keyRowEditable(row: Pick<EngineKeyRow, 'lock'>, list: Pick<EngineKeysPublic, 'source'>): boolean {
  return list.source === 'engine' && row.lock === null;
}

/** Splits the list into the normal rows and the ones the engine hides ("Advanced"). */
export function splitKeyRows(list: Pick<EngineKeysPublic, 'keys'>): { main: EngineKeyRow[]; advanced: EngineKeyRow[] } {
  return {
    main: list.keys.filter((k) => !k.advanced),
    advanced: list.keys.filter((k) => k.advanced),
  };
}

/** "3 of 10 keys are set." */
export function keysSummary(list: Pick<EngineKeysPublic, 'setCount' | 'total'>): string {
  return `${list.setCount} of ${list.total} keys are set.`;
}

/** The accessible label of one value box of a key row. */
export function keyInputLabel(row: Pick<EngineKeyRow, 'title' | 'envVars'>, envVar: string): string {
  return row.envVars.length > 1 ? `${row.title} ${envVar}` : `${row.title} key (${envVar})`;
}

const BRAND_WORDS: Readonly<Record<string, string>> = {
  AISSTREAM: 'AISStream',
  OPENAI: 'OpenAI',
  OPENSKY: 'OpenSky',
  TOMTOM: 'TomTom',
  NASA: 'NASA',
  FIRMS: 'FIRMS',
  ION: 'ion',
  '—': '—',
};

/** "NASA FIRMS" -> "NASA FIRMS", "AISSTREAM" -> "AISStream", "GOOGLE MAPS" -> "Google Maps". */
export function keyTitle(title: string): string {
  return title
    .split(' ')
    .map((w) => BRAND_WORDS[w] ?? w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

/** Message under a row after a save or clear attempt. */
export function keyResultMessage(result: EngineKeySaveResult, what: 'saved' | 'removed'): string {
  if (result.ok) {
    return what === 'saved'
      ? 'Key saved. The engine is restarting itself; the page reloads in a moment.'
      : 'Key removed. The engine is restarting itself; the page reloads in a moment.';
  }
  return result.message ?? 'The key was not saved.';
}

/** Env var names in the static catalogue, for the "no list yet" fallback and tests. */
export function catalogKeyIds(): string[] {
  return ENGINE_KEY_CATALOG.map((e) => e.id);
}

// ---------------------------------------------------------------------------
// Engine settings
// ---------------------------------------------------------------------------

export const ENGINE_SETTINGS_RESTART_NOTE = 'Saving restarts the engine to apply the settings.';
export const ENGINE_SETTINGS_RESTARTING = 'Restarting the engine to apply settings…';

export type FieldKind = 'text' | 'number' | 'select' | 'password' | 'checkbox';

export interface SelectOption {
  value: string;
  label: string;
}

/** Everything the renderer needs to draw one engine settings field. */
export interface SettingFieldModel {
  key: string;
  label: string;
  description: string;
  warning: string | null;
  kind: FieldKind;
  /** Current value for text, number, select and (as 'true'/'false') checkbox fields. */
  value: string;
  /** True when the variable has an active assignment in .env (for secrets: a non-empty one). */
  isSet: boolean;
  placeholder: string;
  options: SelectOption[];
  min: number | null;
  max: number | null;
  step: string | null;
  /** The "turn this off" checkbox of fields where an empty value is meaningful. */
  canDisable: boolean;
  disabled: boolean;
  secret: boolean;
}

function defaultLabel(def: SettingDef): string {
  if (def.type === 'boolean') return def.default === 'true' || def.default === '1' ? 'Default (on)' : 'Default (off)';
  return def.default !== undefined ? `Default: ${def.default}` : 'Not set';
}

/** The model of one field, from its catalogue entry and the current `.env` values. */
export function settingFieldModel(
  def: SettingDef,
  current: Pick<EngineSettingsPublic, 'values' | 'set'>,
): SettingFieldModel {
  const isSet = current.set[def.key] === true;
  const raw = current.values[def.key] ?? '';
  const base = {
    key: def.key,
    label: def.label,
    description: def.description,
    warning: def.warning ?? null,
    isSet,
    min: def.min ?? null,
    max: def.max ?? null,
    step: def.type === 'number' ? (def.integer === true ? '1' : 'any') : null,
    canDisable: def.emptyDisables === true,
    disabled: false,
    secret: def.type === 'secret',
  };
  switch (def.type) {
    case 'boolean': {
      const parsed = isSet ? parseBoolean(raw) : null;
      return {
        ...base,
        kind: 'select',
        value: parsed === null ? '' : parsed ? 'on' : 'off',
        placeholder: '',
        options: [
          { value: '', label: defaultLabel(def) },
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ],
      };
    }
    case 'enum':
      return {
        ...base,
        kind: 'select',
        value: isSet ? raw : '',
        placeholder: '',
        options: [
          { value: '', label: defaultLabel(def) },
          ...(def.options ?? []).map((o) => ({ value: o, label: o })),
        ],
      };
    case 'secret':
      return {
        ...base,
        kind: 'password',
        value: '',
        placeholder: isSet ? 'Saved. Type to replace it.' : 'Not set',
        options: [],
      };
    case 'number':
      return {
        ...base,
        kind: 'number',
        value: isSet ? raw : '',
        placeholder: def.default ?? '',
        options: [],
      };
    default:
      return {
        ...base,
        kind: 'text',
        value: isSet ? raw : '',
        placeholder: def.placeholder ?? def.default ?? '',
        options: [],
      };
  }
}

/** Models for the plain (non-region) fields of a group. */
export function groupFieldModels(
  group: Pick<SettingGroup, 'settings'>,
  current: Pick<EngineSettingsPublic, 'values' | 'set'>,
): SettingFieldModel[] {
  return group.settings.map((def) => settingFieldModel(def, current));
}

/** One CCTV region as a table row. */
export interface RegionRowModel {
  id: string;
  label: string;
  note: string | null;
  enabledKey: string | null;
  enabled: boolean;
  maxKey: string | null;
  max: string;
  maxPlaceholder: string;
  maxMin: number;
  maxMax: number;
  urlKey: string | null;
  url: string;
  districtsKey: string | null;
  districts: string;
  districtsPlaceholder: string;
}

/** Row models for the region table; `enabled` is the effective state (value, else default). */
export function regionRowModels(
  regions: readonly CctvRegion[],
  current: Pick<EngineSettingsPublic, 'values' | 'set'>,
): RegionRowModel[] {
  return regions.map((r) => {
    const setEnabled = r.enabledKey !== null && current.set[r.enabledKey] === true;
    const parsed = r.enabledKey !== null && setEnabled ? parseBoolean(current.values[r.enabledKey] ?? '') : null;
    const maxSet = r.maxKey !== null && current.set[r.maxKey] === true;
    const urlSet = r.urlKey !== null && current.set[r.urlKey] === true;
    const distSet = r.districtsKey !== null && current.set[r.districtsKey] === true;
    return {
      id: r.id,
      label: r.label,
      note: r.note,
      enabledKey: r.enabledKey,
      enabled: parsed ?? r.enabledDefault,
      maxKey: r.maxKey,
      max: maxSet && r.maxKey !== null ? (current.values[r.maxKey] ?? '') : '',
      maxPlaceholder: r.maxDefault === null ? '' : String(r.maxDefault),
      maxMin: r.maxMin,
      maxMax: r.maxMax,
      urlKey: r.urlKey,
      url: urlSet && r.urlKey !== null ? (current.values[r.urlKey] ?? '') : '',
      districtsKey: r.districtsKey,
      districts: distSet && r.districtsKey !== null ? (current.values[r.districtsKey] ?? '') : '',
      districtsPlaceholder: r.districtsDefault ?? '',
    };
  });
}

/** What the user typed into one field. `off` is the "turn this off" checkbox. */
export interface FieldInput {
  value: string;
  off?: boolean;
}

/**
 * Builds the patch for a Save button: only fields that differ from what is stored. Empty text on
 * a stored setting removes it (null); a secret is only sent when something was typed; the
 * "turn off" checkbox writes an empty assignment where upstream defines that as "off" and
 * unchecking it (with no text) removes that assignment again.
 */
export function buildSettingsPatch(
  defs: readonly SettingDef[],
  regions: readonly CctvRegion[],
  current: Pick<EngineSettingsPublic, 'values' | 'set'>,
  inputs: Readonly<Record<string, FieldInput | undefined>>,
): Record<string, string | null> {
  const patch: Record<string, string | null> = {};
  const byKey = new Map<string, SettingDef>();
  for (const d of defs) byKey.set(d.key, d);

  const textLike = (key: string, input: FieldInput, emptyDisables: boolean): void => {
    const isSet = current.set[key] === true;
    const stored = current.values[key] ?? '';
    if (emptyDisables && input.off === true) {
      if (!(isSet && stored === '')) patch[key] = '';
      return;
    }
    const typed = input.value.trim();
    if (typed === '') {
      if (isSet) patch[key] = null;
      return;
    }
    if (!isSet || typed !== stored) patch[key] = typed;
  };

  for (const def of defs) {
    const input = inputs[def.key];
    if (input === undefined) continue;
    const isSet = current.set[def.key] === true;
    if (def.type === 'secret') {
      if (input.value !== '') patch[def.key] = input.value;
    } else if (def.type === 'boolean') {
      const typed = input.value;
      if (typed === '') {
        if (isSet) patch[def.key] = null;
      } else {
        const want = typed === 'on';
        const had = isSet ? parseBoolean(current.values[def.key] ?? '') : null;
        if (had !== want) patch[def.key] = formatBoolean(def, want);
      }
    } else if (def.type === 'enum') {
      const typed = input.value;
      if (typed === '') {
        if (isSet) patch[def.key] = null;
      } else if (!isSet || typed !== current.values[def.key]) {
        patch[def.key] = typed;
      }
    } else {
      textLike(def.key, input, def.emptyDisables === true);
    }
  }

  for (const r of regions) {
    if (r.enabledKey !== null) {
      const input = inputs[r.enabledKey];
      if (input !== undefined) {
        const isSet = current.set[r.enabledKey] === true;
        const stored = isSet ? parseBoolean(current.values[r.enabledKey] ?? '') : null;
        const effective = stored ?? r.enabledDefault;
        const want = input.value === 'true';
        if (want !== effective) patch[r.enabledKey] = formatBoolean({}, want);
      }
    }
    if (r.maxKey !== null) {
      const input = inputs[r.maxKey];
      if (input !== undefined) textLike(r.maxKey, input, false);
    }
    if (r.urlKey !== null) {
      const input = inputs[r.urlKey];
      if (input !== undefined) textLike(r.urlKey, input, false);
    }
    if (r.districtsKey !== null) {
      const input = inputs[r.districtsKey];
      if (input !== undefined) textLike(r.districtsKey, input, true);
    }
  }
  return patch;
}

/** The sentence shown under a group's Save button after a save attempt. */
export function settingsResultMessage(result: SaveEngineSettingsResult): string {
  if (result.ok) return result.message ?? (result.restarting ? ENGINE_SETTINGS_RESTARTING : 'Saved.');
  const first = Object.entries(result.invalid)[0];
  if (first !== undefined) return `${first[1]} (${first[0]})`;
  return result.message ?? 'The settings were not saved.';
}

// ---------------------------------------------------------------------------
// App settings
// ---------------------------------------------------------------------------

export const UPDATE_INTERVAL_OPTIONS: ReadonlyArray<{ value: UpdateCheckInterval; label: string }> = [
  { value: 'launch-only', label: 'Only when OpenTac starts' },
  { value: '6h', label: 'Every 6 hours' },
  { value: 'daily', label: 'Once a day' },
];

export const LOG_LEVEL_OPTIONS: ReadonlyArray<{ value: LogLevelSetting; label: string }> = [
  { value: 'default', label: 'Default' },
  { value: 'error', label: 'Errors only' },
  { value: 'warn', label: 'Warnings and errors' },
  { value: 'info', label: 'Information' },
  { value: 'debug', label: 'Everything (debug)' },
];

export const APP_NEXT_LAUNCH_NOTE = 'Takes effect the next time OpenTac starts.';
export const PROXY_NOTE =
  'Used for git and npm right away, and for the engine the next time it starts. Addresses with a user name or password are not accepted.';
export const ENGINE_REMOTE_NOTE = 'Only change this to point at your own mirror; the default is the OpenTac mirror.';

/** The "Reset engine files" action only does something while the app shows an error. */
export function resetEngineFilesEnabled(phase: Phase): boolean {
  return phase === 'ERROR';
}

/** The Reinstall action works from a running, crashed or errored engine. */
export function reinstallEnabled(phase: Phase): boolean {
  return phase === 'RUNNING' || phase === 'CRASHED' || phase === 'ERROR';
}
