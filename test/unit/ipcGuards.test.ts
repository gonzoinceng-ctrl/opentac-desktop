import { describe, expect, it } from 'vitest';
import {
  IPC,
  isActionName,
  isAppSettingsPatch,
  isClearEngineKeyPayload,
  isExternalUrl,
  isPrefsPatch,
  isSaveEngineKeyPayload,
  isSaveEngineSettingsPayload,
  isSetAiKeyPayload,
  isSetAiPayload,
  isUsbChoice,
} from '../../src/shared/ipc.js';
import { isAllowedSender } from '../../src/main/policy.js';

const ENGINE = 'http://127.0.0.1:4173';
const SETUP_FRAME = 'app://setup/index.html';
const PICKER_FRAME = 'app://setup/usb-picker.html';
const ENGINE_FRAME = 'http://127.0.0.1:4173/';

const setupOnly = [
  IPC.getState,
  IPC.action,
  IPC.setPrefs,
  IPC.setAi,
  IPC.setAiKey,
  IPC.testAi,
  IPC.setAppSettings,
  IPC.getEngineKeys,
  IPC.saveEngineKey,
  IPC.clearEngineKey,
  IPC.getEngineSettings,
  IPC.saveEngineSettings,
  IPC.listOllamaModels,
  IPC.usbPickerList,
  IPC.usbPickerChoose,
];
const shared = [IPC.getVersions, IPC.openExternal, IPC.openLogsFolder];

describe('isAllowedSender', () => {
  it.each(setupOnly)('%s accepts only app://setup/ frames', (ch) => {
    expect(isAllowedSender(SETUP_FRAME, ch, ENGINE)).toBe(true);
    expect(isAllowedSender(PICKER_FRAME, ch, ENGINE)).toBe(true);
    expect(isAllowedSender(ENGINE_FRAME, ch, ENGINE)).toBe(false);
    expect(isAllowedSender('https://example.com/', ch, ENGINE)).toBe(false);
    expect(isAllowedSender('app://setup.evil/index.html', ch, ENGINE)).toBe(false);
    expect(isAllowedSender('app://setup', ch, ENGINE)).toBe(false);
    expect(isAllowedSender('file:///app/index.html', ch, ENGINE)).toBe(false);
  });

  it.each(shared)('%s accepts the setup window and the engine page', (ch) => {
    expect(isAllowedSender(SETUP_FRAME, ch, ENGINE)).toBe(true);
    expect(isAllowedSender(ENGINE_FRAME, ch, ENGINE)).toBe(true);
    expect(isAllowedSender(`${ENGINE}/some/path?x=1`, ch, ENGINE)).toBe(true);
  });

  it.each(shared)('%s refuses foreign origins and spoofs', (ch) => {
    expect(isAllowedSender('https://example.com/', ch, ENGINE)).toBe(false);
    expect(isAllowedSender('http://127.0.0.1:4174/', ch, ENGINE)).toBe(false);
    expect(isAllowedSender('http://127.0.0.1:4173.evil.com/', ch, ENGINE)).toBe(false);
    expect(isAllowedSender('http://127.0.0.1:4173@evil.com/', ch, ENGINE)).toBe(false);
  });

  it('refuses the engine page when no engine origin is known', () => {
    expect(isAllowedSender(ENGINE_FRAME, IPC.getVersions)).toBe(false);
    expect(isAllowedSender(ENGINE_FRAME, IPC.getVersions, null)).toBe(false);
    expect(isAllowedSender(SETUP_FRAME, IPC.getVersions)).toBe(true);
  });

  it('refuses missing frames and unknown channels', () => {
    expect(isAllowedSender(null, IPC.getVersions, ENGINE)).toBe(false);
    expect(isAllowedSender(undefined, IPC.getVersions, ENGINE)).toBe(false);
    expect(isAllowedSender('', IPC.getVersions, ENGINE)).toBe(false);
    expect(isAllowedSender(SETUP_FRAME, 'opentac:nope', ENGINE)).toBe(false);
    expect(isAllowedSender(SETUP_FRAME, IPC.stateEvent, ENGINE)).toBe(false);
    expect(isAllowedSender(SETUP_FRAME, 'getVersions', ENGINE)).toBe(false);
  });
});

