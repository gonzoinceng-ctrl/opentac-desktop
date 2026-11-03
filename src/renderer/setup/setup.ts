/**
 * Setup window renderer. Plain TypeScript, no framework.
 * All panels live in index.html; this file only toggles them and fills them in from PublicState.
 * Pure decisions (which panel, what labels) are in view.ts.
 */
import type {
  ActionName,
  AiTestResultPublic,
  Disclosure,
  OpenTacSetupApi,
  PublicState,
  Versions,
} from '../../shared/ipc.js';
import { validateEngineRemoteUrl, validateNoProxy, validateProxyUrl } from '../../shared/appSettings.js';
import { engineKeyValueProblem } from '../../shared/engineKeyCatalog.js';
import { ENGINE_SETTINGS_CATALOG } from '../../shared/engineSettingsCatalog.js';
import type { SettingGroup } from '../../shared/engineSettingsCatalog.js';
import { isExternalUrl, isSetAiKeyPayload, isSetAiPayload } from '../../shared/ipc.js';
import type { EngineKeyRow, EngineKeysPublic } from '../../shared/ipc.js';
import type { Channel, LogLevelSetting, UpdateCheckInterval } from '../../shared/types.js';
import {
  APP_NEXT_LAUNCH_NOTE,
  ENGINE_SETTINGS_RESTART_NOTE,
  LICENSES_URL,
  LOG_LEVEL_OPTIONS,
  PREFERENCE_TABS,
  PROXY_NOTE,
  SETTINGS_MAP,
  UPDATE_INTERVAL_OPTIONS,
  buildSettingsPatch,
  channelName,
  groupFieldModels,
  keyInputLabel,
  keyResultMessage,
  keyRowEditable,
  keyRowState,
  keyTierLabel,
  keyTitle,
  keysSummary,
  regionRowModels,
  reinstallEnabled,
  resetEngineFilesEnabled,
  settingFieldModel,
  settingsResultMessage,
  splitKeyRows,
  closeOverlayActions,
  dirtyFileLines,
  disclosureBlockNote,
  disclosureButtons,
  disclosureHeading,
  formatDate,
  formatDisclosureSummary,
  formatGateLine,
  isNearBottom,
  labelForAction,
  LOCKFILE_NOTE,
  panelForPhase,
  phaseNote,
  phaseTitle,
  progressValue,
  untestedBanner,
} from './view.js';
import type { FieldInput, PanelId, SettingFieldModel, TabName } from './view.js';

declare global {
  interface Window {
    openTacSetup: OpenTacSetupApi;
  }
}

