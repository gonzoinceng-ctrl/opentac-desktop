import { connect } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AiGatewayError,
  cleanModelText,
  createAiGateway,
  extractChatText,
  toResponsesShape,
  translateToChat,
  type AiGateway,
  type AiGatewayConfig,
  type ResponsesRequest,
} from '../../src/main/aiGateway.js';
import { createLogger } from '../../src/main/logger.js';
import { isPortFree } from '../../src/main/ports.js';
import {
  chatReply,
  replyJson,
  startBackend,
  type MockBackend,
} from '../helpers/aiGateway-backends.js';

/** Copied from upstream server/providers/openai/hud-summary.js (extractOpenAiResponseText). */
function extractOpenAiResponseText(data: any): string {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (!Array.isArray(data?.output)) return '';
  return data.output
    .flatMap((item: any) => (Array.isArray(item?.content) ? item.content : []))
    .map((part: any) => part?.text || part?.output_text || '')
    .join(' ')
    .trim();
}

const TEST_TOKEN = 'test-gateway-token';
const PLACEHOLDER = 'opentac-gateway-placeholder';
const SUMMARY_JSON = '{"summary":"Eiffel Tower Paris","feedState":null}';
const INSTRUCTIONS = 'SECRET-INSTRUCTIONS-TEXT write a summary';
const INPUT = 'SECRET-INPUT-CONTEXT {"place":"Paris"}';

function upstreamBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'gpt-5-nano',
    instructions: INSTRUCTIONS,
    input: INPUT,
    text: {
      format: {
        type: 'json_schema',
        name: 'hud_summary',
        strict: true,
        schema: { type: 'object', properties: { summary: { type: 'string' } } },
      },
    },
    reasoning: { effort: 'minimal' },
    max_output_tokens: 200,
    ...extra,
  };
}

const logLines: string[] = [];
const log = createLogger(
  {
    info: (m) => logLines.push(m),
    warn: (m) => logLines.push(m),
    error: (m) => logLines.push(m),
    debug: (m) => logLines.push(m),
  },
  { scope: 'test' },
);

const backends: MockBackend[] = [];
const gateways: AiGateway[] = [];

async function backend(handler: Parameters<typeof startBackend>[0]): Promise<MockBackend> {
  const b = await startBackend(handler);
  backends.push(b);
  return b;
}

interface Harness {
  gw: AiGateway;
  url: string;
  cfg: AiGatewayConfig;
  post(
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; text: string; json: any; contentType: string | null }>;
}

async function harness(
  cfg: Partial<AiGatewayConfig>,
  endpoints: Partial<Record<'openai' | 'openrouter' | 'xai' | 'ollama', string>> = {},
): Promise<Harness> {
  const config: AiGatewayConfig = {
    provider: 'ollama',
    model: 'qwen3:8b',
    ollamaHost: null,
    apiKey: null,
    ...cfg,
  };
  const gw = createAiGateway({ getConfig: () => config, log, endpoints, authToken: TEST_TOKEN });
  gateways.push(gw);
  const { url } = await gw.start();
  return {
    gw,
    url,
    cfg: config,
    async post(body = upstreamBody(), headers = {}) {
      const resp = await fetch(`${url}/v1/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${PLACEHOLDER}`,
          'x-opentac-gateway-token': TEST_TOKEN,
          ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      const text = await resp.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: resp.status, text, json, contentType: resp.headers.get('content-type') };
    },
  };
}

beforeEach(() => {
  logLines.length = 0;
});

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.stop()));
  await Promise.all(backends.splice(0).map((b) => b.close()));
});

