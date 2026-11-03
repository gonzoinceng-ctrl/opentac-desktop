import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLocks, toMarkdown } from '../depdiff.mjs';

const lock = (deps, packages) => ({
  packages: { '': { dependencies: deps }, ...packages },
});

test('depdiff: added, removed, changed, install scripts, top-level', () => {
  const a = lock({ vite: '^6.0.0', x: '1' }, {
    'node_modules/vite': { version: '6.0.0' },
    'node_modules/x': { version: '1.0.0' },
    'node_modules/old': { version: '1.0.0' },
  });
  const b = lock({ vite: '^6.1.0', sharp: '^0.35.0' }, {
    'node_modules/vite': { version: '6.1.0' },
    'node_modules/sharp': { version: '0.35.5', hasInstallScript: true },
    'node_modules/x': { version: '1.0.0' },
  });
  const d = diffLocks(a, b);
  assert.deepEqual(d.added.map((p) => p.name), ['sharp']);
  assert.deepEqual(d.removed, ['old']);
  assert.deepEqual(d.changed, [{ name: 'vite', was: '6.0.0', now: '6.1.0' }]);
  assert.deepEqual(d.newInstallScripts, ['sharp']);
  assert.deepEqual(d.topAdded, ['sharp']);
  assert.deepEqual(d.topRemoved, ['x']);
  assert.equal(d.changedAtAll, true);
  assert.match(toMarkdown(d), /Dependencies changed: yes/);
});

test('depdiff: identical locks', () => {
  const a = lock({}, { 'node_modules/y': { version: '1.0.0' } });
  const d = diffLocks(a, structuredClone(a));
  assert.equal(d.changedAtAll, false);
  assert.match(toMarkdown(d), /Dependencies changed: no/);
  assert.match(toMarkdown(d, false), /No previous lockfile/);
});
