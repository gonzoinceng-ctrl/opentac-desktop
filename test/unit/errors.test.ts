import { describe, expect, it } from 'vitest';
import { ACTION_NAMES } from '../../src/shared/ipc.js';
import { AiGatewayError } from '../../src/main/aiGateway.js';
import {
  MAX_DETAIL_CHARS,
  ShellError,
  crashUserError,
  errorDetail,
  toUserError,
  type ErrorContext,
} from '../../src/main/errors.js';
import { GitError, type GitErrorCode } from '../../src/main/git.js';
import { InstallError, type InstallErrorCode } from '../../src/main/install.js';
import { ServerError, type ServerErrorCode } from '../../src/main/server.js';

const CONTEXTS: ErrorContext[] = ['clone', 'install', 'start', 'update', 'rollback', 'fetch', 'disk', 'port'];

function expectPlain(e: ReturnType<typeof toUserError>): void {
  expect(e.title.length).toBeGreaterThan(3);
  expect(e.message).toMatch(/[.!]$/);
  expect(e.message + e.title).not.toMatch(/Error:|\bat .*:\d+:\d+|stack/);
  for (const a of e.actions) expect(ACTION_NAMES).toContain(a);
  expect(e.detail === null || e.detail.length <= MAX_DETAIL_CHARS).toBe(true);
}

describe('toUserError: GitError', () => {
  it('NETWORK while cloning offers retry/showLogs/quit', () => {
    const e = toUserError(new GitError('NETWORK', 'Could not reach.', 'fatal: unable to access'), 'clone');
    expect(e.code).toBe('NETWORK');
    expect(e.title).toMatch(/download/i);
    expect(e.actions).toEqual(['retry', 'showLogs', 'quit']);
    expect(e.detail).toContain('unable to access');
  });

  it('NETWORK elsewhere says the installed version still works', () => {
    const e = toUserError(new GitError('NETWORK', 'x'), 'fetch');
    expect(e.code).toBe('NETWORK');
    expect(e.message).toMatch(/already installed still works/);
    expect(e.actions).toEqual(['retry', 'showLogs']);
  });

  it('TAG_DRIFT explains mirror integrity and never offers an automatic recovery', () => {
    const e = toUserError(new GitError('TAG_DRIFT', 'drift', 'would clobber existing tag stable-1'), 'fetch');
    expect(e.code).toBe('TAG_DRIFT');
    expect(e.message).toMatch(/points to different code/);
    expect(e.actions).toEqual(['restartServer', 'showLogs', 'quit']);
    expect(e.actions).not.toContain('retry');
  });

  it('CLONE_FAILED', () => {
    const e = toUserError(new GitError('CLONE_FAILED', 'x', 'fatal: repository not found'), 'clone');
    expect(e.code).toBe('CLONE_FAILED');
    expect(e.actions).toEqual(['retry', 'showLogs', 'quit']);
  });

  it('NOT_A_REPO maps to GIT_FAILED with resetCheckout first', () => {
    const e = toUserError(new GitError('NOT_A_REPO', 'x'), 'start');
    expect(e.code).toBe('GIT_FAILED');
    expect(e.actions[0]).toBe('resetCheckout');
  });

  it('BAD_REF, GIT_TIMEOUT and GIT_FAILED map to GIT_FAILED', () => {
    for (const code of ['BAD_REF', 'GIT_TIMEOUT', 'GIT_FAILED'] as GitErrorCode[]) {
      const e = toUserError(new GitError(code, 'm', 'detail'), 'update');
      expect(e.code).toBe('GIT_FAILED');
      expect(e.actions).toContain('showLogs');
      expectPlain(e);
    }
    expect(toUserError(new GitError('GIT_FAILED', 'm'), 'update').title).toMatch(/update/i);
    expect(toUserError(new GitError('GIT_FAILED', 'm'), 'fetch').title).not.toMatch(/update/i);
  });
});

