import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTION_NAMES, PHASES } from '../../src/shared/ipc.js';
import type { Disclosure, PublicState, UsbDevicePublic } from '../../src/shared/ipc.js';
import {
  ATTRIBUTION,
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
      if (tpl.startsWith('tab-') || tpl.startsWith('tabpanel-')) for (const t of ['general', 'channel', 'ai']) ids.add(tpl.replace('${t}', t));
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
