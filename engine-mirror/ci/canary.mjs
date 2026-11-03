#!/usr/bin/env node
// Helpers shared by intake.yml and promote.yml. Plain Node ESM, no dependencies.
//
// Library: parse/emit the canary issue's JSON block, canary clock arithmetic,
// stable tag naming, semver tag selection, RELEASES.md entry building.
//
// CLI (all read/write files or stdin/stdout so workflows stay thin):
//   canary.mjs emit-body    --data data.json [--report report.md]      -> issue body on stdout
//   canary.mjs parse-body   [--file body.md]                           -> JSON block on stdout (stdin if no file); exit 3 if absent
//   canary.mjs promote-after --ready-at ISO [--hours 72]               -> ISO time the canary may auto-promote
//   canary.mjs is-ready     --ready-at ISO [--now ISO] [--hours 72]    -> exit 0 if promotable, 1 if not
//   canary.mjs canary-days  --ready-at ISO [--now ISO]                 -> whole days on stdout
//   canary.mjs stable-tag   --date YYYY-MM-DD [--existing-file f]      -> tag name on stdout (existing tags from file or stdin)
//   canary.mjs newest-tag   [--file f] [--exclude-file f]              -> newest v<semver> tag on stdout (tags from file or stdin)
//   canary.mjs release-entry --tag T --date D --range R --log log.txt [--diffstat f] [--deps yes|no]
//                            [--upstream-tag U] [--gate-run URL] [--canary-days N] [--min-shell X] [--severity S]
//   canary.mjs prepend-release --file RELEASES.md --entry entry.md
//   canary.mjs render-template --template t.md --vars vars.json
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CANARY_HOURS = 72;
export const REQUIRED_FIELDS = ['sha', 'readyAt'];
const BLOCK_MARKER = 'opentac-canary';

// ---- issue JSON block ------------------------------------------------------

/**
 * Canonical data shape:
 * { sha, upstreamTag, readyAt, gateRunUrl, policy, commitRange, minShell }
 */
export function emitIssueBody(data, reportMarkdown = '') {
  for (const f of REQUIRED_FIELDS) {
    if (!data || data[f] === undefined || data[f] === null || data[f] === '') {
      throw new Error(`canary data is missing "${f}"`);
    }
  }
  const json = JSON.stringify(data, null, 2);
  return [
    `<!-- ${BLOCK_MARKER}: machine-readable, edited by CI only. Add the label \`hold\` or \`reject\` to stop promotion. -->`,
    '```json',
    json,
    '```',
    '',
    reportMarkdown.trim(),
    '',
  ].join('\n');
}

/**
 * Extract the canary data from an issue body: the first fenced ```json block
 * that parses to an object with a `sha`. Returns null if there is none.
 */
export function parseIssueBody(body) {
  const re = /```json[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```/g;
  for (const m of String(body ?? '').matchAll(re)) {
    try {
      const obj = JSON.parse(m[1]);
      if (obj && typeof obj === 'object' && typeof obj.sha === 'string') return obj;
    } catch {
      /* not our block */
    }
  }
  return null;
}

// ---- canary clock ----------------------------------------------------------

function toMs(iso, label) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`${label} is not a valid ISO date: ${iso}`);
  return ms;
}

export function promoteAfter(readyAtIso, hours = CANARY_HOURS) {
  return new Date(toMs(readyAtIso, 'readyAt') + hours * 3_600_000).toISOString();
}

/** readyAt + hours <= now */
export function isReady(readyAtIso, nowIso = new Date().toISOString(), hours = CANARY_HOURS) {
  return toMs(readyAtIso, 'readyAt') + hours * 3_600_000 <= toMs(nowIso, 'now');
}

export function canaryDays(readyAtIso, nowIso = new Date().toISOString()) {
  return Math.max(0, Math.floor((toMs(nowIso, 'now') - toMs(readyAtIso, 'readyAt')) / 86_400_000));
}

// ---- tags ------------------------------------------------------------------

