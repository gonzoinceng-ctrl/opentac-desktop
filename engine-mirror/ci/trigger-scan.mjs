#!/usr/bin/env node
// trigger-scan.mjs - would pushing these upstream commits fire upstream's workflows HERE?
//
// The mirror pushes upstream-authored commits and tags with a PAT. Pushes made with a PAT
// trigger workflows, and the workflow files that run are the ones inside the pushed commit,
// i.e. third-party code. This script reads the `on:` block of every .github/workflows/*.yml
// at the given refs and reports any trigger that could match a ref the mirror creates:
//
//   branches  upstream-main, candidate, stable
//   tags      v*, stable-*
//
// plus the events that fire on any ref creation or on other workflows finishing
// (`create`, `delete`, `workflow_run`). It is deliberately conservative: anything it
// cannot parse is reported as unsafe.
//
// Usage:
//   node ci/trigger-scan.mjs --repo <gitdir> --ref <ref> [--ref <ref> ...]
//                            [--allow <treeSha,...>] [--json]
//   --allow / env TRUSTED_WORKFLOW_TREES: comma-separated `.github/workflows` TREE ids the
//   owner has reviewed. Exit codes: 0 safe, 3 unsafe trigger found, 1 usage/IO error.
//
// No dependencies. The `on:` parser handles the YAML subset GitHub workflows use for it.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const MIRROR_BRANCHES = ['upstream-main', 'candidate', 'stable'];
export const MIRROR_TAG_PREFIXES = ['v', 'stable-'];
const ALWAYS_UNSAFE = ['workflow_run', 'create', 'delete'];

// ---------------------------------------------------------------------------
// Mini YAML for the `on:` block.
// ---------------------------------------------------------------------------

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s[{,:]/.test(line[i - 1])) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Split on top-level commas (respecting quotes and nesting). */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let q = null;
  let cur = '';
  for (const c of s) {
    if (q) {
      if (c === q) q = null;
      cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === '[' || c === '{') {
      depth += 1;
      cur += c;
    } else if (c === ']' || c === '}') {
      depth -= 1;
      cur += c;
    } else if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function splitKey(s) {
  // first `:` followed by space/end, outside quotes
  let q = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === ':' && (i === s.length - 1 || /\s/.test(s[i + 1]))) {
      return [unquote(s.slice(0, i)), s.slice(i + 1).trim()];
    }
  }
  return null;
}

export function parseFlow(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new Error('unterminated flow sequence');
    return splitTop(s.slice(1, -1)).map(parseFlow);
  }
  if (s.startsWith('{')) {
    if (!s.endsWith('}')) throw new Error('unterminated flow mapping');
    const o = {};
    for (const part of splitTop(s.slice(1, -1))) {
      const kv = splitKey(part.trim());
      if (kv) o[kv[0]] = parseFlow(kv[1]);
      else o[unquote(part)] = null;
    }
    return o;
  }
  if (/^[&*!|>]/.test(s)) throw new Error('unsupported YAML construct');
  return unquote(s);
}

function parseBlock(lines, start, indent) {
  // lines: [{ indent, text }] ; returns [value, nextIndex]
  let i = start;
  if (lines[i].text.startsWith('-')) {
    const list = [];
    while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('-')) {
      const rest = lines[i].text.slice(1).trim();
      i += 1;
      if (rest) {
        const kv = splitKey(rest);
        if (kv && !/^["'[{]/.test(rest)) {
          // `- key: value` mapping item (rare in `on:`): treat as single-key map
          list.push({ [kv[0]]: parseFlow(kv[1]) });
        } else list.push(parseFlow(rest));
      } else if (i < lines.length && lines[i].indent > indent) {
        const [v, n] = parseBlock(lines, i, lines[i].indent);
        list.push(v);
        i = n;
      } else list.push(null);
    }
    return [list, i];
  }
  const obj = {};
  while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('-')) {
    const kv = splitKey(lines[i].text);
    if (!kv) throw new Error(`cannot parse line: ${lines[i].text}`);
    const [key, rest] = kv;
    i += 1;
    if (rest) {
      obj[key] = parseFlow(rest);
    } else if (i < lines.length && lines[i].indent > indent) {
      const [v, n] = parseBlock(lines, i, lines[i].indent);
      obj[key] = v;
      i = n;
    } else if (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('-')) {
      // list at the same indent as its key
      const [v, n] = parseBlock(lines, i, indent);
      obj[key] = v;
      i = n;
    } else obj[key] = null;
  }
  return [obj, i];
}

