import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLsRemote, diffManifest, main, readManifest } from '../manifest.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

const LS = [
  `${A}\trefs/tags/v1.0.0`,
  `${B}\trefs/tags/v1.0.0^{}`,
  `${C}\trefs/tags/v1.1.0`, // lightweight
  `${D}\trefs/tags/nightly`, // filtered out
].join('\n');

test('parseLsRemote: annotated and lightweight, filtered', () => {
  assert.deepEqual(parseLsRemote(LS), {
    'v1.0.0': { object: A, peeled: B },
    'v1.1.0': { object: C, peeled: null },
  });
});

test('diffManifest: clean, new, deleted, moved object, moved peel, lightweight to annotated', () => {
  const rec = { 'v1.0.0': { object: A, peeled: B }, 'v1.1.0': { object: C, peeled: null } };
  const same = diffManifest(rec, structuredClone(rec));
  assert.deepEqual(same, { added: [], deleted: [], changed: [], drift: false });

  const withNew = { ...structuredClone(rec), 'v2.0.0': { object: D, peeled: D } };
  const n = diffManifest(rec, withNew);
  assert.deepEqual(n.added, ['v2.0.0']);
  assert.equal(n.drift, false);

  const del = diffManifest(rec, { 'v1.0.0': rec['v1.0.0'] });
  assert.deepEqual(del.deleted, ['v1.1.0']);
  assert.equal(del.drift, true);

  const obj = diffManifest(rec, { ...rec, 'v1.0.0': { object: D, peeled: B } });
  assert.equal(obj.changed[0].field, 'object');
  assert.equal(obj.drift, true);

  const peel = diffManifest(rec, { ...rec, 'v1.0.0': { object: A, peeled: D } });
  assert.equal(peel.changed[0].field, 'peeled');

  const annotated = diffManifest(rec, { ...rec, 'v1.1.0': { object: C, peeled: D } });
  assert.equal(annotated.changed[0].field, 'peeled');
  assert.equal(annotated.drift, true);
});

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
}

test('CLI: update --init, then check, then drift exits 2 and update refuses', () => {
  const dir = tmp();
  const manifest = path.join(dir, 'tags.json');
  const ls1 = path.join(dir, 'ls1.txt');
  fs.writeFileSync(ls1, LS);
  const base = ['x', 'https://example.invalid/up', '--manifest', manifest, '--ls-remote-file'];

  assert.equal(main(['update', ...base.slice(1), ls1, '--init']), 0);
  const m = readManifest(manifest);
  assert.deepEqual(Object.keys(m.tags), ['v1.0.0', 'v1.1.0']);
  assert.equal(main(['check', ...base.slice(1), ls1]), 0);

  const ls2 = path.join(dir, 'ls2.txt');
  fs.writeFileSync(ls2, `${LS}\n${D}\trefs/tags/v1.2.0`);
  assert.equal(main(['check', ...base.slice(1), ls2]), 0); // new tag is not drift
  assert.equal(main(['update', ...base.slice(1), ls2]), 0);
  assert.ok('v1.2.0' in readManifest(manifest).tags);

  const ls3 = path.join(dir, 'ls3.txt');
  fs.writeFileSync(ls3, LS.replace(A, D)); // v1.0.0 moved
  assert.equal(main(['check', ...base.slice(1), ls3]), 2);
  const before = fs.readFileSync(manifest, 'utf8');
  assert.equal(main(['update', ...base.slice(1), ls3]), 2);
  assert.equal(fs.readFileSync(manifest, 'utf8'), before);
});

test('seeded manifest is well formed and covers the known upstream tags', () => {
  const file = new URL('../../manifest/tags.json', import.meta.url);
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(m.schema, 1);
  for (const t of ['v0.1.0', 'v0.1.1', 'v0.2.0', 'v0.2.1', 'v0.3.0']) {
    assert.match(m.tags[t].object, /^[0-9a-f]{40}$/);
    assert.match(m.tags[t].peeled, /^[0-9a-f]{40}$/);
  }
});
