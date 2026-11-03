import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { exec } from 'dugite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createCheckoutManager,
  GitError,
  parseCloneProgress,
  parseCommitLog,
  parseDirtyReport,
  redactRemoteUrl,
} from '../../src/main/checkout.js';
import { createGitRunner, redactGitText } from '../../src/main/git.js';
import { createLogger } from '../../src/main/logger.js';

describe('redactRemoteUrl', () => {
  it('hides a password in userinfo', () => {
    expect(redactRemoteUrl('https://someone:ghp_secret@github.com/org/repo.git')).toBe(
      'https://***@github.com/org/repo.git',
    );
  });

  it('hides a bare token in userinfo', () => {
    const out = redactRemoteUrl('https://ghp_secret@github.com/org/repo.git');
    expect(out).not.toContain('ghp_secret');
    expect(out).toContain('github.com/org/repo.git');
  });

  it('drops the whole query string and fragment', () => {
    expect(redactRemoteUrl('https://host.example/org/repo.git?access_token=secret')).toBe(
      'https://host.example/org/repo.git',
    );
    expect(redactRemoteUrl('https://host.example/org/repo.git?sneaky=secret&x=1#frag')).toBe(
      'https://host.example/org/repo.git',
    );
    expect(redactRemoteUrl('https://user:pw@host.example/org/repo.git?token=secret')).toBe(
      'https://***@host.example/org/repo.git',
    );
  });

  it('leaves ordinary remotes unchanged', () => {
    const url = 'https://github.com/bilawalsidhu/gods-eye-view.git';
    expect(redactRemoteUrl(url)).toBe(url);
    expect(redactRemoteUrl('git@github.com:bilawalsidhu/gods-eye-view.git')).toBe(
      'git@github.com:bilawalsidhu/gods-eye-view.git',
    );
    expect(redactRemoteUrl('file:///tmp/mirror.git')).toBe('file:///tmp/mirror.git');
    expect(redactRemoteUrl('/tmp/mirror.git')).toBe('/tmp/mirror.git');
    expect(redactRemoteUrl('')).toBe('');
  });
});

describe('redactGitText', () => {
  it('redacts URLs embedded in git messages and keeps surrounding punctuation', () => {
    const out = redactGitText(
      "fatal: unable to access 'https://user:tok@github.com/o/r.git/': Could not resolve host",
    );
    expect(out).not.toContain('tok');
    expect(out).toContain("'https://***@github.com/o/r.git/'");
    expect(redactGitText('see https://h.example/x?token=abc.')).toBe('see https://h.example/x.');
  });
});

describe('parseCloneProgress', () => {
  it('parses each phase', () => {
    expect(parseCloneProgress('Receiving objects:  45% (1234/2718)')).toEqual({
      phase: 'receiving',
      pct: 45,
    });
    expect(parseCloneProgress('remote: Counting objects: 100% (10/10), done.')).toEqual({
      phase: 'counting',
      pct: 100,
    });
    expect(parseCloneProgress('remote: Compressing objects:  3% (1/30)')).toEqual({
      phase: 'compressing',
      pct: 3,
    });
    expect(parseCloneProgress('Resolving deltas: 100% (50/50), done.')).toEqual({
      phase: 'resolving',
      pct: 100,
    });
    expect(parseCloneProgress('Updating files:  99% (990/1000)')).toEqual({
      phase: 'updating',
      pct: 99,
    });
  });

  it('returns null for other lines', () => {
    expect(parseCloneProgress("Cloning into 'checkout'...")).toBeNull();
    expect(parseCloneProgress('')).toBeNull();
    expect(parseCloneProgress('Receiving objects: 250% (1/2)')).toBeNull();
    expect(parseCloneProgress('Enumerating objects: 12% (1/8)')).toBeNull();
  });
});

describe('parseDirtyReport', () => {
  it('is clean for empty output', () => {
    expect(parseDirtyReport('')).toEqual({ dirty: false, modified: [], untracked: [], raw: '' });
  });

  it('separates modified from untracked', () => {
    const raw = ' M src/a.ts\nM  src/b.ts\n D gone.txt\n?? new.txt\n?? dir/deep.txt\n';
    const r = parseDirtyReport(raw);
    expect(r.dirty).toBe(true);
    expect(r.modified).toEqual(['src/a.ts', 'src/b.ts', 'gone.txt']);
    expect(r.untracked).toEqual(['new.txt', 'dir/deep.txt']);
    expect(r.raw).toBe(raw);
  });

  it('handles renames, quoted paths and ignored entries', () => {
    const r = parseDirtyReport('R  old.txt -> new.txt\n?? "a b.txt"\n!! .env\n');
    expect(r.modified).toEqual(['new.txt']);
    expect(r.untracked).toEqual(['a b.txt']);
  });
});

