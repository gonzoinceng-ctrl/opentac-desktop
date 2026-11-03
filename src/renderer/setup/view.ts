/**
 * Pure render helpers for the setup renderer. No DOM, no Node builtins, no electron:
 * everything here is a function of its arguments so it can be unit tested in a node environment.
 */
import type { ActionName, Disclosure, Phase, PublicState, UsbDevicePublic } from '../../shared/ipc.js';
import { isExternalUrl } from '../../shared/ipc.js';
import type { Channel } from '../../shared/types.js';

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