/** stable-YYYY.MM.DD, with -2, -3, ... when that name (or a lower suffix) is taken. */
export function stableTagName(dateIso, existingTags = []) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateIso);
  if (!m) throw new Error(`date must start with YYYY-MM-DD: ${dateIso}`);
  const base = `stable-${m[1]}.${m[2]}.${m[3]}`;
  const taken = new Set(existingTags.map((t) => t.trim()).filter(Boolean));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export function compareSemverTags(a, b) {
  const ma = SEMVER_TAG.exec(a);
  const mb = SEMVER_TAG.exec(b);
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/** Newest plain vX.Y.Z tag (pre-releases like v1.0.0-rc.1 are ignored), skipping `exclude`. */
export function newestSemverTag(tags, exclude = []) {
  const skip = new Set(exclude);
  const ok = tags.map((t) => t.trim()).filter((t) => SEMVER_TAG.test(t) && !skip.has(t));
  if (ok.length === 0) return null;
  return ok.sort(compareSemverTags).at(-1);
}

// ---- RELEASES.md -----------------------------------------------------------

export const RELEASES_MARKER = '<!-- releases:begin -->';

/** Parse "sha<TAB>subject" (or "sha subject") lines from git log. */
export function parseLog(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line) => {
      const tab = line.indexOf('\t');
      const sp = line.indexOf(' ');
      const cut = tab >= 0 ? tab : sp;
      return cut < 0
        ? { sha: line.trim(), subject: '' }
        : { sha: line.slice(0, cut).trim(), subject: line.slice(cut + 1).trim() };
    });
}

const PREFIX = /^(\w+)(?:\([^)]*\))?!?:\s/;

/** Group commits by conventional prefix; merges and unprefixed subjects get their own groups. */
export function groupCommits(commits) {
  const groups = new Map();
  const add = (key, c) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  };
  for (const c of commits) {
    if (/^Merge (pull request|branch|remote-tracking branch)/.test(c.subject)) add('merges', c);
    else {
      const m = PREFIX.exec(c.subject);
      add(m ? m[1].toLowerCase() : 'other', c);
    }
  }
  const order = ['feat', 'fix', 'perf', 'security', 'refactor', 'docs', 'test', 'chore', 'other', 'merges'];
  return [...groups.entries()].sort(
    ([a], [b]) =>
      (order.indexOf(a) === -1 ? 90 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 90 : order.indexOf(b)) ||
      a.localeCompare(b),
  );
}

export function buildReleaseEntry({
  tag,
  date,
  range,
  log,
  diffstat = '',
  depsChanged = false,
  upstreamTag = '',
  gateRunUrl = '',
  canaryDays: days,
  minShell = '',
  severity = 'normal',
}) {
  const commits = parseLog(log);
  const lines = [];
  lines.push(`## ${tag} (${String(date).slice(0, 10)})`, '');
  lines.push(`- Upstream: ${upstreamTag || 'main (no tag)'}`);
  lines.push(`- Commit range: \`${range}\` (${commits.length} commit${commits.length === 1 ? '' : 's'})`);
  lines.push(`- Dependencies changed: ${depsChanged ? 'yes' : 'no'}`);
  if (days !== undefined && days !== '') lines.push(`- Canary: ${days} day${Number(days) === 1 ? '' : 's'}`);
  if (gateRunUrl) lines.push(`- Gate run: ${gateRunUrl}`);
  if (minShell) lines.push(`- Minimum OpenTac version: ${minShell}`);
  lines.push(`- Severity: ${severity}`, '');
  for (const [key, list] of groupCommits(commits)) {
    lines.push(`### ${key}`, '');
    if (key === 'merges') {
      lines.push(`${list.length} merge commit${list.length === 1 ? '' : 's'} (pull request merges and branch syncs, not listed).`, '');
      continue;
    }
    for (const c of list) lines.push(`- \`${c.sha}\` ${c.subject}`);
    lines.push('');
  }
  if (commits.length === 0) lines.push('No commits in range (tag moved without new commits).', '');
  if (diffstat.trim()) lines.push('### diffstat', '', '```', diffstat.trim(), '```', '');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

/** Insert an entry right after the marker (newest first). Adds the marker if missing. */
export function prependRelease(releasesMd, entry) {
  const text = releasesMd.includes(RELEASES_MARKER)
    ? releasesMd
    : `${releasesMd.trimEnd()}\n\n${RELEASES_MARKER}\n`;
  const i = text.indexOf(RELEASES_MARKER) + RELEASES_MARKER.length;
  return `${text.slice(0, i)}\n\n${entry.trim()}\n${text.slice(i).replace(/^\n+/, '\n')}`;
}

/** {{key}} substitution. Unknown keys become the empty string; values are inserted verbatim. */
export function renderTemplate(template, vars) {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
}

// ---- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    opts[a.slice(2)] = argv[(i += 1)];
  }
  return opts;
}

