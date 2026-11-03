import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { redact, REDACTED } from '../shared/redact.js';
import type { AiProvider } from '../shared/types.js';
import type { Logger } from './logger.js';

const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';
const DEFAULT_BASES: Record<Exclude<AiProvider, 'ollama'>, string> = {
  openai: 'https://api.openai.com',
  openrouter: 'https://openrouter.ai/api',
  xai: 'https://api.x.ai',
};
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TOKEN_FLOOR = 600;
const BODY_LIMIT_BYTES = 1024 * 1024;
const OPENROUTER_REFERER = 'https://opentac.icu';
const OPENROUTER_TITLE = 'OpenTac';
/** Key the launcher injects so upstream does not short-circuit; never sent to a backend. */
const PLACEHOLDER_KEY = 'opentac-gateway-placeholder';
const NO_CONTENT_BUDGET = 'model returned no content (token budget spent on reasoning)';
const NO_CONTENT = 'model returned no content';
const ERROR_SNIPPET_CHARS = 200;
const TEST_PROMPT = 'Reply with the single word OK as JSON {"summary":"OK","feedState":null}';

/** Stable machine-readable failure classes of the gateway. */
export type AiGatewayErrorCode =
  'NOT_RUNNING' | 'BAD_REQUEST' | 'BACKEND' | 'TIMEOUT' | 'NO_KEY' | 'NO_MODEL';

/** Error thrown by the gateway; `message` is a plain sentence, `detail` an optional scrubbed hint. */
export class AiGatewayError extends Error {
  code: AiGatewayErrorCode;
  detail?: string;