describe('toResponsesShape', () => {
  it('emits exactly one message item with one output_text part', () => {
    const shape = toResponsesShape(SUMMARY_JSON, 'm1');
    expect(shape).toMatchObject({
      object: 'response',
      status: 'completed',
      model: 'm1',
      output_text: SUMMARY_JSON,
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: SUMMARY_JSON, annotations: [] }],
        },
      ],
    });
    expect(shape.id).toMatch(/^resp_/);
    expect(shape.output).toHaveLength(1);
    expect(shape.output[0]?.content).toHaveLength(1);
    expect(extractOpenAiResponseText(shape)).toBe(SUMMARY_JSON);
    // Also without the top-level shortcut, the item path yields the same text.
    const { output_text: _drop, ...noTop } = shape;
    void _drop;
    expect(extractOpenAiResponseText(noTop)).toBe(SUMMARY_JSON);
  });
});

describe('cleanModelText', () => {
  it('strips json code fences and re-serialises compactly', () => {
    expect(cleanModelText('```json\n{ "summary": "A B", "feedState": null }\n```')).toBe(
      '{"summary":"A B","feedState":null}',
    );
    expect(cleanModelText('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('extracts a fenced JSON object from surrounding prose', () => {
    expect(cleanModelText('Here you go:\n```json\n{"a": 1}\n```\nHope it helps')).toBe('{"a":1}');
  });

  it('removes <think> blocks, including multi-line, orphan close and dangling open', () => {
    expect(cleanModelText('<think>hmm\nlet me think</think>\n{"a": 2}')).toBe('{"a":2}');
    expect(cleanModelText('reasoning only</think> {"a":3}')).toBe('{"a":3}');
    expect(cleanModelText('<think>never finished')).toBe('');
    expect(cleanModelText('<think>x</think>```json\n{"a":4}\n```')).toBe('{"a":4}');
  });

  it('leaves JSON objects whose strings mention think tags untouched', () => {
    expect(cleanModelText('{"summary":"a <think> b","feedState":null}')).toBe(
      '{"summary":"a <think> b","feedState":null}',
    );
    expect(cleanModelText('{"summary":"x </think> y"}')).toBe('{"summary":"x </think> y"}');
    expect(cleanModelText('```json\n{"summary":"a <think> b"}\n```')).toBe(
      '{"summary":"a <think> b"}',
    );
  });

  it('does not treat the first word of a one-line fence as a language tag', () => {
    expect(cleanModelText('```Paris```')).toBe('Paris');
    expect(cleanModelText('```json\n{"a":1}```')).toBe('{"a":1}');
  });

  it('returns prose and non-object JSON as-is (trimmed)', () => {
    expect(cleanModelText('  Paris, France.  \n')).toBe('Paris, France.');
    expect(cleanModelText('[1, 2]')).toBe('[1, 2]');
    expect(cleanModelText('"x"')).toBe('"x"');
    expect(cleanModelText('')).toBe('');
  });
});

describe('translateToChat', () => {
  const req = upstreamBody() as ResponsesRequest;

  it('builds messages, limits and response_format', () => {
    expect(translateToChat(req, 'qwen3:8b', { reasoningOff: true, maxTokens: 600 })).toEqual({
      model: 'qwen3:8b',
      messages: [
        { role: 'system', content: INSTRUCTIONS },
        { role: 'user', content: INPUT },
      ],
      max_tokens: 600,
      temperature: 0.2,
      stream: false,
      reasoning_effort: 'none',
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'hud_summary',
          strict: true,
          schema: { type: 'object', properties: { summary: { type: 'string' } } },
        },
      },
    });
  });

  it('omits reasoning_effort, response_format and system message when absent', () => {
    const out = translateToChat({ input: 'hi' }, 'm', {
      reasoningOff: false,
      maxTokens: 10,
    }) as any;
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.response_format).toBeUndefined();
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('flattens array input', () => {
    const out = translateToChat(
      { input: [{ role: 'user', content: [{ type: 'input_text', text: 'a' }] }, 'b'] },
      'm',
      { reasoningOff: false, maxTokens: 10 },
    ) as any;
    expect(out.messages[0].content).toBe('a\nb');
  });
});

describe('extractChatText', () => {
  it('reads choices[0].message.content', () => {
    expect(extractChatText(chatReply('hello', 'stop'))).toEqual({
      text: 'hello',
      finishReason: 'stop',
      error: null,
    });
  });

  it('reports an OpenRouter choice error', () => {
    const r = extractChatText({
      choices: [
        { error: { message: 'Provider returned error', code: 502 }, finish_reason: 'error' },
      ],
    });
    expect(r.text).toBe('');
    expect(r.error).toContain('Provider returned error');
  });

  it('reports empty content with finish_reason length as a spent token budget', () => {
    expect(extractChatText(chatReply('', 'length')).error).toBe(
      'model returned no content (token budget spent on reasoning)',
    );
    expect(extractChatText(chatReply('  ', 'stop')).error).toBe('model returned no content');
  });

  it('handles junk replies', () => {
    expect(extractChatText(null).error).not.toBeNull();
    expect(extractChatText({ choices: [] }).error).not.toBeNull();
    expect(
      extractChatText({ error: { message: 'bad key sk-abcdefghijklmnop' } }).error,
    ).not.toContain('sk-abcdefghijklmnop');
  });
});

describe('gateway server', () => {
  it('serves healthz, 404s everything else, and frees the port on stop', async () => {
    const h = await harness({ provider: 'openrouter' });
    const health = await fetch(`${h.url}/healthz`);
    expect(health.status).toBe(200);
    // No token: bare liveness only, no provider name (SEC-02).
    expect(await health.json()).toEqual({ ok: true });
    const authed = await fetch(`${h.url}/healthz`, { headers: { 'x-opentac-gateway-token': TEST_TOKEN } });
    expect(await authed.json()).toEqual({ ok: true, provider: 'openrouter' });
    expect((await fetch(`${h.url}/nope`)).status).toBe(404);
    expect((await fetch(`${h.url}/v1/responses`)).status).toBe(404);
    expect(
      (await fetch(`${h.url}/v1/chat/completions`, { method: 'POST', body: '{}' })).status,
    ).toBe(404);

    const { port } = await h.gw.start();
    expect(h.url).toBe(`http://127.0.0.1:${port}`);
    expect(h.gw.url()).toBe(h.url);
    expect(await isPortFree(port)).toBe(false);
    await h.gw.stop();
    expect(h.gw.url()).toBeNull();
    expect(await isPortFree(port)).toBe(true);
    await h.gw.stop(); // second stop is a no-op
  });

  it('answers 400 for invalid JSON and 413 for an oversized declared body', async () => {
    const h = await harness({});
    const bad = await h.post('not json');
    expect(bad.status).toBe(400);
    expect(bad.contentType).toContain('application/json');

    const port = Number(new URL(h.url).port);
    const head = await new Promise<string>((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => {
        sock.write(
          `POST /v1/responses HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nx-opentac-gateway-token: ${TEST_TOKEN}\r\nContent-Length: 2000000\r\nConnection: close\r\n\r\n`,
        );
      });
      let buf = '';
      sock.on('data', (d) => (buf += d.toString()));
      sock.on('close', () => resolve(buf));
      sock.on('error', reject);
    });
    expect(head.startsWith('HTTP/1.1 413')).toBe(true);
  });
});