describe('parseCommitLog', () => {
  it('parses NUL-separated lines and skips malformed ones', () => {
    const out = [
      ['a'.repeat(40), 'aaaaaaa', 'Fix: thing', 'Ann', '2026-11-01T10:00:00+00:00'].join('\0'),
      'garbage line',
      ['b'.repeat(40), 'bbbbbbb', '', 'Bob', '2026-10-31T09:00:00+00:00'].join('\0'),
      '',
    ].join('\n');
    expect(parseCommitLog(out)).toEqual([
      {
        sha: 'a'.repeat(40),
        short: 'aaaaaaa',
        subject: 'Fix: thing',
        author: 'Ann',
        date: '2026-11-01T10:00:00+00:00',
      },
      {
        sha: 'b'.repeat(40),
        short: 'bbbbbbb',
        subject: '',
        author: 'Bob',
        date: '2026-10-31T09:00:00+00:00',
      },
    ]);
    expect(parseCommitLog('')).toEqual([]);
  });
});

interface FakeChild extends EventEmitter {
  stderr: EventEmitter;
  kill(signal?: NodeJS.Signals): boolean;
}

function makeLogger(): { lines: string[]; log: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  const push = (m: string): void => void lines.push(m);
  return { lines, log: createLogger({ info: push, warn: push, error: push, debug: push }) };
}

type ExecArgs = Parameters<typeof exec>;

