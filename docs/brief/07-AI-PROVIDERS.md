# 07 — AI Providers: Ollama, OpenRouter, xAI (Grok), Gemini

## What upstream uses today (verified at commit a725178)

| Surface | Endpoint(s) | Transport | Notes |
|---|---|---|---|
| **Voice control** | `https://api.openai.com/v1/realtime/client_secrets` (server mints an ephemeral key), `https://api.openai.com/v1/realtime/calls` (browser) | **WebRTC speech-to-speech** (OpenAI Realtime API). Model from `OPENAI_REALTIME_MODEL` / `_MINI`; voice `OPENAI_REALTIME_VOICE`. Tool-calling against upstream's action schema (`src/voice/actionSchemas.js`, `gevActions.js`, `server/providers/openai/tools.js`). | Alternative auth: ChatGPT/Codex OAuth (`server/providers/openai/codex-auth.js`, reads `~/.codex`). |
| **Voice control (alt)** | `https://generativelanguage.googleapis.com/v1beta/auth_tokens`, `wss://…/BidiGenerateContentConstrained` | **Gemini Live** over WebSocket | Opt-in via Provider Settings. |
| **HUD summary** | `https://api.openai.com/v1/responses` | HTTPS, OpenAI **Responses API**; model `OPENAI_HUD_SUMMARY_MODEL` (default `gpt-5-nano`), `reasoning.effort: minimal`, `max_output_tokens: 100`; output post-processed to five words (`toFiveWordHudSummary`). Keyless fallback exists. | Per-IP rate limit `GEV_RATELIMIT_OPENAI_PER_MIN`. |
| **MCP server** | n/a | stdio JSON-RPC (`npm run mcp`) and an in-process plugin | Lets *external* agents (Claude Code, Codex, anything speaking MCP) read the globe. Not an LLM call. |

**Base URLs are hard-coded.** There is no `OPENAI_BASE_URL`, no provider
switch. Grep confirms zero mentions of ollama/openrouter/x.ai.

## Feasibility by provider