describe('ollama', () => {
  /** Thinking-model variant: empty content + finish_reason length unless reasoning_effort is 'none'. */
  function thinkingHandler(content: string) {
    return (req: { json: Record<string, unknown> | null }, res: any) => {
      if (req.json?.reasoning_effort === 'none') replyJson(res, 200, chatReply(content));
      else replyJson(res, 200, chatReply('', 'length'));
    };
  }

  it('translates to chat completions with reasoning off and returns the exact Responses shape', async () => {
    const ollama = await backend(thinkingHandler(SUMMARY_JSON));
    const h = await harness({ provider: 'ollama', ollamaHost: ollama.url });
    const r = await h.post();
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('application/json');
    expect(extractOpenAiResponseText(r.json)).toBe(SUMMARY_JSON);
    expect(JSON.parse(extractOpenAiResponseText(r.json))).toEqual({
      summary: 'Eiffel Tower Paris',
      feedState: null,
    });
    expect(r.json.output).toHaveLength(1);
    expect(r.json.output[0].content).toHaveLength(1);
    expect(r.json.output[0].content[0].type).toBe('output_text');

    expect(ollama.requests).toHaveLength(1);
    const seen = ollama.requests[0]!;
    expect(seen.url).toBe('/v1/chat/completions');
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.raw).not.toContain(PLACEHOLDER);
    expect(seen.json).toMatchObject({
      model: 'qwen3:8b',
      reasoning_effort: 'none',
      max_tokens: 600,
      temperature: 0.2,
    });
    expect((seen.json as any).messages).toEqual([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: INPUT },
    ]);
    expect((seen.json as any).response_format.json_schema.name).toBe('hud_summary');
  });

  it('keeps a larger incoming max_output_tokens and honours the configured floor', async () => {
    const ollama = await backend((_r, res) => replyJson(res, 200, chatReply(SUMMARY_JSON)));
    const h = await harness({ provider: 'ollama', ollamaHost: ollama.url });
    await h.post(upstreamBody({ max_output_tokens: 1500 }));
    h.cfg.maxOutputTokensFloor = 900;
    await h.post(upstreamBody({ max_output_tokens: 200 }));
    expect(ollama.requests.map((q) => (q.json as any).max_tokens)).toEqual([1500, 900]);
  });

  it('cleans think blocks and code fences from the model text', async () => {
    const ollama = await backend((_r, res) =>
      replyJson(
        res,
        200,
        chatReply(
          '<think>pondering</think>\n```json\n{ "summary": "Paris", "feedState": null }\n```',
        ),
      ),
    );
    const h = await harness({ ollamaHost: ollama.url });
    const r = await h.post();
    expect(r.status).toBe(200);
    expect(extractOpenAiResponseText(r.json)).toBe('{"summary":"Paris","feedState":null}');
  });

  it('turns a spent token budget into a plain 502', async () => {
    const ollama = await backend((_r, res) => replyJson(res, 200, chatReply('', 'length')));
    const h = await harness({ ollamaHost: ollama.url });
    const r = await h.post();
    expect(r.status).toBe(502);
    expect(r.json.error).toBe(
      'OpenTac AI gateway: model returned no content (token budget spent on reasoning)',
    );
  });

  it('returns 502 without contacting the backend when no model is configured', async () => {
    const ollama = await backend((_r, res) => replyJson(res, 200, chatReply(SUMMARY_JSON)));
    const h = await harness({ ollamaHost: ollama.url, model: null });
    const r = await h.post();
    expect(r.status).toBe(502);
    expect(r.json.error).toContain('no model');
    expect(ollama.requests).toHaveLength(0);
  });

  it('accepts a host without a scheme and reports an unreachable Ollama as 502', async () => {
    const ollama = await backend((_r, res) => replyJson(res, 200, chatReply(SUMMARY_JSON)));
    const h = await harness({ ollamaHost: `127.0.0.1:${ollama.port}/` });
    expect((await h.post()).status).toBe(200);

    const dead = await backend((_r, res) => {
      res.end();
    });
    const deadUrl = dead.url;
    await dead.close();
    backends.splice(backends.indexOf(dead), 1);
    h.cfg.ollamaHost = deadUrl;
    const r = await h.post();
    expect(r.status).toBe(502);
    expect(r.json.error).toBe('OpenTac AI gateway: could not reach the ollama backend');
  });

  it('treats an empty or blank ollamaHost as unset', async () => {
    const ollama = await backend((_r, res) => replyJson(res, 200, chatReply(SUMMARY_JSON)));
    const h = await harness({ ollamaHost: '' }, { ollama: ollama.url });
    expect((await h.post()).status).toBe(200);
    h.cfg.ollamaHost = '   ';
    const r = await h.post();
    expect(r.status).toBe(200);
    expect(extractOpenAiResponseText(r.json)).toBe(SUMMARY_JSON);
    expect(ollama.requests).toHaveLength(2);
  });

  it('applies config changes live', async () => {
    const a = await backend((_r, res) => replyJson(res, 200, chatReply('{"summary":"A"}')));
    const b = await backend((_r, res) => replyJson(res, 200, chatReply('{"summary":"B"}')));
    const h = await harness({ ollamaHost: a.url });
    expect(extractOpenAiResponseText((await h.post()).json)).toBe('{"summary":"A"}');
    h.cfg.ollamaHost = b.url;
    h.cfg.model = 'other-model';
    expect(extractOpenAiResponseText((await h.post()).json)).toBe('{"summary":"B"}');
    expect((b.requests[0]!.json as any).model).toBe('other-model');
  });
});

