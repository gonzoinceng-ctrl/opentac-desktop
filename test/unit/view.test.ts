import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTION_NAMES, PHASES } from '../../src/shared/ipc.js';
import type { Disclosure, EngineKeyRow, EngineKeysPublic, PublicState, UsbDevicePublic } from '../../src/shared/ipc.js';
import { CCTV_REGIONS, ENGINE_SETTINGS_CATALOG, findSetting } from '../../src/shared/engineSettingsCatalog.js';
import type { SettingDef } from '../../src/shared/engineSettingsCatalog.js';
import {
  APP_NEXT_LAUNCH_NOTE,
  ATTRIBUTION,
  ENGINE_SETTINGS_RESTARTING,
  ENGINE_SETTINGS_RESTART_NOTE,
  LOG_LEVEL_OPTIONS,
  PREFERENCE_TABS,
  SETTINGS_MAP,
  UPDATE_INTERVAL_OPTIONS,
  buildSettingsPatch,
  catalogKeyIds,
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
  KEY_LOCK_CAVEAT,
  VOICE_CAVEAT,
  dirtyFileLines,
  disclosureBlockNote,
  closeOverlayActions,
  disclosureButtons,
  formatBytes,
  formatCommitCount,
  formatDate,
  formatDisclosureSummary,
  formatGateLine,
  formatUsbIds,
  gateLineText,
  isNearBottom,
  labelForAction,
  moveSelection,
  panelForPhase,
  phaseNote,
  phaseTitle,
  progressValue,
  untestedBanner,
  usbDeviceDetail,
  usbDeviceTitle,
} from '../../src/renderer/setup/view.js';

function disclosure(over: Partial<Disclosure> = {}): Disclosure {
  return {
    remote: 'https://github.com/gonzoinceng-ctrl/opentac-engine.git',
    channel: 'stable',
    fromCommit: 'a'.repeat(40),
    toCommit: 'b'.repeat(40),
    fromLabel: 'v0.3.0',
    toLabel: 'stable-2026.11.01',
    commitCount: 12,
    truncated: false,
    commits: [],
    diffStat: ' 3 files changed',
    lockfileChanged: false,
    compareUrl: 'https://github.com/o/r/compare/a...b',
    dirty: { modified: [], untracked: [] },
    needsReset: false,
    untested: false,
    gate: { gateRun: 'https://github.com/o/r/actions/runs/1', canaryDays: '3', testedOn: '2026-11-01T10:00:00Z' },
    minShell: null,
    severity: 'normal',
    blockedByShell: false,
    ...over,
  };
}

function pstate(over: Partial<PublicState> = {}): Pick<
  PublicState,
  'phase' | 'preferencesOpen' | 'aboutOpen' | 'disclosure' | 'error'
> {
  return { phase: 'RUNNING', preferencesOpen: false, aboutOpen: false, disclosure: null, error: null, ...over };
}

describe('panelForPhase', () => {
  it('shows progress for working phases', () => {
    for (const phase of ['BOOT', 'CLONING', 'INSTALLING', 'STARTING', 'RUNNING', 'CHECKING', 'UPDATING', 'RESTARTING', 'ROLLING_BACK'] as const) {
      expect(panelForPhase(pstate({ phase }))).toBe('progress');
    }
  });

  it('shows disclosure only when there is a disclosure', () => {
    expect(panelForPhase(pstate({ phase: 'DISCLOSING', disclosure: disclosure() }))).toBe('disclosure');
    expect(panelForPhase(pstate({ phase: 'DISCLOSING' }))).toBe('progress');
  });

  it('shows crash and error panels', () => {
    expect(panelForPhase(pstate({ phase: 'CRASHED' }))).toBe('crash');
    const error = { code: 'X', title: 't', message: 'm', detail: null, actions: [] };
    expect(panelForPhase(pstate({ phase: 'ERROR', error }))).toBe('error');
    expect(panelForPhase(pstate({ phase: 'ERROR' }))).toBe('progress');
  });

  it('lets preferences then about override the phase panel', () => {
    expect(panelForPhase(pstate({ phase: 'CRASHED', aboutOpen: true }))).toBe('about');
    expect(panelForPhase(pstate({ phase: 'CRASHED', aboutOpen: true, preferencesOpen: true }))).toBe('preferences');
  });
});

