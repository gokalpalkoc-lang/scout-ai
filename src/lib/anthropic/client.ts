import { UsageMetadata } from '../gemini/types';
import { errorMessage, withRetry, withTimeout } from '../util';
import { AnthropicCredential } from './auth';
import {
  AnthropicModelInfo,
  ContentBlock,
  MessagesRequest,
  MessagesResponse,
  textOfMessage,
} from './types';

/**
 * Anthropic Messages API over raw HTTP.
 *
 * The official `@anthropic-ai/sdk` is the right choice on Node and in browsers,
 * but it cannot run here, and both reasons were verified rather than assumed:
 *
 *  1. It imports `node:fs` / `node:child_process` through its credential chain,
 *     so Metro cannot even resolve it without shimming Node builtins.
 *  2. Its streaming reads `response.body.getReader()`. React Native's `fetch` is
 *     a whatwg-fetch polyfill over XHR — there is no `ReadableStream` and no
 *     streaming body — so `client.messages.stream()` could never work.
 *
 * This client therefore mirrors the approach already proven in
 * `src/lib/gemini/client.ts`: plain fetch for one-shot calls, and XHR
 * `onprogress` for SSE, which is the only incremental transport RN provides.
 */

const API_BASE = 'https://api.anthropic.com/v1';
const API_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 180_000;

export class AnthropicError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, status: number, code = 'UNKNOWN') {
    super(message);
    this.name = 'AnthropicError';
    this.status = status;
    this.code = code;
    this.retryable = status === 429 || status === 500 || status === 529 || status === 0;
  }
}

interface ApiErrorBody {
  error?: { type?: string; message?: string };
}

function explain(status: number, body: string): AnthropicError {
  let parsed: ApiErrorBody = {};
  try {
    parsed = JSON.parse(body) as ApiErrorBody;
  } catch {
    /* non-JSON error body */
  }
  const raw = parsed.error?.message ?? body.slice(0, 300) ?? 'Unknown error';
  const code = parsed.error?.type ?? 'UNKNOWN';

  const friendly = (() => {
    if (status === 401) {
      return 'That Anthropic API key was rejected. Check it in Settings, or create a new one at console.anthropic.com.';
    }
    if (status === 403) return `Access denied by Anthropic. ${raw}`;
    if (status === 404) {
      return `Model not found. Pick a different Claude model in Settings. (${raw})`;
    }
    if (status === 413) return 'That request was too large. Try a shorter conversation.';
    if (status === 429) {
      return 'Anthropic rate limit or credit limit reached. Wait a moment, or switch to a smaller model in Settings.';
    }
    if (status === 529) return 'Anthropic is temporarily overloaded. Scout will retry.';
    if (status >= 500) return `Anthropic is temporarily unavailable (${status}). Scout will retry.`;
    return raw;
  })();

  return new AnthropicError(friendly, status, code);
}

function headersFor(cred: AnthropicCredential): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': cred.apiKey,
    'anthropic-version': API_VERSION,
  };
}

// Usage accounting shares the ledger with Gemini so Settings shows one total.
type UsageRecorder = (model: string, usage: UsageMetadata | undefined) => void;
let usageRecorder: UsageRecorder | null = null;

export function setAnthropicUsageRecorder(fn: UsageRecorder | null): void {
  usageRecorder = fn;
}

/** Maps Anthropic's usage shape onto the shared ledger's field names. */
function record(model: string, usage: MessagesResponse['usage']): void {
  if (!usageRecorder) return;
  const prompt =
    (usage?.input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0);
  const output = usage?.output_tokens ?? 0;
  try {
    usageRecorder(model, {
      promptTokenCount: prompt,
      candidatesTokenCount: output,
      totalTokenCount: prompt + output,
    });
  } catch {
    // Accounting must never break a request.
  }
}

/**
 * A refusal is an HTTP 200 with `stop_reason: "refusal"` and possibly empty
 * content, so it has to be handled before anything reads `content`.
 */
export function refusalMessage(res: MessagesResponse): string | null {
  if (res.stop_reason !== 'refusal') return null;
  const category = res.stop_details?.category;
  return category
    ? `Claude declined this request (${category}). Rephrasing usually helps; you can also switch the assistant provider to Gemini in Settings.`
    : 'Claude declined this request. Rephrasing usually helps.';
}