| Provider | HUD summary (text) | Voice control |
|---|---|---|
| **Ollama** (local) | ✅ Yes — Ollama exposes OpenAI-compatible `/v1/chat/completions`; a tiny translation from Responses-API shape is needed (or use Ollama's native `/api/chat`). Needs a small model (e.g. a 3–8B instruct model) and a 100-token cap; fine on Apple Silicon. | ❌ Not directly. Ollama has no speech-to-speech/realtime endpoint. Would require OpenTac to build a local pipeline: STT (e.g. whisper.cpp) → Ollama text model with tool-calling → TTS (macOS `say`/AVSpeech via a helper, or Piper/Kokoro) → speak upstream's tool schema. Feasible, substantial (weeks, not days). |
| **OpenRouter** | ✅ Yes — OpenAI-compatible chat completions; any model id. | ❌ No realtime voice API. |
| **xAI (Grok)** | ✅ Yes — OpenAI-compatible chat completions. ⚠ Verify at build time whether xAI offers a realtime voice API compatible with OpenAI's WebRTC flow; as of the brief's knowledge it does not. | ❌ / ⚠ as left. |
| **Gemini** | (upstream doesn't use Gemini for HUD) | ✅ Already supported upstream (Gemini Live). |
| **OpenAI** | ✅ (default) | ✅ (default) |

So: **text summaries can be routed to Ollama / OpenRouter / xAI as an
option. Voice stays OpenAI or Gemini unless OpenTac builds its own local
voice pipeline.** Be explicit about this in the UI and on the website; don't
imply "runs fully local" when voice is the headline feature.

## Implementation approach (no upstream patching)

The brief forbids modifying the checkout. Two compliant routes, use both:

### Route A — the right one: upstream PR

Open a PR against `bilawalsidhu/gods-eye-view` adding `OPENAI_BASE_URL`
(default `https://api.openai.com`) to `server/providers/openai/hud-summary.js`
and ideally a `GEV_HUD_SUMMARY_API=responses|chat` switch so a chat-
completions-only backend works. Small, additive, matches upstream's env-driven
style. If merged, Route B becomes a thin config and the gateway shrinks.

### Route B — works today: OpenTac AI gateway + fetch interceptor

OpenTac owns the Node process the engine runs in, so the launcher
(`resources/launcher/opentac-start.mjs`) installs a `globalThis.fetch`
interceptor **before importing Vite** that rewrites exactly one URL —
`https://api.openai.com/v1/responses` — to `OPENTAC_AI_GATEWAY_URL/v1/responses`
when that env var is set. Nothing in the checkout changes; updates fast-
forward cleanly. The scaffold already contains this hook.

The **gateway** is a tiny HTTP server in OpenTac's main process (or a second
child under bundled Node) bound to `127.0.0.1` on its own port, that:

1. Accepts the Responses-API request shape upstream sends (`model`,
   `instructions`, `input` (string), `reasoning`, `max_output_tokens`).
2. Translates to the selected backend:
   - `openai` → pass-through to `https://api.openai.com/v1/responses` with
     the user's key (gateway disabled by default = no interceptor at all).
   - `ollama` → `POST http://127.0.0.1:11434/v1/chat/completions` with
     `messages: [{role:'system', content: instructions}, {role:'user',
     content: input}]`, `max_tokens`, configured model; no key.
   - `openrouter` → `https://openrouter.ai/api/v1/chat/completions`,
     `Authorization: Bearer <key>`, `HTTP-Referer`/`X-Title` headers set to
     OpenTac.
   - `xai` → `https://api.x.ai/v1/chat/completions`, Bearer key.
3. Returns a **Responses-API-shaped** JSON so upstream's
   `extractOpenAiResponseText()` finds the text: ⚠ read that function in the
   live checkout and produce the minimal structure it accepts (`output[]` →
   `content[]` → `{type:'output_text', text}`), plus `status: 'completed'`.
4. Never logs prompts or keys; 10 s timeout; on error returns the same
   `{error: '…request failed'}` shape so upstream's keyless/degraded path
   behaves normally.

**Settings** (OpenTac Preferences → AI): Summary provider
`OpenAI (engine default) | Ollama | OpenRouter | xAI`, model name, endpoint
override (Ollama host), API key fields for OpenRouter/xAI stored by OpenTac
in **macOS Keychain** via `safeStorage` (these keys are OpenTac's, not the
engine's, so they do not go in the engine's `.env`). A "Test" button sends a
one-line prompt and shows the reply and latency. An info line: "Voice control
uses OpenAI or Gemini — configure those in the engine's POWER UP panel."

**Robustness rule:** the interceptor only matches the exact URL. If upstream
changes the endpoint or request shape, the gateway must fail soft (log once,
pass the original request through to OpenAI if a key exists, else return the
degraded shape). Add an integration test that runs the real upstream
`hud-summary.js` handler against the gateway with Ollama mocked.

### Route C — stretch: local voice pipeline (not in the core scope)

If the owner wants fully local voice later, it's a separate project: a
local server implementing enough of OpenAI's Realtime WebRTC contract
(`/v1/realtime/client_secrets` + `/v1/realtime/calls` SDP exchange, audio
in/out, `response.function_call` events using upstream's tool schema) backed
by whisper.cpp + Ollama + a TTS engine. The interceptor approach extends to
`client_secrets` (server side), but the browser-side `calls` URL is in
upstream client code and would need an upstream PR to make configurable
(e.g. the server returning the `calls` URL alongside the ephemeral secret).
Scope it only after Routes A/B are done.

## Tasks to add to the implementation plan

- Phase 4b (after Phase 4): gateway module `src/main/aiGateway.ts`, Preferences
  → AI panel, Keychain storage, interceptor env plumbing in `server.ts`, tests.
- Phase 0 addendum: read `extractOpenAiResponseText` and `hud-summary.js` in
  the live checkout; verify xAI/OpenRouter/Ollama current endpoint shapes;
  open the upstream PR (Route A) early so it has time to land.
- Website `/ai` page (06-WEBSITE.md) describing exactly what is and isn't
  local.
