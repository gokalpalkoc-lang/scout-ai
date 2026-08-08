import { Settings } from '../../store/settings';
import { AgentCallbacks, AgentResult } from '../ai/contract';
import { assistantSystemPrompt } from '../ai/prompt';
import { TOOL_DECLARATIONS, ToolContext, runTool } from '../gemini/tools';
import { ChatMessage, ToolTrailEntry } from '../types';
import { errorMessage, truncate } from '../util';
import { OpenAiCredential } from './auth';
import { OpenAiError, createCompletion, streamCompletion } from './client';
import { toChatTools } from './schema';
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessageParam,
  parseToolArgs,
  textOfCompletion,
  toolCallsOfCompletion,
} from './types';

/**
 * The OpenAI-compatible half of the assistant, serving every backend in the pool.
 *
 * Same shape as the Gemini and Claude loops — same tools, same callbacks, same
 * `AgentResult` — so the chat store still does not care who answered. The wire
 * differences that matter here: tool results are separate `role: "tool"`
 * messages paired by `tool_call_id`, and the assistant turn has to be echoed
 * back with its `tool_calls` intact or the pairing is rejected.
 *
 * Rounds are capped lower than on Gemini or Claude. The models in the free pool
 * are smaller, and a small model that has not converged in five rounds is
 * usually looping rather than working.
 */

const MAX_TOOL_ROUNDS = 5;

/** Chat history → `messages`, dropping errored turns. */
function historyToMessages(messages: ChatMessage[], maxTurns = 20): ChatMessageParam[] {
  return messages
    .filter((m) => !m.error && m.text.trim() && m.role !== 'system')
    .slice(-maxTurns)
    .map<ChatMessageParam>((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.text,
    }));
}

export interface OpenAiTurnArgs {
  credential: OpenAiCredential;
  settings: Settings;
  history: ChatMessage[];
  userMessage: string;
  siteCount: number;
  callbacks: AgentCallbacks;
  onDataChanged?: () => void;
  signal?: AbortSignal;
}

export async function runOpenAiTurn(args: OpenAiTurnArgs): Promise<AgentResult> {
  const { credential, settings, history, userMessage, callbacks } = args;

  const system = assistantSystemPrompt({
    siteCount: args.siteCount,
    grounding: false,
    // Module authoring asks for a whole HTML fragment; the pool's models are not
    // the right tool for it and the Studio tab says so.
    modules: false,
    terse: true,
  });

  const messages: ChatMessageParam[] = [
    { role: 'system', content: system },
    ...historyToMessages(history),
    { role: 'user', content: userMessage },
  ];

  const toolTrail: ToolTrailEntry[] = [];
  let answer = '';
  let rounds = 0;

  const toolCtx: ToolContext = {
    // Only the extraction tools need a model credential of their own, and those
    // always run on the Gemini path — see src/lib/ai/index.ts.
    credential: { provider: 'aistudio', apiKey: '' },
    settings,
    onDataChanged: args.onDataChanged,
    signal: args.signal,
  };

  const tools = toChatTools(TOOL_DECLARATIONS);

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds += 1;
    if (args.signal?.aborted) break;

    const request: Omit<ChatCompletionRequest, 'model'> = {
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.4,
      max_tokens: 4096,
    };

    let response: ChatCompletionResponse;
    try {
      response = settings.streamResponses
        ? await streamOnce({ credential, request, callbacks })
        : await createCompletion({ credential, request, signal: args.signal });
    } catch (e) {
      // The pool inspects the thrown error to decide whether another backend is
      // worth trying, so a backend failure is rethrown rather than folded into
      // an AgentResult here. Anything else is this turn's own problem.
      if (e instanceof OpenAiError) throw e;
      return { text: answer, toolTrail, grounding: [], error: errorMessage(e), rounds };
    }

    const roundText = textOfCompletion(response);
    if (roundText && !settings.streamResponses) callbacks.onText(roundText);
    if (roundText) answer += roundText;

    const calls = toolCallsOfCompletion(response);
    if (!calls.length) {
      return { text: answer.trim(), toolTrail, grounding: [], error: null, rounds };
    }

    // Echo the assistant turn back verbatim so `tool_call_id`s stay paired.
    messages.push({
      role: 'assistant',
      content: roundText || null,
      tool_calls: calls,
    });

    for (const call of calls) {
      if (args.signal?.aborted) break;
      const name = call.function?.name ?? '';
      const callArgs = parseToolArgs(call);
      callbacks.onToolStart?.(name, callArgs);

      const result = await runTool(name, callArgs, toolCtx);
      const entry: ToolTrailEntry = {
        name,
        args: callArgs,
        ok: result.ok,
        summary: result.summary,
      };
      toolTrail.push(entry);
      callbacks.onToolEnd?.(entry);

      // Unlike Anthropic, every result is its own message; a missing one for any
      // id in `tool_calls` is a hard 400 on most backends.
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: truncate(JSON.stringify(result.data), 24_000),
      });
    }

    if (answer && !answer.endsWith('\n')) {
      answer += '\n\n';
      callbacks.onText('\n\n');
    }
  }

  return {
    text: answer.trim(),
    toolTrail,
    grounding: [],
    error: answer.trim()
      ? null
      : `Stopped after ${MAX_TOOL_ROUNDS} tool rounds without reaching an answer. Try asking for one thing at a time.`,
    rounds,
  };
}

function streamOnce({
  credential,
  request,
  callbacks,
}: {
  credential: OpenAiCredential;
  request: Omit<ChatCompletionRequest, 'model'>;
  callbacks: AgentCallbacks;
}): Promise<ChatCompletionResponse> {
  return new Promise((resolve, reject) => {
    streamCompletion({
      credential,
      request,
      handlers: { onText: callbacks.onText, onDone: resolve, onError: reject },
    });
  });
}

/** One-shot generation with no tools — used by the rule author. */
export async function openAiAsk({
  credential,
  prompt,
  system,
  maxTokens = 8192,
  signal,
}: {
  credential: OpenAiCredential;
  prompt: string;
  system?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const res = await createCompletion({
    credential,
    signal,
    request: {
      messages: [
        ...(system ? [{ role: 'system' as const, content: system }] : []),
        { role: 'user' as const, content: prompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
    },
  });
  return truncate(textOfCompletion(res).trim(), 400_000);
}
