import { describe, expect, it } from 'vitest';
import {
  IPC,
  isActionName,
  isExternalUrl,
  isPrefsPatch,
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
  it('isUsbChoice', () => {
    expect(isUsbChoice(null)).toBe(true);
    expect(isUsbChoice('abc')).toBe(true);
    expect(isUsbChoice('')).toBe(false);
    expect(isUsbChoice(3)).toBe(false);
    expect(isUsbChoice(undefined)).toBe(false);
  });
});
