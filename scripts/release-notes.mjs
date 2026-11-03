#!/usr/bin/env node
/**
 * Print GitHub release notes (Markdown) for a tag.
 *   node scripts/release-notes.mjs v0.1.0 > notes.md
 *
 * Body: the matching section of CHANGELOG.md if one exists (a `## [v0.1.0]`, `## v0.1.0` or
 * `## 0.1.0 - 2026-11-03` style heading), otherwise `git log` subjects since the previous v* tag.
 * Footer: fixed attribution/verification text, plus the engine `stable` tag when OPENTAC_ENGINE_STABLE is set.
 * Uses execFile (no shell); the tag is validated before it reaches git.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TAG_RE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Extract the CHANGELOG section for `tag`, or null. */
export function changelogSection(markdown, tag) {
  const version = tag.replace(/^v/, '');
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^##\\s+\\[?v?${esc}\\]?(?:\\s|$|[-–—(])`);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]) || /^\[[^\]]+\]:\s+\S+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join('\n').trim();
  return body === '' ? null : body;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** Commit subjects since the previous v* tag (or all history, capped) up to `tag` (or HEAD if the tag is absent). */
export function gitLogNotes(tag) {
  let tip = 'HEAD';
  try {
    git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
    tip = `refs/tags/${tag}`;
  } catch {
    /* tag not present locally (e.g. workflow_dispatch before tagging): describe HEAD */
  }
  let prev = '';
  try {
    prev = git(['describe', '--tags', '--abbrev=0', '--match', 'v*', `${tip}^`]);
  } catch {
    /* first release */
  }
  const range = prev ? `${prev}..${tip}` : tip;
  let out = '';
  try {
    out = git(['log', '--no-merges', '--max-count=200', '--pretty=format:- %s (%h)', range]);
  } catch {
    /* not a git checkout */
  }
  if (!out) return null;
  return `${prev ? `Changes since ${prev}:` : 'Changes:'}\n\n${out}`;
}

export function footer(env = process.env) {
  const lines = [
    '---',
    '',
    "OpenTac is an unofficial macOS app for [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) by Bilawal Sidhu (MIT). It is independent of, and not endorsed by, the upstream author.",
    '',
    'Requires macOS 13.5 or later. Download the `arm64` build for Apple Silicon and the build without `arm64` in its name for Intel. Verify downloads against `SHA256SUMS.txt`: `shasum -a 256 -c SHA256SUMS.txt`.',
  ];
  const stable = (env.OPENTAC_ENGINE_STABLE ?? '').trim();
  if (stable) {
    lines.push('', `Engine \`stable\` channel at release time: \`${stable}\` (the engine updates itself independently of the app).`);
  }
  return lines.join('\n');
}

export function buildNotes(tag, { changelogPath = 'CHANGELOG.md', env = process.env } = {}) {
  let body = null;
  if (existsSync(changelogPath)) body = changelogSection(readFileSync(changelogPath, 'utf8'), tag);
  body ??= gitLogNotes(tag);
  body ??= 'No change notes recorded for this release.';
  return `${body}\n\n${footer(env)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tag = process.argv[2];
  if (!tag || !TAG_RE.test(tag)) {
    console.error('usage: release-notes.mjs vX.Y.Z');
    process.exit(64);
  }
  process.stdout.write(buildNotes(tag));
}
