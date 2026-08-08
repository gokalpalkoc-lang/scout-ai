import { errorMessage, withRetry, withTimeout } from '../util';
import { Credential } from './auth';
import {
  GenerateContentRequest,
  GenerateContentResponse,
  ModelInfo,
  UsageMetadata,
  textOf,
} from './types';

const AI_STUDIO_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Token accounting hook.
 *
 * Every response Google returns carries `usageMetadata`; recording it in one
 * place here means the Settings screen can show real consumption instead of an
 * estimate, whether the call came from chat, a page check or a background run.
 */
type UsageRecorder = (model: string, usage: UsageMetadata | undefined) => void;

let usageRecorder: UsageRecorder | null = null;

export function setUsageRecorder(fn: UsageRecorder | null): void {
  usageRecorder = fn;
}

function recordUsage(model: string, usage: UsageMetadata | undefined): void {
  if (!usageRecorder) return;
  try {
    usageRecorder(model, usage);
  } catch {
    // Accounting must never break a request.
  }
}

/** A Gemini failure with a message worth putting in front of the user. */
export class GeminiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, status: number, code = 'UNKNOWN') {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.code = code;
    this.retryable = status === 429 || status === 500 || status === 503 || status === 504 || status === 0;
  }
}

interface ApiErrorBody {
  error?: { code?: number; message?: string; status?: string };
}

/** Turns Google's error payloads into something actionable. */
function explain(status: number, body: string): GeminiError {
  let parsed: ApiErrorBody = {};
  try {
    parsed = JSON.parse(body) as ApiErrorBody;
  } catch {
    /* non-JSON error body */
  }
  const raw = parsed.error?.message ?? body.slice(0, 300) ?? 'Unknown error';
  const code = parsed.error?.status ?? 'UNKNOWN';

  const friendly = (() => {
    if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(raw)) {
      return 'That Gemini API key was rejected. Check it in Settings → Gemini access, or create a new one at aistudio.google.com/apikey.';
    }
    if (status === 400 && /API key expired/i.test(raw)) {
      return 'The Gemini API key has expired. Create a new one at aistudio.google.com/apikey.';
    }
    if (status === 401 || status === 403) {
      return `Access denied by Google (${status}). ${raw}`;
    }
    if (status === 404) {
      return `Model not found. Pick a different model in Settings. (${raw})`;
    }
    if (status === 429) {
      return 'Gemini rate limit or quota reached. Wait a moment, or switch to a lighter model such as Flash-Lite in Settings.';
    }
    if (status >= 500) {
      return `Gemini is temporarily unavailable (${status}). Scout will retry.`;
    }
    return raw;
  })();

  return new GeminiError(friendly, status, code);
}

function endpointFor(cred: Credential, model: string, method: string, query = ''): string {
  if (cred.provider === 'vertex') {
    const base = `https://${cred.location}-aiplatform.googleapis.com/v1/projects/${cred.project}/locations/${cred.location}/publishers/google/models`;
    return `${base}/${model}:${method}${query}`;
  }
  return `${AI_STUDIO_BASE}/models/${model}:${method}${query}`;
}

function headersFor(cred: Credential): Record<string, string> {
  const base: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cred.provider === 'vertex') base.Authorization = `Bearer ${cred.accessToken}`;
  // Sent as a header rather than a query param so the key stays out of logs.
  else base['x-goog-api-key'] = cred.apiKey;
  return base;
}

