import { Settings } from '../../store/settings';
import { resolveAnthropicCredential } from '../anthropic/auth';
import { runAnthropicTurn } from '../anthropic/agent';
import { verifyAnthropicCredential } from '../anthropic/client';
import { runAgentTurn } from '../gemini/agent';
import { resolveCredential } from '../gemini/auth';
import { verifyCredential } from '../gemini/client';
import { runOpenAiTurn } from '../openai/agent';
import { resolveBackendCredential } from '../openai/auth';
import { backendById } from '../openai/catalog';
import { OpenAiError, verifyBackend } from '../openai/client';
import { ChatMessage } from '../types';
import { errorMessage } from '../util';
import {
  AgentCallbacks,
  AgentResult,
  AssistantProvider,
  PoolMember,
  poolMemberLabel,
} from './contract';
import { advanceCursor, orderCandidates, recordFailure, recordSuccess } from './pool';

/**
 * Provider router for the assistant.
 *
 * Each provider owns its own wire format and tool loop; this module is the only
 * place that knows which one is active. The tool *implementations* are shared —
 * `src/lib/gemini/tools.ts` is provider-neutral (name + args → JSON result), so
 * every agent drives the same 24 tools against the same database.
 *
 * Page extraction deliberately does not route through here: it runs on every
 * site check, and a cheap Gemini Flash model is the right tool for "read this
 * text, emit JSON". Reasoning and authoring are what the router is for.
 */

export * from './contract';

/** A member's display name, resolving the catalog label for OpenAI backends. */
const labelOf = (m: PoolMember): string =>
  poolMemberLabel(m, m.backend ? backendById(m.backend)?.label : undefined);

export interface TurnArgs {
  settings: Settings;
  history: ChatMessage[];
  userMessage: string;
  siteCount: number;
  callbacks: AgentCallbacks;
  onDataChanged?: () => void;
  signal?: AbortSignal;
}

/** Runs one assistant turn on whichever provider is configured. */
export async function runTurn(args: TurnArgs): Promise<AgentResult> {
  const provider = args.settings.assistantProvider;
  if (provider === 'pool') return runPoolTurn(args);
  if (provider === 'claude') return runClaudeTurn(args);
  return runGeminiTurn(args);
}

async function runClaudeTurn(args: TurnArgs): Promise<AgentResult> {
  const resolved = await resolveAnthropicCredential();
  if ('error' in resolved) {
    return { text: '', toolTrail: [], grounding: [], error: resolved.error, rounds: 0 };
  }
  return runAnthropicTurn({
    credential: resolved.credential,
    settings: args.settings,
    history: args.history,
    userMessage: args.userMessage,
    siteCount: args.siteCount,
    callbacks: args.callbacks,
    onDataChanged: args.onDataChanged,
    signal: args.signal,
  });
}

async function runGeminiTurn(args: TurnArgs): Promise<AgentResult> {
  const resolved = await resolveCredential(args.settings);
  if ('error' in resolved) {
    return { text: '', toolTrail: [], grounding: [], error: resolved.error, rounds: 0 };
  }
  return runAgentTurn({
    credential: resolved.credential,
    settings: args.settings,
    history: args.history,
    userMessage: args.userMessage,
    siteCount: args.siteCount,
    callbacks: args.callbacks,
    onDataChanged: args.onDataChanged,
    signal: args.signal,
  });
}

export function enabledPoolMembers(settings: Settings): PoolMember[] {
  return settings.poolMembers.filter((m) => m.enabled);
}

/**
 * Runs a turn against the pool, moving to the next backend when one refuses.
 *
 * The hard constraint is that failover has to be invisible. Once a backend has
 * streamed a word to the UI or run a tool, the turn is *committed*: the chat
 * store appends deltas to a single draft, and the tools mutate SQLite, so
 * restarting on another backend would duplicate both. From that point a failure
 * is reported rather than retried — which is also why the loop watches
 * `onToolStart` and not `onToolEnd`, since a tool that failed halfway through
 * has still had its chance to write.
 */