describe('phaseTitle and phaseNote', () => {
  it('has a non-empty plain title for every phase', () => {
    for (const p of PHASES) {
      const t = phaseTitle(p);
      expect(t.length).toBeGreaterThan(3);
      expect(t).not.toMatch(/[A-Z_]{5,}/);
    }
  });

  it('gives honest first-run copy for cloning and installing', () => {
    expect(phaseNote('CLONING')).toContain('~200 MB');
    expect(phaseNote('CLONING')).toContain('~400 MB');
    expect(phaseNote('CLONING')).toContain('GitHub and npm');
    expect(phaseNote('INSTALLING')).toContain('npm');
    expect(phaseNote('RUNNING')).toBeNull();
  });
});

describe('labelForAction', () => {
  it('labels every action and keeps the specified wording', () => {
    for (const a of ACTION_NAMES) expect(labelForAction(a).length).toBeGreaterThan(0);
    expect(labelForAction('confirmUpdate')).toBe('Update');
    expect(labelForAction('laterUpdate')).toBe('Later');
    expect(labelForAction('skipUpdate')).toBe('Skip this version');
    expect(labelForAction('showLogs')).toBe('Show Logs');
    expect(labelForAction('restartServer')).toBe('Restart');
    expect(labelForAction('reinstall')).toMatch(/^Reinstall/);
  });

  it('keeps app-update and engine-update labels separate', () => {
    expect(labelForAction('checkForUpdates')).toMatch(/engine/i);
    expect(labelForAction('checkForAppUpdates')).toMatch(/OpenTac/);
    expect(labelForAction('checkForAppUpdates')).not.toMatch(/engine/i);
  });
});

