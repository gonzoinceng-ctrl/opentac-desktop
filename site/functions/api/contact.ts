// Cloudflare Pages Function: POST /api/contact
//
// Stores a contact message in the CONTACT_KV namespace (key `msg:<iso>:<random>`, 90-day TTL, no index:
// list by prefix). No email is sent and nothing leaves Cloudflare. Rate limit: 5 messages per hour per
// client IP, tracked under a hashed key that expires with the hour. The IP is never stored with a message.
//
// Browser without JavaScript: form POST -> 303 to /contact/thanks/ (errors: a small HTML page).
// With contact.js (fetch, Accept: application/json): JSON { ok: true } or { ok: false, error }.

interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}
interface Env {
  CONTACT_KV: KVNamespaceLike;
}
interface Ctx {
  request: Request;
  env: Env;
}

const SUBJECTS = ['App problem', 'Engine/globe question', 'Feedback', 'Other'] as const;
const MAX_BODY_BYTES = 20_000;
const LIMITS = { name: 100, email: 254, message: 5000 } as const;
const MIN_MESSAGE = 10;
const RATE_MAX = 5;
const RATE_WINDOW_S = 3600;
const MSG_TTL_S = 90 * 24 * 3600;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

class Reject extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

const escHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function errorPage(message: string, status: number, extra: Record<string, string> = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Message not sent | OpenTac</title></head><body><main><h1>Your message was not sent</h1><p>${escHtml(message)}</p><p><a href="/contact/">Back to the contact form</a></p></main></body></html>`;
  return new Response(html, { status, headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', ...extra } });
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readFields(request: Request): Promise<Record<string, unknown>> {
  const type = (request.headers.get('Content-Type') ?? '').toLowerCase();
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw new Reject(413, 'The message is too large.');
  const isJson = type.startsWith('application/json');
  const isForm = type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data');
  if (!isJson && !isForm) throw new Reject(415, 'Unsupported content type.');
  if (isJson) {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) throw new Reject(413, 'The message is too large.');
    try {
      const v: unknown = JSON.parse(text);
      if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
      return v as Record<string, unknown>;
    } catch {
      throw new Reject(400, 'The request body could not be read.');
    }
  }
  try {
    const form = await request.formData();
    const out: Record<string, unknown> = {};
    for (const [k, v] of form.entries()) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    throw new Reject(400, 'The form could not be read.');
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim() : '');

export const onRequestPost = async ({ request, env }: Ctx): Promise<Response> => {
  const wantsJson =
    (request.headers.get('Accept') ?? '').includes('application/json') ||
    (request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json');
  const fail = (status: number, message: string, extra: Record<string, string> = {}): Response =>
    wantsJson ? json({ ok: false, error: message }, status, extra) : errorPage(message, status, extra);

  try {
    // Same-origin only (browsers send Origin on POST). Non-browser clients without Origin are allowed.
    const origin = request.headers.get('Origin');
    if (origin !== null && origin !== new URL(request.url).origin) throw new Reject(403, 'Cross-site requests are not accepted.');

    const f = await readFields(request);

    // Honeypot: bots fill it. Pretend success, store nothing.
    if (str(f.website) !== '' || str(f.company) !== '') {
      return wantsJson ? json({ ok: true }, 200) : redirectThanks(request);
    }

    const name = str(f.name);
    const email = str(f.email);
    const subject = str(f.subject);
    const message = str(f.message);
    if (name.length < 1 || name.length > LIMITS.name) throw new Reject(400, `Please enter your name (up to ${LIMITS.name} characters).`);
    if (email.length > LIMITS.email || !EMAIL_RE.test(email)) throw new Reject(400, 'Please enter a valid email address.');
    if (!(SUBJECTS as readonly string[]).includes(subject)) throw new Reject(400, 'Please choose a subject.');
    if (message.length < MIN_MESSAGE || message.length > LIMITS.message)
      throw new Reject(400, `Please write a message between ${MIN_MESSAGE} and ${LIMITS.message} characters.`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(name + email + subject + message)) throw new Reject(400, 'The message contains control characters.');

    // Rate limit: 5 per hour per IP (hashed; the key expires with the window). KV is not atomic, so this is
    // a courtesy limit rather than a hard guarantee.
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const bucket = Math.floor(Date.now() / (RATE_WINDOW_S * 1000));
    const rlKey = `rl:${(await sha256Hex(`${ip}|${bucket}`)).slice(0, 32)}`;
    const used = Number((await env.CONTACT_KV.get(rlKey)) ?? '0') || 0;
    if (used >= RATE_MAX) throw new Reject(429, 'Too many messages from this network. Please try again in an hour.');
    await env.CONTACT_KV.put(rlKey, String(used + 1), { expirationTtl: RATE_WINDOW_S + 60 });

    const iso = new Date().toISOString();
    await env.CONTACT_KV.put(`msg:${iso}:${randomId()}`, JSON.stringify({ receivedAt: iso, name, email, subject, message }), {
      expirationTtl: MSG_TTL_S,
    });

    return wantsJson ? json({ ok: true }, 200) : redirectThanks(request);
  } catch (e) {
    if (e instanceof Reject) return fail(e.status, e.message, e.status === 429 ? { 'Retry-After': String(RATE_WINDOW_S) } : {});
    return fail(500, 'Something went wrong on our side. Please try again later, or open an issue on GitHub.');
  }
};

function redirectThanks(request: Request): Response {
  return new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: new URL('/contact/thanks/', request.url).toString() } });
}

// Anything but POST: 405 (GET on /api/contact is not a page).
export const onRequest = async ({ request }: Ctx): Promise<Response> =>
  new Response('Method Not Allowed', { status: 405, headers: { ...SECURITY_HEADERS, Allow: 'POST', 'Content-Type': 'text/plain; charset=utf-8' } });
