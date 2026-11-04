import { describe, expect, it } from 'vitest';
import { REDACTED, REDACTION_PATTERNS, redact, redactHomeDir } from '../../src/shared/redact.js';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r';

describe('redact patterns', () => {
  it('exports a non-empty pattern list', () => {
    expect(REDACTION_PATTERNS.length).toBeGreaterThan(5);
  });

  it.each([
    ['OpenAI key', 'key sk-abcdEFGH1234567890 end', 'key [REDACTED] end'],
    ['OpenAI project key', 'sk-proj-AbC_dEf-1234567890xyz', REDACTED],
    ['OpenAI service-account key', 'sk-svcacct-AbC_dEf-1234567890xyz', REDACTED],
    ['OpenRouter key', 'sk-or-v1-0123456789abcdef0123456789abcdef', REDACTED],
    ['Google API key', 'AIzaSyA1234567890abcdefghijklmnopqrstuv', REDACTED],
    ['JWT', `token ${JWT} done`, 'token [REDACTED] done'],
    ['bare JWT prefix', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', REDACTED],
    ['GitHub PAT', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', REDACTED],
    ['GitHub OAuth token', 'gho_abcdefghijklmnopqrstuvwxyz0123456789', REDACTED],
    ['GitHub fine-grained PAT', 'github_pat_11ABCDEFG0abcdefghij_klmnopqrstuvwxyz', REDACTED],
    ['xAI key', 'xai-abcdefghijklmnopqrstuvwxyz0123', REDACTED],
    [
      'Bearer header',
      'Authorization: Bearer abc.DEF-123_456~xyz',
      'Authorization: Bearer [REDACTED]',
    ],
    ['URL credentials', 'git clone https://user:p4ss@github.com/a/b', 'git clone https://[REDACTED]@github.com/a/b'],
  ])('redacts %s', (_name, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('redacts only the VALUE of KEY=VALUE secrets and keeps KEY=', () => {
    expect(redact('OPENAI_API_KEY=abc123')).toBe('OPENAI_API_KEY=[REDACTED]');
    expect(redact('export CESIUM_TOKEN = "some value"')).toBe('export CESIUM_TOKEN = [REDACTED]');
    expect(redact('db_password=hunter2 next')).toBe('db_password=[REDACTED] next');
    expect(redact('GITHUB_CLIENT_SECRET=zzz')).toBe('GITHUB_CLIENT_SECRET=[REDACTED]');
    expect(redact('MY_SECRET=\'quoted\'')).toBe('MY_SECRET=[REDACTED]');
  });

  it('leaves non-secret KEY=VALUE lines alone', () => {
    expect(redact('PORT=3000\nNODE_ENV=production')).toBe('PORT=3000\nNODE_ENV=production');
  });
});

describe('redact safety', () => {
  it('redacts every secret in a mixed multi-line sample and keeps the rest', () => {
    const input = [
      '[gev] server starting on 127.0.0.1:5173',
      'OPENAI_API_KEY=sk-live1234567890abcdef',
      `fetch with Bearer ${JWT}`,
      'cloning https://bob:secret@example.com/repo.git at 48146f8e5befe7ea5e0c886149f4a6de825f6ebb',
      'maps key AIzaSyA1234567890abcdefghijklmnopqrstuv ok',
      'version 1.2.3-beta.4 ready',
    ].join('\n');
    const out = redact(input);
    expect(out).toBe(
      [
        '[gev] server starting on 127.0.0.1:5173',
        'OPENAI_API_KEY=[REDACTED]',
        'fetch with Bearer [REDACTED]',
        'cloning https://[REDACTED]@example.com/repo.git at 48146f8e5befe7ea5e0c886149f4a6de825f6ebb',
        'maps key [REDACTED] ok',
        'version 1.2.3-beta.4 ready',
      ].join('\n'),
    );
    expect(out).not.toMatch(/secret@|sk-live|AIza|eyJ/);
  });

  it('is idempotent', () => {
    const input = [
      'OPENAI_API_KEY=sk-live1234567890abcdef',
      `Authorization: Bearer ${JWT}`,
      'https://u:p@host/x',
      'sk-or-v1-0123456789abcdef0123456789abcdef ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      JWT,
    ].join('\n');
    const once = redact(input);
    expect(redact(once)).toBe(once);
  });

  it('leaves a 40-char hex git SHA untouched', () => {
    const sha = '48146f8e5befe7ea5e0c886149f4a6de825f6ebb';
    expect(redact(`commit ${sha}`)).toBe(`commit ${sha}`);
  });

  it('leaves semver and ordinary prose untouched', () => {
    const text = 'Updated to v0.3.0 (24.22.2); the task-force asked for sk-ip logic.';
    expect(redact(text)).toBe(text);
  });

  it('leaves "sk-" followed by only 3 characters untouched', () => {
    expect(redact('prefix sk-abc suffix')).toBe('prefix sk-abc suffix');
  });

  it('does not match sk- inside a longer word', () => {
    expect(redact('task-management-system-long')).toBe('task-management-system-long');
  });
});

describe('redact URL credentials with raw special characters', () => {
  it('redacts a password containing an unencoded "@"', () => {
    const out = redact('git clone https://user:p@ss@host.example/x');
    expect(out).toBe('git clone https://[REDACTED]@host.example/x');
    expect(out).not.toContain('ss@');
  });

  it('redacts a password containing an unencoded "/"', () => {
    expect(redact('https://user:pa/ss@host.example/repo')).toBe(
      'https://[REDACTED]@host.example/repo',
    );
  });

  it('is idempotent for credentialed URLs', () => {
    const once = redact('https://user:p@ss@host/x');
    expect(redact(once)).toBe(once);
  });

  it('leaves URLs without credentials untouched', () => {
    const text = 'open https://example.com:8080/path and http://localhost:3000/';
    expect(redact(text)).toBe(text);
  });
});

describe('redact performance', () => {
  it('handles a 200 KB keyword-dense word with no "=" quickly', () => {
    const line = 'TOKEN'.repeat(40_000);
    const start = performance.now();
    expect(redact(line)).toBe(line);
    expect(performance.now() - start).toBeLessThan(250);
  });

  it('handles 200 KB of repeated URL-credential prefixes quickly', () => {
    const line = 'https://a:'.repeat(20_000);
    const start = performance.now();
    redact(line);
    expect(performance.now() - start).toBeLessThan(250);
  });

  it('still redacts a secret assignment whose key is very long', () => {
    const key = `${'A'.repeat(200)}_TOKEN`;
    expect(redact(`${key}=abc123`)).toBe(`${key}=[REDACTED]`);
  });
});

describe('secret key-name rule is suffix-based', () => {
  it('leaves max_tokens and similar non-secret keys alone', () => {
    expect(redact('max_tokens=200 tokens=5 token_count=9')).toBe('max_tokens=200 tokens=5 token_count=9');
  });
  it('still redacts real secret keys', () => {
    expect(redact('OPENAI_API_KEY=abc123def GITHUB_TOKEN=xyz ACCESS_TOKEN=q client_secret=s')).toBe(
      'OPENAI_API_KEY=[REDACTED] GITHUB_TOKEN=[REDACTED] ACCESS_TOKEN=[REDACTED] client_secret=[REDACTED]',
    );
  });
});

describe('redact: JSON, header and path forms (SEC-03)', () => {
  const HEX40 = 'a3f5c9d1e7b2480f6a1c3d5e7f9b1a2c3d4e5f60';
  it.each([
    ['JSON apiKey', `{"APIKey":"${HEX40}"}`, '{"APIKey":"[REDACTED]"}'],
    ['JSON access_token', '{"access_token":"abcd1234efgh"}', '{"access_token":"[REDACTED]"}'],
    ['x-api-key header', `x-api-key: ${HEX40}`, 'x-api-key: [REDACTED]'],
    ['gateway token header', `x-opentac-gateway-token: ${'ab'.repeat(32)}`, 'x-opentac-gateway-token: [REDACTED]'],
    ['bare Authorization', `Authorization: ${HEX40}`, 'Authorization: [REDACTED]'],
    ['client_secret', 'client_secret: s3cr3t-value', 'client_secret: [REDACTED]'],
    ['password colon', 'password: hunter22', 'password: [REDACTED]'],
    ['FIRMS key in a path', 'GET /api/area/csv/0123456789abcdef0123456789abcdef/VIIRS_SNPP_NRT/world/1', 'GET /api/area/csv/[REDACTED]/VIIRS_SNPP_NRT/world/1'],
    ['Mapillary token', 'access_token=MLY|123456789|0123456789abcdef0123456789abcdef', 'access_token=[REDACTED]'],
    ['bare Mapillary token', 'using MLY|123456789|0123456789abcdef0123456789abcdef now', 'using [REDACTED] now'],
  ])('redacts %s', (_n, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('keeps the Authorization scheme', () => {
    expect(redact('Authorization: Basic dXNlcjpwYXNz')).toBe('Authorization: Basic [REDACTED]');
  });

  it('does not touch commit SHAs, short hex or ordinary words', () => {
    const sha = '48146f8e5befe7ea5e0c886149f4a6de825f6ebb';
    expect(redact(`checked out ${sha} (7322ce5)`)).toBe(`checked out ${sha} (7322ce5)`);
    expect(redact('GET /api/area/csv/world/1 200')).toBe('GET /api/area/csv/world/1 200');
    expect(redact('max_tokens: 200, keyboard layout, tokenizer ready')).toBe(
      'max_tokens: 200, keyboard layout, tokenizer ready',
    );
  });
});

describe('redactHomeDir', () => {
  it('replaces the home directory with ~ at path boundaries only', () => {
    expect(redactHomeDir('/Users/ann/Library/Application Support/OpenTac/logs', '/Users/ann')).toBe(
      '~/Library/Application Support/OpenTac/logs',
    );
    expect(redactHomeDir('at /Users/ann and /Users/annabel/x', '/Users/ann')).toBe('at ~ and /Users/annabel/x');
    expect(redactHomeDir('keep /Users/bob', '')).toBe('keep /Users/bob');
  });
});