const readStdin = () => fs.readFileSync(0, 'utf8');
const readFileOrStdin = (f) => (f ? fs.readFileSync(f, 'utf8') : readStdin());
const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

export function main(argv) {
  const [cmd, ...rest] = argv;
  const o = parseArgs(rest);
  const out = (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
  switch (cmd) {
    case 'emit-body':
      out(emitIssueBody(JSON.parse(fs.readFileSync(o.data, 'utf8')), o.report ? fs.readFileSync(o.report, 'utf8') : ''));
      return 0;
    case 'parse-body': {
      const data = parseIssueBody(readFileOrStdin(o.file));
      if (!data) {
        console.error('no canary JSON block found');
        return 3;
      }
      out(JSON.stringify(data));
      return 0;
    }
    case 'promote-after':
      out(promoteAfter(o['ready-at'], o.hours ? Number(o.hours) : CANARY_HOURS));
      return 0;
    case 'is-ready':
      return isReady(o['ready-at'], o.now, o.hours ? Number(o.hours) : CANARY_HOURS) ? 0 : 1;
    case 'canary-days':
      out(String(canaryDays(o['ready-at'], o.now)));
      return 0;
    case 'stable-tag':
      out(stableTagName(o.date, lines(readFileOrStdin(o['existing-file']))));
      return 0;
    case 'newest-tag': {
      const tag = newestSemverTag(lines(readFileOrStdin(o.file)), o['exclude-file'] ? lines(fs.readFileSync(o['exclude-file'], 'utf8')) : []);
      if (!tag) return 4;
      out(tag);
      return 0;
    }
    case 'release-entry':
      out(
        buildReleaseEntry({
          tag: o.tag,
          date: o.date,
          range: o.range,
          log: fs.readFileSync(o.log, 'utf8'),
          diffstat: o.diffstat ? fs.readFileSync(o.diffstat, 'utf8') : '',
          depsChanged: o.deps === 'yes',
          upstreamTag: o['upstream-tag'],
          gateRunUrl: o['gate-run'],
          canaryDays: o['canary-days'],
          minShell: o['min-shell'],
          severity: o.severity || 'normal',
        }),
      );
      return 0;
    case 'prepend-release': {
      const current = fs.existsSync(o.file) ? fs.readFileSync(o.file, 'utf8') : '# OpenTac engine releases\n';
      fs.writeFileSync(o.file, prependRelease(current, fs.readFileSync(o.entry, 'utf8')));
      return 0;
    }
    case 'render-template':
      out(renderTemplate(fs.readFileSync(o.template, 'utf8'), JSON.parse(fs.readFileSync(o.vars, 'utf8'))));
      return 0;
    default:
      console.error('usage: node ci/canary.mjs <emit-body|parse-body|promote-after|is-ready|canary-days|stable-tag|newest-tag|release-entry|prepend-release|render-template> [--opt value ...]');
      return 64;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`canary.mjs: ${e.message}`);
    process.exitCode = 1;
  }
}
