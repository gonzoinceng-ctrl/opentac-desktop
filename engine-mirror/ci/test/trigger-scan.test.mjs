import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseOn, scanWorkflowText, matchesFilter, globToRegExp, scanRefs } from '../trigger-scan.mjs';

const wf = (on) => `name: x\n${on}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`;
const unsafe = (on) => scanWorkflowText(wf(on)).length > 0;

test('parseOn: block, flow and scalar forms', () => {
  assert.deepEqual(Object.keys(parseOn(wf('on: push'))), ['push']);
  assert.deepEqual(Object.keys(parseOn(wf('on: [push, pull_request]'))), ['push', 'pull_request']);
  const o = parseOn(wf('on:\n  push:\n    branches: [main]  # comment\n  pull_request:\n    branches:\n      - main\n      - "release/**"\n'));
  assert.deepEqual(o.push.branches, ['main']);
  assert.deepEqual(o.pull_request.branches, ['main', 'release/**']);
  assert.deepEqual(Object.keys(parseOn(wf('"on":\n  workflow_dispatch:\n'))), ['workflow_dispatch']);
});

test('upstream-shaped ci.yml (push: main, pull_request) is safe', () => {
  assert.equal(unsafe('on:\n  push:\n    branches: [main]\n  pull_request:\n'), false);
  assert.equal(unsafe('on:\n  push:\n    branches:\n      - main\n  pull_request:\n    branches: [main]\n'), false);
});

test('unfiltered or matching push triggers are unsafe', () => {
  assert.equal(unsafe('on: push'), true);
  assert.equal(unsafe('on: [push]'), true);
  assert.equal(unsafe('on:\n  push:\n'), true);
  assert.equal(unsafe('on:\n  push:\n    paths: ["src/**"]\n'), true);
  assert.equal(unsafe('on:\n  push:\n    branches: ["**"]\n'), true);
  assert.equal(unsafe('on:\n  push:\n    branches: [stable, "release/*"]\n'), true);
  assert.equal(unsafe('on:\n  push:\n    branches: ["*", "!stable", "!candidate", "!upstream-main"]\n'), false);
  assert.equal(unsafe('on:\n  push:\n    branches-ignore: [main]\n'), true);
  assert.equal(unsafe('on:\n  push:\n    tags: ["v*"]\n'), true);
  assert.equal(unsafe('on:\n  push:\n    tags: ["**"]\n'), true);
  assert.equal(unsafe('on:\n  push:\n    tags: ["release-*"]\n'), false);
  assert.equal(unsafe('on:\n  push:\n    tags-ignore: ["**"]\n'), false);
  assert.equal(unsafe('on:\n  push:\n    tags-ignore: ["beta"]\n'), true);
});

test('workflow_run, create, delete and unparseable are unsafe; dispatch/schedule/PR are safe', () => {
  assert.equal(unsafe('on:\n  workflow_run:\n    workflows: [ci]\n'), true);
  assert.equal(unsafe('on: [create]'), true);
  assert.equal(unsafe('on:\n  schedule:\n    - cron: "1 * * * *"\n  workflow_dispatch:\n  pull_request:\n'), false);
  assert.equal(scanWorkflowText('name: no triggers here\n').length, 1);
  assert.equal(unsafe('on: &anchor push'), true);
});

test('glob semantics', () => {
  assert.equal(globToRegExp('release/*').test('release/1'), true);
  assert.equal(globToRegExp('release/*').test('release/1/2'), false);
  assert.equal(globToRegExp('release/**').test('release/1/2'), true);
  assert.equal(matchesFilter('stable', ['*', '!stable']), false);
  assert.equal(matchesFilter('candidate', ['*', '!stable']), true);
});

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
}

test('scanRefs: reads the tree at refs, dedupes trees, honours --allow', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tscan-'));
  git(dir, 'init', '-q');
  fs.mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github/workflows/ci.yml'), wf('on:\n  push:\n    branches: [main]\n'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'safe');
  git(dir, 'tag', 'v1.0.0');
  fs.writeFileSync(path.join(dir, '.github/workflows/ci.yml'), wf('on: push'));
  git(dir, 'commit', '-qam', 'unsafe');
  git(dir, 'tag', 'v1.1.0');
  const safe = scanRefs(dir, ['v1.0.0']);
  assert.equal(safe.findings.length, 0);
  const both = scanRefs(dir, ['v1.0.0', 'v1.1.0', 'HEAD']);
  assert.equal(both.treesScanned, 2);
  assert.equal(both.findings.length, 1);
  assert.deepEqual(both.findings[0].refs, ['v1.1.0', 'HEAD']);
  const tree = both.findings[0].tree;
  assert.equal(scanRefs(dir, ['v1.1.0'], [tree]).findings.length, 0);
  assert.equal(scanRefs(dir, ['no-such-ref']).findings.length, 0);
});

test('scanRefs: upstream clone is safe at HEAD', { skip: !process.env.UPSTREAM_DIR && !fs.existsSync('/private/tmp/claude-501/-Users-simontucker-Projects--DEVELOPMENT-ASSISTANT/daeb13cb-8722-47bf-95c8-c357ce2aa7d2/scratchpad/upstream/gods-eye-view/.git') && 'no upstream clone' }, () => {
  const up = process.env.UPSTREAM_DIR || '/private/tmp/claude-501/-Users-simontucker-Projects--DEVELOPMENT-ASSISTANT/daeb13cb-8722-47bf-95c8-c357ce2aa7d2/scratchpad/upstream/gods-eye-view';
  assert.deepEqual(scanRefs(up, ['HEAD']).findings, []);
});
