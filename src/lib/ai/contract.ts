import { OPENAI_BACKENDS, OpenAiBackendId } from '../openai/catalog';
import { GroundingRef, ToolTrailEntry } from '../types';

/**
 * The contract both providers implement.
 *
 * Extracted into its own module so `src/lib/gemini` and `src/lib/anthropic` can
 * each depend on it without depending on each other — importing the Gemini agent
 * from the Anthropic one would drag Gemini's whole wire layer into every bundle
 * path and make the two providers circular.
 */

export interface AgentCallbacks {
  /** Streamed text of the answer. */
  onText: (delta: string) => void;
  /** A tool is about to run — lets the UI show "Checking Salon IKSV…". */
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  onToolEnd?: (entry: ToolTrailEntry) => void;
}

export interface AgentResult {
  text: string;
  toolTrail: ToolTrailEntry[];
  /** Web-search citations. Gemini-only; always empty on Claude. */
  grounding: GroundingRef[];
  /** Set when the turn ended badly; `text` then holds a user-facing message. */
  error: string | null;
  rounds: number;
  /** Which pool member actually answered. Only set when the pool is active. */
  usedMember?: string;
}

export type AssistantProvider = 'gemini' | 'claude' | 'pool';

export const PROVIDER_LABELS: Record<AssistantProvider, string> = {
  gemini: 'Gemini',
  claude: 'Claude',
  pool: 'Free pool',
};

/**
 * One rotatable entry in the free model pool.
 *
 * A member is not a provider — it is a *configured* provider. `gemini` and
 * `claude` members reuse the credentials already in Settings, so the pool can
 * mix a paid key that is fast with free tiers that are not, and fall through to
 * whichever still has quota. Keeping the shape open like this is also what lets
 * an on-device backend join later without touching the router: it becomes
 * another `kind`.
 */
export interface PoolMember {
  /** Stable identity, used as the health key. Equals `backend` for OpenAI kinds. */
  id: string;
  kind: 'openai' | 'gemini' | 'claude';
  /** Required when `kind` is `openai`. */
  backend?: OpenAiBackendId;
  /** Empty means "the backend's default". */
  model: string;
  /** Only for backends whose catalog entry has no fixed base URL. */
  baseUrl?: string;
  enabled: boolean;
}

export function poolMemberLabel(member: PoolMember, backendLabel?: string): string {
  if (member.kind === 'gemini') return 'Gemini';
  if (member.kind === 'claude') return 'Claude';
  return backendLabel ?? member.backend ?? member.id;
}

/**
 * Every member Scout knows how to run, all switched off.
 *
 * Seeded rather than created on demand so the Settings screen has a stable row
 * per backend and a model choice survives being switched off and on again. A
 * member only ever joins a turn once the user enables it *and* a key resolves.
 *
 * Returns fresh objects each call — the settings store hands these straight to
 * React state, where a shared array would leak edits across a reset.
 */
export function defaultPoolMembers(): PoolMember[] {
  return [
    ...OPENAI_BACKENDS.map<PoolMember>((b) => ({
      id: b.id,
      kind: 'openai',
      backend: b.id,
      model: b.defaultModel,
      baseUrl: b.userBaseUrl ? '' : undefined,
      enabled: false,
    })),
    { id: 'gemini', kind: 'gemini', model: '', enabled: false },
    { id: 'claude', kind: 'claude', model: '', enabled: false },
  ];
}

/**
 * Folds saved choices onto the current catalog.
 *
 * A backend added in a later release has no saved row, and one removed from the
 * catalog should not linger in the list; taking the defaults as the shape and
 * the saved values as the content handles both without a migration.
 */
export function mergePoolMembers(saved: PoolMember[] | undefined): PoolMember[] {
  if (!saved?.length) return defaultPoolMembers();
  const byId = new Map(saved.map((m) => [m.id, m]));
  return defaultPoolMembers().map((fallback) => {
    const existing = byId.get(fallback.id);
    return existing ? { ...fallback, ...existing, kind: fallback.kind } : fallback;
  });
}