  constructor(code: AiGatewayErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'AiGatewayError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** Live gateway settings; read on every request so Preferences changes apply immediately. */
export interface AiGatewayConfig {
  provider: AiProvider;
  model: string | null;
  /** Default http://127.0.0.1:11434. */
  ollamaHost: string | null;
  /** OpenRouter / xAI key from Keychain. */
  apiKey: string | null;
  /** Key used for the openai provider when the incoming request has no usable Authorization. */
  openAiKey?: string | null;
  /** Per-request deadline; default 10000. */
  requestTimeoutMs?: number;
  /** Minimum max-output-tokens sent to the backend; default 600. */
  maxOutputTokensFloor?: number;
}

/** Outcome of the Preferences "Test" button. */
export interface AiTestResult {
  ok: boolean;
  text: string;
  latencyMs: number;
  finishReason: string | null;
  error: string | null;
  provider: AiProvider;
  model: string | null;
}

/** The local HUD-summary gateway. */
export interface AiGateway {
  /** Starts listening on 127.0.0.1 (ephemeral port); idempotent. */
  start(): Promise<{ port: number; url: string }>;
  /** Stops listening, aborts in-flight backend calls and frees the port. */
  stop(): Promise<void>;
  /** Base URL while running, otherwise null. */
  url(): string | null;
  /** Sends a one-line request through the same backend path and reports the result. */
  testPrompt(cfg?: AiGatewayConfig): Promise<AiTestResult>;
}

/** The subset of the OpenAI Responses request that upstream sends. */
export interface ResponsesRequest {
  model?: string;
  instructions?: string;
  input?: unknown;
  text?: {
    format?: { type?: string; name?: string; strict?: boolean; schema?: unknown };
  };
  reasoning?: { effort?: string };
  max_output_tokens?: number;
  [key: string]: unknown;
}

/** Minimal Responses reply: exactly one message item holding one output_text part. */
export interface ResponsesShape {
  id: string;
  object: 'response';
  status: 'completed';
  model: string;
  output: Array<{
    type: 'message';
    role: 'assistant';
    status: 'completed';
    content: Array<{ type: 'output_text'; text: string; annotations: never[] }>;
  }>;
  output_text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Builds the minimal Responses-API reply that upstream's extractOpenAiResponseText accepts. */
export function toResponsesShape(text: string, model: string): ResponsesShape {
  return {
    id: `resp_opentac_${randomUUID().replaceAll('-', '')}`,
    object: 'response',
    status: 'completed',
    model,
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    output_text: text,
  };
}

// A language tag is only a tag when a newline follows it; '```Paris```' is prose, not a tag.
const FENCE_WHOLE = /^```(?:[A-Za-z0-9_-]+[ \t]*\n|\n)?([\s\S]*?)\s*```$/;
const FENCE_ANY = /```[A-Za-z0-9_-]*[ \t]*\n?([\s\S]*?)\s*```/g;

/**
 * Strips `<think>` blocks and markdown code fences from model output; a result that is a JSON
 * object is re-serialised compactly, anything else is returned trimmed but otherwise untouched.
 */
export function cleanModelText(text: string): string {
  // Text that already is a JSON object (bare or wholly fenced) is left alone: a string value may
  // legitimately contain the literal text '<think>'.
  const direct = text.trim();
  const bare = asJsonObject(direct);
  if (bare) return JSON.stringify(bare);
  const fenced = FENCE_WHOLE.exec(direct);
  const fencedObj = fenced?.[1] !== undefined ? asJsonObject(fenced[1].trim()) : null;
  if (fencedObj) return JSON.stringify(fencedObj);

  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  t = t.replace(/^[\s\S]*<\/think>/i, '');
  const dangling = t.search(/<think>/i);
  if (dangling >= 0) t = t.slice(0, dangling);
  t = t.trim();

  const whole = FENCE_WHOLE.exec(t);
  if (whole?.[1] !== undefined) {
    t = whole[1].trim();
  } else {
    for (const match of t.matchAll(FENCE_ANY)) {
      const inner = (match[1] ?? '').trim();
      if (asJsonObject(inner)) {
        t = inner;
        break;
      }
    }
  }

  const obj = asJsonObject(t);
  return obj ? JSON.stringify(obj) : t;
}

function partText(part: unknown): string {
  if (typeof part === 'string') return part;
  if (!isRecord(part)) return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.output_text === 'string') return part.output_text;
  return '';
}

/** Flattens a Responses `input` (string or message array) to plain text. */
function inputToText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    return input
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!isRecord(item)) return '';
        const content = item.content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) return content.map(partText).join('');
        return '';
      })
      .filter((s) => s.length > 0)
      .join('\n');
  }
  return input === undefined || input === null ? '' : JSON.stringify(input);
}

/** Translates an upstream Responses request into an OpenAI-style chat-completions body. */
export function translateToChat(
  body: ResponsesRequest,
  model: string,
  opts: { reasoningOff: boolean; maxTokens: number },
): object {
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (typeof body.instructions === 'string' && body.instructions.length > 0) {
    messages.push({ role: 'system', content: body.instructions });
  }
  messages.push({ role: 'user', content: inputToText(body.input) });

  const out: Record<string, unknown> = {
    model,
    messages,
    max_tokens: opts.maxTokens,
    temperature: 0.2,
    stream: false,
  };
  const format = body.text?.format;
  if (isRecord(format)) {
    if (format.type === 'json_schema' && format.schema !== undefined) {
      const jsonSchema: Record<string, unknown> = {
        name: typeof format.name === 'string' ? format.name : 'response',
        schema: format.schema,
      };
      if (typeof format.strict === 'boolean') jsonSchema.strict = format.strict;
      out.response_format = { type: 'json_schema', json_schema: jsonSchema };
    } else if (format.type === 'json_object') {
      out.response_format = { type: 'json_object' };
    }
  }
  if (opts.reasoningOff) out.reasoning_effort = 'none';
  return out;
}

function errorMessageOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    if (typeof value.message === 'string') return value.message;
    if (isRecord(value.error)) return errorMessageOf(value.error);
    if (typeof value.error === 'string') return value.error;
  }
  return null;
}

function snippet(text: string): string {
  return redact(text).replace(/\s+/g, ' ').trim().slice(0, ERROR_SNIPPET_CHARS);
}

