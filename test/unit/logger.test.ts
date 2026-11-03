import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, createServerLogWriter, resolveLogLevels, type LogSink } from '../../src/main/logger.js';

function fakeSink(): { sink: LogSink; out: string[] } {
  const out: string[] = [];
  const sink: LogSink = {
    info: (m) => out.push(`info:${m}`),
    warn: (m) => out.push(`warn:${m}`),
    error: (m) => out.push(`error:${m}`),
    debug: (m) => out.push(`debug:${m}`),
  };
  return { sink, out };
}

describe('createLogger', () => {
  it('routes each level to the matching sink method', () => {
    const { sink, out } = fakeSink();
    const log = createLogger(sink);
    log.info('a');
    log.warn('b');
    log.error('c');
    log.debug('d');
    expect(out).toEqual(['info:a', 'warn:b', 'error:c', 'debug:d']);
  });

  it('redacts secrets by default', () => {
    const { sink, out } = fakeSink();
    createLogger(sink).info('OPENAI_API_KEY=sk-live1234567890abcdef');
    expect(out).toEqual(['info:OPENAI_API_KEY=[REDACTED]']);
  });

  it('does not redact when redact:false', () => {
    const { sink, out } = fakeSink();
    createLogger(sink, { redact: false }).info('sk-live1234567890abcdef');
    expect(out).toEqual(['info:sk-live1234567890abcdef']);
  });

  it('prefixes the scope and nests child scopes', () => {
    const { sink, out } = fakeSink();
    const log = createLogger(sink, { scope: 'server' });
    log.warn('slow');
    log.scope('ready').info('up');
    createLogger(sink).scope('x').debug('y');
    expect(out).toEqual(['warn:[server] slow', 'info:[server:ready] up', 'debug:[x] y']);
  });

  it('child scopes inherit the redact option', () => {
    const { sink, out } = fakeSink();
    createLogger(sink, { redact: false, scope: 'a' }).scope('b').info('sk-live1234567890abcdef');
    expect(out).toEqual(['info:[a:b] sk-live1234567890abcdef']);
  });

  it('renders Errors as message + newline + stack, redacted', () => {
    const { sink, out } = fakeSink();
    const err = new Error('boom sk-live1234567890abcdef');
    err.stack = 'Error: boom\n    at fn (file.ts:1:1)';
    createLogger(sink, { scope: 's' }).error(err);
    expect(out).toEqual(['error:[s] boom [REDACTED]\nError: boom\n    at fn (file.ts:1:1)']);
  });

  it('renders an Error without a stack as its message only', () => {
    const { sink, out } = fakeSink();
    const err = new Error('plain');
    delete err.stack;
    createLogger(sink).error(err);
    expect(out).toEqual(['error:plain']);
  });

  it('time() logs the elapsed duration at info', () => {
    const { sink, out } = fakeSink();
    const clock = [1000, 1234.4];
    let i = 0;
    const log = createLogger(sink, { scope: 'git', now: () => clock[i++] ?? 0 });
    const stop = log.time('clone');
    expect(out).toEqual([]);
    stop();
    expect(out).toEqual(['info:[git] clone took 234ms']);
  });
});

describe('resolveLogLevels', () => {
  it('defaults: file info, console debug unpackaged / warn packaged', () => {
    expect(resolveLogLevels({}, false)).toEqual({ fileLevel: 'info', consoleLevel: 'debug' });
    expect(resolveLogLevels({}, true)).toEqual({ fileLevel: 'info', consoleLevel: 'warn' });
  });

  it('OPENTAC_LOG_LEVEL sets both levels, case-insensitively', () => {
    for (const packaged of [false, true]) {
      expect(resolveLogLevels({ OPENTAC_LOG_LEVEL: 'debug' }, packaged)).toEqual({ fileLevel: 'debug', consoleLevel: 'debug' });
      expect(resolveLogLevels({ OPENTAC_LOG_LEVEL: 'ERROR' }, packaged)).toEqual({ fileLevel: 'error', consoleLevel: 'error' });
      expect(resolveLogLevels({ OPENTAC_LOG_LEVEL: ' Warn ' }, packaged)).toEqual({ fileLevel: 'warn', consoleLevel: 'warn' });
      expect(resolveLogLevels({ OPENTAC_LOG_LEVEL: 'info' }, packaged)).toEqual({ fileLevel: 'info', consoleLevel: 'info' });
    }
  });

  it('ignores unknown or empty values', () => {
    expect(resolveLogLevels({ OPENTAC_LOG_LEVEL: 'verbose' }, true)).toEqual({ fileLevel: 'info', consoleLevel: 'warn' });
    expect(resolveLogLevels({ OPENTAC_LOG_LEVEL: '' }, false)).toEqual({ fileLevel: 'info', consoleLevel: 'debug' });
  });
});

