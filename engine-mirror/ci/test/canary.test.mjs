import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emitIssueBody,
  parseIssueBody,
  promoteAfter,
  isReady,
  canaryDays,
  stableTagName,
  newestSemverTag,
  parseLog,
  groupCommits,
  buildReleaseEntry,
  prependRelease,
  renderTemplate,
  RELEASES_MARKER,
} from '../canary.mjs';

const DATA = {
  sha: '48146f8e5befe7ea5e0c886149f4a6de825f6ebb',
  upstreamTag: 'main',
  readyAt: '2026-11-08T03:00:00.000Z',
  gateRunUrl: 'https://github.com/OWNER/opentac-engine/actions/runs/1',
  policy: 'main',
  commitRange: 'aaaaaaa..48146f8',
  minShell: '1.0.0',
};

test('issue JSON block round-trips, including awkward report text', () => {
  const report = 'Report\n\n```json\n{"not":"ours"}\n```\n\nbacktick ``` mess';
  const body = emitIssueBody(DATA, report);
  assert.deepEqual(parseIssueBody(body), DATA);
  assert.match(body, /^<!-- opentac-canary/);
  // CRLF as GitHub may store it
  assert.deepEqual(parseIssueBody(body.replace(/\n/g, '\r\n')), DATA);
});

test('parseIssueBody: absent or malformed block gives null', () => {
  assert.equal(parseIssueBody('no block here'), null);
  assert.equal(parseIssueBody('```json\n{ nope\n```'), null);
  assert.equal(parseIssueBody('```json\n{"x":1}\n```'), null);
  assert.equal(parseIssueBody(undefined), null);
});

test('emitIssueBody refuses incomplete data', () => {
  assert.throws(() => emitIssueBody({ sha: 'x' }), /readyAt/);
});

test('canary clock: readyAt + 72h', () => {
  assert.equal(promoteAfter('2026-11-08T03:00:00Z'), '2026-11-11T03:00:00.000Z');
  assert.equal(isReady('2026-11-08T03:00:00Z', '2026-11-11T02:59:59Z'), false);
  assert.equal(isReady('2026-11-08T03:00:00Z', '2026-11-11T03:00:00Z'), true);
  assert.equal(isReady('2026-11-08T03:00:00Z', '2026-11-20T00:00:00Z'), true);
  assert.equal(isReady('2026-11-08T03:00:00Z', '2026-11-09T03:00:00Z', 24), true);
  assert.equal(canaryDays('2026-11-08T03:00:00Z', '2026-11-11T05:00:00Z'), 3);
  assert.equal(canaryDays('2026-11-08T03:00:00Z', '2026-11-08T05:00:00Z'), 0);
  assert.throws(() => promoteAfter('garbage'));
});

test('stable tag naming with -N suffix', () => {
  assert.equal(stableTagName('2026-11-12', []), 'stable-2026.11.12');
  assert.equal(stableTagName('2026-11-12T10:00:00Z', ['stable-2026.11.05']), 'stable-2026.11.12');
  assert.equal(stableTagName('2026-11-12', ['stable-2026.11.12']), 'stable-2026.11.12-2');
  assert.equal(stableTagName('2026-11-12', ['stable-2026.11.12', 'stable-2026.11.12-2']), 'stable-2026.11.12-3');
  assert.equal(stableTagName('2026-11-12', ['stable-2026.11.12', 'stable-2026.11.12-3']), 'stable-2026.11.12-2');
  assert.throws(() => stableTagName('11/12/2026', []));
});

test('newestSemverTag: numeric ordering, exclusions, prereleases ignored', () => {
  const tags = ['v0.9.0', 'v0.10.0', 'v0.3.0', 'v1.0.0-rc.1', 'nightly', 'v0.2.1'];
  assert.equal(newestSemverTag(tags), 'v0.10.0');
  assert.equal(newestSemverTag(tags, ['v0.10.0']), 'v0.9.0');
  assert.equal(newestSemverTag(['nightly']), null);
  assert.equal(newestSemverTag([]), null);
});

const LOG = [
  'a1b2c3d\tfeat(map): add layer',
  'b2c3d4e\tfix(camera): keep the zoom ceiling fixed',
  'c3d4e5f\tMerge pull request #1522 from x/y',
  'd4e5f60\tMerge branch \'main\' into y',
  'e5f6071\tupdate readme',
  'f607182\tfix!: breaking',
].join('\n');

test('log grouping by prefix', () => {
  const commits = parseLog(LOG);
  assert.equal(commits.length, 6);
  assert.deepEqual(commits[0], { sha: 'a1b2c3d', subject: 'feat(map): add layer' });
  const groups = Object.fromEntries(groupCommits(commits).map(([k, v]) => [k, v.length]));
  assert.deepEqual(groups, { feat: 1, fix: 2, other: 1, merges: 2 });
  assert.deepEqual(groupCommits(commits).map(([k]) => k), ['feat', 'fix', 'other', 'merges']);
});

test('release entry and prepending', () => {
  const entry = buildReleaseEntry({
    tag: 'stable-2026.11.12',
    date: '2026-11-12',
    range: 'aaaaaaa..bbbbbbb',
    log: LOG,
    diffstat: ' 3 files changed, 10 insertions(+)',
    depsChanged: true,
    upstreamTag: 'v0.4.0',
    gateRunUrl: 'https://example/run/1',
    canaryDays: 3,
    minShell: '1.0.0',
    severity: 'normal',
  });
  assert.match(entry, /^## stable-2026\.11\.12 \(2026-11-12\)/);
  assert.match(entry, /Dependencies changed: yes/);
  assert.match(entry, /### feat\n\n- `a1b2c3d` feat\(map\): add layer/);
  assert.match(entry, /2 merge commits/);
  assert.match(entry, /Canary: 3 days/);

  const header = `# Releases\n\n${RELEASES_MARKER}\n`;
  const once = prependRelease(header, entry);
  const older = buildReleaseEntry({ tag: 'stable-2026.11.05', date: '2026-11-05', range: 'x..y', log: '' });
  const twice = prependRelease(once, older);
  assert.ok(twice.indexOf('## stable-2026.11.05') < twice.indexOf('## stable-2026.11.12'), 'newest entry is prepended on top');
  assert.ok(prependRelease('# Releases\n', entry).includes(RELEASES_MARKER), 'marker is added when missing');
  assert.match(older, /No commits in range/);
});

test('renderTemplate', () => {
  assert.equal(renderTemplate('a {{x}} b {{ y }} c {{missing}}', { x: 1, y: 'two' }), 'a 1 b two c ');
});
