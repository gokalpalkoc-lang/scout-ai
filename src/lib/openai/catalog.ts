/**
 * The OpenAI-compatible backends Scout can rotate through.
 *
 * Every entry here has a permanent free tier and speaks Chat Completions, which
 * is why one client and one agent loop serve all of them — adding a backend is
 * a row in this table, not a new module.
 *
 * `freeTier` is documentation, not enforcement: quotas move, and the pool learns
 * the real limits from 429s rather than from these numbers. It exists so the
 * Settings screen can tell the user what they are signing up for.
 */

export type OpenAiBackendId =
  | 'groq'
  | 'cerebras'
  | 'openrouter'
  | 'mistral'
  | 'github'
  | 'custom';

export interface OpenAiBackend {
  id: OpenAiBackendId;
  label: string;
  /** Base URL including the version segment; `/chat/completions` is appended. */
  baseUrl: string;
  /** Where the user goes to create a key. */
  keyUrl: string;
  defaultModel: string;
  /** Shown under the model field so the user knows what else is available. */
  suggestedModels: string[];
  freeTier: string;
  /** False for backends whose free models mostly lack function calling. */
  toolCalling: boolean;
  /** A cheap paste check; not validation. */
  keyHint?: (key: string) => boolean;
  /** Backends that need more than `Authorization: Bearer`. */
  extraHeaders?: Record<string, string>;
  /** True when the base URL is user-supplied rather than fixed. */
  userBaseUrl?: boolean;
}

export const OPENAI_BACKENDS: OpenAiBackend[] = [
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    defaultModel: 'llama-3.3-70b-versatile',
    suggestedModels: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'openai/gpt-oss-120b',
      'qwen/qwen3-32b',
    ],
    freeTier: 'Fastest replies. Around 1,000 requests a day, 30 a minute.',
    toolCalling: true,
    keyHint: (k) => k.startsWith('gsk_'),
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyUrl: 'https://cloud.cerebras.ai',
    defaultModel: 'llama-3.3-70b',
    suggestedModels: ['llama-3.3-70b', 'llama3.1-8b', 'qwen-3-32b'],
    freeTier: 'Highest daily throughput — roughly a million tokens a day.',
    toolCalling: true,
    keyHint: (k) => k.startsWith('csk-'),
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    suggestedModels: [
      'meta-llama/llama-3.3-70b-instruct:free',
      'deepseek/deepseek-chat-v3-0324:free',
      'google/gemma-3-27b-it:free',
      'qwen/qwen3-235b-a22b:free',
    ],
    freeTier: 'One key, many free models. Models ending in ":free" cost nothing.',
    toolCalling: true,
    keyHint: (k) => k.startsWith('sk-or-'),
    // OpenRouter attributes traffic by these; they are optional but polite.
    extraHeaders: { 'HTTP-Referer': 'https://github.com/scout-app', 'X-Title': 'Scout' },
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
    defaultModel: 'mistral-large-latest',
    suggestedModels: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo'],
    freeTier: 'Very large monthly allowance, but slow — about 1 request a second.',
    toolCalling: true,
  },
  {
    id: 'github',
    label: 'GitHub Models',
    baseUrl: 'https://models.github.ai/inference',
    keyUrl: 'https://github.com/settings/personal-access-tokens',
    defaultModel: 'openai/gpt-4.1-mini',
    suggestedModels: ['openai/gpt-4.1-mini', 'openai/gpt-4.1', 'meta/Llama-4-Scout-17B-16E-Instruct'],
    freeTier: 'Frontier models on a GitHub token. Low daily caps.',
    toolCalling: true,
    keyHint: (k) => k.startsWith('ghp_') || k.startsWith('github_pat_'),
  },
  {
    id: 'custom',
    label: 'Custom endpoint',
    baseUrl: '',
    keyUrl: '',
    defaultModel: '',
    suggestedModels: [],
    freeTier: 'Any OpenAI-compatible server — Ollama, LM Studio, vLLM, a proxy.',
    toolCalling: true,
    userBaseUrl: true,
  },
];

export function backendById(id: OpenAiBackendId): OpenAiBackend | undefined {
  return OPENAI_BACKENDS.find((b) => b.id === id);
}
