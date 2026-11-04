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
import type { EngineKeyRow, EngineKeysPublic, Phase } from '../../shared/ipc.js';
import type { Channel, LogLevelSetting, UpdateCheckInterval } from '../../shared/types.js';
import {
  APP_NEXT_LAUNCH_NOTE,
  ENGINE_SETTINGS_RESTART_NOTE,
  EXPOSED_LEGEND,
  LICENSES_URL,
  LOGIN_UNAVAILABLE_NOTE,
  LOG_LEVEL_OPTIONS,
  PREFERENCE_TABS,
  PROXY_NOTE,
  SETTINGS_MAP,
  STATUS_SECONDS,
  UPDATE_INTERVAL_OPTIONS,
  UPSTREAM_URL,
  buildSettingsPatch,
  channelName,
  groupFieldModels,
  groupSaveLabel,
  gpuSummary,
  keyFieldLabel,
  keyInputLabel,
  keyPlaceholder,
  keyRestartedMessage,
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
  elapsedLabel,
  formatDate,
  formatDisclosureSummary,
  formatGateLine,
  formatDiffStat,
  isDowngrade,
  isNearBottom,
  labelForAction,
  launchAtLoginAvailable,
  newLogLines,
  nextProgressReason,
  parseAiTestReply,
  plainErrorDetail,
  plainErrorMessage,
  plainErrorTitle,
  plainProxyReason,
  progressSubLine,
  LOCKFILE_NOTE,
  panelForPhase,
  phaseNote,
  phaseTitle,
  progressValue,
  showsElapsed,
  untestedBanner,
  visibleLogLines,
  warningActive,
} from './view.js';
import type { FieldInput, PanelId, ProgressReason, SettingFieldModel, TabName } from './view.js';

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

// Status lines under controls say what just happened. They clear on their own after a few seconds, and
// as soon as another control in Preferences is used, so an old message never sits next to a new action.
const statusTimers = new WeakMap<HTMLElement, number>();
const statusRestore = new WeakMap<HTMLElement, () => string>();

type StatusKind = 'ok' | 'error' | 'busy';

function setStatus(node: HTMLElement, text: string, kind: StatusKind = 'ok', seconds?: number): void {
  const old = statusTimers.get(node);
  if (old !== undefined) window.clearTimeout(old);
  statusTimers.delete(node);
  setText(node, text);
  node.classList.toggle('status-error', kind === 'error');
  if (text === '') {
    delete node.dataset['transient'];
    delete node.dataset['busy'];
    return;
  }
  node.dataset['transient'] = 'true';
  if (kind === 'busy') node.dataset['busy'] = 'true';
  else {
    delete node.dataset['busy'];
    const secs = seconds ?? STATUS_SECONDS[kind];
    statusTimers.set(node, window.setTimeout(() => {
      clearStatus(node);
    }, secs * 1000));
  }
}

function clearStatus(node: HTMLElement): void {
  const t = statusTimers.get(node);
  if (t !== undefined) window.clearTimeout(t);
  statusTimers.delete(node);
  delete node.dataset['transient'];
  delete node.dataset['busy'];
  node.classList.remove('status-error');
  setText(node, statusRestore.get(node)?.() ?? '');
}