describe('openrouter', () => {
  const REAL_KEY = 'or-key-REALKEY123456';

  it('replaces auth/model, floors tokens, collapses reasoning + message items to one part', async () => {
    const or = await backend((_r, res) =>
      replyJson(res, 200, {
        id: 'resp_x',
        status: 'completed',
        output: [
          {
            type: 'reasoning',
            id: 'rs_1',
            summary: [{ type: 'summary_text', text: 'thinking about Paris' }],
            content: [{ type: 'reasoning_text', text: 'secret chain of thought' }],
          },
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: '{"summary":"Eiffel ' },
              { type: 'output_text', text: 'Tower Paris","feedState":null}' },
            ],
          },
        ],
      }),
    );
    const h = await harness(
      { provider: 'openrouter', model: 'meta/llama-x', apiKey: REAL_KEY },
      { openrouter: `${or.url}/api` },
    );
    const r = await h.post();
    expect(r.status).toBe(200);
    expect(r.json.output).toHaveLength(1);
    expect(r.json.output[0].type).toBe('message');
    expect(r.json.output[0].content).toHaveLength(1);
    expect(extractOpenAiResponseText(r.json)).toBe(SUMMARY_JSON);
    expect(r.text).not.toContain('chain of thought');

    const seen = or.requests[0]!;
    expect(seen.url).toBe('/api/v1/responses');
    expect(seen.headers.authorization).toBe(`Bearer ${REAL_KEY}`);
    expect(seen.raw).not.toContain(PLACEHOLDER);
    expect(seen.headers['http-referer']).toBe('https://opentac.icu');
    expect(seen.headers['x-openrouter-title']).toBe('OpenTac');
    expect(seen.json).toMatchObject({
      model: 'meta/llama-x',
      instructions: INSTRUCTIONS,
      input: INPUT,
      reasoning: { effort: 'minimal' },
      max_output_tokens: 600,
    });
    expect((seen.json as any).text.format.name).toBe('hud_summary');
  });

  it('falls back once to chat completions when /v1/responses answers 404', async () => {
    const or = await backend((req, res) => {
      if (req.url.endsWith('/v1/responses')) {
        replyJson(res, 404, { error: { message: 'Not Found', code: 404 } });
      } else {
        replyJson(res, 200, chatReply('```json\n{"summary":"Paris","feedState":null}\n```'));
      }
    });
    const h = await harness(
      { provider: 'openrouter', model: 'm/x', apiKey: REAL_KEY },
      { openrouter: `${or.url}/api` },
    );
    const r = await h.post();
    expect(r.status).toBe(200);
    expect(extractOpenAiResponseText(r.json)).toBe('{"summary":"Paris","feedState":null}');
    expect(or.requests.map((q) => q.url)).toEqual([
      '/api/v1/responses',
      '/api/v1/chat/completions',
    ]);
    const chat = or.requests[1]!;
    expect(chat.headers.authorization).toBe(`Bearer ${REAL_KEY}`);
    expect(chat.headers['http-referer']).toBe('https://opentac.icu');
    expect(chat.raw).not.toContain(PLACEHOLDER);
    expect(chat.json).toMatchObject({
      model: 'm/x',
      max_tokens: 600,
      reasoning: { effort: 'minimal' },
    });
  });

  it('keeps backend choice-error text out of the 502 body', async () => {
    const leaked = `Provider echoed ${REAL_KEY.slice(0, 8)}-partial-secret`;
    const or = await backend((_r, res) =>
      replyJson(res, 200, {
        choices: [{ error: { message: leaked, code: 502 }, finish_reason: 'error' }],
      }),
    );
    const h = await harness(
      { provider: 'openrouter', model: 'm/x', apiKey: REAL_KEY },
      { openrouter: `${or.url}/api` },
    );
    h.cfg.provider = 'ollama';
    h.cfg.ollamaHost = or.url;
    const r = await h.post();
    expect(r.status).toBe(502);
    expect(r.json.error).toBe('OpenTac AI gateway: the ollama backend reported an error');
    expect(r.text).not.toContain('partial-secret');
  });

  it('does not fall back for other failures and never forwards backend bodies', async () => {
    const or = await backend((_r, res) =>
      replyJson(res, 500, { error: { message: `boom with key sk-or-v1-${'a'.repeat(40)}` } }),
    );
    const h = await harness(
      { provider: 'openrouter', model: 'm/x', apiKey: REAL_KEY },
      { openrouter: `${or.url}/api` },
    );
    const r = await h.post();
    expect(r.status).toBe(502);
    expect(r.json.error).toBe('OpenTac AI gateway: the openrouter backend returned HTTP 500');
    expect(r.text).not.toContain('boom');
    expect(or.requests).toHaveLength(1);
  });

  it('returns 502 NO_KEY without contacting the backend', async () => {
    const or = await backend((_r, res) => replyJson(res, 200, {}));
    const h = await harness(
      { provider: 'openrouter', model: 'm/x', apiKey: null },
      { openrouter: `${or.url}/api` },
    );
    const r = await h.post();
    expect(r.status).toBe(502);
    expect(r.json.error).toContain('API key');
    expect(or.requests).toHaveLength(0);
  });

  it('reports an incomplete reply that spent its budget on reasoning', async () => {
    const or = await backend((_r, res) =>
      replyJson(res, 200, {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'reasoning', summary: [] }],
      }),
    );
    const h = await harness(
      { provider: 'openrouter', model: 'm/x', apiKey: REAL_KEY },
      { openrouter: `${or.url}/api` },
    );
    const r = await h.post();
    expect(r.status).toBe(502);
    expect(r.json.error).toContain('token budget');
  });
});