export interface AnthropicCallArgs {
  credential: AnthropicCredential;
  request: MessagesRequest;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function createMessage({
  credential,
  request,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
}: AnthropicCallArgs): Promise<MessagesResponse> {
  const attempt = async (): Promise<MessagesResponse> => {
    const res = await withTimeout(
      fetch(`${API_BASE}/messages`, {
        method: 'POST',
        headers: headersFor(credential),
        body: JSON.stringify({ ...request, stream: false }),
        signal,
      }),
      timeoutMs,
      'Claude request',
    );

    const body = await res.text();
    if (!res.ok) throw explain(res.status, body);

    try {
      const parsed = JSON.parse(body) as MessagesResponse;
      record(request.model, parsed.usage);
      return parsed;
    } catch (e) {
      if (e instanceof AnthropicError) throw e;
      throw new AnthropicError('Claude returned a malformed response.', 502, 'BAD_RESPONSE');
    }
  };

  return withRetry(attempt, {
    attempts: 3,
    baseMs: 900,
    retryable: (e) => e instanceof AnthropicError && e.retryable,
  });
}

export interface AnthropicStreamHandlers {
  onText: (delta: string) => void;
  onDone: (final: MessagesResponse) => void;
  onError: (error: Error) => void;
}

/**
 * Streaming over XHR `onprogress`, assembled from Anthropic's SSE events.
 *
 * The event sequence is `message_start` → (`content_block_start` →
 * `content_block_delta`* → `content_block_stop`)* → `message_delta` →
 * `message_stop`. Tool inputs arrive as `input_json_delta` fragments that have
 * to be concatenated and parsed once the block closes — a partially streamed
 * tool input is not valid JSON.
 */
export function streamMessage({
  credential,
  request,
  handlers,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: Omit<AnthropicCallArgs, 'signal'> & { handlers: AnthropicStreamHandlers }): {
  cancel: () => void;
} {
  const xhr = new XMLHttpRequest();
  let consumed = 0;
  let settled = false;

  const blocks: ContentBlock[] = [];
  /** Accumulates `input_json_delta` text per block index. */
  const partialToolJson = new Map<number, string>();
  let usage: MessagesResponse['usage'];
  let stopReason: MessagesResponse['stop_reason'];
  let stopDetails: MessagesResponse['stop_details'];
  let model = request.model;

  const finish = (err?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (err) {
      handlers.onError(err);
      return;
    }
    const final: MessagesResponse = {
      content: blocks,
      stop_reason: stopReason,
      stop_details: stopDetails,
      usage,
      model,
    };
    record(model, usage);
    handlers.onDone(final);
  };

  const timer = setTimeout(() => {
    xhr.abort();
    finish(new AnthropicError('Claude request timed out.', 0, 'TIMEOUT'));
  }, timeoutMs);

  const handleEvent = (payload: string) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return; // A malformed frame should not kill the stream.
    }

    const type = event.type as string | undefined;
    const index = typeof event.index === 'number' ? event.index : 0;

    switch (type) {
      case 'message_start': {
        const message = event.message as MessagesResponse | undefined;
        if (message?.model) model = message.model;
        if (message?.usage) usage = { ...message.usage };
        break;
      }
      case 'content_block_start': {
        const block = event.content_block as ContentBlock | undefined;
        if (!block) break;
        if (block.type === 'tool_use') {
          blocks[index] = { ...block, input: {} };
          partialToolJson.set(index, '');
        } else if (block.type === 'text') {
          blocks[index] = { type: 'text', text: '' };
        } else if (block.type === 'thinking') {
          blocks[index] = { type: 'thinking', thinking: '' };
        }
        break;
      }
      case 'content_block_delta': {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (!delta) break;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          const existing = blocks[index];
          if (existing?.type === 'text') existing.text += delta.text;
          else blocks[index] = { type: 'text', text: delta.text };
          handlers.onText(delta.text);
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          const existing = blocks[index];
          if (existing?.type === 'thinking') existing.thinking += delta.thinking;
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          partialToolJson.set(index, (partialToolJson.get(index) ?? '') + delta.partial_json);
        }
        break;
      }
      case 'content_block_stop': {
        const raw = partialToolJson.get(index);
        const block = blocks[index];
        if (raw !== undefined && block?.type === 'tool_use') {
          try {
            block.input = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
          } catch {
            // Leave the args empty; the dispatcher reports a usable error.
            block.input = {};
          }
          partialToolJson.delete(index);
        }
        break;
      }
      case 'message_delta': {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.stop_reason) stopReason = delta.stop_reason as MessagesResponse['stop_reason'];
        if (delta?.stop_details !== undefined) {
          stopDetails = delta.stop_details as MessagesResponse['stop_details'];
        }
        const u = event.usage as MessagesResponse['usage'] | undefined;
        if (u) usage = { ...usage, ...u };
        break;
      }
      case 'error': {
        const err = event.error as { message?: string } | undefined;
        finish(new AnthropicError(err?.message ?? 'Claude stream error', 0, 'STREAM'));
        break;
      }
      default:
        break; // ping, message_stop
    }
  };

  const drain = () => {
    const text = xhr.responseText ?? '';
    if (text.length <= consumed) return;
    const fresh = text.slice(consumed);
    const lastBreak = fresh.lastIndexOf('\n');
    if (lastBreak === -1) return;
    consumed += lastBreak + 1;

    for (const line of fresh.slice(0, lastBreak).split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload) handleEvent(payload);
    }
  };

  xhr.open('POST', `${API_BASE}/messages`, true);
  for (const [k, v] of Object.entries(headersFor(credential))) xhr.setRequestHeader(k, v);
  xhr.setRequestHeader('Accept', 'text/event-stream');

  xhr.onprogress = () => {
    if (xhr.status >= 200 && xhr.status < 300) drain();
  };

  xhr.onload = () => {
    if (xhr.status < 200 || xhr.status >= 300) {
      finish(explain(xhr.status, xhr.responseText ?? ''));
      return;
    }
    drain();
    const tail = (xhr.responseText ?? '').slice(consumed).trim();
    if (tail.startsWith('data:')) handleEvent(tail.slice(5).trim());
    finish();
  };

  xhr.onerror = () =>
    finish(new AnthropicError('Network error reaching Anthropic. Check your connection.', 0, 'NETWORK'));
  xhr.onabort = () => finish();

  xhr.send(JSON.stringify({ ...request, stream: true }));

  return {
    cancel: () => {
      try {
        xhr.abort();
      } catch {
        /* already finished */
      }
    },
  };
}