describe('toUserError: InstallError', () => {
  const cases: Array<[InstallErrorCode, string, string]> = [
    ['NPM_FAILED', 'NPM_FAILED', 'retry'],
    ['NETWORK', 'NETWORK', 'retry'],
    ['DISK_FULL', 'DISK_FULL', 'retry'],
    ['TIMEOUT', 'NPM_FAILED', 'retry'],
    ['ABORTED', 'NPM_FAILED', 'retry'],
    ['NO_LOCKFILE', 'NPM_FAILED', 'resetCheckout'],
  ];
  for (const [input, code, firstAction] of cases) {
    it(`${input} -> ${code}`, () => {
      const e = toUserError(new InstallError(input, 'sentence.', 'npm error tail'), 'install');
      expect(e.code).toBe(code);
      expect(e.actions[0]).toBe(firstAction);
      expect(e.actions).toContain('showLogs');
      expectPlain(e);
    });
  }

  it('DISK_FULL mentions free space', () => {
    expect(toUserError(new InstallError('DISK_FULL', 'x'), 'install').message).toMatch(/free/);
  });
});

describe('toUserError: ServerError', () => {
  const cases: Array<[ServerErrorCode, string, string]> = [
    ['EADDRINUSE', 'EADDRINUSE', 'changePort'],
    ['START_FAILED', 'START_FAILED', 'reinstall'],
    ['START_TIMEOUT', 'START_TIMEOUT', 'reinstall'],
    ['VITE_MISSING', 'VITE_MISSING', 'reinstall'],
    ['ABORTED', 'START_FAILED', 'retry'],
    ['ALREADY_RUNNING', 'START_FAILED', 'restartServer'],
  ];
  for (const [input, code, mustHave] of cases) {
    it(`${input} -> ${code}`, () => {
      const e = toUserError(new ServerError(input, 'sentence.', { detail: 'line1\nline2\nline3\nline4' }), 'start');
      expect(e.code).toBe(code);
      expect(e.actions).toContain(mustHave);
      expect(e.actions).toContain('showLogs');
      expectPlain(e);
      expect(e.detail).toBe('line2 | line3 | line4');
    });
  }

  it('EADDRINUSE in the port context is PORT_IN_USE with changePort', () => {
    const e = toUserError(new ServerError('EADDRINUSE', 'x'), 'port');
    expect(e.code).toBe('PORT_IN_USE');
    expect(e.actions).toEqual(['retry', 'changePort', 'showLogs']);
    expect(e.message).toMatch(/reset/);
  });
});

describe('toUserError: controller and plain errors', () => {
  it('ShellError DISK_SPACE reports the free space', () => {
    const e = toUserError(new ShellError('DISK_SPACE', 'x', { freeBytes: 1.5 * 1024 ** 3 }), 'disk');
    expect(e.code).toBe('DISK_SPACE');
    expect(e.message).toContain('1.5 GB');
    expect(e.actions).toEqual(['retry', 'showLogs', 'quit']);
  });

  it('ShellError PORT_IN_USE', () => {
    const e = toUserError(new ShellError('PORT_IN_USE', 'Port 4173 is busy.'), 'port');
    expect(e.code).toBe('PORT_IN_USE');
    expect(e.actions).toContain('changePort');
  });

  it('disk and port contexts map unknown errors to their own codes', () => {
    expect(toUserError(new Error('statfs failed'), 'disk').code).toBe('DISK_SPACE');
    expect(toUserError(new Error('nope'), 'port').code).toBe('PORT_IN_USE');
  });

  it('ENOSPC from node maps to DISK_FULL', () => {
    const err = Object.assign(new Error('write failed'), { code: 'ENOSPC' });
    expect(toUserError(err, 'update').code).toBe('DISK_FULL');
  });

  it('AiGatewayError points at the preferences', () => {
    const e = toUserError(new AiGatewayError('NO_KEY', 'no key is set'), 'start');
    expect(e.code).toBe('START_FAILED');
    expect(e.actions).toContain('openPreferences');
    expect(e.message).toContain('no key is set');
  });

  it('plain errors and thrown strings become UNKNOWN with the raw line as detail', () => {
    const e = toUserError(new Error('kaboom'), 'start');
    expect(e.code).toBe('UNKNOWN');
    expect(e.detail).toBe('kaboom');
    expectPlain(e);
    expect(toUserError('just a string', 'start').detail).toBe('just a string');
    expect(toUserError(undefined, 'start').detail).toBeNull();
  });
});

