import { describe, expect, it } from 'vitest';
import { createLogger, type LogSink } from '../../src/main/logger.js';

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