async function runPoolTurn(args: TurnArgs): Promise<AgentResult> {
  const members = enabledPoolMembers(args.settings);
  if (!members.length) {
    return {
      text: '',
      toolTrail: [],
      grounding: [],
      error: 'The free model pool is empty. Add at least one backend in Settings → Free model pool.',
      rounds: 0,
    };
  }

  const ordered = await orderCandidates(members);
  const attempts: string[] = [];
  let committed = false;

  const callbacks: AgentCallbacks = {
    onText: (delta) => {
      if (delta) committed = true;
      args.callbacks.onText(delta);
    },
    onToolStart: (name, toolArgs) => {
      committed = true;
      args.callbacks.onToolStart?.(name, toolArgs);
    },
    onToolEnd: (entry) => args.callbacks.onToolEnd?.(entry),
  };

  for (const member of ordered) {
    if (args.signal?.aborted) break;
    const label = labelOf(member);

    let result: AgentResult;
    try {
      result = await runMember(member, { ...args, callbacks });
    } catch (e) {
      if (committed) {
        return {
          text: '',
          toolTrail: [],
          grounding: [],
          error: `${label} failed partway through: ${errorMessage(e)}`,
          rounds: 0,
          usedMember: member.id,
        };
      }
      await noteFailure(member.id, e);
      attempts.push(`${label}: ${errorMessage(e)}`);
      continue;
    }

    // Gemini and Claude report failures in the result rather than throwing, so
    // an errored turn that produced nothing counts the same as an exception.
    if (result.error && !result.text.trim()) {
      if (committed) return { ...result, usedMember: member.id };
      await recordFailure(member.id, { message: result.error });
      attempts.push(`${label}: ${result.error}`);
      continue;
    }

    await recordSuccess(member.id);
    await advanceCursor(members, member.id);
    return { ...result, usedMember: member.id };
  }

  if (args.signal?.aborted) {
    return { text: '', toolTrail: [], grounding: [], error: null, rounds: 0 };
  }

  return {
    text: '',
    toolTrail: [],
    grounding: [],
    error: [
      `All ${ordered.length} pool backend(s) refused this turn.`,
      ...attempts.map((a) => `• ${a}`),
    ].join('\n'),
    rounds: 0,
  };
}

/** Dispatches one pool member to the agent loop that speaks its wire format. */
async function runMember(member: PoolMember, args: TurnArgs): Promise<AgentResult> {
  if (member.kind === 'gemini') return runGeminiTurn(args);
  if (member.kind === 'claude') return runClaudeTurn(args);

  const resolved = await resolveBackendCredential({
    id: member.backend!,
    model: member.model,
    baseUrl: member.baseUrl,
  });
  if ('error' in resolved) throw new Error(resolved.error);

  return runOpenAiTurn({
    credential: resolved.credential,
    settings: args.settings,
    history: args.history,
    userMessage: args.userMessage,
    siteCount: args.siteCount,
    callbacks: args.callbacks,
    onDataChanged: args.onDataChanged,
    signal: args.signal,
  });
}

/** Turns a thrown failure into the bench time it deserves. */
function noteFailure(id: string, e: unknown): Promise<void> {
  if (e instanceof OpenAiError) {
    return recordFailure(id, {
      message: e.message,
      retryAfterMs: e.retryAfterMs,
      authFailure: e.authFailure,
      network: e.status === 0,
    });
  }
  return recordFailure(id, { message: errorMessage(e) });
}

/** Model name for the active assistant provider, for headers and labels. */
export function activeAssistantModel(settings: Settings): string {
  if (settings.assistantProvider === 'claude') return settings.claudeModel;
  if (settings.assistantProvider === 'pool') {
    const members = enabledPoolMembers(settings);
    if (!members.length) return 'none configured';
    return members.length === 1 ? members[0].model || labelOf(members[0]) : `${members.length} backends`;
  }
  return settings.chatModel;
}

