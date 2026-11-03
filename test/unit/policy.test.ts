import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decideNavigation,
  decidePermission,
  isWithinDir,
  matchUsbDevice,
  originOf,
  sameUsbIdentity,
  toRememberedUsb,
  validateBounds,
} from '../../src/main/policy.js';

const ENGINE = 'http://127.0.0.1:4173';

describe('originOf', () => {
  it('handles http, https and custom schemes', () => {
    expect(originOf('http://127.0.0.1:4173/a?b=1')).toBe(ENGINE);
    expect(originOf('https://example.com/x')).toBe('https://example.com');
    expect(originOf('app://setup/index.html')).toBe('app://setup');
  });
  it('returns null for junk', () => {
    expect(originOf('not a url')).toBeNull();
    expect(originOf('')).toBeNull();
    expect(originOf('mailto:')).toBeNull();
  });
});

describe('decideNavigation', () => {
  it('allows the engine origin with any path', () => {
    expect(decideNavigation('http://127.0.0.1:4173/', ENGINE)).toBe('allow');
    expect(decideNavigation('http://127.0.0.1:4173/api/x?y=1#z', ENGINE)).toBe('allow');
  });
  it('sends https and mailto to the system', () => {
    expect(decideNavigation('https://github.com/bilawalsidhu/gods-eye-view', ENGINE)).toBe('external');
    expect(decideNavigation('mailto:hi@example.com', ENGINE)).toBe('external');
    expect(decideNavigation('https://example.com', null)).toBe('external');
  });
  it('denies everything else', () => {
    for (const url of [
      'http://example.com/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'ftp://example.com/x',
      'app://evil/x',
      'blob:http://127.0.0.1:4173/abc',
      'garbage',
      '',
    ]) {
      expect(decideNavigation(url, ENGINE), url).toBe('deny');
    }
  });
  it('is not fooled by origin spoofing', () => {
    expect(decideNavigation('http://127.0.0.1:4173.evil.com/', ENGINE)).toBe('deny');
    expect(decideNavigation('http://127.0.0.1:4173@evil.com/', ENGINE)).toBe('deny');
    expect(decideNavigation('http://evil.com/?http://127.0.0.1:4173', ENGINE)).toBe('deny');
    expect(decideNavigation('http://127.0.0.1.evil.com:4173/', ENGINE)).toBe('deny');
  });
  it('denies a different port and a different scheme on the same host', () => {
    expect(decideNavigation('http://127.0.0.1:4174/', ENGINE)).toBe('deny');
    expect(decideNavigation('http://127.0.0.1/', ENGINE)).toBe('deny');
    expect(decideNavigation('https://127.0.0.1:4173/', ENGINE)).toBe('external');
    expect(decideNavigation('http://localhost:4173/', ENGINE)).toBe('deny');
  });
  it('allows nothing local when no engine origin is known', () => {
    expect(decideNavigation('http://127.0.0.1:4173/', null)).toBe('deny');
  });
  it('allows the setup origin when it is the given origin', () => {
    expect(decideNavigation('app://setup/index.html', 'app://setup')).toBe('allow');
    expect(decideNavigation('app://setupx/index.html', 'app://setup')).toBe('deny');
  });
});