describe('createGitRunner', () => {
  function runnerWith(
    impl: (args: ExecArgs[0], cwd: string, options: NonNullable<ExecArgs[2]>) => Promise<unknown>,
    killGraceMs = 30,
  ): { runner: ReturnType<typeof createGitRunner>; lines: string[] } {
    const { lines, log } = makeLogger();
    const runner = createGitRunner({
      gitDir: '/fake/git',
      log,
      baseEnv: { HOME: '/fake/home' },
      killGraceMs,
      execImpl: ((args: ExecArgs[0], cwd: string, options: NonNullable<ExecArgs[2]>) =>
        impl(args, cwd, options)) as unknown as typeof exec,
    });
    return { runner, lines };
  }

  it('passes a locked-down environment and returns the result', async () => {
    let seen: Record<string, string | undefined> = {};
    const { runner, lines } = runnerWith(async (_a, _c, o) => {
      seen = o.env ?? {};
      return { stdout: 'out', stderr: '', exitCode: 0 };
    });
    const res = await runner.run(['status'], '/repo', { env: { EXTRA: '1' } });
    expect(res).toMatchObject({ code: 0, stdout: 'out', stderr: '' });
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(seen['LOCAL_GIT_DIRECTORY']).toBe('/fake/git');
    expect(seen['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(seen['GIT_CONFIG_NOSYSTEM']).toBe('1');
    expect(seen['GIT_ASKPASS']).toBe('');
    expect(seen['SSH_ASKPASS']).toBe('');
    expect(seen['LC_ALL']).toBe('C');
    expect(seen['HOME']).toBe('/fake/home');
    expect(seen['PATH']).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
    expect(seen['EXTRA']).toBe('1');
    expect(seen['GIT_DIR']).toBeUndefined();
    expect(lines.some((l) => l.includes('git status') && l.includes('took'))).toBe(true);
  });

  it('does not let poisoned inherited GIT_* variables reach git', async () => {
    const poisoned = {
      GIT_SSH_COMMAND: 'evil-ssh',
      GIT_PROXY_COMMAND: 'evil-proxy',
      GIT_EXEC_PATH: '/evil',
      GIT_CONFIG_GLOBAL: '/evil/gitconfig',
      GIT_CONFIG_PARAMETERS: "'core.pager=evil'",
      GIT_COMMON_DIR: '/evil/common',
      GIT_NAMESPACE: 'evil',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/evil/objects',
      GIT_CEILING_DIRECTORIES: '/evil',
      GIT_SSH: 'evil-ssh',
      GIT_SOMETHING_NEW: 'x',
    };
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(poisoned)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      let seen: Record<string, string | undefined> = {};
      const { runner } = runnerWith(async (_a, _c, o) => {
        seen = o.env ?? {};
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      await runner.run(['status'], '/repo');
      for (const k of Object.keys(poisoned)) {
        expect(k in seen, `${k} must be present as an explicit unset`).toBe(true);
        expect(seen[k], k).toBeUndefined();
      }
      expect(seen['GIT_TERMINAL_PROMPT']).toBe('0');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('adds only the three proxy variables from proxyEnv, read on every call', async () => {
    const seen: Array<Record<string, string | undefined>> = [];
    let proxy: Record<string, string> = {};
    const { log } = makeLogger();
    const runner = createGitRunner({
      gitDir: '/fake/git',
      log,
      baseEnv: { HOME: '/fake/home' },
      proxyEnv: () => proxy,
      execImpl: (async (_a: ExecArgs[0], _c: string, o: NonNullable<ExecArgs[2]>) => {
        seen.push(o.env ?? {});
        return { stdout: '', stderr: '', exitCode: 0 };
      }) as unknown as typeof exec,
    });
    await runner.run(['status'], '/repo');
    proxy = {
      HTTPS_PROXY: 'http://p:1',
      HTTP_PROXY: 'http://p:1',
      NO_PROXY: 'localhost',
      NODE_USE_ENV_PROXY: '1',
      GIT_SSH_COMMAND: 'evil',
      EXTRA: 'x',
    };
    await runner.run(['status'], '/repo');
    expect(seen[0]?.['HTTPS_PROXY']).toBeUndefined();
    expect(seen[1]?.['HTTPS_PROXY']).toBe('http://p:1');
    expect(seen[1]?.['HTTP_PROXY']).toBe('http://p:1');
    expect(seen[1]?.['NO_PROXY']).toBe('localhost');
    expect(seen[1]?.['NODE_USE_ENV_PROXY']).toBeUndefined();
    expect(seen[1]?.['GIT_SSH_COMMAND']).toBeUndefined();
    expect(seen[1]?.['EXTRA']).toBeUndefined();
  });

  it('keeps the fatal line when stderr is mostly progress output', async () => {
    const progress = Array.from(
      { length: 200 },
      (_v, i) => `Receiving objects:  ${i % 100}% (${i}/200), 1.00 MiB | 2.00 MiB/s`,
    ).join('\r');
    const { runner } = runnerWith(async () => ({
      stdout: '',
      stderr: `Cloning into 'x'...\n${progress}\nfatal: early EOF\nfatal: fetch-pack: invalid index-pack output\n`,
      exitCode: 128,
    }));
    const err = await runner.run(['clone'], '/repo').catch((e: unknown) => e);
    expect((err as GitError).detail).toContain('fatal: early EOF');
    expect((err as GitError).detail).not.toContain('Receiving objects');
  });

  it('truncates long non-progress stderr from the head, keeping the tail', async () => {
    const { runner } = runnerWith(async () => ({
      stdout: '',
      stderr: `${'noise line\n'.repeat(1000)}fatal: the real reason\n`,
      exitCode: 128,
    }));
    const err = await runner.run(['fetch'], '/repo').catch((e: unknown) => e);
    const detail = (err as GitError).detail ?? '';
    expect(detail.length).toBeLessThanOrEqual(4000);
    expect(detail.endsWith('fatal: the real reason')).toBe(true);
  });

  it('logs argv with remote URL credentials redacted', async () => {
    const { runner, lines } = runnerWith(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    await runner.run(['ls-remote', 'https://u:secret123@github.com/o/r.git'], '/repo');
    const joined = lines.join('\n');
    expect(joined).not.toContain('secret123');
    expect(joined).toContain('https://***@github.com/o/r.git');
  });

  it('throws GIT_FAILED with redacted stderr on a non-zero exit', async () => {
    const { runner } = runnerWith(async () => ({
      stdout: '',
      stderr: "fatal: unable to access 'https://u:pw123@h.example/r.git/': nope\n",
      exitCode: 128,
    }));
    const err = await runner.run(['fetch'], '/repo').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe('GIT_FAILED');
    expect((err as GitError).detail).toContain('nope');
    expect((err as GitError).detail).not.toContain('pw123');
    expect((err as GitError).message).not.toContain('\n    at ');
  });

  it('returns non-zero results when expectZero is false', async () => {
    const { runner } = runnerWith(async () => ({ stdout: '', stderr: 'x', exitCode: 1 }));
    const res = await runner.run(['diff', '--quiet'], '/repo', { expectZero: false });
    expect(res.code).toBe(1);
  });

  it('maps launch failures to GIT_FAILED', async () => {
    const { runner } = runnerWith(async () => {
      throw new Error('ENOENT: Git failed to execute.');
    });
    const err = await runner.run(['status'], '/nope').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'GIT_FAILED' });
    expect((err as GitError).detail).toContain('ENOENT');
  });

  it('splits stderr into lines on CR and LF, including the unterminated tail', async () => {
    const got: string[] = [];
    const { runner } = runnerWith(async (_a, _c, o) => {
      const child = new EventEmitter() as FakeChild;
      child.stderr = new EventEmitter();
      child.kill = () => true;
      o.processCallback?.(child as unknown as ChildProcess);
      child.stderr.emit(
        'data',
        Buffer.from('Receiving objects:  1%\rReceiving objects:  2%\rpart'),
      );
      child.stderr.emit('data', 'ial\nlast');
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await runner.run(['clone'], '/repo', { onStderrLine: (l) => got.push(l) });
    expect(got).toEqual(['Receiving objects:  1%', 'Receiving objects:  2%', 'partial', 'last']);
  });

  describe('timeout', () => {
    function hangingExec(opts: { diesOn: 'SIGTERM' | 'SIGKILL' | 'never' }): {
      impl: Parameters<typeof runnerWith>[0];
      signals: string[];
    } {
      const signals: string[] = [];
      const impl: Parameters<typeof runnerWith>[0] = (_a, _c, o) =>
        new Promise((_resolve, reject) => {
          const child = new EventEmitter() as FakeChild;
          child.stderr = new EventEmitter();
          child.kill = (signal = 'SIGTERM') => {
            signals.push(signal);
            if (signal === opts.diesOn) reject(new Error(`killed by ${signal}`));
            return true;
          };
          o.processCallback?.(child as unknown as ChildProcess);
        });
      return { impl, signals };
    }

    it('kills the process with SIGTERM and throws GIT_TIMEOUT', async () => {
      const { impl, signals } = hangingExec({ diesOn: 'SIGTERM' });
      const { runner, lines } = runnerWith(impl);
      const started = Date.now();
      const err = await runner.run(['fetch'], '/repo', { timeoutMs: 40 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitError);
      expect((err as GitError).code).toBe('GIT_TIMEOUT');
      expect(signals).toEqual(['SIGTERM']);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(lines.some((l) => l.includes('timed out'))).toBe(true);
    });

    it('escalates to SIGKILL when SIGTERM is ignored', async () => {
      const { impl, signals } = hangingExec({ diesOn: 'SIGKILL' });
      const { runner } = runnerWith(impl);
      const err = await runner.run(['fetch'], '/repo', { timeoutMs: 40 }).catch((e: unknown) => e);
      expect((err as GitError).code).toBe('GIT_TIMEOUT');
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    });

    it('gives up after the grace period if the process never exits', async () => {
      const { impl, signals } = hangingExec({ diesOn: 'never' });
      const { runner } = runnerWith(impl);
      const err = await runner.run(['fetch'], '/repo', { timeoutMs: 40 }).catch((e: unknown) => e);
      expect((err as GitError).code).toBe('GIT_TIMEOUT');
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    });

    it('does not time out a call that finishes in time', async () => {
      const { runner } = runnerWith(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
      const res = await runner.run(['status'], '/repo', { timeoutMs: 5_000 });
      expect(res.stdout).toBe('ok');
    });
  });
});

describe('clone failure classification with long progress output', () => {
  it('reports NETWORK for a mid-transfer drop after hundreds of progress lines', async () => {
    const progress = Array.from(
      { length: 300 },
      (_v, i) => `Receiving objects: ${i % 100}% (${i}/300), 1.00 MiB | 2.00 MiB/s`,
    ).join('\r');
    expect(progress.length).toBeGreaterThan(4000);
    const { log } = makeLogger();
    const git = createGitRunner({
      gitDir: '/fake/git',
      log,
      baseEnv: { HOME: '/fake/home' },
      execImpl: (async () => ({
        stdout: '',
        stderr: `Cloning into 'x'...\n${progress}\nerror: RPC failed; curl 18 transfer closed\nfatal: early EOF\n`,
        exitCode: 128,
      })) as unknown as typeof exec,
    });
    const root = await mkdtemp(join(tmpdir(), 'opentac-unit-'));
    let err: unknown;
    try {
      const mgr = createCheckoutManager({ checkoutDir: join(root, 'checkout'), git, log });
      err = await mgr
        .clone('https://h.example/x.git', () => undefined)
        .catch((e: unknown) => e);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe('NETWORK');
    expect((err as GitError).detail).toContain('early EOF');
  });
});