describe('payload guards used by the handlers', () => {
  it('isActionName', () => {
    expect(isActionName('retry')).toBe(true);
    expect(isActionName('showLogs')).toBe(true);
    expect(isActionName('rm -rf')).toBe(false);
    expect(isActionName(undefined)).toBe(false);
    expect(isActionName({})).toBe(false);
  });
  it('isExternalUrl', () => {
    expect(isExternalUrl('https://github.com/x')).toBe(true);
    expect(isExternalUrl('mailto:a@b.co')).toBe(true);
    expect(isExternalUrl('http://example.com')).toBe(false);
    expect(isExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isExternalUrl(`https://a.com/${'x'.repeat(3000)}`)).toBe(false);
    expect(isExternalUrl(5)).toBe(false);
  });
  it('isPrefsPatch', () => {
    expect(isPrefsPatch({ channel: 'stable' })).toBe(true);
    expect(isPrefsPatch({ updateCheckOnLaunch: false })).toBe(true);
    expect(isPrefsPatch({ channel: 'main' })).toBe(false);
    expect(isPrefsPatch({ extra: 1 })).toBe(false);
    expect(isPrefsPatch(null)).toBe(false);
    expect(isPrefsPatch([])).toBe(false);
  });
  it('isSetAiPayload', () => {
    expect(isSetAiPayload({ provider: 'ollama', model: 'qwen3:8b', ollamaHost: 'http://127.0.0.1:11434' })).toBe(true);
    expect(isSetAiPayload({ provider: 'nope', model: null, ollamaHost: null })).toBe(false);
    expect(isSetAiPayload({ provider: 'openai', model: null, ollamaHost: 'ftp://x' })).toBe(false);
    expect(isSetAiPayload({ provider: 'openai', model: null, ollamaHost: null, extra: 1 })).toBe(false);
  });
  it('isSetAiKeyPayload', () => {
    expect(isSetAiKeyPayload({ provider: 'xai', key: 'abc' })).toBe(true);
    expect(isSetAiKeyPayload({ provider: 'xai', key: '' })).toBe(true);
    expect(isSetAiKeyPayload({ provider: 'openai', key: 'abc' })).toBe(false);
    expect(isSetAiKeyPayload({ provider: 'xai', key: 'a b' })).toBe(false);
    expect(isSetAiKeyPayload({ provider: 'xai', key: 'x'.repeat(600) })).toBe(false);
  });
  it('isActionName knows the two new maintenance actions', () => {
    expect(isActionName('openDataFolder')).toBe(true);
    expect(isActionName('forgetUsbDevices')).toBe(true);
  });
  it('isAppSettingsPatch is re-exported for the handlers', () => {
    expect(isAppSettingsPatch({ launchAtLogin: true })).toBe(true);
    expect(isAppSettingsPatch({ proxy: { httpsProxy: 'http://p:1' } })).toBe(true);
    expect(isAppSettingsPatch({ proxy: { httpsProxy: 'javascript:alert(1)' } })).toBe(false);
    expect(isAppSettingsPatch({ engineRemoteUrl: 'file:///x.git', logLevel: 'warn' })).toBe(true);
    expect(isAppSettingsPatch({ engineRemoteUrl: 'ssh://x/y.git' })).toBe(false);
  });
  it('isSaveEngineKeyPayload', () => {
    expect(isSaveEngineKeyPayload({ values: { AISSTREAM_API_KEY: 'abc123' } })).toBe(true);
    expect(isSaveEngineKeyPayload({ values: { OPENSKY_CLIENT_ID: 'a', OPENSKY_CLIENT_SECRET: 'b' } })).toBe(true);
    expect(isSaveEngineKeyPayload({ values: {} })).toBe(false);
    expect(isSaveEngineKeyPayload({ values: { AISSTREAM_API_KEY: '' } })).toBe(false);
    expect(isSaveEngineKeyPayload({ values: { AISSTREAM_API_KEY: 'a b' } })).toBe(false);
    expect(isSaveEngineKeyPayload({ values: { AISSTREAM_API_KEY: 'a\nb' } })).toBe(false);
    expect(isSaveEngineKeyPayload({ values: { AISSTREAM_API_KEY: 'a$b' } })).toBe(false);
    expect(isSaveEngineKeyPayload({ values: { AISSTREAM_API_KEY: 'x'.repeat(513) } })).toBe(false);
    expect(isSaveEngineKeyPayload({ values: { 'bad name': 'abc' } })).toBe(false);
    expect(isSaveEngineKeyPayload({ values: { aisstream_api_key: 'abc' } })).toBe(false);
    expect(isSaveEngineKeyPayload({ values: { A: 'b' }, extra: 1 })).toBe(false);
    expect(isSaveEngineKeyPayload({ values: [] })).toBe(false);
    expect(isSaveEngineKeyPayload(null)).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 17 }, (_v, i) => [`KEY_${i}`, 'abc']));
    expect(isSaveEngineKeyPayload({ values: many })).toBe(false);
  });
  it('isClearEngineKeyPayload', () => {
    expect(isClearEngineKeyPayload({ id: 'aisstream' })).toBe(true);
    expect(isClearEngineKeyPayload({ id: 'google-maps-server' })).toBe(true);
    expect(isClearEngineKeyPayload({ id: 'AISSTREAM' })).toBe(false);
    expect(isClearEngineKeyPayload({ id: '../x' })).toBe(false);
    expect(isClearEngineKeyPayload({ id: 'a', extra: 1 })).toBe(false);
    expect(isClearEngineKeyPayload({})).toBe(false);
  });
  it('isSaveEngineSettingsPayload', () => {
    expect(isSaveEngineSettingsPayload({ patch: { CCTV_MAX_SOURCES: '4000', PHOTON_URL: null } })).toBe(true);
    expect(isSaveEngineSettingsPayload({ patch: { PHOTON_URL: '' } })).toBe(true);
    expect(isSaveEngineSettingsPayload({ patch: {} })).toBe(false);
    expect(isSaveEngineSettingsPayload({ patch: { CCTV_MAX_SOURCES: 5 } })).toBe(false);
    expect(isSaveEngineSettingsPayload({ patch: { CCTV_MAX_SOURCES: 'a\nHOST=0.0.0.0' } })).toBe(false);
    expect(isSaveEngineSettingsPayload({ patch: { 'bad key': '1' } })).toBe(false);
    expect(isSaveEngineSettingsPayload({ patch: { X: 'x'.repeat(1025) } })).toBe(false);
    expect(isSaveEngineSettingsPayload({ patch: { X: '1' }, extra: 1 })).toBe(false);
    expect(isSaveEngineSettingsPayload([])).toBe(false);
    const big = Object.fromEntries(Array.from({ length: 201 }, (_v, i) => [`K_${i}`, '1']));
    expect(isSaveEngineSettingsPayload({ patch: big })).toBe(false);
  });
  it('isUsbChoice', () => {
    expect(isUsbChoice(null)).toBe(true);
    expect(isUsbChoice('abc')).toBe(true);
    expect(isUsbChoice('')).toBe(false);
    expect(isUsbChoice(3)).toBe(false);
    expect(isUsbChoice(undefined)).toBe(false);
  });
});
