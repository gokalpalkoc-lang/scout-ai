import { UsageMetadata } from '../gemini/types';
import { errorMessage, withRetry, withTimeout } from '../util';
import { OpenAiCredential } from './auth';
import { OpenAiBackendId, backendById } from './catalog';
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatToolCall,
  OpenAiModelInfo,
  textOfCompletion,
} from './types';

/**
 * Chat Completions over raw HTTP, for every backend in `catalog.ts`.
 *
 * Built the same way as `src/lib/anthropic/client.ts` and for the same measured
 * reason: React Native's `fetch` is an XHR polyfill with no readable body, so
 * plain fetch handles one-shot calls and XHR `onprogress` is the only way to get
 * incremental output.
 *
 * The rotation pool depends on this module classifying failures accurately —
 * `retryAfterMs` and `authFailure` are what decide how long a backend sits out.
 */

const DEFAULT_TIMEOUT_MS = 120_000;

export class OpenAiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Which backend produced this, so the pool can penalise the right one. */
  readonly backend: OpenAiBackendId;
  /** Worth trying the same backend again shortly. */
  readonly retryable: boolean;
  /** Worth trying a *different* backend right now. */
  readonly failover: boolean;
  /** The key is wrong or revoked — retrying will not help until it changes. */
  readonly authFailure: boolean;
  /** From `Retry-After`, when the backend told us how long to wait. */
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    status: number,
    backend: OpenAiBackendId,
    code = 'UNKNOWN',
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'OpenAiError';
    this.status = status;
    this.backend = backend;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.authFailure = status === 401 || status === 403;
    // 402 is OpenRouter's out-of-credit; 413 is a request this backend cannot
    // hold, which a roomier one might.
    this.failover =
      status === 401 ||
      status === 402 ||
      status === 403 ||
      status === 404 ||
      status === 413 ||
      status === 429 ||
      status >= 500 ||
      status === 0;
    this.retryable = status === 429 || status >= 500 || status === 0;
  }
}

interface ApiErrorBody {
  error?: { message?: string; type?: string; code?: string | number };
  message?: string;
  detail?: string;
}

function explain(
  status: number,
  body: string,
  backend: OpenAiBackendId,
  retryAfterMs: number | null,
): OpenAiError {
  let parsed: ApiErrorBody = {};
  try {
    parsed = JSON.parse(body) as ApiErrorBody;
  } catch {
    /* non-JSON error body */
  }
  const raw =
    parsed.error?.message ?? parsed.message ?? parsed.detail ?? body.slice(0, 300) ?? 'Unknown error';
  const code = String(parsed.error?.code ?? parsed.error?.type ?? 'UNKNOWN');
  const label = backendById(backend)?.label ?? backend;

  const friendly = (() => {
    if (status === 401) return `${label} rejected that key. Replace it in Settings → Free model pool.`;
    if (status === 402) return `${label} is out of free credit for now.`;
    if (status === 403) return `${label} denied access. ${raw}`;
    if (status === 404) return `${label} does not have that model. Pick another in Settings. (${raw})`;
    if (status === 413) return `That conversation is too long for ${label}.`;
    if (status === 429) return `${label} is rate limited right now.`;
    if (status >= 500) return `${label} is temporarily unavailable (${status}).`;
    return `${label}: ${raw}`;
  })();

  return new OpenAiError(friendly, status, backend, code, retryAfterMs);
}

/** `Retry-After` is seconds or an HTTP date; both appear in the wild. */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

function headersFor(cred: OpenAiCredential): Record<string, string> {
  const backend = backendById(cred.backend);
  return {
    'Content-Type': 'application/json',
    ...(cred.apiKey ? { Authorization: `Bearer ${cred.apiKey}` } : {}),
    ...(backend?.extraHeaders ?? {}),
  };
}

// Usage feeds the same ledger as Gemini and Claude so Settings shows one total.
type UsageRecorder = (model: string, usage: UsageMetadata | undefined) => void;
let usageRecorder: UsageRecorder | null = null;

export function setOpenAiUsageRecorder(fn: UsageRecorder | null): void {
  usageRecorder = fn;
}