/**
 * Parse the `on:` block of a workflow into { eventName: config|null }.
 * Throws if the block cannot be understood (the caller treats that as unsafe).
 */
export function parseOn(yamlText) {
  const all = yamlText.replace(/\r\n?/g, '\n').split('\n');
  const idx = all.findIndex((l) => /^(?:on|"on"|'on')\s*:/.test(l));
  if (idx < 0) throw new Error('no top-level `on:` key');
  const first = stripComment(all[idx]).replace(/^(?:on|"on"|'on')\s*:/, '').trim();
  let value;
  if (first) {
    value = parseFlow(first);
  } else {
    const lines = [];
    for (let j = idx + 1; j < all.length; j += 1) {
      const raw = stripComment(all[j]);
      if (!raw.trim()) continue;
      const indent = raw.length - raw.trimStart().length;
      if (indent === 0 && !raw.trimStart().startsWith('-')) break;
      if (/^\s*\t/.test(raw)) throw new Error('tab indentation');
      lines.push({ indent, text: raw.trim() });
    }
    if (lines.length === 0) throw new Error('empty `on:` block');
    value = parseBlock(lines, 0, lines[0].indent)[0];
  }
  if (typeof value === 'string') return { [value]: null };
  if (Array.isArray(value)) {
    const o = {};
    for (const v of value) {
      if (typeof v !== 'string') throw new Error('unexpected item in `on:` list');
      o[v] = null;
    }
    return o;
  }
  if (value && typeof value === 'object') return value;
  throw new Error('unrecognised `on:` value');
}

// ---------------------------------------------------------------------------
// GitHub filter patterns.
// ---------------------------------------------------------------------------