describe('xai', () => {
  it('posts to /v1/responses with the xAI key and no OpenRouter headers', async () => {
    const xai = await backend((_r, res) =>
      replyJson(res, 200, {
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: `<think>x</think>${SUMMARY_JSON}` }],
          },
        ],
      }),
    );
    const h = await harness(
      { provider: 'xai', model: 'grok-4-fast', apiKey: 'xai-REALKEY123456789' },
      { xai: xai.url },
    );
    const r = await h.post();
    expect(r.status).toBe(200);
    expect(extractOpenAiResponseText(r.json)).toBe(SUMMARY_JSON);
    const seen = xai.requests[0]!;
    expect(seen.url).toBe('/v1/responses');
    expect(seen.headers.authorization).toBe('Bearer xai-REALKEY123456789');
    expect(seen.headers['http-referer']).toBeUndefined();
    expect(seen.headers['x-openrouter-title']).toBeUndefined();
    expect(seen.raw).not.toContain(PLACEHOLDER);
    expect((seen.json as any).model).toBe('grok-4-fast');
  });

  it('uses the top-level output_text when no message items exist', async () => {
    const xai = await backend((_r, res) => replyJson(res, 200, { output_text: SUMMARY_JSON }));
    const h = await harness({ provider: 'xai', model: 'g', apiKey: 'k-123456' }, { xai: xai.url });
    expect(extractOpenAiResponseText((await h.post()).json)).toBe(SUMMARY_JSON);
  });
});