function record(model: string, usage: ChatCompletionResponse['usage']): void {
  if (!usageRecorder) return;
  try {
    usageRecorder(model, {
      promptTokenCount: usage?.prompt_tokens ?? 0,
      candidatesTokenCount: usage?.completion_tokens ?? 0,
      totalTokenCount: usage?.total_tokens ?? 0,
    });
  } catch {
    // Accounting must never break a request.
  }
}

/**
 * Some compatible servers answer with HTTP 200 and an `error` object rather than
 * a status code, so success has to be checked twice.
 */
function assertNoInlineError(res: ChatCompletionResponse, backend: OpenAiBackendId): void {
  if (!res.error) return;
  const status = Number(res.error.code);
  throw explain(
    Number.isFinite(status) ? status : 502,
    JSON.stringify({ error: res.error }),
    backend,
    null,
  );
}

export interface OpenAiCallArgs {
  credential: OpenAiCredential;
  request: Omit<ChatCompletionRequest, 'model'>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function createCompletion({
  credential,
  request,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
}: OpenAiCallArgs): Promise<ChatCompletionResponse> {
  const url = `${credential.baseUrl}/chat/completions`;

  const attempt = async (): Promise<ChatCompletionResponse> => {
    const res = await withTimeout(
      fetch(url, {
        method: 'POST',
        headers: headersFor(credential),
        body: JSON.stringify({ ...request, model: credential.model, stream: false }),
        signal,
      }),
      timeoutMs,
      'Model request',
    );

    const body = await res.text();
    if (!res.ok) {
      throw explain(res.status, body, credential.backend, parseRetryAfter(res.headers.get('retry-after')));
    }

    let parsed: ChatCompletionResponse;
    try {
      parsed = JSON.parse(body) as ChatCompletionResponse;
    } catch {
      throw new OpenAiError(
        `${credential.backend} returned a malformed response.`,
        502,
        credential.backend,
        'BAD_RESPONSE',
      );
    }
    assertNoInlineError(parsed, credential.backend);
    record(credential.model, parsed.usage);
    return parsed;
  };

  // Only two attempts: the pool would rather move to another backend than sit
  // here backing off against one that is already rate limiting us.
  return withRetry(attempt, {
    attempts: 2,
    baseMs: 800,
    retryable: (e) => e instanceof OpenAiError && e.retryable && e.status !== 429,
  });
}

export interface OpenAiStreamHandlers {
  onText: (delta: string) => void;
  onDone: (final: ChatCompletionResponse) => void;
  onError: (error: Error) => void;
}

/**
 * Streaming over XHR `onprogress`.
 *
 * Text deltas can be emitted as they arrive, but tool calls cannot: the backend
 * sends `function.arguments` in fragments keyed by `index`, and a half-streamed
 * argument string is not valid JSON. They are accumulated per index and only
 * assembled once the stream ends.
 */
export function streamCompletion({
  credential,
  request,
  handlers,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: Omit<OpenAiCallArgs, 'signal'> & { handlers: OpenAiStreamHandlers }): { cancel: () => void } {
  const url = `${credential.baseUrl}/chat/completions`;
  const xhr = new XMLHttpRequest();
  let consumed = 0;
  let settled = false;

  let text = '';
  let finishReason: string | null = null;
  let usage: ChatCompletionResponse['usage'];
  /** index → the tool call being assembled. */
  const partialCalls = new Map<number, { id: string; name: string; args: string }>();

  const finish = (err?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (err) {
      handlers.onError(err);
      return;
    }

    const toolCalls: ChatToolCall[] = [...partialCalls.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, c]) => !!c.name)
      .map(([index, c]) => ({
        // A missing id is legal on some backends; the loop still needs a unique
        // one to pair the result message against.
        id: c.id || `call_${index}`,
        type: 'function' as const,
        function: { name: c.name, arguments: c.args },
      }));

    record(credential.model, usage);
    handlers.onDone({
      model: credential.model,
      choices: [
        {
          message: {
            role: 'assistant',
            content: text || null,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finishReason,
        },
      ],
      usage,
    });
  };

  const timer = setTimeout(() => {
    xhr.abort();
    finish(new OpenAiError('The model took too long to answer.', 0, credential.backend, 'TIMEOUT'));
  }, timeoutMs);

  const handleFrame = (payload: string) => {
    let event: ChatCompletionResponse;
    try {
      event = JSON.parse(payload) as ChatCompletionResponse;
    } catch {
      return; // A malformed frame should not kill the stream.
    }

    if (event.error) {
      finish(
        new OpenAiError(
          event.error.message ?? 'Stream error',
          502,
          credential.backend,
          String(event.error.code ?? 'STREAM'),
        ),
      );
      return;
    }

    if (event.usage) usage = event.usage;

    const choice = event.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = choice.delta;
    if (!delta) return;

    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content;
      handlers.onText(delta.content);
    }

    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? 0;
      const existing = partialCalls.get(index) ?? { id: '', name: '', args: '' };
      if (call.id) existing.id = call.id;
      if (call.function?.name) existing.name = call.function.name;
      if (call.function?.arguments) existing.args += call.function.arguments;
      partialCalls.set(index, existing);
    }
  };

  const drain = () => {
    const raw = xhr.responseText ?? '';
    if (raw.length <= consumed) return;
    const fresh = raw.slice(consumed);
    const lastBreak = fresh.lastIndexOf('\n');
    if (lastBreak === -1) return;
    consumed += lastBreak + 1;

    for (const line of fresh.slice(0, lastBreak).split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      handleFrame(payload);
    }
  };

  xhr.open('POST', url, true);
  for (const [k, v] of Object.entries(headersFor(credential))) xhr.setRequestHeader(k, v);
  xhr.setRequestHeader('Accept', 'text/event-stream');

  xhr.onprogress = () => {
    if (xhr.status >= 200 && xhr.status < 300) drain();
  };

  xhr.onload = () => {
    if (xhr.status < 200 || xhr.status >= 300) {
      finish(
        explain(
          xhr.status,
          xhr.responseText ?? '',
          credential.backend,
          parseRetryAfter(xhr.getResponseHeader('retry-after')),
        ),
      );
      return;
    }
    drain();
    const tail = (xhr.responseText ?? '').slice(consumed).trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== '[DONE]') handleFrame(payload);
    }
    finish();
  };

  xhr.onerror = () =>
    finish(
      new OpenAiError(
        `Could not reach ${backendById(credential.backend)?.label ?? credential.backend}.`,
        0,
        credential.backend,
        'NETWORK',
      ),
    );
  xhr.onabort = () => finish();

  xhr.send(
    JSON.stringify({
      ...request,
      model: credential.model,
      stream: true,
      stream_options: { include_usage: true },
    }),
  );

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

