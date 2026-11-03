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
import { isExternalUrl, isSetAiKeyPayload, isSetAiPayload } from '../../shared/ipc.js';
import type { Channel } from '../../shared/types.js';
import {
  LICENSES_URL,
  channelName,
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
import type { PanelId } from './view.js';

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
let aiDirty = false;
const localNotices: string[] = [];
const dismissedNotices = new Set<string>();
type TabName = 'general' | 'channel' | 'ai';
const TABS: readonly TabName[] = ['general', 'channel', 'ai'];
let activeTab: TabName = 'general';

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
  selectTab(activeTab, false);
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
  byId('btn-prefs-close').addEventListener('click', () => {
    runAction('closePreferences');
  });
  byId('btn-about-close').addEventListener('click', () => {
    // The shell has one close action for both overlays.
    runAction('closePreferences');
  });
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
      runAction('closePreferences');
    }
  });

  wireTabs();
  wireLog();
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(state: PublicState): void {
  current = state;
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