describe('openai pass-through', () => {
  it('forwards the body unchanged with the incoming Authorization', async () => {
    const oa = await backend((_r, res) =>
      replyJson(res, 200, toResponsesShape(SUMMARY_JSON, 'gpt')),
    );
    const h = await harness({ provider: 'openai', model: null }, { openai: oa.url });
    const body = JSON.stringify(upstreamBody());
    const r = await h.post(body, { Authorization: 'Bearer sk-real-incoming-key-1234' });
    expect(r.status).toBe(200);
    expect(extractOpenAiResponseText(r.json)).toBe(SUMMARY_JSON);
    const seen = oa.requests[0]!;
    expect(seen.url).toBe('/v1/responses');
    expect(seen.raw).toBe(body);
    expect(seen.headers.authorization).toBe('Bearer sk-real-incoming-key-1234');
  });

  it('never sends the placeholder; uses openAiKey or fails with NO_KEY', async () => {
    const oa = await backend((_r, res) =>
      replyJson(res, 200, toResponsesShape(SUMMARY_JSON, 'gpt')),
    );
    const h = await harness({ provider: 'openai' }, { openai: oa.url });
    const none = await h.post();
    expect(none.status).toBe(502);
    expect(oa.requests).toHaveLength(0);
    h.cfg.openAiKey = 'sk-own-key-123456789';
    expect((await h.post()).status).toBe(200);
    expect(oa.requests[0]!.headers.authorization).toBe('Bearer sk-own-key-123456789');
  });
});

