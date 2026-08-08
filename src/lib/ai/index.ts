import { Settings } from '../../store/settings';
import { resolveAnthropicCredential } from '../anthropic/auth';
import { runAnthropicTurn } from '../anthropic/agent';
import { verifyAnthropicCredential } from '../anthropic/client';
import { runAgentTurn } from '../gemini/agent';
import { resolveCredential } from '../gemini/auth';
import { verifyCredential } from '../gemini/client';
import { ChatMessage } from '../types';
import { AgentCallbacks, AgentResult, AssistantProvider } from './contract';

/**
 * Provider router for the assistant.
 *
 * Each provider owns its own wire format and tool loop; this module is the only
 * place that knows which one is active. The tool *implementations* are shared —
 * `src/lib/gemini/tools.ts` is provider-neutral (name + args → JSON result), so
 * both agents drive the same 17 tools against the same database.
 *
 * Page extraction deliberately does not route through here: it runs on every
 * site check, and a cheap Gemini Flash model is the right tool for "read this
 * text, emit JSON". Claude is where reasoning and authoring happen.
 */

export * from './contract';

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

  if (provider === 'claude') {
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

/** Model name for the active assistant provider, for headers and labels. */
export function activeAssistantModel(settings: Settings): string {
  return settings.assistantProvider === 'claude' ? settings.claudeModel : settings.chatModel;
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
  const resolved = await resolveCredential(settings);
  if ('error' in resolved) return { ok: false, error: resolved.error };
  return verifyCredential(resolved.credential, settings.chatModel);
}

/**
 * Whether an authoring feature (rules, modules) can run right now.
 *
 * Both work on either provider, but they are code- and schema-authoring tasks,
 * so the message names Claude when it is the stronger available option.
 */
export async function authoringAvailability(
  settings: Settings,
): Promise<{ ok: true; provider: AssistantProvider } | { ok: false; error: string }> {
  if (settings.assistantProvider === 'claude') {
    const resolved = await resolveAnthropicCredential();
    return 'error' in resolved ? { ok: false, error: resolved.error } : { ok: true, provider: 'claude' };
  }
  const resolved = await resolveCredential(settings);
  return 'error' in resolved ? { ok: false, error: resolved.error } : { ok: true, provider: 'gemini' };
}