const api: OpenTacSetupApi = window.openTacSetup;

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`Missing element #${id}`);
  return node as T;
}

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Run `fn` only when `key` differs from the last key used on this element (keeps focus stable). */
function whenChanged(node: HTMLElement, key: string, fn: () => void): void {
  if (node.dataset['sig'] === key) return;
  node.dataset['sig'] = key;
  fn();
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function setHidden(node: HTMLElement, hidden: boolean): void {
  if (node.hidden !== hidden) node.hidden = hidden;
}

// ---------------------------------------------------------------------------
// Local state
// ---------------------------------------------------------------------------

let current: PublicState | null = null;
let shownPanel: PanelId | null = null;
let logPaused = false;
let closingOverlay = false;
let aiDirty = false;
const localNotices: string[] = [];
const dismissedNotices = new Set<string>();
const TABS: readonly TabName[] = PREFERENCE_TABS.map((t) => t.id);
let activeTab: TabName = 'general';
const engineDirty = new Set<string>();
let proxyDirty = false;
let remoteDirty = false;

const PANEL_IDS: readonly PanelId[] = ['progress', 'disclosure', 'crash', 'error', 'about', 'preferences'];

function panelEl(id: PanelId): HTMLElement {
  return byId(`panel-${id}`);
}

function reportFailure(what: string, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  localNotices.push(`${what} ${reason}`);
  if (current !== null) render(current);
}

function runAction(name: ActionName): void {
  api.action(name).catch((err: unknown) => {
    reportFailure(`Could not do that (${labelForAction(name)}).`, err);
  });
}

/**
 * Close Preferences or About. Closing About takes two shell actions (see closeOverlayActions), run
 * in order; the intermediate Preferences state is not drawn so the panel does not flash.
 */
function closeOverlay(): void {
  if (current === null) {
    runAction('closePreferences');
    return;
  }
  const names = closeOverlayActions(current);
  closingOverlay = names.length > 1;
  const run = async (): Promise<void> => {
    try {
      for (const name of names) await api.action(name);
    } catch (err: unknown) {
      reportFailure('Could not close that panel.', err);
    } finally {
      closingOverlay = false;
      if (current !== null) render(current);
    }
  };
  void run();
}

function openExternal(url: string): void {
  if (!isExternalUrl(url)) return;
  api.openExternal(url).catch((err: unknown) => {
    reportFailure('Could not open the link.', err);
  });
}

function setButtons(container: HTMLElement, names: readonly ActionName[]): void {
  whenChanged(container, names.join(','), () => {
    container.replaceChildren();
    names.forEach((name, i) => {
      const b = make('button', i === 0 ? 'primary' : undefined, labelForAction(name));
      b.type = 'button';
      b.addEventListener('click', () => {
        runAction(name);
      });
      container.append(b);
    });
  });
}

// ---------------------------------------------------------------------------
// Header and notices
// ---------------------------------------------------------------------------

function engineLabel(v: Versions): string {
  const { engine } = v;
  if (engine.upstreamTag !== null && engine.short !== null) return `${engine.upstreamTag} (${engine.short})`;
  return engine.upstreamTag ?? engine.short ?? 'not installed yet';
}

function renderHeader(state: PublicState): void {
  const v = state.versions;
  setText(
    byId('versions'),
    v === null ? '' : `OpenTac ${v.app} · God's Eye View ${engineLabel(v)}`,
  );
}

function renderNotices(state: PublicState): void {
  const all = [...state.notices, ...localNotices];
  for (const text of [...dismissedNotices]) {
    if (!all.includes(text)) dismissedNotices.delete(text);
  }
  const visible = all.filter((n) => !dismissedNotices.has(n));
  const host = byId('notices');
  whenChanged(host, visible.join('\u0000'), () => {
    host.replaceChildren();
    for (const text of visible) {
      const row = make('div', 'notice');
      row.append(make('span', undefined, text));
      const dismiss = make('button', undefined, 'Dismiss');
      dismiss.type = 'button';
      dismiss.setAttribute('aria-label', `Dismiss notice: ${text}`);
      dismiss.addEventListener('click', () => {
        dismissedNotices.add(text);
        const i = localNotices.indexOf(text);
        if (i >= 0) localNotices.splice(i, 1);
        if (current !== null) render(current);
      });
      row.append(dismiss);
      host.append(row);
    }
  });
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

function setLog(node: HTMLElement, lines: readonly string[], follow: boolean): void {
  const text = lines.join('\n');
  if (node.textContent !== text) {
    node.textContent = text;
    if (follow) node.scrollTop = node.scrollHeight;
  }
}

function renderProgress(state: PublicState): void {
  setText(byId('progress-title'), phaseTitle(state.phase));
  setText(byId('progress-message'), state.message);
  const bar = byId<HTMLProgressElement>('progress-bar');
  const value = progressValue(state.progress?.pct);
  if (value === null) {
    if (bar.hasAttribute('value')) bar.removeAttribute('value');
  } else {
    bar.value = value;
  }
  bar.setAttribute('aria-label', state.progress?.label ?? phaseTitle(state.phase));
  setText(byId('progress-label'), state.progress === null ? '' : state.progress.label);
  setText(byId('progress-note'), phaseNote(state.phase) ?? '');
  setLog(byId('log'), state.logTail, !logPaused);
}

function wireLog(): void {
  const log = byId('log');
  log.addEventListener('scroll', () => {
    logPaused = !isNearBottom(log.scrollTop, log.clientHeight, log.scrollHeight);
    setHidden(byId('log-paused'), !logPaused);
  });
}

// ---------------------------------------------------------------------------
// Disclosure
// ---------------------------------------------------------------------------

function renderDisclosure(d: Disclosure): void {
  setText(byId('disclosure-title'), disclosureHeading(d));
  setText(byId('disclosure-summary'), formatDisclosureSummary(d));
  setText(byId('disclosure-remote'), `${d.remote} · ${channelName(d.channel)} channel`);

  const banner = untestedBanner(d);
  const bannerEl = byId('disclosure-banner');
  setHidden(bannerEl, banner === null);
  setText(bannerEl, banner ?? '');

  const gate = formatGateLine(d);
  const gateEl = byId('disclosure-gate');
  setHidden(gateEl, gate === null);
  whenChanged(gateEl, gate === null ? '' : JSON.stringify(gate), () => {
    gateEl.replaceChildren();
    if (gate === null) return;
    gateEl.append(document.createTextNode(gate.before));
    if (gate.link !== null) {
      const url = gate.link.url;
      const b = make('button', 'link-button', gate.link.text);
      b.type = 'button';
      b.addEventListener('click', () => {
        openExternal(url);
      });
      gateEl.append(b);
    }
    gateEl.append(document.createTextNode(gate.after));
  });

  setHidden(byId('disclosure-security'), d.severity !== 'security');
  const lock = byId('disclosure-lockfile');
  setHidden(lock, !d.lockfileChanged);
  setText(lock, d.lockfileChanged ? LOCKFILE_NOTE : '');
  const block = disclosureBlockNote(d);
  const blockEl = byId('disclosure-block');
  setHidden(blockEl, block === null);
  setText(blockEl, block ?? '');

  const dirty = dirtyFileLines(d);
  setHidden(byId('disclosure-dirty'), dirty.length === 0);
  const dirtyList = byId('disclosure-dirty-list');
  whenChanged(dirtyList, dirty.join('\n'), () => {
    dirtyList.replaceChildren(...dirty.map((line) => make('li', undefined, line)));
  });

  const list = byId('commit-list');
  whenChanged(list, `${d.toCommit}:${d.commits.map((c) => c.sha).join(',')}`, () => {
    list.replaceChildren();
    for (const c of d.commits) {
      const li = make('li');
      li.append(make('span', 'commit-sha', c.short));
      li.append(make('span', 'commit-subject', c.subject));
      const when = formatDate(c.date);
      li.append(make('span', 'commit-meta', when === '' ? c.author : `${c.author}, ${when}`));
      list.append(li);
    }
  });
  const stat = d.diffStat.trim();
  setHidden(byId('diffstat-details'), stat === '');
  setText(byId('diffstat'), stat);

  setButtons(byId('disclosure-buttons'), disclosureButtons(d));
  const gh = byId('btn-view-github');
  setHidden(gh, d.compareUrl === null || !isExternalUrl(d.compareUrl));
  gh.dataset['url'] = d.compareUrl ?? '';
}

// ---------------------------------------------------------------------------
// Crash and error
// ---------------------------------------------------------------------------

function renderCrash(state: PublicState): void {
  setLog(byId('crash-log'), state.logTail, true);
  setButtons(byId('crash-buttons'), ['restartServer', 'showLogs', 'reinstall']);
}

function renderError(state: PublicState): void {
  const err = state.error;
  if (err === null) return;
  setText(byId('error-title'), err.title);
  setText(byId('error-message'), err.message);
  const detail = byId('error-detail');
  setHidden(detail, err.detail === null || err.detail === '');
  setText(detail, err.detail ?? '');
  setButtons(byId('error-buttons'), err.actions.length > 0 ? err.actions : ['retry', 'showLogs', 'quit']);
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

function renderAbout(state: PublicState): void {
  const v = state.versions;
  if (v === null) {
    for (const id of ['about-app', 'about-engine', 'about-channel', 'about-electron', 'about-node', 'about-datadir']) {
      setText(byId(id), 'Loading…');
    }
    return;
  }
  setText(byId('about-app'), v.app);
  const stable = v.engine.stableTag === null ? '' : `, release ${v.engine.stableTag}`;
  setText(byId('about-engine'), `${engineLabel(v)}${stable}`);
  setText(byId('about-channel'), channelName(v.engine.channel));
  setText(byId('about-electron'), `${v.electron} (Chromium ${v.chromium})`);
  setText(byId('about-node'), v.bundledNode);
  setText(byId('about-datadir'), v.dataDir);
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

function selectTab(tab: TabName, focus: boolean): void {
  activeTab = tab;
  for (const t of TABS) {
    const btn = byId(`tab-${t}`);
    const selected = t === tab;
    btn.setAttribute('aria-selected', String(selected));
    btn.tabIndex = selected ? 0 : -1;
    setHidden(byId(`tabpanel-${t}`), !selected);
    if (selected && focus) btn.focus();
  }
}

function wireTabs(): void {
  for (const t of TABS) {
    const btn = byId(`tab-${t}`);
    btn.addEventListener('click', () => {
      selectTab(t, false);
    });
    btn.addEventListener('keydown', (e: KeyboardEvent) => {
      const i = TABS.indexOf(t);
      let next: TabName | undefined;
      if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length];
      else if (e.key === 'ArrowLeft') next = TABS[(i - 1 + TABS.length) % TABS.length];
      else if (e.key === 'Home') next = TABS[0];
      else if (e.key === 'End') next = TABS[TABS.length - 1];
      if (next !== undefined) {
        e.preventDefault();
        selectTab(next, true);
      }
    });
  }
}

const CHANNEL_WARNING: Readonly<Record<Channel, string | null>> = {
  stable: null,
  candidate: 'Canary — may break. This is the next stable version while it is still being checked. If it fails to start, switch back to Stable.',
  upstream: 'Raw upstream, untested. This is the newest code from God’s Eye View with no checks. It may fail to start or behave badly.',
};

function aiProviderSelect(): HTMLSelectElement {
  return byId<HTMLSelectElement>('ai-provider');
}

function updateAiVisibility(state: PublicState): void {
  const provider = aiProviderSelect().value;
  setHidden(byId('ai-ollama-fields'), provider !== 'ollama');
  const available = state.ai.encryptionAvailable;
  setHidden(byId('ai-encryption'), available);
  for (const p of ['openrouter', 'xai'] as const) {
    byId<HTMLInputElement>(`key-${p}`).disabled = !available;
    byId<HTMLButtonElement>(`btn-save-key-${p}`).disabled = !available;
    byId<HTMLButtonElement>(`btn-clear-key-${p}`).disabled = !available;
  }
  const changed = provider !== state.ai.provider;
  setText(byId('ai-restart-note'), changed ? 'Saving a different provider restarts the engine.' : '');
}

function renderPreferences(state: PublicState): void {
  byId<HTMLInputElement>('pref-update-on-launch').checked = state.prefs.updateCheckOnLaunch;
  for (const radio of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="channel"]'))) {
    radio.checked = radio.value === state.prefs.channel;
  }
  const warning = CHANNEL_WARNING[state.prefs.channel];
  setHidden(byId('channel-warning'), warning === null);
  setText(byId('channel-warning'), warning ?? '');

  if (!aiDirty) {
    aiProviderSelect().value = state.ai.provider;
    byId<HTMLInputElement>('ai-model').value = state.ai.model ?? '';
    byId<HTMLInputElement>('ai-ollama-host').value = state.ai.ollamaHost ?? '';
  }
  setText(byId('state-key-openrouter'), state.ai.hasOpenRouterKey ? 'Key stored.' : 'No key stored.');
  setText(byId('state-key-xai'), state.ai.hasXaiKey ? 'Key stored.' : 'No key stored.');
  updateAiVisibility(state);
  renderKeys(state);
  fillEngineSettings(state);
  renderAppSettings(state);
  selectTab(activeTab, false);
}


// ---------------------------------------------------------------------------
// Settings map (General tab)
// ---------------------------------------------------------------------------

function buildSettingsMap(): void {
  const host = byId('settings-map');
  host.replaceChildren(
    ...SETTINGS_MAP.map((item) => {
      const li = make('li');
      const b = make('button', 'link-button', item.title);
      b.type = 'button';
      b.addEventListener('click', () => {
        selectTab(item.tab, true);
      });
      li.append(b, document.createTextNode(' '), make('span', 'muted small', item.text));
      return li;
    }),
  );
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

function latestKeyRow(id: string): EngineKeyRow | undefined {
  return current?.engineKeys.keys.find((k) => k.id === id);
}

function buildKeyRow(row: EngineKeyRow): HTMLLIElement {
  const li = make('li', 'key-row');
  li.dataset['keyId'] = row.id;
  const head = make('div', 'key-head');
  const title = make('strong', 'key-title', keyTitle(row.title));
  title.dataset['role'] = 'title';
  const tier = make('span', 'badge');
  tier.dataset['role'] = 'tier';
  const exposed = make('span', 'badge', 'Visible in the browser');
  exposed.dataset['role'] = 'exposed';
  exposed.title = 'This key is built into the page by design. Restrict it at the provider.';
  const state = make('span', 'key-state');
  state.dataset['role'] = 'state';
  head.append(title, tier, exposed, state);
  const unlocks = make('p', 'muted small');
  unlocks.dataset['role'] = 'unlocks';
  const lock = make('p', 'note');
  lock.dataset['role'] = 'lock';
  lock.hidden = true;

  const fields = make('div', 'key-fields');
  row.envVars.forEach((envVar, i) => {
    const wrap = make('div');
    const inputId = `key-input-${row.id}-${i}`;
    const label = make('label', undefined, row.envVars.length > 1 ? envVar : 'Key');
    label.htmlFor = inputId;
    const inline = make('div', 'inline');
    const input = make('input');
    input.type = 'password';
    input.id = inputId;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.maxLength = 512;
    input.dataset['envVar'] = envVar;
    input.setAttribute('aria-label', keyInputLabel(row, envVar));
    const show = make('button', undefined, 'Show');
    show.type = 'button';
    show.setAttribute('aria-pressed', 'false');
    show.setAttribute('aria-label', `Show ${envVar}`);
    show.addEventListener('click', () => {
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      show.textContent = showing ? 'Show' : 'Hide';
      show.setAttribute('aria-pressed', String(!showing));
    });
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') void saveEngineKeyRow(row.id, false);
    });
    inline.append(input, show);
    wrap.append(label, inline);
    fields.append(wrap);
  });

  const buttons = make('div', 'button-row left');
  const save = make('button', undefined, 'Save');
  save.type = 'button';
  save.dataset['role'] = 'save';
  save.addEventListener('click', () => {
    void saveEngineKeyRow(row.id, false);
  });
  const clear = make('button', undefined, 'Clear');
  clear.type = 'button';
  clear.dataset['role'] = 'clear';
  clear.addEventListener('click', () => {
    void saveEngineKeyRow(row.id, true);
  });
  const get = make('button', 'link-button', 'Get key');
  get.type = 'button';
  get.dataset['role'] = 'get';
  get.addEventListener('click', () => {
    const r = latestKeyRow(row.id);
    if (r !== undefined) openExternal(r.getUrl);
  });
  buttons.append(save, clear, get);
  const status = make('p', 'muted small');
  status.dataset['role'] = 'status';
  status.setAttribute('role', 'status');
  li.append(head, unlocks, lock, fields, buttons, status);
  return li;
}

function part(li: HTMLElement, role: string): HTMLElement {
  const el = li.querySelector<HTMLElement>(`[data-role="${role}"]`);
  if (el === null) throw new Error(`Missing ${role} in key row`);
  return el;
}

function updateKeyRow(li: HTMLElement, row: EngineKeyRow, list: EngineKeysPublic): void {
  const st = keyRowState(row);
  if (li.dataset['state'] !== st.kind) li.dataset['state'] = st.kind;
  setText(part(li, 'state'), st.label);
  setText(part(li, 'tier'), keyTierLabel(row.tier));
  setHidden(part(li, 'exposed'), !row.clientExposed);
  setText(part(li, 'unlocks'), row.unlocks);
  const lock = part(li, 'lock');
  setHidden(lock, row.lock === null);
  setText(lock, row.lock ?? '');
  const editable = keyRowEditable(row, list);
  for (const input of Array.from(li.querySelectorAll<HTMLInputElement>('input'))) {
    input.disabled = !editable;
    input.placeholder = row.set ? 'Saved. Type to replace it.' : 'Paste key';
  }
  (part(li, 'save') as HTMLButtonElement).disabled = !editable;
  (part(li, 'clear') as HTMLButtonElement).disabled = !editable || !row.set;
  setHidden(part(li, 'get'), !isExternalUrl(row.getUrl));
}

function syncKeyList(host: HTMLElement, rows: readonly EngineKeyRow[], list: EngineKeysPublic): void {
  const sig = rows.map((r) => `${r.id}:${r.envVars.join('+')}`).join(',');
  if (host.dataset['ids'] !== sig) {
    host.dataset['ids'] = sig;
    host.replaceChildren(...rows.map(buildKeyRow));
  }
  for (const row of rows) {
    const li = host.querySelector<HTMLElement>(`[data-key-id="${row.id}"]`);
    if (li !== null) updateKeyRow(li, row, list);
  }
}

function renderKeys(state: PublicState): void {
  const list = state.engineKeys;
  const note = byId('keys-note');
  setHidden(note, list.note === null);
  setText(note, list.note ?? '');
  setText(byId('keys-summary'), keysSummary(list));
  const { main, advanced } = splitKeyRows(list);
  syncKeyList(byId('keys-list'), main, list);
  setHidden(byId('keys-advanced'), advanced.length === 0);
  syncKeyList(byId('keys-list-advanced'), advanced, list);
}

async function saveEngineKeyRow(id: string, clear: boolean): Promise<void> {
  const li = document.querySelector<HTMLElement>(`[data-key-id="${id}"]`);
  if (li === null) return;
  const status = part(li, 'status');
  const inputs = Array.from(li.querySelectorAll<HTMLInputElement>('input[data-env-var]'));
  try {
    if (clear) {
      setText(status, 'Removing the key…');
      const r = await api.clearEngineKey({ id });
      setText(status, keyResultMessage(r, 'removed'));
      if (r.ok) for (const i of inputs) i.value = '';
      return;
    }
    const values: Record<string, string> = {};
    for (const input of inputs) {
      const v = input.value;
      if (v === '') continue;
      const problem = engineKeyValueProblem(v);
      if (problem !== null) {
        setText(status, problem);
        return;
      }
      values[input.dataset['envVar'] ?? ''] = v;
    }
    if (Object.keys(values).length === 0) {
      setText(status, 'Type or paste a key first.');
      return;
    }
    setText(status, 'Saving…');
    const r = await api.saveEngineKey({ values });
    setText(status, keyResultMessage(r, 'saved'));
    if (r.ok) {
      for (const i of inputs) {
        i.value = '';
        i.type = 'password';
      }
      for (const b of Array.from(li.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'))) {
        b.textContent = 'Show';
        b.setAttribute('aria-pressed', 'false');
      }
    }
  } catch (err) {
    setText(status, `Could not save the key. ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Engine settings
// ---------------------------------------------------------------------------

interface EngineControl {
  key: string;
  groupId: string;
  el: HTMLInputElement | HTMLSelectElement;
  off: HTMLInputElement | null;
  /** 'region-enabled' controls are checkboxes whose state is the effective on/off. */
  role: 'field' | 'region-enabled' | 'region-field';
}

const engineControls = new Map<string, EngineControl>();

function describeId(key: string, suffix: string): string {
  return `engine-${key.toLowerCase()}-${suffix}`;
}

function makeSettingControl(model: SettingFieldModel, groupId: string): { field: HTMLElement; control: EngineControl } {
  const field = make('div', 'field');
  const inputId = describeId(model.key, 'input');
  const label = make('label', undefined, model.label);
  label.htmlFor = inputId;
  let el: HTMLInputElement | HTMLSelectElement;
  if (model.kind === 'select') {
    const sel = make('select');
    for (const o of model.options) {
      const opt = make('option', undefined, o.label);
      opt.value = o.value;
      sel.append(opt);
    }
    el = sel;
  } else {
    const input = make('input');
    input.type = model.kind === 'password' ? 'password' : model.kind === 'number' ? 'number' : 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    if (model.kind === 'number') {
      if (model.min !== null) input.min = String(model.min);
      if (model.max !== null) input.max = String(model.max);
      if (model.step !== null) input.step = model.step;
    }
    input.maxLength = 1024;
    el = input;
  }
  el.id = inputId;
  const descId = describeId(model.key, 'desc');
  el.setAttribute('aria-describedby', descId);
  const desc = make('p', 'muted small', `${model.description} (${model.key})`);
  desc.id = descId;
  field.append(label, el);
  let off: HTMLInputElement | null = null;
  if (model.canDisable) {
    const wrap = make('label', 'check');
    off = make('input');
    off.type = 'checkbox';
    off.id = describeId(model.key, 'off');
    wrap.append(off, make('span', undefined, 'Turn this off'));
    field.append(wrap);
  }
  field.append(desc);
  if (model.warning !== null) {
    const warn = make('p', 'banner banner-warn', model.warning);
    warn.setAttribute('role', 'note');
    field.append(warn);
  }
  if (model.secret) {
    const remove = make('button', undefined, 'Remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${model.label}`);
    remove.addEventListener('click', () => {
      void saveEngineSettingsPatch(groupId, { [model.key]: null });
    });
    field.append(remove);
  }
  return { field, control: { key: model.key, groupId, el, off, role: 'field' } };
}

function buildRegionTable(group: SettingGroup): HTMLElement {
  const table = make('table', 'region-table');
  const caption = make('caption', 'muted small', 'Camera packs by region. Untouched rows keep the engine defaults.');
  caption.style.textAlign = 'left';
  table.append(caption);
  const head = make('tr');
  for (const h of ['Region', 'On', 'Cameras', 'More']) {
    const th = make('th', undefined, h);
    th.scope = 'col';
    head.append(th);
  }
  const thead = make('thead');
  thead.append(head);
  table.append(thead);
  const body = make('tbody');
  for (const r of group.regions ?? []) {
    const tr = make('tr');
    const name = make('th', undefined, r.label);
    name.scope = 'row';
    if (r.note !== null) {
      name.append(document.createElement('br'), make('span', 'muted small', r.note));
    }
    const on = make('td');
    if (r.enabledKey !== null) {
      const box = make('input');
      box.type = 'checkbox';
      box.id = describeId(r.enabledKey, 'input');
      box.setAttribute('aria-label', `${r.label}: enabled`);
      on.append(box);
      engineControls.set(r.enabledKey, { key: r.enabledKey, groupId: group.id, el: box, off: null, role: 'region-enabled' });
    } else {
      on.append(make('span', 'muted small', 'Always'));
    }
    const max = make('td');
    if (r.maxKey !== null) {
      const num = make('input');
      num.type = 'number';
      num.min = String(r.maxMin);
      num.max = String(r.maxMax);
      num.step = '1';
      num.id = describeId(r.maxKey, 'input');
      num.setAttribute('aria-label', `${r.label}: camera cap (${r.maxKey})`);
      max.append(num);
      engineControls.set(r.maxKey, { key: r.maxKey, groupId: group.id, el: num, off: null, role: 'region-field' });
    } else {
      max.append(make('span', 'muted small', 'n/a'));
    }
    const more = make('td');
    for (const [key, what] of [
      [r.urlKey, 'catalogue URL'],
      [r.districtsKey, 'districts'],
    ] as const) {
      if (key === null) continue;
      const input = make('input');
      input.type = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.id = describeId(key, 'input');
      input.setAttribute('aria-label', `${r.label}: ${what} (${key})`);
      input.placeholder = what;
      more.append(input);
      let off: HTMLInputElement | null = null;
      if (key === r.districtsKey) {
        const wrap = make('label', 'check');
        off = make('input');
        off.type = 'checkbox';
        off.id = describeId(key, 'off');
        wrap.append(off, make('span', 'small', 'Turn pack off'));
        more.append(wrap);
      }
      engineControls.set(key, { key, groupId: group.id, el: input, off, role: 'region-field' });
    }
    tr.append(name, on, max, more);
    body.append(tr);
  }
  table.append(body);
  return table;
}

function buildEngineSettings(): void {
  const host = byId('engine-groups');
  host.replaceChildren();
  const empty = { values: {}, set: {} };
  for (const group of ENGINE_SETTINGS_CATALOG) {
    const section = make('section', 'settings-group');
    section.dataset['group'] = group.id;
    section.setAttribute('aria-labelledby', `group-title-${group.id}`);
    const h = make('h3', undefined, group.title);
    h.id = `group-title-${group.id}`;
    section.append(h, make('p', 'muted small', group.description));
    for (const model of groupFieldModels(group, empty)) {
      const { field, control } = makeSettingControl(model, group.id);
      engineControls.set(control.key, control);
      section.append(field);
    }
    if (group.regions !== undefined) section.append(buildRegionTable(group));
    section.append(make('p', 'note', ENGINE_SETTINGS_RESTART_NOTE));
    const row = make('div', 'button-row left');
    const save = make('button', 'primary', `Save ${group.title.toLowerCase()} settings`);
    save.type = 'button';
    save.addEventListener('click', () => {
      void saveEngineGroup(group);
    });
    row.append(save);
    const status = make('p', 'muted small');
    status.id = `group-status-${group.id}`;
    status.setAttribute('role', 'status');
    section.append(row, status);
    const markDirty = (): void => {
      engineDirty.add(group.id);
    };
    section.addEventListener('input', markDirty);
    section.addEventListener('change', markDirty);
    host.append(section);
  }
}

function controlValue(c: EngineControl): FieldInput {
  const base: FieldInput =
    c.el instanceof HTMLInputElement && c.el.type === 'checkbox'
      ? { value: String(c.el.checked) }
      : { value: c.el.value };
  return c.off === null ? base : { ...base, off: c.off.checked };
}

function fillEngineSettings(state: PublicState): void {
  const cur = state.engineSettings;
  for (const group of ENGINE_SETTINGS_CATALOG) {
    if (engineDirty.has(group.id)) continue;
    for (const def of group.settings) {
      const c = engineControls.get(def.key);
      if (c === undefined) continue;
      const m = settingFieldModel(def, cur);
      c.el.value = m.value;
      if (c.el instanceof HTMLInputElement) c.el.placeholder = m.placeholder;
      if (c.off !== null) c.off.checked = m.isSet && m.value === '';
    }
    for (const row of regionRowModels(group.regions ?? [], cur)) {
      const fill = (key: string | null, value: string, placeholder: string, offOn: boolean): void => {
        if (key === null) return;
        const c = engineControls.get(key);
        if (c === undefined) return;
        c.el.value = value;
        if (c.el instanceof HTMLInputElement) c.el.placeholder = placeholder;
        if (c.off !== null) c.off.checked = offOn;
      };
      if (row.enabledKey !== null) {
        const c = engineControls.get(row.enabledKey);
        if (c !== undefined && c.el instanceof HTMLInputElement) c.el.checked = row.enabled;
      }
      fill(row.maxKey, row.max, row.maxPlaceholder, false);
      fill(row.urlKey, row.url, 'catalogue URL', false);
      const distSet = row.districtsKey !== null && cur.set[row.districtsKey] === true;
      fill(row.districtsKey, row.districts, row.districtsPlaceholder, distSet && row.districts === '');
    }
  }
}

async function saveEngineSettingsPatch(groupId: string, patch: Record<string, string | null>): Promise<void> {
  const status = byId(`group-status-${groupId}`);
  if (Object.keys(patch).length === 0) {
    setText(status, 'There is nothing to save yet.');
    return;
  }
  setText(status, 'Saving…');
  try {
    const r = await api.saveEngineSettings({ patch });
    setText(status, settingsResultMessage(r));
    if (r.ok) {
      engineDirty.delete(groupId);
      for (const c of engineControls.values()) {
        if (c.groupId === groupId && c.el instanceof HTMLInputElement && c.el.type === 'password') c.el.value = '';
      }
      if (current !== null) fillEngineSettings(current);
    }
  } catch (err) {
    setText(status, `Could not save the settings. ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function saveEngineGroup(group: SettingGroup): Promise<void> {
  if (current === null) return;
  const inputs: Record<string, FieldInput> = {};
  for (const c of engineControls.values()) {
    if (c.groupId === group.id) inputs[c.key] = controlValue(c);
  }
  const patch = buildSettingsPatch(group.settings, group.regions ?? [], current.engineSettings, inputs);
  await saveEngineSettingsPatch(group.id, patch);
}

// ---------------------------------------------------------------------------
// App settings
// ---------------------------------------------------------------------------

function fillSelect(sel: HTMLSelectElement, options: ReadonlyArray<{ value: string; label: string }>): void {
  sel.replaceChildren(
    ...options.map((o) => {
      const opt = make('option', undefined, o.label);
      opt.value = o.value;
      return opt;
    }),
  );
}

function renderAppSettings(state: PublicState): void {
  const a = state.app;
  byId<HTMLInputElement>('app-launch-at-login').checked = a.launchAtLogin;
  byId<HTMLInputElement>('app-auto-restart').checked = a.autoRestartOnCrash;
  byId<HTMLSelectElement>('app-update-interval').value = a.updateCheckInterval;
  byId<HTMLSelectElement>('app-log-level').value = a.logLevel;
  if (!proxyDirty) {
    byId<HTMLInputElement>('app-proxy-https').value = a.proxy.httpsProxy ?? '';
    byId<HTMLInputElement>('app-proxy-no').value = a.proxy.noProxy ?? '';
  }
  if (!remoteDirty) byId<HTMLInputElement>('app-engine-remote').value = a.engineRemoteUrl ?? '';
  byId<HTMLButtonElement>('btn-reset-remote').disabled = a.engineRemoteUrl === null;
  byId<HTMLButtonElement>('btn-reset-engine').disabled = !resetEngineFilesEnabled(state.phase);
  byId<HTMLButtonElement>('btn-reinstall').disabled = !reinstallEnabled(state.phase);
  setText(
    byId('app-maint-note'),
    resetEngineFilesEnabled(state.phase)
      ? ''
      : 'Reset engine files is available when the engine shows an error. Use Reinstall dependencies if the engine will not start after an update.',
  );
}

function saveAppSetting(patch: Parameters<OpenTacSetupApi['setAppSettings']>[0], what: string): void {
  api.setAppSettings(patch).catch((err: unknown) => {
    reportFailure(`Could not save ${what}.`, err);
  });
}

async function saveProxy(): Promise<void> {
  const status = byId('app-proxy-status');
  const https = validateProxyUrl(byId<HTMLInputElement>('app-proxy-https').value);
  if (!https.ok) {
    setText(status, https.reason);
    return;
  }
  const no = validateNoProxy(byId<HTMLInputElement>('app-proxy-no').value);
  if (!no.ok) {
    setText(status, no.reason);
    return;
  }
  try {
    await api.setAppSettings({ proxy: { httpsProxy: https.value, noProxy: no.value } });
    proxyDirty = false;
    setText(status, 'Proxy saved.');
  } catch (err) {
    setText(status, `Could not save the proxy. ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function saveRemote(reset: boolean): Promise<void> {
  const status = byId('app-remote-status');
  const checked = reset ? ({ ok: true, value: null } as const) : validateEngineRemoteUrl(byId<HTMLInputElement>('app-engine-remote').value);
  if (!checked.ok) {
    setText(status, checked.reason);
    return;
  }
  try {
    await api.setAppSettings({ engineRemoteUrl: checked.value });
    remoteDirty = false;
    if (reset) byId<HTMLInputElement>('app-engine-remote').value = '';
    setText(status, reset ? `The default mirror will be used. ${APP_NEXT_LAUNCH_NOTE}` : `Mirror address saved. ${APP_NEXT_LAUNCH_NOTE}`);
  } catch (err) {
    setText(status, `Could not save the mirror address. ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A two-step button: the first click arms it, a second click within 5 s runs `fn`. */
function armedButton(btn: HTMLButtonElement, armedLabel: string, fn: () => void): void {
  const original = btn.textContent ?? '';
  let timer: number | undefined;
  btn.addEventListener('click', () => {
    if (btn.dataset['armed'] === 'true') {
      window.clearTimeout(timer);
      btn.dataset['armed'] = 'false';
      btn.textContent = original;
      fn();
      return;
    }
    btn.dataset['armed'] = 'true';
    btn.textContent = armedLabel;
    timer = window.setTimeout(() => {
      btn.dataset['armed'] = 'false';
      btn.textContent = original;
    }, 5000);
  });
}

function wireSettings(): void {
  fillSelect(byId<HTMLSelectElement>('app-update-interval'), UPDATE_INTERVAL_OPTIONS);
  fillSelect(byId<HTMLSelectElement>('app-log-level'), LOG_LEVEL_OPTIONS);
  setText(byId('app-proxy-note'), PROXY_NOTE);

  byId<HTMLInputElement>('app-launch-at-login').addEventListener('change', (e) => {
    saveAppSetting({ launchAtLogin: (e.target as HTMLInputElement).checked }, 'the login setting');
  });
  byId<HTMLInputElement>('app-auto-restart').addEventListener('change', (e) => {
    saveAppSetting({ autoRestartOnCrash: (e.target as HTMLInputElement).checked }, 'the crash setting');
  });
  byId<HTMLSelectElement>('app-update-interval').addEventListener('change', (e) => {
    saveAppSetting({ updateCheckInterval: (e.target as HTMLSelectElement).value as UpdateCheckInterval }, 'the update interval');
  });
  byId<HTMLSelectElement>('app-log-level').addEventListener('change', (e) => {
    saveAppSetting({ logLevel: (e.target as HTMLSelectElement).value as LogLevelSetting }, 'the log level');
    setText(byId('app-status'), `Log level saved. ${APP_NEXT_LAUNCH_NOTE}`);
  });
  for (const id of ['app-proxy-https', 'app-proxy-no']) {
    byId(id).addEventListener('input', () => {
      proxyDirty = true;
    });
  }
  byId('app-engine-remote').addEventListener('input', () => {
    remoteDirty = true;
  });
  byId('btn-save-proxy').addEventListener('click', () => {
    void saveProxy();
  });
  byId('btn-save-remote').addEventListener('click', () => {
    void saveRemote(false);
  });
  byId('btn-reset-remote').addEventListener('click', () => {
    void saveRemote(true);
  });
  byId('btn-open-data').addEventListener('click', () => {
    runAction('openDataFolder');
  });
  byId('btn-open-logs').addEventListener('click', () => {
    runAction('showLogs');
  });
  byId('btn-forget-usb').addEventListener('click', () => {
    runAction('forgetUsbDevices');
  });
  armedButton(byId<HTMLButtonElement>('btn-reinstall'), 'Click again to reinstall', () => {
    runAction('reinstall');
  });
  armedButton(byId<HTMLButtonElement>('btn-reset-engine'), 'Click again to reset', () => {
    runAction('resetCheckout');
  });
}

function markAiDirty(): void {
  aiDirty = true;
  if (current !== null) updateAiVisibility(current);
}

async function saveKey(provider: 'openrouter' | 'xai', clear: boolean): Promise<void> {
  const input = byId<HTMLInputElement>(`key-${provider}`);
  const status = byId(`state-key-${provider}`);
  const key = clear ? '' : input.value;
  if (!clear && key === '') {
    setText(status, 'Type or paste a key first.');
    return;
  }
  const payload = { provider, key };
  if (!isSetAiKeyPayload(payload)) {
    setText(status, 'A key cannot contain spaces or line breaks.');
    return;
  }
  try {
    await api.setAiKey(payload);
    setText(status, clear ? 'Key removed.' : 'Key saved.');
  } catch (err) {
    setText(status, `Could not save the key. ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    input.value = '';
  }
}

async function saveAi(): Promise<void> {
  const status = byId('ai-save-status');
  const model = byId<HTMLInputElement>('ai-model').value.trim();
  const host = byId<HTMLInputElement>('ai-ollama-host').value.trim();
  const provider = aiProviderSelect().value;
  const payload = { provider, model: model === '' ? null : model, ollamaHost: host === '' ? null : host };
  if (!isSetAiPayload(payload)) {
    setText(status, 'The Ollama address should look like http://127.0.0.1:11434 and the model name must be plain text.');
    return;
  }
  try {
    await api.setAi(payload);
    aiDirty = false;
    setText(status, 'AI settings saved.');
  } catch (err) {
    setText(status, `Could not save the AI settings. ${err instanceof Error ? err.message : String(err)}`);
  }
}

function showTestResult(r: AiTestResultPublic): void {
  const box = byId('ai-test-result');
  setHidden(box, false);
  const headline = byId('ai-test-headline');
  headline.className = r.ok ? 'ok' : 'bad';
  setText(headline, r.ok ? 'The test worked.' : 'The test failed.');
  setText(byId('ai-test-text'), r.text === '' ? (r.ok ? '(The model sent an empty reply.)' : '') : r.text);
  setHidden(byId('ai-test-text'), r.text === '' && !r.ok);
  const meta: string[] = [`Took ${r.latencyMs} ms`];
  if (r.finishReason !== null) meta.push(`finish reason: ${r.finishReason}`);
  if (r.error !== null) meta.push(`error: ${r.error}`);
  setText(byId('ai-test-meta'), meta.join(', '));
}

async function runAiTest(): Promise<void> {
  const btn = byId<HTMLButtonElement>('btn-test-ai');
  btn.disabled = true;
  setText(byId('ai-save-status'), 'Testing the saved settings…');
  try {
    const r = await api.testAi();
    showTestResult(r);
    setText(byId('ai-save-status'), '');
  } catch (err) {
    setText(byId('ai-save-status'), `The test could not run. ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    btn.disabled = false;
  }
}

async function loadOllamaModels(): Promise<void> {
  const status = byId('ollama-status');
  const btn = byId<HTMLButtonElement>('btn-load-ollama');
  btn.disabled = true;
  setText(status, 'Loading models…');
  try {
    const r = await api.listOllamaModels();
    const list = byId('ai-model-options');
    list.replaceChildren(
      ...r.models.map((m) => {
        const o = make('option');
        o.value = m;
        return o;
      }),
    );
    if (r.error !== null) setText(status, r.error);
    else if (r.models.length === 0) setText(status, 'No models were found on that Ollama server.');
    else setText(status, `Found ${r.models.length} ${r.models.length === 1 ? 'model' : 'models'}. Pick one in the Model box.`);
  } catch (err) {
    setText(status, `Could not load models. ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    btn.disabled = false;
  }
}

function wireControls(): void {
  byId('btn-prefs-close').addEventListener('click', closeOverlay);
  byId('btn-about-close').addEventListener('click', closeOverlay);
  byId('btn-licenses').addEventListener('click', () => {
    openExternal(LICENSES_URL);
  });
  byId('btn-view-github').addEventListener('click', () => {
    const url = byId('btn-view-github').dataset['url'] ?? '';
    openExternal(url);
  });
  byId('btn-check-engine').addEventListener('click', () => {
    runAction('checkForUpdates');
  });
  byId('btn-check-app').addEventListener('click', () => {
    runAction('checkForAppUpdates');
  });
  byId('btn-show-logs').addEventListener('click', () => {
    runAction('showLogs');
  });

  byId<HTMLInputElement>('pref-update-on-launch').addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    api.setPrefs({ updateCheckOnLaunch: checked }).catch((err: unknown) => {
      reportFailure('Could not save that setting.', err);
    });
  });
  for (const radio of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="channel"]'))) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      const channel = radio.value as Channel;
      api.setPrefs({ channel }).catch((err: unknown) => {
        reportFailure('Could not change the engine channel.', err);
      });
    });
  }

  aiProviderSelect().addEventListener('change', markAiDirty);
  byId('ai-model').addEventListener('input', markAiDirty);
  byId('ai-ollama-host').addEventListener('input', markAiDirty);
  byId('btn-save-ai').addEventListener('click', () => {
    void saveAi();
  });
  byId('btn-test-ai').addEventListener('click', () => {
    void runAiTest();
  });
  byId('btn-load-ollama').addEventListener('click', () => {
    void loadOllamaModels();
  });
  for (const p of ['openrouter', 'xai'] as const) {
    byId(`btn-save-key-${p}`).addEventListener('click', () => {
      void saveKey(p, false);
    });
    byId(`btn-clear-key-${p}`).addEventListener('click', () => {
      void saveKey(p, true);
    });
    byId(`key-${p}`).addEventListener('keydown', (e: Event) => {
      if ((e as KeyboardEvent).key === 'Enter') void saveKey(p, false);
    });
  }

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || current === null) return;
    const panel = panelForPhase(current);
    if (panel === 'preferences' || panel === 'about') {
      e.preventDefault();
      closeOverlay();
    }
  });

  wireTabs();
  wireLog();
  buildSettingsMap();
  buildEngineSettings();
  wireSettings();
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(state: PublicState): void {
  current = state;
  // While About is being closed, the shell passes through a Preferences state; skip drawing it.
  if (closingOverlay && state.preferencesOpen) return;
  renderHeader(state);
  renderNotices(state);

  const panel = panelForPhase(state);
  for (const id of PANEL_IDS) setHidden(panelEl(id), id !== panel);

  switch (panel) {
    case 'progress':
      renderProgress(state);
      break;
    case 'disclosure':
      if (state.disclosure !== null) renderDisclosure(state.disclosure);
      break;
    case 'crash':
      renderCrash(state);
      break;
    case 'error':
      renderError(state);
      break;
    case 'about':
      renderAbout(state);
      break;
    case 'preferences':
      renderPreferences(state);
      break;
  }

  if (panel !== shownPanel) {
    shownPanel = panel;
    const heading = panelEl(panel).querySelector<HTMLElement>('h2');
    heading?.focus({ preventScroll: true });
    byId('main').scrollTop = 0;
  }
}

function start(): void {
  wireControls();
  api.onState(render);
  api
    .getState()
    .then(render)
    .catch((err: unknown) => {
      reportFailure('Could not read the current status.', err);
    });
}

start();