/** Pulls the text, finish reason and any error out of a chat-completions reply. */
export function extractChatText(reply: unknown): {
  text: string;
  finishReason: string | null;
  error: string | null;
} {
  if (!isRecord(reply)) {
    return { text: '', finishReason: null, error: 'unexpected reply from the model backend' };
  }
  const choices = Array.isArray(reply.choices) ? (reply.choices as unknown[]) : [];
  const choice = choices[0];
  if (!isRecord(choice)) {
    const topError = errorMessageOf(reply.error);
    return {
      text: '',
      finishReason: null,
      error: topError
        ? `model backend error: ${snippet(topError)}`
        : 'model backend returned no choices',
    };
  }
  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
  if (choice.error !== undefined && choice.error !== null) {
    const msg = errorMessageOf(choice.error);
    return {
      text: '',
      finishReason,
      error: `model backend error: ${msg ? snippet(msg) : 'unspecified'}`,
    };
  }
  const message = isRecord(choice.message) ? choice.message : null;
  const content = message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(partText).join('')
        : '';
  if (text.trim().length === 0) {
    return {
      text: '',
      finishReason,
      error: finishReason === 'length' ? NO_CONTENT_BUDGET : NO_CONTENT,
    };
  }
  return { text, finishReason, error: null };
}

/** Text of the assistant message items of a Responses reply (reasoning items are ignored). */
function extractResponsesText(data: Record<string, unknown>): {
  text: string;
  finishReason: string | null;
  incompleteReason: string | null;
} {
  const parts: string[] = [];
  if (Array.isArray(data.output)) {
    for (const item of data.output as unknown[]) {
      if (!isRecord(item)) continue;
      if (item.type !== undefined && item.type !== 'message') continue;
      if (typeof item.content === 'string') {
        parts.push(item.content);
      } else if (Array.isArray(item.content)) {
        for (const part of item.content as unknown[]) {
          if (isRecord(part) && part.type !== undefined) {
            if (part.type !== 'output_text' && part.type !== 'text') continue;
          }
          parts.push(partText(part));
        }
      }
    }
  }
  let text = parts.join('');
  if (text.trim().length === 0 && typeof data.output_text === 'string') text = data.output_text;

  let finishReason: string | null = null;
  let incompleteReason: string | null = null;
  if (data.status === 'incomplete') {
    const details = data.incomplete_details;
    incompleteReason =
      isRecord(details) && typeof details.reason === 'string' ? details.reason : 'incomplete';
    finishReason = incompleteReason;
  } else if (data.status === 'completed') {
    finishReason = 'stop';
  } else if (typeof data.status === 'string') {
    finishReason = data.status;
  }
  return { text, finishReason, incompleteReason };
}

/** Options for {@link createAiGateway}. */
export interface CreateAiGatewayOptions {
  getConfig: () => AiGatewayConfig;
  log: Logger;
  fetchImpl?: typeof fetch;
  /** Base URL overrides per provider (tests). */
  endpoints?: Partial<Record<AiProvider, string>>;
  /**
   * Per-launch shared secret. When set, POST /v1/responses must carry it in the
   * x-opentac-gateway-token header; the launcher's fetch interceptor adds it. Stops any other local
   * process or web page from spending the configured provider keys.
   */
  authToken?: string;
}

interface RequestContext {
  signal: AbortSignal;
  timeout: AbortSignal;
  controller: AbortController;
  dispose(): void;
}

interface Outcome {
  status: number;
  body: string;
  text: string;
  finishReason: string | null;
  model: string | null;
}

function trimSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