export interface GenerateArgs {
  credential: Credential;
  model: string;
  request: GenerateContentRequest;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** One non-streaming `generateContent` round trip, with backoff on 429/5xx. */
export async function generateContent({
  credential,
  model,
  request,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
}: GenerateArgs): Promise<GenerateContentResponse> {
  const url = endpointFor(credential, model, 'generateContent');

  const attempt = async (): Promise<GenerateContentResponse> => {
    const res = await withTimeout(
      fetch(url, {
        method: 'POST',
        headers: headersFor(credential),
        body: JSON.stringify(request),
        signal,
      }),
      timeoutMs,
      'Gemini request',
    );

    const body = await res.text();
    if (!res.ok) throw explain(res.status, body);

    try {
      const parsed = JSON.parse(body) as GenerateContentResponse;
      recordUsage(model, parsed.usageMetadata);
      return parsed;
    } catch (e) {
      if (e instanceof GeminiError) throw e;
      throw new GeminiError('Gemini returned a malformed response.', 502, 'BAD_RESPONSE');
    }
  };

  return withRetry(attempt, {
    attempts: 3,
    baseMs: 900,
    retryable: (e) => e instanceof GeminiError && e.retryable,
  });
}

export interface StreamHandlers {
  onText: (chunk: string) => void;
  onDone: (final: GenerateContentResponse) => void;
  onError: (error: Error) => void;
}

/**
 * Streaming `generateContent` over XMLHttpRequest.
 *
 * React Native's `fetch` does not expose a readable body, so incremental output
 * has to come from XHR's growing `responseText`. Each SSE `data:` frame is a
 * partial GenerateContentResponse; we emit its text and merge the pieces so the
 * caller still receives one complete response at the end.
 */
export function streamGenerateContent({
  credential,
  model,
  request,
  handlers,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: Omit<GenerateArgs, 'signal'> & { handlers: StreamHandlers }): { cancel: () => void } {
  const url = endpointFor(credential, model, 'streamGenerateContent', '?alt=sse');
  const xhr = new XMLHttpRequest();
  let consumed = 0;
  let settled = false;
  const chunks: GenerateContentResponse[] = [];

  const finish = (err?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (err) {
      handlers.onError(err);
      return;
    }
    const merged = mergeChunks(chunks);
    recordUsage(model, merged.usageMetadata);
    handlers.onDone(merged);
  };

  const timer = setTimeout(() => {
    xhr.abort();
    finish(new GeminiError('Gemini request timed out.', 0, 'TIMEOUT'));
  }, timeoutMs);

  const drain = () => {
    const text = xhr.responseText ?? '';
    if (text.length <= consumed) return;
    const fresh = text.slice(consumed);
    // Only consume up to the last complete frame; keep any partial tail.
    const lastBreak = fresh.lastIndexOf('\n');
    if (lastBreak === -1) return;
    const ready = fresh.slice(0, lastBreak);
    consumed += lastBreak + 1;

    for (const line of ready.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload) as GenerateContentResponse;
        chunks.push(parsed);
        const piece = textOf(parsed);
        if (piece) handlers.onText(piece);
      } catch {
        // Ignore an unparseable frame rather than killing the stream.
      }
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
      finish(explain(xhr.status, xhr.responseText ?? ''));
      return;
    }
    drain();
    // Flush a trailing frame that arrived without a newline.
    const tail = (xhr.responseText ?? '').slice(consumed).trim();
    if (tail.startsWith('data:')) {
      try {
        const parsed = JSON.parse(tail.slice(5).trim()) as GenerateContentResponse;
        chunks.push(parsed);
        const piece = textOf(parsed);
        if (piece) handlers.onText(piece);
      } catch {
        /* ignore */
      }
    }
    finish();
  };

  xhr.onerror = () =>
    finish(new GeminiError('Network error reaching Gemini. Check your connection.', 0, 'NETWORK'));
  xhr.onabort = () => {
    // A user-cancelled stream still returns whatever arrived before the abort.
    finish();
  };

