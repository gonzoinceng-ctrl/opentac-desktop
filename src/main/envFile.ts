import { readFile } from 'node:fs/promises';

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * Returns the index just past the closing quote that matches the quote at `text[0]`,
 * or -1 when the quote is not closed within `text`. Double quotes honour backslash escapes.
 */
function closingQuote(text: string): number {
  const quote = text[0];
  for (let i = 1; i < text.length; i += 1) {
    if (quote === '"' && text[i] === '\\') {
      i += 1;
    } else if (text[i] === quote) {
      return i;
    }
  }
  return -1;
}

/** True when the unquoted tail of a value (after an inline comment is stripped) has content. */
function unquotedHasContent(raw: string): boolean {
  const hash = raw.search(/(^|\s)#/);
  const value = hash === -1 ? raw : raw.slice(0, hash);
  return value.trim() !== '';
}

/**
 * Scans dotenv text and returns the keys whose value is non-empty. Values are inspected
 * only to decide emptiness; they are never stored or returned.
 */
function scanKeys(text: string): Set<string> {
  const keys = new Set<string>();
  const lines = text.split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line
      .slice(0, eq)
      .replace(/^export\s+/, '')
      .trim();
    if (!KEY_PATTERN.test(key)) continue;
    let rest = line.slice(eq + 1).trim();
    const first = rest[0];
    if (first === '"' || first === "'" || first === '`') {
      // Quoted values may span several lines; consume until the closing quote. When no closing
      // quote exists before EOF, Node's util.parseEnv (used upstream) treats the quote as an
      // ordinary character of the value, so fall back to the first line only as unquoted.
      const startLine = i;
      const firstLine = rest;
      let end = closingQuote(rest);
      while (end === -1 && i + 1 < lines.length) {
        i += 1;
        rest += `\n${lines[i] ?? ''}`;
        end = closingQuote(rest);
      }
      if (end === -1) {
        i = startLine;
        if (unquotedHasContent(firstLine)) keys.add(key);
      } else if (rest.slice(1, end).trim() !== '') {
        keys.add(key);
      }
    } else if (unquotedHasContent(rest)) {
      keys.add(key);
    }
  }
  return keys;
}

/**
 * Reads a dotenv file and returns the names of keys with a non-empty value.
 * Handles `export KEY=`, single/double quotes, comments and CRLF. A missing or unreadable
 * file yields an empty set. Values are never retained.
 */
export async function envFileKeys(file: string): Promise<Set<string>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return new Set();
  }
  return scanKeys(text);
}

/** True when `key` has a non-empty value in the dotenv file at `file`. */
export async function envFileHasKey(file: string, key: string): Promise<boolean> {
  return (await envFileKeys(file)).has(key);
}
