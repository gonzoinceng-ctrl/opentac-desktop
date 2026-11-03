#!/usr/bin/env node
// Owner CLI for the contact form inbox (Cloudflare KV namespace CONTACT_KV).
//
//   node site/contact-inbox.mjs list            list stored messages (newest last), with sender and subject
//   node site/contact-inbox.mjs read <key>      print one message (key as shown by `list`)
//   node site/contact-inbox.mjs delete <key>    delete one message
//
// Needs a Cloudflare API token with Workers KV Storage: Edit, in CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID (or a prior `npx wrangler login`). The namespace id is read from site/wrangler.toml.
// Messages expire on their own after 90 days. Keys look like msg:<iso timestamp>:<random>.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const toml = fs.readFileSync(path.join(HERE, 'wrangler.toml'), 'utf8');
const id = /binding\s*=\s*"CONTACT_KV"\s*\n\s*id\s*=\s*"([0-9a-f]{32})"/.exec(toml)?.[1];
if (!id) { console.error('CONTACT_KV id not found in site/wrangler.toml'); process.exit(1); }

const wr = (...args) =>
  execFileSync('npx', ['-y', 'wrangler@4', 'kv', 'key', ...args, '--namespace-id', id, '--remote'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024,
  });

const [cmd, key] = process.argv.slice(2);
if (cmd === 'list') {
  const keys = JSON.parse(wr('list', '--prefix', 'msg:')).map((k) => k.name).sort();
  if (!keys.length) console.log('(no messages)');
  for (const k of keys) {
    let line = k;
    try {
      const m = JSON.parse(wr('get', k));
      line += `\t${m.subject}\t${m.name} <${m.email}>`;
    } catch { /* unreadable: list the key only */ }
    console.log(line);
  }
} else if (cmd === 'read' && key?.startsWith('msg:')) {
  const m = JSON.parse(wr('get', key));
  console.log(`Received: ${m.receivedAt}\nFrom:     ${m.name} <${m.email}>\nSubject:  ${m.subject}\n\n${m.message}`);
} else if (cmd === 'delete' && key?.startsWith('msg:')) {
  wr('delete', key);
  console.log(`deleted ${key}`);
} else {
  console.error('usage: node site/contact-inbox.mjs list | read <key> | delete <key>');
  process.exit(2);
}