interface RawModel {
  id?: string;
  name?: string;
  context_length?: number;
  context_window?: number;
}

/** `GET /models`, which every backend in the catalog implements. */
export async function listBackendModels(credential: OpenAiCredential): Promise<OpenAiModelInfo[]> {
  const res = await withTimeout(
    fetch(`${credential.baseUrl}/models`, { headers: headersFor(credential) }),
    30_000,
    'Model list',
  );
  const body = await res.text();
  if (!res.ok) throw explain(res.status, body, credential.backend, null);

  const parsed = JSON.parse(body) as { data?: RawModel[] };
  return (parsed.data ?? [])
    .filter((m) => !!m.id)
    .map<OpenAiModelInfo>((m) => ({
      id: m.id!,
      displayName: m.name ?? m.id!,
      contextLength: m.context_length ?? m.context_window,
    }))
    // Whisper, embeddings and guard models cannot hold a conversation.
    .filter((m) => !/whisper|embed|tts|guard|moderation|rerank/i.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Round-trips a trivial prompt to prove a backend works end to end. */
export async function verifyBackend(
  credential: OpenAiCredential,
): Promise<{ ok: true; reply: string } | { ok: false; error: string }> {
  try {
    const res = await createCompletion({
      credential,
      timeoutMs: 45_000,
      request: {
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
        max_tokens: 256,
        temperature: 0,
      },
    });
    return { ok: true, reply: textOfCompletion(res).trim() || 'ready' };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}