/** Translate a GitHub filter pattern (`*`, `**`, `?`, `+`, `[...]`) to a RegExp. */
export function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 1;
      } else re += '[^/]*';
    } else if (c === '?' || c === '+') re += c;
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else {
        re += pattern.slice(i, end + 1);
        i = end;
      }
    } else re += c.replace(/[.^$()|{}\\/]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Ordered include/exclude evaluation, as GitHub does for `branches`/`tags` with `!` patterns. */
export function matchesFilter(name, patterns) {
  let matched = false;
  for (const p of patterns) {
    if (typeof p !== 'string') continue;
    if (p.startsWith('!')) {
      if (globToRegExp(p.slice(1)).test(name)) matched = false;
    } else if (globToRegExp(p).test(name)) matched = true;
  }
  return matched;
}

/** Could `pattern` match some name that starts with `prefix`? (conservative, prefix-based) */
export function canMatchPrefix(pattern, prefix) {
  if (pattern.startsWith('!')) return false;
  const m = /[*?+[]/.exec(pattern);
  const lit = m ? pattern.slice(0, m.index) : pattern;
  return lit.startsWith(prefix) || prefix.startsWith(lit);
}

const asList = (v) => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Problems for one parsed `on:` map. Returns [{ event, reason }]. */
export function analyzeOn(on) {
  const problems = [];
  for (const ev of ALWAYS_UNSAFE) {
    if (Object.hasOwn(on, ev)) {
      problems.push({ event: ev, reason: `\`${ev}\` fires for refs the mirror creates or for other workflows` });
    }
  }
  if (Object.hasOwn(on, 'push')) {
    const cfg = on.push && typeof on.push === 'object' && !Array.isArray(on.push) ? on.push : {};
    const has = (k) => Object.hasOwn(cfg, k);
    const anyBranchFilter = has('branches') || has('branches-ignore');
    const anyTagFilter = has('tags') || has('tags-ignore');
    if (!anyBranchFilter && !anyTagFilter) {
      problems.push({ event: 'push', reason: '`push` has no branch/tag filter: it fires for every branch and tag push' });
    }
    if (!anyTagFilter && anyBranchFilter) {
      // branch-only filter: tag pushes never match
    }
    if (anyBranchFilter) {
      const hit = has('branches')
        ? MIRROR_BRANCHES.filter((b) => matchesFilter(b, asList(cfg.branches)))
        : MIRROR_BRANCHES.filter((b) => !asList(cfg['branches-ignore']).some((p) => globToRegExp(String(p)).test(b)));
      if (hit.length > 0) {
        problems.push({ event: 'push', reason: `\`push\` branch filter matches mirror branch(es): ${hit.join(', ')}` });
      }
    }
    if (anyTagFilter) {
      if (has('tags')) {
        const pats = asList(cfg.tags).map(String);
        const hit = MIRROR_TAG_PREFIXES.filter((pre) => pats.some((p) => canMatchPrefix(p, pre)));
        if (hit.length > 0) {
          problems.push({ event: 'push', reason: `\`push\` tag filter can match mirrored tags (${hit.map((h) => `${h}*`).join(', ')}): ${pats.join(', ')}` });
        }
      } else {
        const ignore = asList(cfg['tags-ignore']).map(String);
        if (!ignore.some((p) => p === '**' || p === '*')) {
          problems.push({ event: 'push', reason: '`push` with only `tags-ignore` fires for the mirrored v* and stable-* tags' });
        }
      }
    }
  }
  return problems;
}

/** Scan one workflow file's text. Unparseable => one unsafe finding. */
export function scanWorkflowText(text) {
  let on;
  try {
    on = parseOn(text);
  } catch (e) {
    return [{ event: '(unparsed)', reason: `cannot evaluate the \`on:\` block (${e.message}); treated as unsafe` }];
  }
  return analyzeOn(on);
}

// ---------------------------------------------------------------------------
// Git access and CLI.
// ---------------------------------------------------------------------------

function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

/** Scan the workflow tree at each ref. Trees are de-duplicated and `allow`ed trees skipped. */
export function scanRefs(repo, refs, allow = []) {
  const seen = new Map(); // tree -> [refs]
  const findings = [];
  for (const ref of refs) {
    let tree;
    try {
      tree = git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}:.github/workflows`]).trim();
    } catch {
      continue; // ref missing or no workflows directory: nothing can run
    }
    if (!tree) continue;
    if (seen.has(tree)) {
      seen.get(tree).push(ref);
      continue;
    }
    seen.set(tree, [ref]);
  }
  for (const [tree, treeRefs] of seen) {
    if (allow.includes(tree)) continue;
    const names = git(repo, ['ls-tree', '--name-only', tree]).split('\n').filter((n) => /\.ya?ml$/i.test(n));
    for (const name of names) {
      const text = git(repo, ['cat-file', 'blob', `${tree}:${name}`]);
      for (const p of scanWorkflowText(text)) {
        findings.push({ tree, refs: treeRefs.slice(0, 3), file: `.github/workflows/${name}`, ...p });
      }
    }
  }
  return { treesScanned: seen.size, findings };
}

function main(argv) {
  const refs = [];
  let repo = '.';
  let json = false;
  let allow = (process.env.TRUSTED_WORKFLOW_TREES || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repo') repo = argv[++i];
    else if (a === '--ref') refs.push(argv[++i]);
    else if (a === '--allow') allow = allow.concat(String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--json') json = true;
    else {
      console.error(`unknown argument: ${a}`);
      return 1;
    }
  }
  if (refs.length === 0) {
    console.error('usage: node ci/trigger-scan.mjs --repo <gitdir> --ref <ref> [--ref ...] [--allow <tree,...>] [--json]');
    return 1;
  }
  const { treesScanned, findings } = scanRefs(repo, refs, allow);
  if (json) console.log(JSON.stringify({ treesScanned, findings }, null, 2));
  else if (findings.length === 0) console.log(`workflow triggers: ${treesScanned} distinct workflow tree(s) scanned, none would fire on mirror refs`);
  else {
    for (const f of findings) {
      console.log(`UNSAFE ${f.file} @ ${f.refs.join(', ')} (tree ${f.tree}): ${f.reason}`);
    }
    console.log('To accept a reviewed workflow tree, add its id to the TRUSTED_WORKFLOW_TREES repository variable.');
  }
  return findings.length === 0 ? 0 : 3;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)));
}