describe('createServerLogWriter', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opentac-serverlog-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const fixed = () => new Date('2026-11-03T20:00:00.000Z');

  it('writes timestamp-prefixed, redacted lines and creates the directory', async () => {
    const file = join(dir, 'nested', 'server.log');
    const w = createServerLogWriter({ file, now: fixed });
    w.write('[gev:stdout] hello');
    w.write('[gev:stderr] OPENAI_API_KEY=sk-live1234567890abcdef\n');
    await w.close();
    expect(readFileSync(file, 'utf8')).toBe(
      '2026-11-03T20:00:00.000Z [gev:stdout] hello\n' +
        '2026-11-03T20:00:00.000Z [gev:stderr] OPENAI_API_KEY=[REDACTED]\n',
    );
  });

  it('appends to an existing file across writers', async () => {
    const file = join(dir, 'server.log');
    writeFileSync(file, 'old\n');
    const w = createServerLogWriter({ file, now: fixed });
    w.write('new');
    await w.close();
    expect(readFileSync(file, 'utf8')).toBe('old\n2026-11-03T20:00:00.000Z new\n');
  });

  it('rotates at maxBytes and keeps at most `keep` archives, newest first', async () => {
    const file = join(dir, 'server.log');
    const w = createServerLogWriter({ file, maxBytes: 100, keep: 3, now: fixed });
    // Each line is 25 (timestamp + space) + 4 + newline = 30 bytes; three fit per file.
    for (let i = 0; i < 30; i++) w.write(`L${String(i).padStart(2, '0')}`.padEnd(4, '.'));
    await w.close();
    const names = readdirSync(dir).sort();
    expect(names).toEqual(['server.log', 'server.log.1', 'server.log.2', 'server.log.3']);
    const read = (n: string): string[] => readFileSync(join(dir, n), 'utf8').trim().split('\n').map((l) => l.slice(25));
    expect(read('server.log')).toEqual(['L27.', 'L28.', 'L29.']);
    expect(read('server.log.1')).toEqual(['L24.', 'L25.', 'L26.']);
    expect(read('server.log.2')).toEqual(['L21.', 'L22.', 'L23.']);
    expect(read('server.log.3')).toEqual(['L18.', 'L19.', 'L20.']);
    expect(existsSync(join(dir, 'server.log.4'))).toBe(false);
  });

  it('rotates a pre-existing oversize file on the first write', async () => {
    const file = join(dir, 'server.log');
    writeFileSync(file, 'x'.repeat(200));
    const w = createServerLogWriter({ file, maxBytes: 100, keep: 2, now: fixed });
    w.write('fresh');
    await w.close();
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('x'.repeat(200));
    expect(readFileSync(file, 'utf8')).toBe('2026-11-03T20:00:00.000Z fresh\n');
  });

  it('close() flushes everything written and later writes are ignored', async () => {
    const file = join(dir, 'server.log');
    const w = createServerLogWriter({ file, now: fixed });
    for (let i = 0; i < 500; i++) w.write(`line ${i}`);
    await w.close();
    w.write('after close');
    await w.close();
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(500);
    expect(lines[499]).toBe('2026-11-03T20:00:00.000Z line 499');
  });
});