describe('formatBytes', () => {
  it('formats common sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(400 * 1024 * 1024)).toBe('400 MB');
    expect(formatBytes(2.25 * 1024 ** 3)).toBe('2.3 GB');
  });

  it('is safe on bad input', () => {
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});

describe('formatDate', () => {
  it('formats ISO dates in UTC', () => {
    expect(formatDate('2026-11-03T23:59:59Z')).toBe('3 Nov 2026');
    expect(formatDate('2026-01-15')).toBe('15 Jan 2026');
  });

  it('passes through unparseable text and empties null', () => {
    expect(formatDate('last Tuesday')).toBe('last Tuesday');
    expect(formatDate(null)).toBe('');
    expect(formatDate('')).toBe('');
  });
});

describe('disclosure formatting', () => {
  it('summarises from to and commit count', () => {
    expect(formatDisclosureSummary(disclosure())).toBe('From v0.3.0 to stable-2026.11.01: 12 commits');
    expect(formatDisclosureSummary(disclosure({ commitCount: 1 }))).toBe('From v0.3.0 to stable-2026.11.01: 1 commit');
    expect(formatCommitCount(50, true)).toBe('50 commits (list shortened)');
  });

  it('builds the stable gate line', () => {
    const g = formatGateLine(disclosure());
    expect(g).not.toBeNull();
    expect(g?.before).toBe('Tested by OpenTac on 1 Nov 2026, gate run ');
    expect(g?.link?.url).toBe('https://github.com/o/r/actions/runs/1');
    expect(g?.after).toBe(', canary 3 days');
    expect(gateLineText(disclosure({ gate: { gateRun: null, canaryDays: '1', testedOn: '2026-11-01' } }))).toBe(
      'Tested by OpenTac on 1 Nov 2026, canary 1 day',
    );
  });

  it('does not make a link from a non-URL gate run', () => {
    const g = formatGateLine(disclosure({ gate: { gateRun: 'javascript:alert(1)', canaryDays: null, testedOn: null } }));
    expect(g?.link).toBeNull();
    expect(g?.before).toBe('Tested by OpenTac, gate run javascript:alert(1)');
  });

  it('shows no gate line when untested or missing', () => {
    expect(formatGateLine(disclosure({ untested: true, channel: 'candidate' }))).toBeNull();
    expect(formatGateLine(disclosure({ gate: null }))).toBeNull();
  });

  it('shows an untested banner for non-stable channels only', () => {
    expect(untestedBanner(disclosure())).toBeNull();
    expect(untestedBanner(disclosure({ channel: 'upstream', untested: true }))).toMatch(/^Untested/);
    expect(untestedBanner(disclosure({ channel: 'candidate', untested: true }))).toMatch(/canary/i);
  });

  it('lists dirty files', () => {
    const d = disclosure({ dirty: { modified: ['a.js'], untracked: ['b.txt'] } });
    expect(dirtyFileLines(d)).toEqual(['Changed: a.js', 'New: b.txt']);
  });

  it('chooses buttons for each state', () => {
    expect(disclosureButtons(disclosure())).toEqual(['confirmUpdate', 'laterUpdate', 'skipUpdate']);
    expect(disclosureButtons(disclosure({ needsReset: true }))).toEqual(['resetAndUpdate', 'laterUpdate', 'skipUpdate']);
    expect(disclosureButtons(disclosure({ dirty: { modified: ['x'], untracked: [] } }))[0]).toBe('resetAndUpdate');
    expect(disclosureButtons(disclosure({ blockedByShell: true, minShell: '9.0.0' }))).toEqual([
      'checkForAppUpdates',
      'laterUpdate',
    ]);
  });

  it('explains blocked and reset states', () => {
    expect(disclosureBlockNote(disclosure())).toBeNull();
    expect(disclosureBlockNote(disclosure({ blockedByShell: true, minShell: '9.0.0' }))).toContain('Update OpenTac first');
    expect(disclosureBlockNote(disclosure({ blockedByShell: true, minShell: '9.0.0' }))).toContain('9.0.0');
    expect(disclosureBlockNote(disclosure({ needsReset: true }))).toMatch(/older version/);
    expect(disclosureBlockNote(disclosure({ dirty: { modified: ['x'], untracked: [] } }))).toMatch(/local changes/);
  });
});

describe('progress and scroll helpers', () => {
  it('clamps progress and treats null as indeterminate', () => {
    expect(progressValue(null)).toBeNull();
    expect(progressValue(undefined)).toBeNull();
    expect(progressValue(Number.NaN)).toBeNull();
    expect(progressValue(-4)).toBe(0);
    expect(progressValue(55)).toBe(55);
    expect(progressValue(140)).toBe(100);
  });

  it('detects the bottom of a scroller', () => {
    expect(isNearBottom(800, 200, 1000)).toBe(true);
    expect(isNearBottom(795, 200, 1000)).toBe(true);
    expect(isNearBottom(500, 200, 1000)).toBe(false);
  });
});

describe('usb helpers', () => {
  const dev: UsbDevicePublic = { deviceId: 'd1', vendorId: 0x0bda, productId: 0x2838, productName: 'RTL2838UHIDIR', serialNumber: '00000001' };

  it('formats ids, titles and detail', () => {
    expect(formatUsbIds(dev)).toBe('0bda:2838');
    expect(usbDeviceTitle(dev)).toBe('RTL2838UHIDIR');
    expect(usbDeviceTitle({ productName: null })).toBe('Unknown USB device');
    expect(usbDeviceDetail(dev)).toBe('Vendor 0bda, product 2838, serial 00000001');
    expect(usbDeviceDetail({ ...dev, serialNumber: null, vendorId: 1, productId: 2 })).toBe(
      'Vendor 0001, product 0002, no serial number',
    );
  });

  it('moves a selection with wrap-around', () => {
    expect(moveSelection(-1, 1, 3)).toBe(0);
    expect(moveSelection(-1, -1, 3)).toBe(2);
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(0, -1, 3)).toBe(2);
    expect(moveSelection(0, 1, 0)).toBe(-1);
  });
});

