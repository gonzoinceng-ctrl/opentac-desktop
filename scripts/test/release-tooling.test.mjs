import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { changelogSection, footer, buildNotes } from '../release-notes.mjs';
import { sha256Lines } from '../sha256sums.mjs';
import { compareVersions, newestOnLine, darwinShaLines } from '../check-toolchain-updates.mjs';

const CHANGELOG = `# Changelog

## [Unreleased]

- later

## [v0.2.0] - 2026-12-01

- second

## 0.1.0 - 2026-11-03

- first thing
- second thing

### Fixed

- a fix

[v0.2.0]: https://example.invalid/compare
`;

test('changelog sections match by tag in several heading styles and stop at the next heading', () => {
  assert.equal(changelogSection(CHANGELOG, 'v0.1.0'), '- first thing\n- second thing\n\n### Fixed\n\n- a fix');
  assert.equal(changelogSection(CHANGELOG, 'v0.2.0'), '- second');
  assert.equal(changelogSection(CHANGELOG, 'v0.1'), null);
  assert.equal(changelogSection(CHANGELOG, 'v0.10.0'), null);
});

test('notes use the changelog when present and always carry the attribution footer', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'notes-'));
  const f = path.join(dir, 'CHANGELOG.md');
  writeFileSync(f, CHANGELOG);
  const notes = buildNotes('v0.1.0', { changelogPath: f, env: { OPENTAC_ENGINE_STABLE: 'stable-2026.11.03' } });
  assert.match(notes, /^- first thing/);
  assert.match(notes, /Bilawal Sidhu/);
  assert.match(notes, /`stable-2026\.11\.03`/);
  assert.doesNotMatch(footer({}), /Engine `stable`/);
});

test('sha256sums prints "<hash>  <basename>"', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sums-'));
  const f = path.join(dir, 'a.txt');
  writeFileSync(f, 'abc');
  assert.deepEqual(await sha256Lines([f]), ['ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  a.txt']);
  await assert.rejects(sha256Lines([path.join(dir, 'missing')]));
});

test('toolchain version helpers', () => {
  assert.ok(compareVersions('24.22.2', '24.9.0') > 0);
  assert.equal(compareVersions('v24.1.0', '24.1.0'), 0);
  assert.equal(newestOnLine(['v24.9.0', 'v24.22.2', 'v25.0.0', '45.0.0-beta.1'], 24), '24.22.2');
  assert.equal(newestOnLine(['45.0.0-beta.1', '45.2.1', '45.10.0', '46.0.0'], 45), '45.10.0');
  const sums = ['aa  node-v24.1.0-darwin-arm64.tar.gz', 'bb  node-v24.1.0-darwin-x64.tar.gz', 'cc  node-v24.1.0-linux-x64.tar.gz'].join('\n');
  assert.deepEqual(darwinShaLines(sums, '24.1.0'), { 'node-v24.1.0-darwin-arm64.tar.gz': 'aa', 'node-v24.1.0-darwin-x64.tar.gz': 'bb' });
  assert.throws(() => darwinShaLines('aa  node-v24.1.0-darwin-arm64.tar.gz', '24.1.0'), /missing/);
});