describe('timeouts and hygiene', () => {
  it('answers 504 when the backend hangs', async () => {
    const slow = await backend(() => new Promise(() => undefined));
    const h = await harness({ ollamaHost: slow.url, requestTimeoutMs: 150 });
    const started = Date.now();
    const r = await h.post();
    expect(r.status).toBe(504);
    expect(r.json).toEqual({ error: 'OpenTac AI gateway: request timed out' });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('stop() aborts an in-flight backend call', async () => {
    const slow = await backend(() => new Promise(() => undefined));
    const h = await harness({ ollamaHost: slow.url, requestTimeoutMs: 30_000 });
    const pending = h.post().catch(() => null);
    await new Promise((r) => setTimeout(r, 100));
    await h.gw.stop();
    await pending;
    expect(h.gw.url()).toBeNull();
  });

  it('never logs keys, instructions, input or model output', async () => {
    const ollama = await backend((_r, res) => replyJson(res, 200, chatReply(SUMMARY_JSON)));
    const or = await backend((_r, res) => replyJson(res, 500, { error: 'SECRET-BACKEND-BODY' }));
    const h = await harness({ ollamaHost: ollama.url, provider: 'ollama' }, { openrouter: or.url });
    await h.post();
    h.cfg.provider = 'openrouter';
    h.cfg.apiKey = 'or-key-LOGSECRET987654';
    await h.post(upstreamBody(), { Authorization: 'Bearer sk-incoming-LOGSECRET1234' });
    const all = logLines.join('\n');
    expect(all).not.toContain('LOGSECRET');
    expect(all).not.toContain('SECRET-INSTRUCTIONS-TEXT');
    expect(all).not.toContain('SECRET-INPUT-CONTEXT');
    expect(all).not.toContain('Eiffel');
    expect(all).not.toContain('SECRET-BACKEND-BODY');
    expect(all).toMatch(/request start ollama model=qwen3:8b/);
    expect(all).toMatch(/request done ollama model=qwen3:8b status=200 finishReason=stop/);
    expect(all).toMatch(/took \d+ms/);
  });
});

describe('testPrompt', () => {
  it('reports text, latency and finish reason through the same path', async () => {
    const ollama = await backend((_r, res) =>
      replyJson(res, 200, chatReply('{"summary":"OK","feedState":null}')),
    );
    const h = await harness({ ollamaHost: ollama.url });
    const r = await h.gw.testPrompt();
    expect(r).toMatchObject({
      ok: true,
      text: '{"summary":"OK","feedState":null}',
      finishReason: 'stop',
      error: null,
      provider: 'ollama',
      model: 'qwen3:8b',
    });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    const sent = (ollama.requests[0]!.json as any).messages;
    expect(sent[sent.length - 1].content).toBe(
      'Reply with the single word OK as JSON {"summary":"OK","feedState":null}',
    );
    expect((ollama.requests[0]!.json as any).reasoning_effort).toBe('none');
  });

  it('works without start(), accepts a config override and never throws', async () => {
    const ollama = await backend((_r, res) => replyJson(res, 200, chatReply('', 'length')));
    const gw = createAiGateway({
      getConfig: () => ({ provider: 'openrouter', model: null, ollamaHost: null, apiKey: null }),
      log,
      authToken: TEST_TOKEN,
    });
    gateways.push(gw);
    expect(gw.url()).toBeNull();
    const bad = await gw.testPrompt();
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('no model');

    const r = await gw.testPrompt({
      provider: 'ollama',
      model: 'thinker',
      ollamaHost: ollama.url,
      apiKey: null,
    });
    expect(r.ok).toBe(false);
    expect(r.text).toBe('');
    expect(r.error).toBe('model returned no content (token budget spent on reasoning)');
    expect(r.model).toBe('thinker');
  });

  it('reports timeouts', async () => {
    const slow = await backend(() => new Promise(() => undefined));
    const gw = createAiGateway({
      getConfig: () => ({ provider: 'ollama', model: 'm', ollamaHost: slow.url, apiKey: null }),
      log,
      authToken: TEST_TOKEN,
    });
    gateways.push(gw);
    const r = await gw.testPrompt({
      provider: 'ollama',
      model: 'm',
      ollamaHost: slow.url,
      apiKey: null,
      requestTimeoutMs: 100,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('request timed out');
  });
});

describe('AiGatewayError', () => {
  it('carries a code and optional detail', () => {
    const e = new AiGatewayError('NO_KEY', 'no key');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('NO_KEY');
    expect(e.detail).toBeUndefined();
    expect(new AiGatewayError('BACKEND', 'x', 'why').detail).toBe('why');
  });
});

describe('gateway auth token', () => {
  it('refuses to be created without a token', () => {
    const getConfig = (): AiGatewayConfig => ({ provider: 'ollama', model: 'm', ollamaHost: null, apiKey: null });
    expect(() => createAiGateway({ getConfig, log } as never)).toThrow(/authToken/);
    expect(() => createAiGateway({ getConfig, log, authToken: '' })).toThrow(/authToken/);
  });

  it('rejects /v1/responses without the per-launch token and accepts it with the token', async () => {
    const ollama = await backend((_req: unknown, res: any) => replyJson(res, 200, chatReply(SUMMARY_JSON)));
    const gw = createAiGateway({
      getConfig: () => ({ provider: 'ollama', model: 'qwen3:8b', ollamaHost: ollama.url, apiKey: null }),
      log,
      authToken: 'secret-token-123',
    });
    gateways.push(gw);
    const { url } = await gw.start();
    const noToken = await fetch(`${url}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(upstreamBody()),
    });
    expect(noToken.status).toBe(401);
    const wrong = await fetch(`${url}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-opentac-gateway-token': 'nope' },
      body: JSON.stringify(upstreamBody()),
    });
    expect(wrong.status).toBe(401);
    const right = await fetch(`${url}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-opentac-gateway-token': 'secret-token-123' },
      body: JSON.stringify(upstreamBody()),
    });
    expect(right.status).toBe(200);
    // healthz stays open (no secrets, used by the shell itself)
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  });
});
