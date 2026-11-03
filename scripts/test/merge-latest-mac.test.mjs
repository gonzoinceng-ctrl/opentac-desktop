import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeLatestMac, parseLatestMac, serializeLatestMac, mergeFiles } from '../merge-latest-mac.mjs';

// Shape produced by app-builder-lib 26.x serializeToYaml() for a mac zip + dmg build of one arch.
const ARM64 = `version: 0.1.0
files:
  - url: OpenTac-0.1.0-arm64-mac.zip
    sha512: 8Fh2Yk3m0gQ0Wl5mQ0m1l0x3Zk1H0eF6y5mT0a1uJb9n4oVqQ0m9wXr8c1pK0sQ0Vd3Gx2Zb7LwH5uJ1nQ9yUg==
    size: 118342211
    blockMapSize: 124830
  - url: OpenTac-0.1.0-arm64.dmg
    sha512: Qm1xV0b8dK3pH9tT2yR6uL4nC7zA5sJ0wE1fG8hI3kO2pN6rM9vB4cX7aZ0lD5jY1eT3qU8iS2oW6gF9hK4nA==
    size: 121904837
path: OpenTac-0.1.0-arm64-mac.zip
sha512: 8Fh2Yk3m0gQ0Wl5mQ0m1l0x3Zk1H0eF6y5mT0a1uJb9n4oVqQ0m9wXr8c1pK0sQ0Vd3Gx2Zb7LwH5uJ1nQ9yUg==
releaseDate: '2026-11-03T21:14:09.123Z'
`;

const X64 = `version: 0.1.0
files:
  - url: OpenTac-0.1.0-mac.zip
    sha512: Zk9rT2yH1xV6bN3mQ8wL0pA4cD7fG5jS1eU9iO2tR6nB8vC3zX0aM4lK7hY5qW1dF9gJ2oE6sI3uP8nT0xA==
    size: 126771905
    blockMapSize: 131002
  - url: OpenTac-0.1.0.dmg
    sha512: Lp4eW8nB1vC6xZ3aS9dF2gH5jK0lQ7wE4rT1yU8iO3pA6sD9fG2hJ5kL0zX7cV4bN1mM8qW3eR6tY9uI2oP5a==
    size: 130518446
path: OpenTac-0.1.0-mac.zip
sha512: Zk9rT2yH1xV6bN3mQ8wL0pA4cD7fG5jS1eU9iO2tR6nB8vC3zX0aM4lK7hY5qW1dF9gJ2oE6sI3uP8nT0xA==
releaseDate: '2026-11-03T21:19:44.907Z'
`;

const urls = (doc) => doc.files.map((f) => f.get('url').value);

test('parses an electron-builder style file', () => {
  const d = parseLatestMac(ARM64);
  assert.equal(d.top.get('version').value, '0.1.0');
  assert.deepEqual(urls(d), ['OpenTac-0.1.0-arm64-mac.zip', 'OpenTac-0.1.0-arm64.dmg']);
  assert.equal(d.files[0].get('size').value, '118342211');
  assert.equal(d.files[0].get('blockMapSize').value, '124830');
  assert.equal(d.top.get('releaseDate').value, '2026-11-03T21:14:09.123Z');
});

test('merges both architectures and keeps version/releaseDate from the first', () => {
  const out = serializeLatestMac(mergeLatestMac([parseLatestMac(ARM64), parseLatestMac(X64)]));
  const back = parseLatestMac(out);
  assert.equal(back.top.get('version').value, '0.1.0');
  assert.deepEqual(urls(back), [
    'OpenTac-0.1.0-arm64-mac.zip',
    'OpenTac-0.1.0-arm64.dmg',
    'OpenTac-0.1.0-mac.zip',
    'OpenTac-0.1.0.dmg',
  ]);
  // electron-updater's legacy fields point at the x64 zip.
  assert.equal(back.top.get('path').value, 'OpenTac-0.1.0-mac.zip');
  assert.equal(back.top.get('sha512').value, parseLatestMac(X64).files[0].get('sha512').value);
  // releaseDate from the first file, quoted like electron-builder does.
  assert.match(out, /^releaseDate: '2026-11-03T21:14:09\.123Z'$/m);
  // numeric fields stay numeric (unquoted) so the updater's size/blockMapSize checks keep working.
  assert.match(out, /^ {4}size: 126771905$/m);
  assert.match(out, /^ {4}blockMapSize: 131002$/m);
  // Output layout: top-level keys in electron-builder order.
  assert.deepEqual(
    out.split('\n').filter((l) => /^\S/.test(l)).map((l) => l.split(':')[0]),
    ['version', 'files', 'path', 'sha512', 'releaseDate'],
  );
});

test('argument order does not decide which zip is the legacy path', () => {
  const m = mergeLatestMac([parseLatestMac(X64), parseLatestMac(ARM64)]);
  assert.equal(m.path.value, 'OpenTac-0.1.0-mac.zip');
});

test('de-duplicates files by url', () => {
  const m = mergeLatestMac([parseLatestMac(ARM64), parseLatestMac(ARM64), parseLatestMac(X64)]);
  assert.equal(m.files.length, 4);
});

test('rejects mismatched versions, missing x64 zip, empty file lists and unsupported YAML', () => {
  assert.throws(() => mergeLatestMac([parseLatestMac(ARM64), parseLatestMac(X64.replace('version: 0.1.0', 'version: 0.1.1'))]), /differs/);
  assert.throws(() => mergeLatestMac([parseLatestMac(ARM64), parseLatestMac(ARM64)]), /no x64 zip/);
  assert.throws(() => mergeLatestMac([parseLatestMac('version: 0.1.0\nreleaseDate: x\n'), parseLatestMac(X64)]), /no files/);
  assert.throws(() => parseLatestMac(`${ARM64}releaseNotes: |\n  hello\n`), /unsupported/);
  assert.throws(() => parseLatestMac('version: 0.1.0\n  stray: indent\n'), /unexpected indented/);
});

test('CLI: merges two files to stdout and exits non-zero on bad input', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'merge-latest-'));
  const a = path.join(dir, 'latest-mac-arm64.yml');
  const b = path.join(dir, 'latest-mac-x64.yml');
  writeFileSync(a, ARM64);
  writeFileSync(b, X64);
  const script = fileURLToPath(new URL('../merge-latest-mac.mjs', import.meta.url));
  const ok = spawnSync(process.execPath, [script, a, b], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, mergeFiles([a, b]));
  const bad = spawnSync(process.execPath, [script, a, path.join(dir, 'missing.yml')], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /missing\.yml/);
});
