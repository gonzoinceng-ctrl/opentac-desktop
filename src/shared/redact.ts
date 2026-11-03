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
