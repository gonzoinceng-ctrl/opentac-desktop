/** Placeholder substituted for every secret found in text. */
export const REDACTED = '[REDACTED]';

/** Replacer callback form: receives the full match followed by the capture groups. */
export type RedactionReplacer = (match: string, ...groups: string[]) => string;

/** One redaction rule: a global regex plus a replacement string (may use groups) or replacer. */
export interface RedactionPattern {
  readonly name: string;
  readonly regex: RegExp;
  readonly replacement: string | RedactionReplacer;
}

/** Keywords that mark an environment-style variable name as holding a secret. */
// Whole-word suffix match: OPENAI_API_KEY, GITHUB_TOKEN, CLIENT_SECRET, DB_PASSWORD, ACCESS_TOKEN — but not max_tokens=200.
const SECRET_KEY_NAME = /(?:^|_)(?:API_KEY|KEY|TOKEN|SECRET|PASSWORD|PASS)$/i;

/**
 * Replacer for `KEY=VALUE`: keeps the match untouched unless KEY names a secret.
 * The key is matched as a bare word and tested here, which keeps the regex linear.
 */
const redactSecretAssignment: RedactionReplacer = (match, key, separator) =>
  SECRET_KEY_NAME.test(key) ? `${key}${separator}${REDACTED}` : match;

/**
 * Ordered list of redaction rules. Order matters: more specific shapes (URLs with
 * credentials, KEY=VALUE, full JWTs) run before the bare-token shapes they overlap.
 */
export const REDACTION_PATTERNS: readonly RedactionPattern[] = [
  {
    name: 'url-credentials',
    // Bounded quantifiers keep repeated "https://a:" input linear; the password may contain
    // '@' or '/' (tools print them raw), so it runs to the last '@' of the non-space run.
    regex: /\b(https?:\/\/)[^\s/@:]{1,256}:\S{0,256}@(?=[^\s@])/gi,
    replacement: `$1${REDACTED}@`,
  },
  {
    name: 'env-assignment',
    regex: /\b([A-Za-z0-9_]+)([ \t]*=[ \t]*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)/g,
    replacement: redactSecretAssignment,
  },
  {
    // JSON ("apiKey":"..."), header (x-api-key: ..., Authorization: ...) and colon forms.
    // The scheme of an Authorization value (Bearer/Basic) is kept so the log still says which.
    name: 'header-or-json-secret',
    regex:
      /(?<![A-Za-z0-9])(["']?)((?:api[-_]?key|apikey|authorization|x-[a-z0-9-]{0,40}token|x-[a-z0-9-]{0,40}key|secret|password|passwd|access[-_]?token|refresh[-_]?token))\1([ \t]*[:=][ \t]*)(["']?)((?:Bearer[ \t]+|Basic[ \t]+)?)([^\s"',;&}]{4,})/gi,
    replacement: (_m, q1, key, sep, q2, scheme) => `${q1}${key}${q1}${sep}${q2}${scheme}${REDACTED}`,
  },
  {
    name: 'firms-key-in-path',
    // NASA FIRMS puts the 32-hex map key in the URL path: /api/area/csv/<key>/VIIRS_...
    regex: /(\/csv\/)[A-Fa-f0-9]{32}(?=\/|\b)/g,
    replacement: `$1${REDACTED}`,
  },
  {
    name: 'mapillary-token',
    regex: /\bMLY\|\d+\|[A-Za-z0-9]{16,}/g,
    replacement: REDACTED,
  },
  {
    name: 'bearer-token',
    regex: /\b(Bearer[ \t]+)[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: `$1${REDACTED}`,
  },
  {
    name: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replacement: REDACTED,
  },
  {
    name: 'jwt-fragment',
    regex: /\beyJ[A-Za-z0-9_-]{20,}/g,
    replacement: REDACTED,
  },
  {
    name: 'openrouter-key',
    regex: /(?<![A-Za-z0-9])sk-or-v1-[a-f0-9]{20,}/g,
    replacement: REDACTED,
  },
  {
    name: 'openai-key',
    regex: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{10,}/g,
    replacement: REDACTED,
  },
  {
    name: 'google-api-key',
    regex: /\bAIza[0-9A-Za-z_-]{30,}/g,
    replacement: REDACTED,
  },
  {
    name: 'github-token',
    regex: /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    replacement: REDACTED,
  },
  {
    name: 'github-fine-grained-pat',
    regex: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    replacement: REDACTED,
  },
  {
    name: 'xai-key',
    regex: /(?<![A-Za-z0-9])xai-[A-Za-z0-9]{20,}/g,
    replacement: REDACTED,
  },
];

/** Replaces secrets (API keys, tokens, credentialed URLs, KEY=VALUE secrets) with `[REDACTED]`. */
export function redact(text: string): string {
  let out = text;
  for (const { regex, replacement } of REDACTION_PATTERNS) {
    out =
      typeof replacement === 'string'
        ? out.replace(regex, replacement)
        : out.replace(regex, replacement);
  }
  return out;
}

/**
 * Replaces the user's home directory in paths with `~` so pasted diagnostics do not carry the
 * macOS account name. `home` is passed in because this module must not import Node builtins.
 */
export function redactHomeDir(text: string, home: string): string {
  const h = home.replace(/\/+$/, '');
  if (h === '' || h === '/') return text;
  const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`${escaped}(?![A-Za-z0-9_.-])`, 'g'), '~');
}
