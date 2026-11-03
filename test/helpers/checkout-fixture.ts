import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLogger } from '../../src/main/logger.js';
import type { Logger } from '../../src/main/logger.js';
import { createGitRunner } from '../../src/main/git.js';
import type { GitRunner } from '../../src/main/git.js';

/** dugite's embedded git tree, as `Paths.gitDir` resolves it in dev. */
export const DUGITE_GIT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'node_modules',
  'dugite',
  'git',
);

/** A bare "mirror" repository plus the means to move its refs like the real mirror CI does. */
export interface CheckoutFixture {
  /** Temp root; everything lives below it. */
  root: string;
  /** Where the manager under test should put its checkout (not created). */
  checkoutDir: string;
  /** Bare mirror repository directory. */
  mirrorDir: string;
  /** `file://` URL of the mirror. */
  mirrorUrl: string;
  git: GitRunner;
  log: Logger;
  /** Every log line written through `log`. */
  logLines: string[];
  /** Full shas of the fixture commits; c5 exists after {@link CheckoutFixture.addCommit}. */
  commits: { c1: string; c2: string; c3: string; c4: string; c5?: string };
  /** Adds a commit on upstream-main (which also creates c5 the first time) and returns its sha. */
  addCommit(file: string, content: string): Promise<string>;
  /** Moves a branch in the mirror to `sha`, forced (as the real mirror may do). */
  moveBranch(name: string, sha: string): Promise<void>;
  /** Moves `stable` in the mirror. */
  moveStable(sha: string): Promise<void>;
  /** Re-creates an annotated tag at `sha` in the mirror (a "tag drift"). */
  forceRetag(tag: string, sha: string): Promise<void>;
  /** Creates an annotated tag in the mirror. */
  createTag(tag: string, sha: string, message: string): Promise<void>;
  /** Removes the temp root. */
  cleanup(): Promise<void>;
}

const BASE_EPOCH = Date.parse('2026-11-01T10:00:00Z') / 1000;

/** Builds the fixture mirror: c1..c4 on upstream-main, v0.1.0 at c2, stable at c2, candidate at c3. */
export async function createCheckoutFixture(): Promise<CheckoutFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'opentac-checkout-')));
  const home = join(root, 'home');
  const workDir = join(root, 'work');
  const mirrorDir = join(root, 'mirror.git');
  await mkdir(home, { recursive: true });

  const logLines: string[] = [];
  const sink = {
    info: (m: string) => logLines.push(m),
    warn: (m: string) => logLines.push(m),
    error: (m: string) => logLines.push(m),
    debug: (m: string) => logLines.push(m),
  };
  const log = createLogger(sink);
  const git = createGitRunner({
    gitDir: DUGITE_GIT_DIR,
    log,
    baseEnv: {
      HOME: home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture Author',
      GIT_AUTHOR_EMAIL: 'author@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture Committer',
      GIT_COMMITTER_EMAIL: 'committer@example.invalid',
    },
  });

  let tick = 0;
  const nextDate = (): Record<string, string> => {
    tick += 1;
    const stamp = `@${BASE_EPOCH + tick * 60} +0000`;
    return { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp };
  };
  const inWork = (args: string[]): Promise<{ stdout: string }> =>
    git.run(args, workDir, { env: nextDate() });
  const inMirror = (args: string[]): Promise<{ stdout: string }> =>
    git.run(args, mirrorDir, { env: nextDate() });

  async function commitFile(file: string, content: string, message: string): Promise<string> {
    const full = join(workDir, file);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    await inWork(['add', '--', file]);
    await inWork(['commit', '--quiet', '-m', message]);
    return (await inWork(['rev-parse', 'HEAD'])).stdout.trim();
  }

  await git.run(['init', '--quiet', '--bare', '--initial-branch=upstream-main', mirrorDir], root);
  await git.run(['init', '--quiet', '--initial-branch=upstream-main', workDir], root);
  await inWork(['remote', 'add', 'mirror', pathToFileURL(mirrorDir).href]);

  const lock = (dep: string): string =>
    JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': {}, dep } }, null, 2);

  await writeFile(join(workDir, '.gitignore'), '.env\n.gev-cache\n');
  await writeFile(join(workDir, 'package.json'), '{"name":"fixture","version":"0.1.0"}\n');
  await writeFile(join(workDir, 'package-lock.json'), lock('1.0.0'));
  await inWork(['add', '--', '.gitignore', 'package.json', 'package-lock.json']);
  await inWork(['commit', '--quiet', '-m', 'c1: initial']);
  const c1 = (await inWork(['rev-parse', 'HEAD'])).stdout.trim();
  const c2 = await commitFile('src/app.txt', 'app v2\n', 'c2: add app');
  await inWork(['tag', '-a', 'v0.1.0', '-m', 'Release v0.1.0', c2]);
  const c3 = await commitFile('package-lock.json', lock('2.0.0'), 'c3: bump dependency');
  const c4 = await commitFile('src/more.txt', 'more\n', 'c4: more');

  await inWork(['push', '--quiet', 'mirror', 'upstream-main', 'refs/tags/v0.1.0']);
  await inMirror(['update-ref', 'refs/heads/stable', c2]);
  await inMirror(['update-ref', 'refs/heads/candidate', c3]);
  await inMirror([
    'tag',
    '-a',
    'stable-2026.11.01',
    '-m',
    [
      'Stable 2026.11.01',
      '',
      'upstreamTag: v0.1.0',
      'gateRun: https://example/run/1',
      'canaryDays: 3',
      'minShell: 0.1.0',
      'severity: normal',
    ].join('\n'),
    c2,
  ]);

  const fixture: CheckoutFixture = {
    root,
    checkoutDir: join(root, 'data', 'checkout'),
    mirrorDir,
    mirrorUrl: pathToFileURL(mirrorDir).href,
    git,
    log,
    logLines,
    commits: { c1, c2, c3, c4 },
    async addCommit(file, content) {
      const sha = await commitFile(file, content, `add ${file}`);
      await inWork(['push', '--quiet', 'mirror', 'upstream-main']);
      fixture.commits.c5 ??= sha;
      return sha;
    },
    async moveBranch(name, sha) {
      await inMirror(['update-ref', `refs/heads/${name}`, sha]);
    },
    async moveStable(sha) {
      await inMirror(['update-ref', 'refs/heads/stable', sha]);
    },
    async forceRetag(tag, sha) {
      await inMirror(['tag', '-f', '-a', tag, '-m', `Retagged ${tag}`, sha]);
    },
    async createTag(tag, sha, message) {
      await inMirror(['tag', '-a', tag, '-m', message, sha]);
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
  return fixture;
}