  xhr.send(JSON.stringify(request));

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

/** Folds streamed partials into a single response (text joined, parts appended). */
function mergeChunks(chunks: GenerateContentResponse[]): GenerateContentResponse {
  if (!chunks.length) return { candidates: [] };

  const parts: GenerateContentResponse['candidates'] = [
    { content: { role: 'model', parts: [] }, finishReason: undefined, groundingMetadata: {} },
  ];
  const target = parts[0];
  let text = '';

  for (const chunk of chunks) {
    const cand = chunk.candidates?.[0];
    if (!cand) continue;
    for (const p of cand.content?.parts ?? []) {
      if ('text' in p && typeof p.text === 'string') text += p.text;
      else target.content!.parts.push(p);
    }
    if (cand.finishReason) target.finishReason = cand.finishReason;
    const g = cand.groundingMetadata?.groundingChunks;
    if (g?.length) {
      target.groundingMetadata!.groundingChunks = [
        ...(target.groundingMetadata!.groundingChunks ?? []),
        ...g,
      ];
    }
  }

  if (text) target.content!.parts.unshift({ text });

  const usage = chunks[chunks.length - 1]?.usageMetadata;
  return { candidates: parts, usageMetadata: usage };
}

interface RawModel {
  name?: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

/**
 * Lists the models the credential can actually use, newest-looking first.
 * Only AI Studio exposes this; Vertex has no equivalent public listing, so the
 * curated fallback is returned there.
 */
export async function listModels(credential: Credential): Promise<ModelInfo[]> {
  if (credential.provider === 'vertex') return FALLBACK_MODELS;

  const res = await withTimeout(
    fetch(`${AI_STUDIO_BASE}/models?pageSize=200`, { headers: headersFor(credential) }),
    30_000,
    'Model list',
  );
  const body = await res.text();
  if (!res.ok) throw explain(res.status, body);

  const parsed = JSON.parse(body) as { models?: RawModel[] };
  const models = (parsed.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map<ModelInfo>((m) => ({
      name: m.name ?? '',
      id: (m.name ?? '').replace(/^models\//, ''),
      displayName: m.displayName ?? (m.name ?? '').replace(/^models\//, ''),
      description: m.description ?? '',
      inputTokenLimit: m.inputTokenLimit ?? 0,
      outputTokenLimit: m.outputTokenLimit ?? 0,
      supportedActions: m.supportedGenerationMethods ?? [],
    }))
    // Drop embedding/legacy entries that cannot hold a chat.
    .filter((m) => !/embedding|aqa|imagen|veo|tts|image-generation/i.test(m.id));

  return models.sort((a, b) => rank(b.id) - rank(a.id) || a.id.localeCompare(b.id));
}

/** Heuristic ordering so the newest, most useful models surface at the top. */
function rank(id: string): number {
  let score = 0;
  const version = /(\d+)\.(\d+)/.exec(id);
  if (version) score += Number(version[1]) * 100 + Number(version[2]) * 10;
  if (/flash/.test(id)) score += 6;
  if (/pro/.test(id)) score += 5;
  if (/lite/.test(id)) score -= 2;
  if (/preview|exp/.test(id)) score -= 8;
  return score;
}

/**
 * Used before a key has been verified and on Vertex. Kept deliberately short —
 * the live list from `listModels` replaces it as soon as a key is saved.
 */
export const FALLBACK_MODELS: ModelInfo[] = [
  {
    name: 'models/gemini-2.5-flash',
    id: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    description: 'Fast and inexpensive. The right default for page extraction and chat.',
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    supportedActions: ['generateContent'],
  },
  {
    name: 'models/gemini-2.5-pro',
    id: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    description: 'Strongest reasoning. Best for messy pages and long documents.',
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    supportedActions: ['generateContent'],
  },
  {
    name: 'models/gemini-2.5-flash-lite',
    id: 'gemini-2.5-flash-lite',
    displayName: 'Gemini 2.5 Flash-Lite',
    description: 'Cheapest and quickest. Good for frequent background checks.',
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    supportedActions: ['generateContent'],
  },
];

/** Round-trips a trivial prompt to prove a credential works. */
export async function verifyCredential(
  credential: Credential,
  model: string,
): Promise<{ ok: true; reply: string } | { ok: false; error: string }> {
  try {
    const res = await generateContent({
      credential,
      model,
      timeoutMs: 30_000,
      request: {
        contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ready' }] }],
        generationConfig: { maxOutputTokens: 2048, temperature: 0 },
      },
    });
    const reply = textOf(res).trim();
    return { ok: true, reply: reply || 'ready' };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}