/**
 * Curated fallback list. `listAnthropicModels` replaces it with the live list as
 * soon as a key is saved; these ids are only the starting point.
 */
export const FALLBACK_CLAUDE_MODELS: AnthropicModelInfo[] = [
  { id: 'claude-opus-5', display_name: 'Claude Opus 5', max_input_tokens: 1_000_000, max_tokens: 128_000 },
  { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', max_input_tokens: 1_000_000, max_tokens: 128_000 },
  { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', max_input_tokens: 200_000, max_tokens: 64_000 },
];

export async function listAnthropicModels(
  credential: AnthropicCredential,
): Promise<AnthropicModelInfo[]> {
  const res = await withTimeout(
    fetch(`${API_BASE}/models?limit=100`, { headers: headersFor(credential) }),
    30_000,
    'Model list',
  );
  const body = await res.text();
  if (!res.ok) throw explain(res.status, body);

  const parsed = JSON.parse(body) as { data?: AnthropicModelInfo[] };
  const models = (parsed.data ?? []).filter((m) => !!m.id);
  return models.length ? models : FALLBACK_CLAUDE_MODELS;
}

export async function verifyAnthropicCredential(
  credential: AnthropicCredential,
  model: string,
): Promise<{ ok: true; reply: string } | { ok: false; error: string }> {
  try {
    const res = await createMessage({
      credential,
      timeoutMs: 45_000,
      request: {
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
        // Off for the probe: thinking would spend tokens for no benefit here.
        thinking: { type: 'disabled' },
        output_config: { effort: 'low' },
      },
    });
    const refusal = refusalMessage(res);
    if (refusal) return { ok: false, error: refusal };
    return { ok: true, reply: textOfMessage(res).trim() || 'ready' };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}
