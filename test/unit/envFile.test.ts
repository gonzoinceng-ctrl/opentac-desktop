import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envFileHasKey, envFileKeys } from '../../src/main/envFile.js';

let dir = '';
let file = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opentac-env-'));
  file = join(dir, '.env');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function keys(text: string): Promise<string[]> {
  await writeFile(file, text);
  return [...(await envFileKeys(file))].sort();
}

describe('envFileKeys', () => {
  it('returns an empty set for a missing file', async () => {
    expect((await envFileKeys(join(dir, 'nope'))).size).toBe(0);
    expect(await envFileHasKey(join(dir, 'nope'), 'A')).toBe(false);
  });

  it('reads plain assignments', async () => {
    expect(await keys('A=1\nB=two words\n')).toEqual(['A', 'B']);
  });

  it('skips empty values, including empty quotes and whitespace', async () => {
    expect(await keys('A=\nB=""\nC=\'\'\nD=   \nE="  "\nF=x\n')).toEqual(['F']);
  });

  it('handles export prefixes', async () => {
    expect(await keys('export A=1\nexport   B="2"\nexport C=\n')).toEqual(['A', 'B']);
  });

  it('handles double and single quotes, with # and = inside', async () => {
    expect(await keys('A="a # b"\nB=\'x=y\'\n')).toEqual(['A', 'B']);
  });

  it('ignores comment lines and inline comments', async () => {
    expect(await keys('# A=1\n  # B=2\nC=3 # note\nD= # only comment\nE=#nope\n')).toEqual(['C']);
  });

  it('keeps a # that is not preceded by whitespace as part of the value', async () => {
    expect(await keys('A=abc#def\n')).toEqual(['A']);
  });

  it('handles CRLF and lone CR line endings', async () => {
    expect(await keys('A=1\r\nB=\r\nC=3\r\n')).toEqual(['A', 'C']);
    expect(await keys('A=1\rB=2\r')).toEqual(['A', 'B']);
  });

  it('handles multi-line quoted values without leaking inner lines as keys', async () => {
    expect(await keys('A="line1\nINNER=1\nline3"\nB=2\n')).toEqual(['A', 'B']);
  });

  it('treats an unterminated quote as an unquoted value without swallowing later lines', async () => {
    expect(await keys('A="abc\nOPENAI_API_KEY=real\nB=2\n')).toEqual(['A', 'B', 'OPENAI_API_KEY']);
    expect(await keys("A='abc\r\nOPENAI_API_KEY=real")).toEqual(['A', 'OPENAI_API_KEY']);
    expect(await keys('A=" # only comment\nB=1\n')).toEqual(['A', 'B']);
    await writeFile(file, 'A="abc\nOPENAI_API_KEY=real\n');
    expect(await envFileHasKey(file, 'OPENAI_API_KEY')).toBe(true);
  });

  it('ignores lines without = and invalid key names', async () => {
    expect(await keys('just text\n1BAD=x\nA B=x\nOK=1\n')).toEqual(['OK']);
  });

  it('does not strip a leading BOM-free file of its first key', async () => {
    expect(await keys('FIRST=1')).toEqual(['FIRST']);
  });

  it('envFileHasKey is true only for keys with a value', async () => {
    await writeFile(file, 'OPENAI_API_KEY=\nGEMINI_API_KEY=abc\n');
    expect(await envFileHasKey(file, 'OPENAI_API_KEY')).toBe(false);
    expect(await envFileHasKey(file, 'GEMINI_API_KEY')).toBe(true);
    expect(await envFileHasKey(file, 'MISSING')).toBe(false);
  });

  it('never returns values', async () => {
    await writeFile(file, 'SECRET_KEY=hunter2\n');
    const set = await envFileKeys(file);
    expect([...set]).toEqual(['SECRET_KEY']);
  });
});