function normaliseHost(host: string): string {
  const trimmed = host.trim();
  return trimSlashes(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
}

function statusFor(code: AiGatewayErrorCode): number {
  switch (code) {
    case 'TIMEOUT':
      return 504;
    case 'BAD_REQUEST':
      return 400;
    case 'NOT_RUNNING':
      return 503;
    default:
      return 502;
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  sendRaw(res, status, JSON.stringify(payload));
}

function sendRaw(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Reads the request body; resolves null once it exceeds the limit. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        done = true;
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
    req.on('close', () => {
      if (done) return;
      done = true;
      reject(new Error('client closed the connection'));
    });
  });
}

/** Creates the local HUD-summary gateway (not started until {@link AiGateway.start}). */
/** Constant-time string comparison via SHA-256 digests (lengths may differ). */
function timingSafeEqualStr(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

export function createAiGateway(opts: CreateAiGatewayOptions): AiGateway {
  const log = opts.log.scope('aiGateway');
  const fetchImpl: typeof fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const inflight = new Set<AbortController>();
  let server: Server | null = null;
  let starting: Promise<{ port: number; url: string }> | null = null;
  let baseUrl: string | null = null;

  function baseFor(provider: Exclude<AiProvider, 'ollama'>): string {
    return trimSlashes(opts.endpoints?.[provider] ?? DEFAULT_BASES[provider]);
  }

  function makeContext(cfg: AiGatewayConfig): RequestContext {
    const controller = new AbortController();
    inflight.add(controller);
    const timeout = AbortSignal.timeout(cfg.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    return {
      signal: AbortSignal.any([timeout, controller.signal]),
      timeout,
      controller,
      dispose: () => {
        inflight.delete(controller);
      },
    };
  }

  function scrub(text: string, cfg: AiGatewayConfig): string {
    let t = text;
    for (const secret of [cfg.apiKey, cfg.openAiKey]) {
      if (secret && secret.length >= 6) t = t.split(secret).join(REDACTED);
    }
    return snippet(t);
  }

  function failure(provider: AiProvider, status: number, text: string, cfg: AiGatewayConfig) {
    const parsed = asJsonObject(text);
    const hint = parsed ? errorMessageOf(parsed) : null;
    return new AiGatewayError(
      'BACKEND',
      `the ${provider} backend returned HTTP ${status}`,
      hint ? scrub(hint, cfg) : undefined,
    );
  }

  async function post(
    ctx: RequestContext,
    provider: AiProvider,
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<{ status: number; text: string }> {
    try {
      const resp = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
        signal: ctx.signal,
        redirect: 'error',
      });
      const text = await resp.text();
      return { status: resp.status, text };
    } catch (err) {
      if (ctx.timeout.aborted) throw new AiGatewayError('TIMEOUT', 'request timed out');
      if (ctx.controller.signal.aborted) {
        throw new AiGatewayError('BACKEND', 'the gateway was stopped before the backend replied');
      }
      const cause = err instanceof Error && isRecord(err.cause) ? err.cause : null;
      const code = cause && typeof cause.code === 'string' ? cause.code : null;
      throw new AiGatewayError(
        'BACKEND',
        `could not reach the ${provider} backend`,
        code ?? (err instanceof Error ? snippet(err.message) : undefined),
      );
    }
  }

  function chatOutcome(
    provider: AiProvider,
    cfg: AiGatewayConfig,
    model: string,
    result: { status: number; text: string },
  ): Outcome {
    if (result.status < 200 || result.status >= 300) {
      throw failure(provider, result.status, result.text, cfg);
    }
    const parsed = asJsonObject(result.text);
    if (!parsed) throw new AiGatewayError('BACKEND', `the ${provider} backend reply was not JSON`);
    const { text, finishReason, error } = extractChatText(parsed);
    if (error) {
      if (error === NO_CONTENT || error === NO_CONTENT_BUDGET) {
        throw new AiGatewayError('BACKEND', error);
      }
      // Backend-controlled text goes to `detail` only, never into the client-visible message.
      throw new AiGatewayError(
        'BACKEND',
        `the ${provider} backend reported an error`,
        scrub(error, cfg),
      );
    }
    return finishOutcome(model, text, finishReason);
  }

  function finishOutcome(model: string, raw: string, finishReason: string | null): Outcome {
    const text = cleanModelText(raw);
    if (text.length === 0) throw new AiGatewayError('BACKEND', NO_CONTENT);
    return {
      status: 200,
      body: JSON.stringify(toResponsesShape(text, model)),
      text,
      finishReason,
      model,
    };
  }

  function requireModel(cfg: AiGatewayConfig): string {
    const model = cfg.model?.trim();
    if (!model) throw new AiGatewayError('NO_MODEL', 'no model is configured for the AI provider');
    return model;
  }

  function requireKey(cfg: AiGatewayConfig): string {
    const key = cfg.apiKey?.trim();
    if (!key) throw new AiGatewayError('NO_KEY', 'no API key is configured for the AI provider');
    return key;
  }

  function maxTokensFor(cfg: AiGatewayConfig, req: ResponsesRequest): number {
    const incoming = typeof req.max_output_tokens === 'number' ? req.max_output_tokens : 0;
    return Math.max(cfg.maxOutputTokensFloor ?? DEFAULT_TOKEN_FLOOR, incoming);
  }

  async function viaOllama(
    ctx: RequestContext,
    cfg: AiGatewayConfig,
    req: ResponsesRequest,
  ): Promise<Outcome> {
    const model = requireModel(cfg);
    const host = normaliseHost(
      cfg.ollamaHost?.trim() || opts.endpoints?.ollama || DEFAULT_OLLAMA_HOST,
    );
    const body = translateToChat(req, model, {
      reasoningOff: true,
      maxTokens: maxTokensFor(cfg, req),
    });
    const result = await post(
      ctx,
      'ollama',
      `${host}/v1/chat/completions`,
      {},
      JSON.stringify(body),
    );
    return chatOutcome('ollama', cfg, model, result);
  }

  async function viaCloud(
    ctx: RequestContext,
    cfg: AiGatewayConfig,
    req: ResponsesRequest,
    provider: 'openrouter' | 'xai',
  ): Promise<Outcome> {
    const model = requireModel(cfg);
    const key = requireKey(cfg);
    const base = baseFor(provider);
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    if (provider === 'openrouter') {
      headers['HTTP-Referer'] = OPENROUTER_REFERER;
      headers['X-OpenRouter-Title'] = OPENROUTER_TITLE;
    }
    const maxTokens = maxTokensFor(cfg, req);
    const body = {
      ...req,
      model,
      max_output_tokens: maxTokens,
      reasoning: { effort: 'minimal' },
    };
    const result = await post(ctx, provider, `${base}/v1/responses`, headers, JSON.stringify(body));

    if (
      (result.status === 404 || result.status === 405 || result.status === 400) &&
      /responses|not found/i.test(result.text)
    ) {
      log.warn(
        `${provider} rejected /v1/responses (HTTP ${result.status}); using chat completions`,
      );
      const chat: Record<string, unknown> = {
        ...(translateToChat(req, model, { reasoningOff: false, maxTokens }) as Record<
          string,
          unknown
        >),
      };
      if (provider === 'openrouter') chat.reasoning = { effort: 'minimal' };
      const fallback = await post(
        ctx,
        provider,
        `${base}/v1/chat/completions`,
        headers,
        JSON.stringify(chat),
      );
      return chatOutcome(provider, cfg, model, fallback);
    }

    if (result.status < 200 || result.status >= 300) {
      throw failure(provider, result.status, result.text, cfg);
    }
    const data = asJsonObject(result.text);
    if (!data) throw new AiGatewayError('BACKEND', `the ${provider} backend reply was not JSON`);
    if (data.error !== undefined && data.error !== null) {
      const msg = errorMessageOf(data.error);
      throw new AiGatewayError(
        'BACKEND',
        `the ${provider} backend reported an error`,
        msg ? scrub(msg, cfg) : undefined,
      );
    }
    const { text, finishReason, incompleteReason } = extractResponsesText(data);
    if (text.trim().length === 0) {
      throw new AiGatewayError(
        'BACKEND',
        incompleteReason === 'max_output_tokens' ? NO_CONTENT_BUDGET : NO_CONTENT,
      );
    }
    return finishOutcome(model, text, finishReason);
  }

  async function viaOpenAi(
    ctx: RequestContext,
    cfg: AiGatewayConfig,
    rawBody: string,
    incomingAuth: string | null,
  ): Promise<Outcome> {
    const usable =
      incomingAuth !== null &&
      !incomingAuth.includes(PLACEHOLDER_KEY) &&
      /^Bearer\s+\S+/i.test(incomingAuth);
    const own = cfg.openAiKey?.trim();
    const auth = usable ? incomingAuth : own ? `Bearer ${own}` : null;
    if (auth === null) throw new AiGatewayError('NO_KEY', 'no OpenAI API key is available');
    const result = await post(
      ctx,
      'openai',
      `${baseFor('openai')}/v1/responses`,
      { Authorization: auth },
      rawBody,
    );
    if (result.status < 200 || result.status >= 300) {
      throw failure('openai', result.status, result.text, cfg);
    }
    const data = asJsonObject(result.text);
    const extracted = data ? extractResponsesText(data) : null;
    return {
      status: result.status,
      body: result.text,
      text: extracted?.text.trim() ?? '',
      finishReason: extracted?.finishReason ?? null,
      model: typeof data?.model === 'string' ? data.model : (cfg.model ?? null),
    };
  }

  /** Runs one request against the configured backend, logging start, end and duration. */
  async function execute(
    cfg: AiGatewayConfig,
    req: ResponsesRequest,
    rawBody: string,
    incomingAuth: string | null,
    ctx: RequestContext,
  ): Promise<Outcome> {
    const label = `${cfg.provider} model=${cfg.model ?? '-'}`;
    log.info(`request start ${label}`);
    const stop = log.time(`request ${label}`);
    try {
      let outcome: Outcome;
      switch (cfg.provider) {
        case 'openai':
          outcome = await viaOpenAi(ctx, cfg, rawBody, incomingAuth);
          break;
        case 'ollama':
          outcome = await viaOllama(ctx, cfg, req);
          break;
        case 'openrouter':
        case 'xai':
          outcome = await viaCloud(ctx, cfg, req, cfg.provider);
          break;
        default:
          throw new AiGatewayError('BAD_REQUEST', 'unknown AI provider');
      }
      log.info(
        `request done ${label} status=${outcome.status} finishReason=${outcome.finishReason ?? '-'}`,
      );
      return outcome;
    } catch (err) {
      const code = err instanceof AiGatewayError ? err.code : 'BACKEND';
      log.warn(`request failed ${label} code=${code}`);
      throw err;
    } finally {
      stop();
    }
  }

  function toGatewayError(err: unknown): AiGatewayError {
    if (err instanceof AiGatewayError) return err;
    log.error(`unexpected gateway error: ${err instanceof Error ? err.message : String(err)}`);
    return new AiGatewayError('BACKEND', 'unexpected gateway error');
  }

  async function handleResponses(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) {
      res.setHeader('Connection', 'close');
      sendJson(res, 413, { error: 'OpenTac AI gateway: request body too large' });
      return;
    }
    const raw = await readBody(req);
    if (raw === null) {
      res.setHeader('Connection', 'close');
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'OpenTac AI gateway: request body too large' }), () => {
        req.destroy();
      });
      return;
    }
    const parsed = asJsonObject(raw);
    if (!parsed) {
      sendJson(res, 400, { error: 'OpenTac AI gateway: request body is not a JSON object' });
      return;
    }
    const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : null;
    let ctx: RequestContext | null = null;
    try {
      const cfg = opts.getConfig();
      const context = makeContext(cfg);
      ctx = context;
      res.on('close', () => {
        if (!res.writableFinished) context.controller.abort();
      });
      const outcome = await execute(cfg, parsed as ResponsesRequest, raw, auth, context);
      sendRaw(res, outcome.status, outcome.body);
    } catch (err) {
      const gw = toGatewayError(err);
      sendJson(res, statusFor(gw.code), { error: `OpenTac AI gateway: ${gw.message}` });
    } finally {
      ctx?.dispose();
    }
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true, provider: opts.getConfig().provider });
        return;
      }
      if (req.method === 'POST' && path === '/v1/responses') {
        if (opts.authToken) {
          const presented = req.headers['x-opentac-gateway-token'];
          const ok = typeof presented === 'string' && timingSafeEqualStr(presented, opts.authToken);
          if (!ok) {
            log.warn('rejected /v1/responses request without a valid gateway token');
            sendJson(res, 401, { error: 'OpenTac AI gateway: missing or invalid gateway token' });
            return;
          }
        }
        await handleResponses(req, res);
        return;
      }
      sendJson(res, 404, { error: 'OpenTac AI gateway: not found' });
    } catch (err) {
      log.error(`request handler failed: ${err instanceof Error ? err.message : String(err)}`);
      if (res.headersSent) res.destroy();
      else sendJson(res, 502, { error: 'OpenTac AI gateway: unexpected gateway error' });
    }
  }

  function listen(): Promise<{ port: number; url: string }> {
    return new Promise((resolve, reject) => {
      const srv = createServer((req, res) => {
        void handleRequest(req, res);
      });
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        srv.off('error', reject);
        srv.on('error', (err) => log.error(`server error: ${err.message}`));
        server = srv;
        const port = (srv.address() as AddressInfo).port;
        baseUrl = `http://127.0.0.1:${port}`;
        log.info(`listening on ${baseUrl}`);
        resolve({ port, url: baseUrl });
      });
    });
  }

  return {
    start() {
      if (server && baseUrl) {
        return Promise.resolve({ port: (server.address() as AddressInfo).port, url: baseUrl });
      }
      starting ??= listen().finally(() => {
        starting = null;
      });
      return starting;
    },

    async stop() {
      if (starting) await starting.catch(() => undefined);
      const srv = server;
      server = null;
      baseUrl = null;
      for (const controller of inflight) controller.abort();
      if (!srv) return;
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections();
      });
      log.info('stopped');
    },

    url() {
      return baseUrl;
    },

    async testPrompt(override) {
      const cfg = override ?? opts.getConfig();
      const startedAt = performance.now();
      const model = cfg.model?.trim() || null;
      const body: ResponsesRequest = {
        model: model ?? (cfg.provider === 'openai' ? 'gpt-5-nano' : 'unset'),
        instructions: 'You are a connectivity check. Answer with JSON only.',
        input: TEST_PROMPT,
        text: {
          format: {
            type: 'json_schema',
            name: 'hud_summary',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                summary: { type: 'string' },
                feedState: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              },
              required: ['summary', 'feedState'],
              additionalProperties: false,
            },
          },
        },
        reasoning: { effort: 'minimal' },
        max_output_tokens: 200,
      };
      const ctx = makeContext(cfg);
      try {
        const outcome = await execute(cfg, body, JSON.stringify(body), null, ctx);
        return {
          ok: outcome.text.length > 0,
          text: outcome.text,
          latencyMs: Math.round(performance.now() - startedAt),
          finishReason: outcome.finishReason,
          error: outcome.text.length > 0 ? null : NO_CONTENT,
          provider: cfg.provider,
          model,
        };
      } catch (err) {
        const gw = err instanceof AiGatewayError ? err : toGatewayError(err);
        return {
          ok: false,
          text: '',
          latencyMs: Math.round(performance.now() - startedAt),
          finishReason: null,
          error: gw.detail ? `${gw.message} (${gw.detail})` : gw.message,
          provider: cfg.provider,
          model,
        };
      } finally {
        ctx.dispose();
      }
    },
  };
}