/** Round-trips a trivial prompt on whichever provider is active. */
export async function verifyAssistant(
  settings: Settings,
): Promise<{ ok: true; reply: string } | { ok: false; error: string }> {
  if (settings.assistantProvider === 'claude') {
    const resolved = await resolveAnthropicCredential();
    if ('error' in resolved) return { ok: false, error: resolved.error };
    return verifyAnthropicCredential(resolved.credential, settings.claudeModel);
  }

  if (settings.assistantProvider === 'pool') {
    const members = enabledPoolMembers(settings);
    if (!members.length) {
      return { ok: false, error: 'The free model pool is empty. Add a backend first.' };
    }
    // One working backend is enough for the pool to answer, so this reports the
    // first success rather than insisting every member is healthy.
    const failures: string[] = [];
    for (const member of await orderCandidates(members)) {
      const outcome = await verifyMember(member, settings);
      if (outcome.ok) {
        await recordSuccess(member.id);
        return outcome;
      }
      failures.push(`${labelOf(member)}: ${outcome.error}`);
    }
    return { ok: false, error: failures.join('\n') };
  }

  const resolved = await resolveCredential(settings);
  if ('error' in resolved) return { ok: false, error: resolved.error };
  return verifyCredential(resolved.credential, settings.chatModel);
}

async function verifyMember(
  member: PoolMember,
  settings: Settings,
): Promise<{ ok: true; reply: string } | { ok: false; error: string }> {
  if (member.kind === 'gemini') {
    const resolved = await resolveCredential(settings);
    if ('error' in resolved) return { ok: false, error: resolved.error };
    return verifyCredential(resolved.credential, member.model || settings.chatModel);
  }
  if (member.kind === 'claude') {
    const resolved = await resolveAnthropicCredential();
    if ('error' in resolved) return { ok: false, error: resolved.error };
    return verifyAnthropicCredential(resolved.credential, member.model || settings.claudeModel);
  }

  const resolved = await resolveBackendCredential({
    id: member.backend!,
    model: member.model,
    baseUrl: member.baseUrl,
  });
  if ('error' in resolved) return { ok: false, error: resolved.error };
  return verifyBackend(resolved.credential);
}

/**
 * Whether an authoring feature (rules, modules) can run right now.
 *
 * Rules are a closed JSON DSL that a small model can fill in, so the pool is
 * allowed to author them. Modules are hand-written HTML and JavaScript, which
 * the free tiers are not reliably good enough for — `authoringAvailability`
 * reports the provider, and the module generator decides what to do with it.
 */
export async function authoringAvailability(
  settings: Settings,
): Promise<{ ok: true; provider: AssistantProvider } | { ok: false; error: string }> {
  if (settings.assistantProvider === 'claude') {
    const resolved = await resolveAnthropicCredential();
    return 'error' in resolved ? { ok: false, error: resolved.error } : { ok: true, provider: 'claude' };
  }
  if (settings.assistantProvider === 'pool') {
    return enabledPoolMembers(settings).length
      ? { ok: true, provider: 'pool' }
      : { ok: false, error: 'The free model pool is empty. Add a backend in Settings.' };
  }
  const resolved = await resolveCredential(settings);
  return 'error' in resolved ? { ok: false, error: resolved.error } : { ok: true, provider: 'gemini' };
}

/**
 * The pool member that should handle a one-shot authoring call.
 *
 * Authoring has no streaming and no tools, so it does not need the failover
 * machinery — it only needs whichever backend is not currently benched.
 */
export async function firstReadyMember(settings: Settings): Promise<PoolMember | null> {
  const members = enabledPoolMembers(settings);
  if (!members.length) return null;
  const [first] = await orderCandidates(members);
  return first ?? null;
}