describe('static html', () => {
  const dir = path.resolve(import.meta.dirname, '../../src/renderer/setup');
  const index = readFileSync(path.join(dir, 'index.html'), 'utf8');
  const usb = readFileSync(path.join(dir, 'usb-picker.html'), 'utf8');

  it('carries the strict CSP and no inline script or style', () => {
    const csp = `default-src 'self'; style-src 'self'; img-src 'self' data:`;
    for (const html of [index, usb]) {
      expect(html).toContain(csp);
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
      expect(html).not.toMatch(/\sstyle="/);
      expect(html).not.toMatch(/<style/);
      expect(html).not.toMatch(/\son[a-z]+="/);
    }
  });

  it('carries the attribution line and the two fixed AI caveats', () => {
    expect(index).toContain(ATTRIBUTION);
    expect(index).toContain(VOICE_CAVEAT);
    expect(index).toContain(KEY_LOCK_CAVEAT);
  });

  it('has an element for every id the renderer looks up', () => {
    const src = readFileSync(path.join(dir, 'setup.ts'), 'utf8');
    const ids = new Set<string>();
    for (const m of src.matchAll(/byId(?:<[^>]*>)?\('([a-z0-9-]+)'\)/g)) ids.add(m[1] as string);
    for (const m of src.matchAll(/byId(?:<[^>]*>)?\(`([^`]+)`\)/g)) {
      const tpl = m[1] as string;
      if (tpl.startsWith('panel-')) for (const p of ['progress', 'disclosure', 'crash', 'error', 'about', 'preferences']) ids.add(tpl.replace('${id}', p));
      if (tpl.startsWith('tab-') || tpl.startsWith('tabpanel-')) for (const t of PREFERENCE_TABS) ids.add(tpl.replace('${t}', t.id));
      if (tpl.includes('key-') || tpl.includes('state-key-')) for (const p of ['openrouter', 'xai']) ids.add(tpl.replace('${p}', p).replace('${provider}', p));
    }
    const missing = [...ids].filter((id) => !index.includes(`id="${id}"`));
    expect(missing).toEqual([]);
  });
});

describe('closeOverlayActions', () => {
  it('closing About runs openPreferences then closePreferences so both overlays end closed', () => {
    expect(closeOverlayActions({ preferencesOpen: false, aboutOpen: true })).toEqual([
      'openPreferences',
      'closePreferences',
    ]);
  });
  it('closing Preferences, or with nothing open, is a single closePreferences', () => {
    expect(closeOverlayActions({ preferencesOpen: true, aboutOpen: false })).toEqual(['closePreferences']);
    expect(closeOverlayActions({ preferencesOpen: true, aboutOpen: true })).toEqual(['closePreferences']);
    expect(closeOverlayActions({ preferencesOpen: false, aboutOpen: false })).toEqual(['closePreferences']);
  });
});

describe('Preferences tabs', () => {
  const dir = path.resolve(import.meta.dirname, '../../src/renderer/setup');
  const index = readFileSync(path.join(dir, 'index.html'), 'utf8');

  it('lists General, Updates, API keys, AI summaries, Engine settings, App settings in order', () => {
    expect(PREFERENCE_TABS.map((t) => t.label)).toEqual([
      'General',
      'Updates',
      'API keys',
      'AI summaries',
      'Engine settings',
      'App settings',
    ]);
  });

  it('has a tab button and a tab panel in index.html for each tab, wired together', () => {
    for (const t of PREFERENCE_TABS) {
      expect(index).toContain(`id="tab-${t.id}"`);
      expect(index).toContain(`aria-controls="tabpanel-${t.id}"`);
      expect(index).toContain(`id="tabpanel-${t.id}"`);
      expect(index).toMatch(new RegExp(`id="tab-${t.id}"[^>]*>${t.label}<`));
    }
    expect(index.match(/role="tab"/g)).toHaveLength(6);
    expect(index.match(/role="tabpanel"/g)).toHaveLength(6);
  });

  it('keeps every earlier item reachable', () => {
    for (const id of [
      'pref-update-on-launch', 'btn-check-engine', 'btn-check-app', 'btn-show-logs', 'channel-warning',
      'ai-provider', 'ai-model', 'btn-save-ai', 'btn-test-ai', 'key-openrouter', 'key-xai',
    ]) {
      expect(index, id).toContain(`id="${id}"`);
    }
    expect(index.match(/name="channel"/g)).toHaveLength(3);
  });

  it('the OpenRouter and xAI keys sit in the API keys tab under their own heading', () => {
    const keys = index.slice(index.indexOf('id="tabpanel-keys"'), index.indexOf('id="tabpanel-ai"'));
    expect(keys).toContain('OpenTac AI summaries');
    expect(keys).toContain('id="key-openrouter"');
    expect(keys).toContain('id="key-xai"');
    expect(keys).toContain('id="keys-list"');
    const ai = index.slice(index.indexOf('id="tabpanel-ai"'), index.indexOf('id="tabpanel-engine"'));
    expect(ai).not.toContain('id="key-openrouter"');
  });

  it('every control in the new tabs has a visible label or an aria-label', () => {
    const app = index.slice(index.indexOf('id="tabpanel-app"'), index.indexOf('id="btn-prefs-close"'));
    for (const m of app.matchAll(/<(input|select)\b[^>]*\bid="([^"]+)"/g)) {
      const id = m[2] as string;
      const labelled = app.includes(`for="${id}"`) || new RegExp(`<label[^>]*>[^<]*<input[^>]*id="${id}"`).test(app);
      expect(labelled, id).toBe(true);
    }
  });

  it('the general tab points at every other tab', () => {
    expect(SETTINGS_MAP.map((m) => m.tab).sort()).toEqual(['ai', 'app', 'channel', 'engine', 'keys']);
  });

  it('the App settings tab carries the mirror warning verbatim', () => {
    expect(index).toContain('Only change this to point at your own mirror; the default is the OpenTac mirror.');
    expect(index).toContain('id="btn-reset-remote"');
  });

  it('exposes the choices for the interval and log level', () => {
    expect(UPDATE_INTERVAL_OPTIONS.map((o) => o.value)).toEqual(['launch-only', '6h', 'daily']);
    expect(LOG_LEVEL_OPTIONS.map((o) => o.value)).toEqual(['default', 'error', 'warn', 'info', 'debug']);
    expect(APP_NEXT_LAUNCH_NOTE).toContain('next time OpenTac starts');
  });

  it('new actions have labels and maintenance buttons follow the phase', () => {
    expect(labelForAction('openDataFolder')).toBe('Open data folder');
    expect(labelForAction('forgetUsbDevices')).toBe('Forget remembered USB devices');
    expect(resetEngineFilesEnabled('ERROR')).toBe(true);
    expect(resetEngineFilesEnabled('RUNNING')).toBe(false);
    expect(reinstallEnabled('RUNNING')).toBe(true);
    expect(reinstallEnabled('CRASHED')).toBe(true);
    expect(reinstallEnabled('UPDATING')).toBe(false);
  });
});

function keyRow(over: Partial<EngineKeyRow> = {}): EngineKeyRow {
  return {
    id: 'aisstream',
    title: 'AISSTREAM',
    unlocks: 'Live ships, worldwide',
    getUrl: 'https://aisstream.io',
    envVars: ['AISSTREAM_API_KEY'],
    tier: 'free',
    clientExposed: false,
    set: false,
    managed: null,
    lock: null,
    advanced: false,
    ...over,
  };
}

describe('API key rows', () => {
  it('state: locked wins over set wins over not set', () => {
    expect(keyRowState(keyRow())).toEqual({ kind: 'unset', label: 'Not set' });
    expect(keyRowState(keyRow({ set: true }))).toEqual({ kind: 'set', label: 'Set' });
    expect(keyRowState(keyRow({ set: true, lock: 'Locked: x' }))).toEqual({ kind: 'locked', label: 'Locked' });
  });

  it('is editable only against the live engine and when not locked', () => {
    const live = { source: 'engine' as const };
    const fallback = { source: 'fallback' as const };
    expect(keyRowEditable(keyRow(), live)).toBe(true);
    expect(keyRowEditable(keyRow(), fallback)).toBe(false);
    expect(keyRowEditable(keyRow({ lock: 'x' }), live)).toBe(false);
  });

  it('tier badges, titles and labels are plain words', () => {
    expect(keyTierLabel('free')).toBe('Free key');
    expect(keyTierLabel('metered')).toBe('Billing account');
    expect(keyTierLabel('paid')).toBe('Optional paid');
    expect(keyTitle('GOOGLE MAPS')).toBe('Google Maps');
    expect(keyTitle('NASA FIRMS')).toBe('NASA FIRMS');
    expect(keyTitle('AISSTREAM')).toBe('AISStream');
    expect(keyTitle('OPENAI')).toBe('OpenAI');
    expect(keyTitle('CESIUM ION')).toBe('Cesium ion');
    expect(keyTitle('LAUNCH LIBRARY')).toBe('Launch Library');
    expect(keyTitle('GOOGLE MAPS — SERVER')).toBe('Google Maps — Server');
    expect(keyInputLabel(keyRow(), 'AISSTREAM_API_KEY')).toBe('AISSTREAM key (AISSTREAM_API_KEY)');
    expect(keyInputLabel(keyRow({ envVars: ['A_ID', 'A_SECRET'] }), 'A_SECRET')).toBe('AISSTREAM A_SECRET');
  });

  it('splits advanced rows and summarises', () => {
    const list: EngineKeysPublic = {
      source: 'engine',
      keys: [keyRow(), keyRow({ id: 'google-maps-server', advanced: true })],
      setCount: 3,
      total: 10,
      store: 'env-file',
      note: null,
    };
    const { main, advanced } = splitKeyRows(list);
    expect(main.map((k) => k.id)).toEqual(['aisstream']);
    expect(advanced.map((k) => k.id)).toEqual(['google-maps-server']);
    expect(keysSummary(list)).toBe('3 of 10 keys are set.');
  });

  it('result messages are sentences and never echo a value', () => {
    expect(keyResultMessage({ ok: true, restarting: true, code: null, message: null }, 'saved')).toContain('restarting itself');
    expect(keyResultMessage({ ok: true, restarting: true, code: null, message: null }, 'removed')).toContain('Key removed');
    expect(keyResultMessage({ ok: false, restarting: false, code: 'locked', message: 'Locked: switch back.' }, 'saved')).toBe('Locked: switch back.');
    expect(keyResultMessage({ ok: false, restarting: false, code: 'x', message: null }, 'saved')).toBe('The key was not saved.');
  });

  it('the static catalogue has the 11 registry ids for the fallback list', () => {
    expect(catalogKeyIds()).toHaveLength(11);
  });
});

describe('engine settings field models', () => {
  const empty = { values: {}, set: {} };
  const def = (key: string): SettingDef => {
    const d = findSetting(key);
    if (d === undefined) throw new Error(`no ${key}`);
    return d;
  };

  it('every catalogue setting yields a model with a label and a description', () => {
    for (const g of ENGINE_SETTINGS_CATALOG) {
      for (const m of groupFieldModels(g, empty)) {
        expect(m.label.length).toBeGreaterThan(2);
        expect(m.description.length).toBeGreaterThan(10);
        expect(['text', 'number', 'select', 'password']).toContain(m.kind);
        expect(m.isSet).toBe(false);
      }
    }
  });

  it('booleans become Default / On / Off, with the default spelled out', () => {
    const m = settingFieldModel(def('GEV_VOICE_LOG_CONTENT'), empty);
    expect(m.kind).toBe('select');
    expect(m.options.map((o) => o.label)).toEqual(['Default (off)', 'On', 'Off']);
    expect(m.warning).toContain('Privacy');
    expect(settingFieldModel(def('GEV_VOICE_LOG_CONTENT'), { values: { GEV_VOICE_LOG_CONTENT: '1' }, set: { GEV_VOICE_LOG_CONTENT: true } }).value).toBe('on');
    expect(settingFieldModel(def('GEV_PREFER_CODEX_OAUTH'), { values: { GEV_PREFER_CODEX_OAUTH: 'false' }, set: { GEV_PREFER_CODEX_OAUTH: true } }).value).toBe('off');
  });

  it('numbers carry range and step; enums list their options', () => {
    const n = settingFieldModel(def('OPENAI_REALTIME_CONTEXT_TOKENS'), empty);
    expect(n).toMatchObject({ kind: 'number', min: 1000, max: 12000, step: '1', placeholder: '3000' });
    expect(settingFieldModel(def('OPENAI_REALTIME_CONTEXT_RETENTION'), empty).step).toBe('any');
    const e = settingFieldModel(def('OPENSKY_AUTH_MODE'), { values: { OPENSKY_AUTH_MODE: 'anon' }, set: { OPENSKY_AUTH_MODE: true } });
    expect(e.value).toBe('anon');
    expect(e.options.map((o) => o.value)).toEqual(['', 'oauth', 'auto', 'anon']);
  });

  it('secrets never show a value, only whether one is saved', () => {
    const unset = settingFieldModel(def('ONTARIO_511_API_KEY'), empty);
    expect(unset).toMatchObject({ kind: 'password', value: '', secret: true, placeholder: 'Not set' });
    const saved = settingFieldModel(def('ONTARIO_511_API_KEY'), { values: {}, set: { ONTARIO_511_API_KEY: true } });
    expect(saved.value).toBe('');
    expect(saved.placeholder).toBe('Saved. Type to replace it.');
  });

  it('PHOTON_URL offers a turn-off checkbox', () => {
    expect(settingFieldModel(def('PHOTON_URL'), empty).canDisable).toBe(true);
    expect(settingFieldModel(def('NOMINATIM_URL'), empty).canDisable).toBe(false);
  });

  it('region rows show the effective state (value, else the default)', () => {
    const rows = regionRowModels(CCTV_REGIONS, {
      values: { CCTV_TFL_ENABLED: '0', CCTV_NYC_ENABLED: '1', CCTV_HK_MAX_SOURCES: '500', CCTV_TXDOT_DISTRICTS: '' },
      set: { CCTV_TFL_ENABLED: true, CCTV_NYC_ENABLED: true, CCTV_HK_MAX_SOURCES: true, CCTV_TXDOT_DISTRICTS: true },
    });
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(rows).toHaveLength(23);
    expect(by['TFL']?.enabled).toBe(false);
    expect(by['FINTRAFFIC']?.enabled).toBe(true);
    expect(by['NYC']?.enabled).toBe(true);
    expect(by['LITHUANIA']?.enabled).toBe(false);
    expect(by['HK']).toMatchObject({ max: '500', maxMin: 8, maxMax: 1200, maxPlaceholder: '1100' });
    expect(by['AUSTIN']).toMatchObject({ enabledKey: null, maxKey: 'CCTV_AUSTIN_MAX_SOURCES' });
    expect(by['WARENDORF']).toMatchObject({ maxKey: null });
    expect(by['A22']).toMatchObject({ maxKey: null, urlKey: 'CCTV_A22_URL' });
    expect(by['TXDOT']).toMatchObject({ districts: '', districtsPlaceholder: 'AUS,SAT' });
  });
});

describe('buildSettingsPatch', () => {
  const group = (id: string) => {
    const g = ENGINE_SETTINGS_CATALOG.find((x) => x.id === id);
    if (g === undefined) throw new Error(id);
    return g;
  };
  const patchFor = (id: string, current: { values: Record<string, string>; set: Record<string, boolean> }, inputs: Record<string, { value: string; off?: boolean }>) =>
    buildSettingsPatch(group(id).settings, group(id).regions ?? [], current, inputs);
  const empty = { values: {}, set: {} };

  it('sends nothing when nothing changed', () => {
    expect(patchFor('voice', empty, { OPENAI_REALTIME_VOICE: { value: '' }, GEV_VOICE_LOG_CONTENT: { value: '' } })).toEqual({});
    const stored = { values: { OPENAI_REALTIME_VOICE: 'cedar' }, set: { OPENAI_REALTIME_VOICE: true } };
    expect(patchFor('voice', stored, { OPENAI_REALTIME_VOICE: { value: 'cedar' } })).toEqual({});
  });

  it('sets a new or changed value, clears an emptied one', () => {
    expect(patchFor('voice', empty, { OPENAI_REALTIME_VOICE: { value: 'cedar' } })).toEqual({ OPENAI_REALTIME_VOICE: 'cedar' });
    const stored = { values: { OPENAI_REALTIME_MODEL: 'gpt-x' }, set: { OPENAI_REALTIME_MODEL: true } };
    expect(patchFor('voice', stored, { OPENAI_REALTIME_MODEL: { value: 'gpt-y' } })).toEqual({ OPENAI_REALTIME_MODEL: 'gpt-y' });
    expect(patchFor('voice', stored, { OPENAI_REALTIME_MODEL: { value: '  ' } })).toEqual({ OPENAI_REALTIME_MODEL: null });
    expect(patchFor('voice', empty, { OPENAI_REALTIME_MODEL: { value: '' } })).toEqual({});
  });

  it('booleans: On/Off write, Default clears', () => {
    expect(patchFor('voice', empty, { GEV_VOICE_LOG_CONTENT: { value: 'on' } })).toEqual({ GEV_VOICE_LOG_CONTENT: '1' });
    expect(patchFor('voice', empty, { GEV_PREFER_CODEX_OAUTH: { value: 'off' } })).toEqual({ GEV_PREFER_CODEX_OAUTH: 'false' });
    const on = { values: { GEV_VOICE_LOG_CONTENT: '1' }, set: { GEV_VOICE_LOG_CONTENT: true } };
    expect(patchFor('voice', on, { GEV_VOICE_LOG_CONTENT: { value: 'on' } })).toEqual({});
    expect(patchFor('voice', on, { GEV_VOICE_LOG_CONTENT: { value: '' } })).toEqual({ GEV_VOICE_LOG_CONTENT: null });
  });

  it('a secret is sent only when typed', () => {
    expect(patchFor('feeds', empty, { ONTARIO_511_API_KEY: { value: '' } })).toEqual({});
    expect(patchFor('feeds', { values: {}, set: { ONTARIO_511_API_KEY: true } }, { ONTARIO_511_API_KEY: { value: '' } })).toEqual({});
    expect(patchFor('feeds', empty, { ONTARIO_511_API_KEY: { value: 'abc-123' } })).toEqual({ ONTARIO_511_API_KEY: 'abc-123' });
  });

  it('Turn this off writes an empty assignment; unchecking removes it', () => {
    expect(patchFor('feeds', empty, { PHOTON_URL: { value: '', off: true } })).toEqual({ PHOTON_URL: '' });
    const off = { values: { PHOTON_URL: '' }, set: { PHOTON_URL: true } };
    expect(patchFor('feeds', off, { PHOTON_URL: { value: '', off: true } })).toEqual({});
    expect(patchFor('feeds', off, { PHOTON_URL: { value: '', off: false } })).toEqual({ PHOTON_URL: null });
    expect(patchFor('feeds', off, { PHOTON_URL: { value: 'https://p.example/api/', off: false } })).toEqual({ PHOTON_URL: 'https://p.example/api/' });
  });

  it('CCTV: region checkboxes write only when they differ from the effective state', () => {
    const inputs = {
      CCTV_TFL_ENABLED: { value: 'true' }, // default on, stays on: nothing
      CCTV_NYC_ENABLED: { value: 'true' }, // default off, now on: write 1
      CCTV_FINTRAFFIC_ENABLED: { value: 'false' }, // default on, now off: write 0
      CCTV_HK_MAX_SOURCES: { value: '500' },
      CCTV_TXDOT_DISTRICTS: { value: '', off: true },
      CCTV_MAX_SOURCES: { value: '' },
    };
    expect(patchFor('cctv', empty, inputs)).toEqual({
      CCTV_NYC_ENABLED: '1',
      CCTV_FINTRAFFIC_ENABLED: '0',
      CCTV_HK_MAX_SOURCES: '500',
      CCTV_TXDOT_DISTRICTS: '',
    });
    const stored = { values: { CCTV_TFL_ENABLED: '0' }, set: { CCTV_TFL_ENABLED: true } };
    expect(patchFor('cctv', stored, { CCTV_TFL_ENABLED: { value: 'false' } })).toEqual({});
    expect(patchFor('cctv', stored, { CCTV_TFL_ENABLED: { value: 'true' } })).toEqual({ CCTV_TFL_ENABLED: '1' });
  });

  it('every patch the builder can make for a plain text change is accepted by the validator', async () => {
    const { validateSetting } = await import('../../src/shared/engineSettingsCatalog.js');
    const p = patchFor('limits', empty, { GEV_RATELIMIT_OPENAI_PER_MIN: { value: '60' }, TOMTOM_DAILY_TILE_BUDGET: { value: '5000' } });
    for (const [k, v] of Object.entries(p)) expect(validateSetting(k, v as string).ok, k).toBe(true);
  });
});

describe('settings result messages', () => {
  it('describes success, restart and refusal as sentences', () => {
    expect(settingsResultMessage({ ok: true, restarting: true, invalid: {}, message: null })).toBe(ENGINE_SETTINGS_RESTARTING);
    expect(ENGINE_SETTINGS_RESTARTING).toBe('Restarting the engine to apply settings…');
    expect(settingsResultMessage({ ok: true, restarting: false, invalid: {}, message: 'Saved. Later.' })).toBe('Saved. Later.');
    expect(settingsResultMessage({ ok: false, restarting: false, invalid: { CCTV_MAX_SOURCES: 'Enter a number.' }, message: 'Nothing was saved.' })).toBe('Enter a number. (CCTV_MAX_SOURCES)');
    expect(settingsResultMessage({ ok: false, restarting: false, invalid: {}, message: null })).toBe('The settings were not saved.');
    expect(ENGINE_SETTINGS_RESTART_NOTE).toContain('restarts the engine');
  });
});