describe('decidePermission', () => {
  const allowed = ['usb', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'pointerLock'];
  it.each(allowed)('%s is granted to the engine origin only', (p) => {
    expect(decidePermission(p, ENGINE, ENGINE)).toBe(true);
    expect(decidePermission(p, `${ENGINE}/`, ENGINE)).toBe(true);
    expect(decidePermission(p, 'http://127.0.0.1:4174', ENGINE)).toBe(false);
    expect(decidePermission(p, 'https://example.com', ENGINE)).toBe(false);
    expect(decidePermission(p, ENGINE, null)).toBe(false);
  });
  it('rejects spoofed origins', () => {
    expect(decidePermission('usb', 'http://127.0.0.1:4173.evil.com', ENGINE)).toBe(false);
    expect(decidePermission('usb', 'http://127.0.0.1:4173@evil.com', ENGINE)).toBe(false);
    expect(decidePermission('usb', 'http://evil.com', ENGINE)).toBe(false);
    expect(decidePermission('usb', '', ENGINE)).toBe(false);
    expect(decidePermission('usb', 'null', ENGINE)).toBe(false);
  });
  it('allows media only when every type is audio', () => {
    expect(decidePermission('media', ENGINE, ENGINE, { mediaTypes: ['audio'] })).toBe(true);
    expect(decidePermission('media', ENGINE, ENGINE, { mediaTypes: ['video'] })).toBe(false);
    expect(decidePermission('media', ENGINE, ENGINE, { mediaTypes: ['audio', 'video'] })).toBe(false);
    expect(decidePermission('media', ENGINE, ENGINE, { mediaTypes: [] })).toBe(false);
    expect(decidePermission('media', ENGINE, ENGINE, {})).toBe(false);
    expect(decidePermission('media', ENGINE, ENGINE)).toBe(false);
    expect(decidePermission('media', 'https://example.com', ENGINE, { mediaTypes: ['audio'] })).toBe(false);
  });
  it('denies everything not on the list', () => {
    for (const p of [
      'display-capture',
      'geolocation',
      'notifications',
      'hid',
      'serial',
      'midi',
      'midiSysex',
      'openExternal',
      'fileSystem',
      'unknown',
      '',
    ]) {
      expect(decidePermission(p, ENGINE, ENGINE, { mediaTypes: ['audio'] }), p).toBe(false);
    }
  });
});

describe('matchUsbDevice', () => {
  const dev = { vendorId: 0x0bda, productId: 0x2838, productName: 'RTL2838UHIDIR', serialNumber: '00000001' };
  it('matches on vendor and product alone', () => {
    expect(matchUsbDevice({ vendorId: 0x0bda, productId: 0x2838 }, dev)).toBe(true);
  });
  it('rejects other vendor or product', () => {
    expect(matchUsbDevice({ vendorId: 1, productId: 0x2838 }, dev)).toBe(false);
    expect(matchUsbDevice({ vendorId: 0x0bda, productId: 2 }, dev)).toBe(false);
  });
  it('requires a remembered serial to match', () => {
    expect(matchUsbDevice({ vendorId: 0x0bda, productId: 0x2838, serialNumber: '00000001' }, dev)).toBe(true);
    expect(matchUsbDevice({ vendorId: 0x0bda, productId: 0x2838, serialNumber: '00000002' }, dev)).toBe(false);
    expect(
      matchUsbDevice({ vendorId: 0x0bda, productId: 0x2838, serialNumber: '00000001' }, { ...dev, serialNumber: undefined }),
    ).toBe(false);
  });
  it('requires a remembered product name to match, ignores absent fields', () => {
    expect(matchUsbDevice({ vendorId: 0x0bda, productId: 0x2838, productName: 'RTL2838UHIDIR' }, dev)).toBe(true);
    expect(matchUsbDevice({ vendorId: 0x0bda, productId: 0x2838, productName: 'Other' }, dev)).toBe(false);
    expect(matchUsbDevice({ vendorId: 0x0bda, productId: 0x2838, productName: null }, dev)).toBe(true);
    expect(matchUsbDevice({ vendorId: 0x0bda, productId: 0x2838 }, { vendorId: 0x0bda, productId: 0x2838 })).toBe(true);
  });
  it('keeps dual-channel boards with one serial apart only by product', () => {
    const a = { vendorId: 1, productId: 2, serialNumber: 'X' };
    expect(matchUsbDevice(a, { vendorId: 1, productId: 2, serialNumber: 'X' })).toBe(true);
    expect(matchUsbDevice(a, { vendorId: 1, productId: 3, serialNumber: 'X' })).toBe(false);
  });
});

