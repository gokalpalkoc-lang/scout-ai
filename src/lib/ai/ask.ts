import { Settings } from '../../store/settings';
import { claudeAsk } from '../anthropic/agent';
import { resolveAnthropicCredential } from '../anthropic/auth';
import { quickAsk } from '../gemini/agent';
import { resolveCredential } from '../gemini/auth';
import { openAiAsk } from '../openai/agent';
import { resolveBackendCredential } from '../openai/auth';
import { backendById } from '../openai/catalog';
import { OpenAiError } from '../openai/client';
import { errorMessage } from '../util';
import { PoolMember, poolMemberLabel } from './contract';
import { advanceCursor, orderCandidates, recordFailure, recordSuccess } from './pool';

/**
 * One-shot generation on whichever provider is configured.
 *
 * The rule and module authors each carried their own copy of "if Claude … else
 * Gemini …", which is exactly the shape that rots once a third provider exists.
 * They now call this instead, and gain pool rotation for free.
 *
 * Unlike a chat turn, an authoring call has no streaming and no tools, so there
 * are no side effects to duplicate — failover here is unconditional, and the
 * pool can walk the whole list until something answers.
 */

export interface AskArgs {
  settings: Settings;
  prompt: string;
  system?: string;
  maxTokens?: number;
  /** Claude's thinking dial; ignored by the other providers. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  signal?: AbortSignal;
}

export type AskResult = { ok: true; text: string } | { ok: false; error: string };

export async function askOnce(args: AskArgs): Promise<AskResult> {
  const provider = args.settings.assistantProvider;
  if (provider === 'pool') return askPool(args);
  if (provider === 'claude') return askClaude(args);
  return askGemini(args);
}

async function askClaude({
  settings,
  prompt,
  system,
  maxTokens = 8_000,
  effort = 'medium',
  signal,
}: AskArgs): Promise<AskResult> {
  const resolved = await resolveAnthropicCredential();
  if ('error' in resolved) return { ok: false, error: resolved.error };
  try {
    return {
      ok: true,
      text: await claudeAsk({
        credential: resolved.credential,
        model: settings.claudeModel,
        system,
        prompt,
        maxTokens,
        effort,
        signal,
      }),
    };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

async function askGemini({
  settings,
  prompt,
  system,
  maxTokens = 8_000,
  signal,
}: AskArgs): Promise<AskResult> {
  const resolved = await resolveCredential(settings);
  if ('error' in resolved) return { ok: false, error: resolved.error };
  try {
    return {
      ok: true,
      text: await quickAsk({
        credential: resolved.credential,
        model: settings.chatModel,
        system,
        prompt,
        maxOutputTokens: maxTokens,
        signal,
      }),
    };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

async function askPool(args: AskArgs): Promise<AskResult> {
  const members = args.settings.poolMembers.filter((m) => m.enabled);
  if (!members.length) {
    return { ok: false, error: 'The free model pool is empty. Add a backend in Settings.' };
  }

  const failures: string[] = [];
  for (const member of await orderCandidates(members)) {
    if (args.signal?.aborted) break;
    const outcome = await askMember(member, args);

    if (outcome.ok && outcome.text.trim()) {
      await recordSuccess(member.id);
      await advanceCursor(members, member.id);
      return outcome;
    }

    // An empty answer is a failure too — the caller needs JSON or code back, and
    // benching the backend is what moves the next attempt somewhere useful.
    const error = outcome.ok ? 'returned nothing' : outcome.error;
    await recordFailure(member.id, {
      message: error,
      ...(outcome.ok === false && outcome.cause instanceof OpenAiError
        ? {
            retryAfterMs: outcome.cause.retryAfterMs,
            authFailure: outcome.cause.authFailure,
            network: outcome.cause.status === 0,
          }
        : {}),
    });
    failures.push(`${label(member)}: ${error}`);
  }

  return { ok: false, error: failures.join('\n') || 'No pool backend could answer.' };
}

const label = (m: PoolMember) =>
  poolMemberLabel(m, m.backend ? backendById(m.backend)?.label : undefined);

/** Carries the original error so the pool can read its `Retry-After`. */
type MemberResult = { ok: true; text: string } | { ok: false; error: string; cause?: unknown };

async function askMember(member: PoolMember, args: AskArgs): Promise<MemberResult> {
  if (member.kind === 'gemini') return askGemini(args);
  if (member.kind === 'claude') return askClaude(args);

  const resolved = await resolveBackendCredential({
    id: member.backend!,
    model: member.model,
    baseUrl: member.baseUrl,
  });
  if ('error' in resolved) return { ok: false, error: resolved.error };

  try {
    return {
      ok: true,
      text: await openAiAsk({
        credential: resolved.credential,
        system: args.system,
        prompt: args.prompt,
        maxTokens: args.maxTokens ?? 8_000,
        signal: args.signal,
      }),
    };
  } catch (e) {
    return { ok: false, error: errorMessage(e), cause: e };
  }
}