describe('contexts and options', () => {
  it('rollback context fixes the action list and the title but keeps the code', () => {
    const e = toUserError(new ServerError('START_FAILED', 'x'), 'rollback');
    expect(e.code).toBe('START_FAILED');
    expect(e.title).toBe("Couldn't go back to the previous version");
    expect(e.actions).toEqual(['retry', 'reinstall', 'showLogs']);
    const n = toUserError(new InstallError('NETWORK', 'x'), 'rollback');
    expect(n.code).toBe('NETWORK');
    expect(n.actions).toEqual(['retry', 'reinstall', 'showLogs']);
  });

  it('canRollback inserts a rollback button after the first action', () => {
    const e = toUserError(new ServerError('START_FAILED', 'x'), 'start', { canRollback: true });
    expect(e.actions).toEqual(['retry', 'rollback', 'reinstall', 'showLogs']);
    expect(toUserError(new ServerError('START_FAILED', 'x'), 'start').actions).not.toContain('rollback');
    // Never offered in the rollback context itself.
    expect(toUserError(new ServerError('START_FAILED', 'x'), 'rollback', { canRollback: true }).actions).not.toContain(
      'rollback',
    );
  });

  it('every error produced for every context only uses known action names', () => {
    const errors: unknown[] = [
      new GitError('GIT_FAILED', 'x'),
      new InstallError('NPM_FAILED', 'x'),
      new ServerError('START_FAILED', 'x'),
      new AiGatewayError('BACKEND', 'x'),
      new ShellError('DISK_SPACE', 'x'),
      new Error('x'),
    ];
    for (const ctx of CONTEXTS) for (const err of errors) expectPlain(toUserError(err, ctx, { canRollback: true }));
  });
});

describe('detail', () => {
  it('redacts secrets and URL credentials', () => {
    const d = errorDetail(
      new GitError('GIT_FAILED', 'x', 'fatal: unable to access https://user:hunter2@github.com/o/r.git/ OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789'),
    );
    expect(d).not.toContain('hunter2');
    expect(d).not.toContain('sk-abcdef');
  });

  it('caps at 400 characters', () => {
    const d = errorDetail(new Error('x'.repeat(2000)));
    expect(d?.length).toBe(MAX_DETAIL_CHARS);
    expect(d?.endsWith('…')).toBe(true);
  });

  it('prefers the detail over the message and keeps the last three lines', () => {
    const d = errorDetail(new InstallError('NPM_FAILED', 'Sentence.', 'a\n\nb\nc\nd'));
    expect(d).toBe('b | c | d');
    expect(errorDetail(new InstallError('NPM_FAILED', 'Sentence only.'))).toBe('Sentence only.');
  });
});

describe('crashUserError', () => {
  it('describes an exit code and offers restart, logs and reinstall', () => {
    const e = crashUserError({ code: 3, signal: null }, 'TypeError: boom');
    expect(e.message).toContain('exited with code 3');
    expect(e.detail).toBe('TypeError: boom');
    expect(e.actions).toEqual(['restartServer', 'showLogs', 'reinstall']);
  });

  it('describes a signal', () => {
    const e = crashUserError({ code: null, signal: 'SIGKILL' }, null);
    expect(e.message).toContain('SIGKILL');
    expect(e.detail).toBeNull();
  });
});