/** Clears every finished status line inside Preferences (a message still saying "Saving…" stays). */
function clearFinishedStatuses(): void {
  for (const n of Array.from(byId('panel-preferences').querySelectorAll<HTMLElement>('[data-transient="true"]'))) {
    if (n.dataset['busy'] !== 'true') clearStatus(n);
  }
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
    v === null ? '' : `OpenTac ${v.app} · God’s Eye View ${engineLabel(v)}`,
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
        if (current !== null) {
          render(current);
          // The app is running and this was the last notice: nothing is left to look at (FD-05).
          const left = [...current.notices, ...localNotices].filter((n) => !dismissedNotices.has(n));
          if (current.phase === 'RUNNING' && left.length === 0 && panelForPhase(current) === 'progress') {
            runAction('closePreferences');
          }
        }
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

let phaseStartedAt = Date.now();
let phaseSeen: Phase | null = null;
let phaseKey = '';
let progressReason: ProgressReason | null = null;
let logBaseline: string[] = [];
let elapsedTimer: number | null = null;

/**
 * Remembers where the current progress phase began: when (for the elapsed line), why (first run,
 * reset, repair, update or rollback, which decides the note), and what the log looked like then
 * (so the previous run's output is not shown as if it were this phase's).
 */
function trackPhase(state: PublicState): void {
  const key = `${state.phase}:${String(state.rollingBack === true)}`;
  if (key === phaseKey) return;
  phaseKey = key;
  progressReason = nextProgressReason(phaseSeen, state.phase, progressReason, state.rollingBack === true);
  phaseSeen = state.phase;
  phaseStartedAt = Date.now();
  logBaseline = [...state.logTail];
}

function updateElapsed(): void {
  const node = document.getElementById('progress-elapsed');
  if (node === null || current === null) return;
  const show = showsElapsed(current.phase) && Date.now() - phaseStartedAt >= 5000 && shownPanel === 'progress';
  setHidden(node, !show);
  if (show) setText(node, elapsedLabel(Date.now() - phaseStartedAt));
}

function renderProgress(state: PublicState): void {
  const running = state.phase === 'RUNNING';
  const restoring = state.rollingBack === true;
  const title = restoring ? phaseTitle('ROLLING_BACK') : phaseTitle(state.phase);
  setText(byId('progress-title'), title);
  // One headline and one sub-line: the shell's message and bar label often just repeat the headline.
  const sub = running ? 'You can close this window.' : progressSubLine(title, state.message, state.progress?.label ?? '');
  setText(byId('progress-message'), sub);
  setHidden(byId('progress-message'), sub === '');
  const bar = byId<HTMLProgressElement>('progress-bar');
  const value = progressValue(state.progress?.pct);
  if (value === null) {
    if (bar.hasAttribute('value')) bar.removeAttribute('value');
  } else {
    bar.value = value;
  }
  bar.setAttribute('aria-label', state.progress?.label ?? title);
  const pct = byId('progress-label');
  setText(pct, value === null ? '' : `${Math.round(value)}%`);
  setHidden(pct, running || value === null);
  setText(byId('progress-note'), (restoring ? phaseNote('ROLLING_BACK') : phaseNote(state.phase, progressReason)) ?? '');
  // A running engine has nothing left to show but a status line (FD-05).
  setHidden(bar, running);
  const lines = visibleLogLines(newLogLines(logBaseline, state.logTail));
  const hideLog = running || lines.length === 0;
  setHidden(byId('log'), hideLog);
  if (hideLog) setHidden(byId('log-paused'), true);
  setLog(byId('log'), lines, !logPaused);
  if (elapsedTimer === null) elapsedTimer = window.setInterval(updateElapsed, 1000);
  updateElapsed();
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
  // Moving back to an older version is a warning, not a footnote (EU-02).
  const downgrade = isDowngrade(d);
  blockEl.className = downgrade ? 'banner banner-warn' : 'note';
  setHidden(byId('commits-heading'), d.commits.length === 0);
  setHidden(byId('commit-list'), d.commits.length === 0);

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
  const stat = formatDiffStat(d.diffStat);
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
  const reason = byId('crash-reason');
  const why = state.error?.message ?? '';
  setHidden(reason, why === '');
  setText(reason, why);
  setLog(byId('crash-log'), state.logTail, true);
  setButtons(byId('crash-buttons'), ['restartServer', 'showLogs', 'reinstall']);
}

function renderError(state: PublicState): void {
  const err = state.error;
  if (err === null) return;
  setText(byId('error-title'), plainErrorTitle(err.title));
  setText(byId('error-message'), plainErrorMessage(err.message));
  const detail = byId('error-detail');
  const detailText = plainErrorDetail(err.detail);
  setHidden(detail, detailText === '');
  setText(detail, detailText);
  setButtons(byId('error-buttons'), err.actions.length > 0 ? err.actions : ['retry', 'showLogs', 'quit']);
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

let gpuInfo: { ok: boolean; text: string } | null = null;

/** The renderer string WebGL reports, or null when WebGL is not available. */
function webglRenderer(): string | null {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (gl === null) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r: unknown = gl.getParameter(ext === null ? gl.RENDERER : ext.UNMASKED_RENDERER_WEBGL);
    return typeof r === 'string' ? r : null;
  } catch {
    return null;
  }
}

function renderAbout(state: PublicState): void {
  const v = state.versions;
  gpuInfo ??= gpuSummary(webglRenderer());
  setText(byId('about-gpu'), gpuInfo.text);
  byId('about-gpu').classList.toggle('status-error', !gpuInfo.ok);
  setHidden(byId('about-gpu-hint'), gpuInfo.ok);
  if (v === null) {
    for (const id of ['about-app', 'about-engine', 'about-channel', 'about-remote', 'about-electron', 'about-node', 'about-datadir']) {
      setText(byId(id), 'Loading…');
    }
    return;
  }
  setText(byId('about-app'), v.app);
  const stable = v.engine.stableTag === null ? '' : `, release ${v.engine.stableTag}`;
  setText(byId('about-engine'), `${engineLabel(v)}${stable}`);
  setText(byId('about-channel'), channelName(v.engine.channel));
  setText(byId('about-remote'), v.engine.remote);
  setText(byId('about-electron'), `${v.electron} (Chromium ${v.chromium})`);
  setText(byId('about-node'), v.bundledNode);
  setText(byId('about-datadir'), v.dataDir);
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

function selectTab(tab: TabName, focus: boolean): void {
  // A different tab starts at its top, not wherever the last one was scrolled to.
  if (tab !== activeTab) byId('main').scrollTop = 0;
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
    const stored = p === 'openrouter' ? state.ai.hasOpenRouterKey : state.ai.hasXaiKey;
    byId<HTMLButtonElement>(`btn-clear-key-${p}`).disabled = !available || !stored;
  }
  // OpenAI summaries are sent by the engine, which has its own model setting: no model box here.
  setHidden(byId('ai-model-field'), provider === 'openai');
  setHidden(byId('ai-openai-note'), provider !== 'openai');
  byId<HTMLButtonElement>('btn-test-ai').disabled = aiDirty || provider === 'openai';
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
  for (const [p, has] of [['openrouter', state.ai.hasOpenRouterKey], ['xai', state.ai.hasXaiKey]] as const) {
    const node = byId(`state-key-${p}`);
    if (node.dataset['transient'] !== 'true') setText(node, has ? 'Key stored.' : 'No key stored.');
  }
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
    const label = make('label', undefined, keyFieldLabel(row, envVar));
    label.htmlFor = inputId;
    label.title = envVar;
    const inline = make('div', 'inline');
    const input = make('input');
    input.type = 'password';
    input.id = inputId;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.maxLength = 512;
    input.dataset['envVar'] = envVar;
    input.title = envVar;
    input.setAttribute('aria-label', keyInputLabel(row, envVar));
    const show = make('button', undefined, 'Show');
    show.type = 'button';
    show.setAttribute('aria-pressed', 'false');
    show.setAttribute('aria-label', `Show ${keyFieldLabel(row, envVar).toLowerCase()}`);
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
  const clear = make('button', undefined, 'Remove');
  clear.type = 'button';
  clear.dataset['role'] = 'clear';
  armedButton(clear, 'Click again to remove', () => {
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
    input.placeholder = keyPlaceholder(row);
  }
  for (const show of Array.from(li.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'))) show.disabled = !editable;
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
  checkKeyRestarts(state);
  const legend = byId('keys-legend');
  setText(legend, EXPOSED_LEGEND);
  setHidden(legend, !list.keys.some((k) => k.clientExposed));
  const note = byId('keys-note');
  setHidden(note, list.note === null);
  setText(note, list.note ?? '');
  setText(byId('keys-summary'), keysSummary(list, state.ai.provider !== 'openai'));
  const { main, advanced } = splitKeyRows(list);
  syncKeyList(byId('keys-list'), main, list);
  setHidden(byId('keys-advanced'), advanced.length === 0);
  syncKeyList(byId('keys-list-advanced'), advanced, list);
}

interface PendingKey {
  what: 'saved' | 'removed';
  at: number;
}
const pendingKeys = new Map<string, PendingKey>();
let keyPoll: number | null = null;

function finishKeyRestart(id: string, sawEngine: boolean): void {
  const p = pendingKeys.get(id);
  if (p === undefined) return;
  pendingKeys.delete(id);
  if (pendingKeys.size === 0 && keyPoll !== null) {
    window.clearInterval(keyPoll);
    keyPoll = null;
  }
  const li = document.querySelector<HTMLElement>(`[data-key-id="${id}"]`);
  if (li === null) return;
  const status = part(li, 'status');
  // Only replace the message if it is still on screen (using another control clears it).
  if (status.dataset['transient'] !== 'true') return;
  setStatus(status, sawEngine ? keyRestartedMessage(p.what) : p.what === 'saved' ? 'Saved.' : 'Removed.');
}

/** Once the key list shows the change again from a running engine, "restarting" becomes "has restarted". */
function checkKeyRestarts(state: PublicState): void {
  for (const [id, p] of [...pendingKeys]) {
    const row = state.engineKeys.keys.find((k) => k.id === id);
    if (row === undefined || Date.now() - p.at < 1500) continue;
    if (state.engineKeys.source !== 'engine' || state.phase !== 'RUNNING') continue;
    if (p.what === 'saved' ? row.set : !row.set) finishKeyRestart(id, true);
  }
}

function watchKeyRestart(id: string, what: 'saved' | 'removed'): void {
  pendingKeys.set(id, { what, at: Date.now() });
  const started = Date.now();
  keyPoll ??= window.setInterval(() => {
    if (Date.now() - started > 25_000) {
      for (const k of [...pendingKeys.keys()]) finishKeyRestart(k, false);
      return;
    }
    api.getState().then(render).catch(() => undefined);
  }, 1500);
}

async function saveEngineKeyRow(id: string, clear: boolean): Promise<void> {
  const li = document.querySelector<HTMLElement>(`[data-key-id="${id}"]`);
  if (li === null) return;
  const status = part(li, 'status');
  const inputs = Array.from(li.querySelectorAll<HTMLInputElement>('input[data-env-var]'));
  try {
    if (clear) {
      setStatus(status, 'Removing the key…', 'busy');
      const r = await api.clearEngineKey({ id });
      setStatus(status, keyResultMessage(r, 'removed'), r.ok ? 'ok' : 'error', r.ok ? 25 : undefined);
      if (r.ok) {
        for (const i of inputs) i.value = '';
        watchKeyRestart(id, 'removed');
      }
      return;
    }
    const values: Record<string, string> = {};
    for (const input of inputs) {
      // Pasted keys often carry a stray space or newline at the ends; only interior whitespace is a problem.
      const v = input.value.trim();
      if (v === '') continue;
      const problem = engineKeyValueProblem(v);
      if (problem !== null) {
        setStatus(status, problem, 'error');
        return;
      }
      values[input.dataset['envVar'] ?? ''] = v;
    }
    if (Object.keys(values).length === 0) {
      setStatus(status, 'Type or paste a key first.', 'error');
      return;
    }
    setStatus(status, 'Saving…', 'busy');
    const r = await api.saveEngineKey({ values });
    setStatus(status, keyResultMessage(r, 'saved'), r.ok ? 'ok' : 'error', r.ok ? 25 : undefined);
    if (r.ok) {
      watchKeyRestart(id, 'saved');
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
    setStatus(status, `Could not save the key. ${err instanceof Error ? err.message : String(err)}`, 'error');
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
  /** Human label used in error messages. */
  label: string;
  /** The caution under the field and when it applies. */
  warn?: { el: HTMLElement; model: Pick<SettingFieldModel, 'warning' | 'warnWhen'> };
  /** The inline error under the field. */
  error?: HTMLElement;
  /** The Remove button of a secret field (only useful while something is stored). */
  remove?: HTMLButtonElement;
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
  // The variable name is for people who edit the .env file by hand: a tooltip, and a switch at the top of the tab.
  label.title = model.key;
  el.title = model.key;
  const descId = describeId(model.key, 'desc');
  el.setAttribute('aria-describedby', descId);
  const desc = make('p', 'muted small', model.description);
  desc.append(make('span', 'env-name', ` (${model.key})`));
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
  let warnPart: EngineControl['warn'];
  if (model.warning !== null) {
    const warn = make('p', 'banner banner-warn', model.warning);
    warn.setAttribute('role', 'note');
    warn.hidden = true;
    field.append(warn);
    warnPart = { el: warn, model: { warning: model.warning, warnWhen: model.warnWhen } };
  }
  const errorEl = make('p', 'field-error');
  errorEl.id = describeId(model.key, 'error');
  errorEl.setAttribute('role', 'alert');
  errorEl.hidden = true;
  field.append(errorEl);
  let removeBtn: HTMLButtonElement | undefined;
  if (model.secret) {
    const remove = make('button', undefined, 'Remove');
    remove.type = 'button';
    remove.disabled = !model.isSet;
    remove.setAttribute('aria-label', `Remove ${model.label}`);
    armedButton(remove, 'Click again to remove', () => {
      void saveEngineSettingsPatch(groupId, { [model.key]: null });
    });
    field.append(remove);
    removeBtn = remove;
  }
  return {
    field,
    control: {
      key: model.key,
      groupId,
      el,
      off,
      role: 'field',
      label: model.label,
      ...(warnPart !== undefined ? { warn: warnPart } : {}),
      ...(removeBtn !== undefined ? { remove: removeBtn } : {}),
      error: errorEl,
    },
  };
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
      engineControls.set(r.enabledKey, { key: r.enabledKey, groupId: group.id, el: box, off: null, role: 'region-enabled', label: `${r.label}: enabled` });
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
      num.title = r.maxKey;
      num.setAttribute('aria-label', `${r.label}: camera cap`);
      max.append(num);
      engineControls.set(r.maxKey, { key: r.maxKey, groupId: group.id, el: num, off: null, role: 'region-field', label: `${r.label}: camera cap` });
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
      input.title = key;
      input.setAttribute('aria-label', `${r.label}: ${what}`);
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
      engineControls.set(key, { key, groupId: group.id, el: input, off, role: 'region-field', label: `${r.label}: ${what}` });
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
    const save = make('button', 'primary', groupSaveLabel(group));
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
      clearGroupErrors(group.id);
      syncWarnings();
    };
    section.addEventListener('input', markDirty);
    section.addEventListener('change', markDirty);
    host.append(section);
  }
}

/** Shows each caution only while the field holds the value it warns about. */
function syncWarnings(): void {
  for (const c of engineControls.values()) {
    if (c.warn === undefined) continue;
    setHidden(c.warn.el, !warningActive(c.warn.model, c.el.value));
  }
}

function clearGroupErrors(groupId: string): void {
  for (const c of engineControls.values()) {
    if (c.groupId !== groupId) continue;
    if (c.el.getAttribute('aria-invalid') !== null) c.el.removeAttribute('aria-invalid');
    if (c.error !== undefined) {
      setHidden(c.error, true);
      setText(c.error, '');
    }
  }
  const status = document.getElementById(`group-status-${groupId}`);
  if (status !== null) clearStatus(status);
}

/** Marks a field invalid, says why next to it, and (for the first one) scrolls to and focuses it. */
function flagField(c: EngineControl, message: string, focus: boolean): void {
  c.el.setAttribute('aria-invalid', 'true');
  if (c.error !== undefined) {
    setText(c.error, message);
    setHidden(c.error, false);
    c.el.setAttribute('aria-describedby', `${c.el.getAttribute('aria-describedby') ?? ''} ${c.error.id}`.trim());
  }
  if (focus) {
    c.el.scrollIntoView({ block: 'center' });
    c.el.focus({ preventScroll: true });
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
      if (c.remove !== undefined) c.remove.disabled = !m.isSet;
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
  syncWarnings();
}

async function saveEngineSettingsPatch(groupId: string, patch: Record<string, string | null>): Promise<void> {
  const status = byId(`group-status-${groupId}`);
  if (Object.keys(patch).length === 0) {
    setStatus(status, 'There is nothing to save yet.');
    return;
  }
  setStatus(status, 'Saving…', 'busy');
  try {
    const r = await api.saveEngineSettings({ patch });
    clearGroupErrors(groupId);
    setStatus(status, settingsResultMessage(r, (k) => engineControls.get(k)?.label ?? k), r.ok ? 'ok' : 'error', r.ok && r.restarting ? 10 : undefined);
    if (!r.ok) {
      let first = true;
      for (const [key, message] of Object.entries(r.invalid)) {
        const c = engineControls.get(key);
        if (c === undefined) continue;
        flagField(c, message, first);
        first = false;
      }
    }
    if (r.ok) {
      engineDirty.delete(groupId);
      for (const c of engineControls.values()) {
        if (c.groupId === groupId && c.el instanceof HTMLInputElement && c.el.type === 'password') c.el.value = '';
      }
      if (current !== null) fillEngineSettings(current);
    }
  } catch (err) {
    setStatus(status, `Could not save the settings. ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

async function saveEngineGroup(group: SettingGroup): Promise<void> {
  if (current === null) return;
  // A half-typed number leaves the box reading '' even though it holds text; that is not a clear (SET-03).
  clearGroupErrors(group.id);
  let badFirst = true;
  let anyBad = false;
  for (const c of engineControls.values()) {
    if (c.groupId !== group.id || !(c.el instanceof HTMLInputElement) || c.el.type !== 'number') continue;
    if (c.el.validity.badInput) {
      anyBad = true;
      flagField(c, 'Enter a whole number, or clear the box to use the default.', badFirst);
      badFirst = false;
    }
  }
  if (anyBad) {
    setStatus(byId(`group-status-${group.id}`), 'Nothing was saved. Fix the highlighted field first.', 'error');
    return;
  }
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
  const loginOk = launchAtLoginAvailable(state.versions);
  const login = byId<HTMLInputElement>('app-launch-at-login');
  login.checked = a.launchAtLogin && loginOk;
  login.disabled = !loginOk;
  setHidden(byId('app-login-note'), loginOk);
  setText(byId('app-login-note'), LOGIN_UNAVAILABLE_NOTE);
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

function saveAppSetting(
  patch: Parameters<OpenTacSetupApi['setAppSettings']>[0],
  what: string,
  statusId: string,
  okText = 'Saved.',
): void {
  api
    .setAppSettings(patch)
    .then(() => {
      setStatus(byId(statusId), okText);
    })
    .catch((err: unknown) => {
      reportFailure(`Could not save ${what}.`, err);
    });
}

/** Runs a shell action and, when it went through, says so next to the button. */
function runActionThen(name: ActionName, statusId: string, okText: string): void {
  api
    .action(name)
    .then(() => {
      setStatus(byId(statusId), okText);
    })
    .catch((err: unknown) => {
      reportFailure(`Could not do that (${labelForAction(name)}).`, err);
    });
}

async function saveProxy(): Promise<void> {
  const status = byId('app-proxy-status');
  const https = validateProxyUrl(byId<HTMLInputElement>('app-proxy-https').value);
  if (!https.ok) {
    setStatus(status, plainProxyReason(https.reason), 'error');
    return;
  }
  const no = validateNoProxy(byId<HTMLInputElement>('app-proxy-no').value);
  if (!no.ok) {
    setStatus(status, plainProxyReason(no.reason), 'error');
    return;
  }
  try {
    await api.setAppSettings({ proxy: { httpsProxy: https.value, noProxy: no.value } });
    proxyDirty = false;
    setStatus(status, 'Proxy saved.');
  } catch (err) {
    setStatus(status, `Could not save the proxy. ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

async function saveRemote(reset: boolean): Promise<void> {
  const status = byId('app-remote-status');
  const checked = reset ? ({ ok: true, value: null } as const) : validateEngineRemoteUrl(byId<HTMLInputElement>('app-engine-remote').value);
  if (!checked.ok) {
    setStatus(status, checked.reason, 'error');
    return;
  }
  try {
    await api.setAppSettings({ engineRemoteUrl: checked.value });
    remoteDirty = false;
    if (reset) byId<HTMLInputElement>('app-engine-remote').value = '';
    setStatus(status, reset ? `The default mirror will be used. ${APP_NEXT_LAUNCH_NOTE}` : `Mirror address saved. ${APP_NEXT_LAUNCH_NOTE}`);
  } catch (err) {
    setStatus(status, `Could not save the mirror address. ${err instanceof Error ? err.message : String(err)}`, 'error');
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
    saveAppSetting({ launchAtLogin: (e.target as HTMLInputElement).checked }, 'the login setting', 'app-behaviour-status');
  });
  byId<HTMLInputElement>('app-auto-restart').addEventListener('change', (e) => {
    saveAppSetting({ autoRestartOnCrash: (e.target as HTMLInputElement).checked }, 'the crash setting', 'app-behaviour-status');
  });
  byId<HTMLSelectElement>('app-update-interval').addEventListener('change', (e) => {
    saveAppSetting({ updateCheckInterval: (e.target as HTMLSelectElement).value as UpdateCheckInterval }, 'the update interval', 'app-behaviour-status');
  });
  byId<HTMLSelectElement>('app-log-level').addEventListener('change', (e) => {
    saveAppSetting({ logLevel: (e.target as HTMLSelectElement).value as LogLevelSetting }, 'the log level', 'app-log-status', `Saved. ${APP_NEXT_LAUNCH_NOTE}`);
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
    runActionThen('openDataFolder', 'app-status', 'Opened the data folder.');
  });
  byId('btn-open-logs').addEventListener('click', () => {
    runActionThen('showLogs', 'app-status', 'Opened the logs folder.');
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

/** A model name belongs to its provider: changing the provider clears it, and an old test result goes stale (SET-07). */
function onAiProviderChange(): void {
  const provider = aiProviderSelect().value;
  const saved = current?.ai;
  byId<HTMLInputElement>('ai-model').value = saved !== undefined && saved.provider === provider ? (saved.model ?? '') : '';
  byId<HTMLSelectElement>('ai-model-picker').value = '';
  setHidden(byId('ai-test-result'), true);
  markAiDirty();
}

async function saveKey(provider: 'openrouter' | 'xai', clear: boolean): Promise<void> {
  const input = byId<HTMLInputElement>(`key-${provider}`);
  const status = byId(`state-key-${provider}`);
  const key = clear ? '' : input.value;
  if (!clear && key === '') {
    setStatus(status, 'Type or paste a key first.', 'error');
    return;
  }
  const payload = { provider, key };
  if (!isSetAiKeyPayload(payload)) {
    setStatus(status, 'A key cannot contain spaces or line breaks.', 'error');
    return;
  }
  try {
    await api.setAiKey(payload);
    setStatus(status, clear ? 'Removed.' : 'Saved.');
  } catch (err) {
    setStatus(status, `Could not save the key. ${err instanceof Error ? err.message : String(err)}`, 'error');
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
    setStatus(status, 'The Ollama address should look like http://127.0.0.1:11434 and the model name must be plain text.', 'error');
    return;
  }
  try {
    const providerChanged = current !== null && current.ai.provider !== provider;
    if (providerChanged) setStatus(status, 'Saving. The engine is restarting to apply the new provider…', 'busy');
    await api.setAi(payload);
    aiDirty = false;
    setHidden(byId('ai-test-result'), true);
    setStatus(status, providerChanged ? 'Saved. The engine has restarted with the new provider.' : 'Saved.');
    if (current !== null) updateAiVisibility(current);
  } catch (err) {
    setStatus(status, `Could not save the AI settings. ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

function showTestResult(r: AiTestResultPublic): void {
  const box = byId('ai-test-result');
  setHidden(box, false);
  const headline = byId('ai-test-headline');
  headline.className = r.ok ? 'ok' : 'bad';
  setText(headline, r.ok ? 'The test worked.' : 'The test failed.');
  // The summary sentence first; the engine's raw reply and the technical figures are behind Details.
  const reply = parseAiTestReply(r.text);
  const summary = r.ok ? (reply.summary === '' ? '(The model sent an empty reply.)' : reply.summary) : (r.error ?? reply.summary);
  setText(byId('ai-test-summary'), summary);
  setHidden(byId('ai-test-summary'), summary === '');
  setText(byId('ai-test-meta'), `Took ${r.latencyMs} ms.`);
  const extra: string[] = [];
  if (r.finishReason !== null) extra.push(`Finish reason: ${r.finishReason}.`);
  if (!r.ok && r.error !== null && reply.raw !== '') extra.push(`Error: ${r.error}`);
  setText(byId('ai-test-text'), reply.raw);
  setHidden(byId('ai-test-text'), reply.raw === '' || (reply.raw === summary && extra.length === 0));
  setText(byId('ai-test-extra'), extra.join(' '));
  setHidden(byId('ai-test-details'), reply.raw === '' && extra.length === 0);
  if (reply.raw === summary && extra.length === 0) setHidden(byId('ai-test-details'), true);
}

async function runAiTest(): Promise<void> {
  const btn = byId<HTMLButtonElement>('btn-test-ai');
  btn.disabled = true;
  setStatus(byId('ai-save-status'), 'Testing the saved settings…', 'busy');
  try {
    const r = await api.testAi();
    showTestResult(r);
    setStatus(byId('ai-save-status'), '');
  } catch (err) {
    setStatus(byId('ai-save-status'), `The test could not run. ${err instanceof Error ? err.message : String(err)}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function loadOllamaModels(): Promise<void> {
  const status = byId('ollama-status');
  const btn = byId<HTMLButtonElement>('btn-load-ollama');
  btn.disabled = true;
  setStatus(status, 'Loading models…', 'busy');
  try {
    const r = await api.listOllamaModels();
    const picker = byId<HTMLSelectElement>('ai-model-picker');
    picker.replaceChildren(
      make('option', undefined, 'Choose a model…'),
      ...r.models.map((m) => {
        const o = make('option', undefined, m);
        o.value = m;
        return o;
      }),
    );
    picker.options[0]!.value = '';
    picker.value = r.models.includes(byId<HTMLInputElement>('ai-model').value.trim()) ? byId<HTMLInputElement>('ai-model').value.trim() : '';
    setHidden(picker, r.models.length === 0);
    if (r.error !== null) setStatus(status, r.error, 'error');
    else if (r.models.length === 0) setStatus(status, 'No models were found on that Ollama server.', 'error');
    else setStatus(status, `Found ${r.models.length} ${r.models.length === 1 ? 'model' : 'models'}. Choose one from the list, or type a name.`, 'ok', 12);
  } catch (err) {
    setStatus(status, `Could not load models. ${err instanceof Error ? err.message : String(err)}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

function wireControls(): void {
  // Links in our own text (the credit line) open in the browser, never inside this window.
  document.addEventListener('click', (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest<HTMLAnchorElement>('a[data-external]');
    if (a === null || a === undefined) return;
    e.preventDefault();
    openExternal(a.href);
  });
  // Using any control in Preferences clears the old status lines (capture phase: before the control's own handler sets a new one).
  for (const type of ['input', 'change', 'click'] as const) {
    byId('panel-preferences').addEventListener(type, clearFinishedStatuses, true);
  }
  byId<HTMLInputElement>('engine-show-names').addEventListener('change', (e) => {
    byId('tabpanel-engine').classList.toggle('show-names', (e.target as HTMLInputElement).checked);
  });
  byId('btn-upstream').addEventListener('click', () => {
    openExternal(UPSTREAM_URL);
  });
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
    api
      .setPrefs({ updateCheckOnLaunch: checked })
      .then(() => {
        setStatus(byId('updates-status'), 'Saved.');
      })
      .catch((err: unknown) => {
        reportFailure('Could not save that setting.', err);
      });
  });
  for (const radio of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="channel"]'))) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      const channel = radio.value as Channel;
      api
        .setPrefs({ channel })
        .then(() => {
          setStatus(byId('updates-status'), 'Saved.');
        })
        .catch((err: unknown) => {
          reportFailure('Could not change the engine channel.', err);
        });
    });
  }

  aiProviderSelect().addEventListener('change', onAiProviderChange);
  byId<HTMLSelectElement>('ai-model-picker').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v !== '') byId<HTMLInputElement>('ai-model').value = v;
    markAiDirty();
  });
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
    armedButton(byId<HTMLButtonElement>(`btn-clear-key-${p}`), 'Click again to remove', () => {
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
  trackPhase(state);
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