describe('isWithinDir', () => {
  const base = '/app/dist/renderer/setup';
  it('accepts the directory and anything below it', () => {
    expect(isWithinDir(base, base)).toBe(true);
    expect(isWithinDir(base, `${base}/index.html`)).toBe(true);
    expect(isWithinDir(base, `${base}/a/b/c.js`)).toBe(true);
    expect(isWithinDir(`${base}/`, `${base}/index.html`)).toBe(true);
    expect(isWithinDir('/', '/anything')).toBe(true);
  });
  it('rejects siblings with a shared prefix', () => {
    expect(isWithinDir(base, `${base}-evil/index.html`)).toBe(false);
    expect(isWithinDir(base, '/app/dist/renderer/setup2')).toBe(false);
  });
  it('rejects traversal', () => {
    expect(isWithinDir(base, `${base}/../../../etc/passwd`)).toBe(false);
    expect(isWithinDir(base, `${base}/a/../../x`)).toBe(false);
    expect(isWithinDir(base, '/etc/passwd')).toBe(false);
    expect(isWithinDir(base, `${base}/a/../b.js`)).toBe(true);
  });
  it('rejects NUL bytes', () => {
    expect(isWithinDir(base, `${base}/index.html\0.png`)).toBe(false);
  });
});

describe('validateBounds', () => {
  const work = { x: 0, y: 25, width: 1920, height: 1055 };
  const def = { width: 1440, height: 900 };
  const min = { width: 1024, height: 640 };
  it('uses the default size when nothing was saved', () => {
    expect(validateBounds(null, work, def, min)).toEqual({ width: 1440, height: 900 });
  });
  it('keeps a visible saved position and size', () => {
    expect(validateBounds({ x: 100, y: 100, width: 1200, height: 800 }, work, def, min)).toEqual({
      x: 100,
      y: 100,
      width: 1200,
      height: 800,
    });
  });
  it('drops a position that is off every screen', () => {
    expect(validateBounds({ x: 5000, y: 100, width: 1200, height: 800 }, work, def, min)).toEqual({
      width: 1200,
      height: 800,
    });
    expect(validateBounds({ x: -1190, y: 100, width: 1200, height: 800 }, work, def, min)).toEqual({
      width: 1200,
      height: 800,
    });
  });
  it('clamps size to the minimum and to the work area', () => {
    expect(validateBounds({ width: 100, height: 100 }, work, def, min)).toEqual({ width: 1024, height: 640 });
    expect(validateBounds({ width: 9999, height: 9999 }, work, def, min)).toEqual({ width: 1920, height: 1055 });
  });
  it('keeps the title bar below the top of the work area', () => {
    expect(validateBounds({ x: 10, y: -300, width: 1200, height: 800 }, work, def, min)).toMatchObject({ x: 10, y: 25 });
  });
  it('ignores non-finite numbers', () => {
    expect(validateBounds({ x: Number.NaN, y: 1, width: Number.NaN, height: 5 }, work, def, min)).toEqual({
      width: 1440,
      height: 900,
    });
  });
});

describe('remembered USB identity', () => {
  const chanA = { vendorId: 0x0bda, productId: 0x2838, serialNumber: '00000001', productName: 'RTL2838UHIDIR A' };
  const chanB = { ...chanA, productName: 'RTL2838UHIDIR B' };

  it('keeps productName and serial in the remembered entry', () => {
    expect(toRememberedUsb({ ...chanA })).toEqual(chanA);
    expect(toRememberedUsb({ vendorId: 1, productId: 2, serialNumber: '', productName: null })).toEqual({
      vendorId: 1,
      productId: 2,
    });
  });
  it('a pick of one channel does not grant a sibling that shares vendor, product and serial', () => {
    const remembered = toRememberedUsb(chanA);
    expect(matchUsbDevice(remembered, chanA)).toBe(true);
    expect(matchUsbDevice(remembered, chanB)).toBe(false);
  });
  it('treats entries with different product names as different identities', () => {
    expect(sameUsbIdentity(toRememberedUsb(chanA), toRememberedUsb(chanB))).toBe(false);
    expect(sameUsbIdentity(toRememberedUsb(chanA), toRememberedUsb({ ...chanA }))).toBe(true);
  });
});

describe('shell URLs', () => {
  it('index.ts ships no placeholder repository owner and points at the app repo', () => {
    const src = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bOWNER\b/);
    expect(src).toContain('https://github.com/gonzoinceng-ctrl/opentac-desktop/issues');
    expect(src).not.toContain('gonzoinceng-ctrl/opentac/');
  });
});
