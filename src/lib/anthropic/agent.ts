import { Settings } from '../../store/settings';
import { AgentCallbacks, AgentResult } from '../ai/contract';
import { assistantSystemPrompt } from '../ai/prompt';
import { TOOL_DECLARATIONS, ToolContext, runTool } from '../gemini/tools';
import { ChatMessage, ToolTrailEntry } from '../types';
import { errorMessage, truncate } from '../util';
import { AnthropicCredential } from './auth';
import { AnthropicError, createMessage, refusalMessage, streamMessage } from './client';
import { toAnthropicTools } from './schema';
import {
  AnthropicMessage,
  ContentBlock,
  MessagesRequest,
  MessagesResponse,
  textOfMessage,
  toolUsesOfMessage,
} from './types';

/**
 * The Claude half of the assistant.
 *
 * Deliberately the same shape as `src/lib/gemini/agent.ts` — same tools, same
 * callbacks, same `AgentResult` — so the chat store does not care which provider
 * is active. Only the wire format differs: Anthropic pairs `tool_use` blocks with
 * `tool_result` blocks by id, where Gemini uses positional `functionResponse`
 * parts.
 */

const MAX_TOOL_ROUNDS = 8;

/** Chat history → Anthropic `messages`, dropping errored turns. */
function historyToMessages(messages: ChatMessage[], maxTurns = 24): AnthropicMessage[] {
  return messages
    .filter((m) => !m.error && m.text.trim() && m.role !== 'system')
    .slice(-maxTurns)
    .map<AnthropicMessage>((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.text,
    }));
}

export interface AnthropicTurnArgs {
  credential: AnthropicCredential;
  settings: Settings;
  history: ChatMessage[];
  userMessage: string;
  siteCount: number;
  callbacks: AgentCallbacks;
  onDataChanged?: () => void;
  signal?: AbortSignal;
}

export async function runAnthropicTurn(args: AnthropicTurnArgs): Promise<AgentResult> {
  const { credential, settings, history, userMessage, callbacks } = args;

  const messages: AnthropicMessage[] = [
    ...historyToMessages(history),
    { role: 'user', content: userMessage },
  ];

  const toolTrail: ToolTrailEntry[] = [];
  let answer = '';
  let rounds = 0;

  const toolCtx: ToolContext = {
    // The tool layer only needs a credential for tools that call a model
    // themselves (page extraction), and those always run on the Gemini path.
    credential: { provider: 'aistudio', apiKey: '' },
    settings,
    onDataChanged: args.onDataChanged,
    signal: args.signal,
  };

  const tools = toAnthropicTools(TOOL_DECLARATIONS);

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds += 1;
    if (args.signal?.aborted) break;

    const request: MessagesRequest = {
      model: settings.claudeModel,
      max_tokens: settings.streamResponses ? 32_000 : 16_000,
      system: assistantSystemPrompt({
        siteCount: args.siteCount,
        // Claude has no Google Search grounding; read_url is the only way out.
        grounding: false,
        modules: true,
      }),
      messages,
      tools,
      thinking: { type: 'adaptive' },
      output_config: { effort: settings.claudeEffort },
    };

    let response: MessagesResponse;
    try {
      response = settings.streamResponses
        ? await streamOnce({ credential, request, callbacks })
        : await createMessage({ credential, request, signal: args.signal });
    } catch (e) {
      const message = e instanceof AnthropicError ? e.message : errorMessage(e);
      return { text: answer, toolTrail, grounding: [], error: message, rounds };
    }

    // Safety classifiers can decline with HTTP 200 and empty content.
    const refusal = refusalMessage(response);
    if (refusal) {
      return { text: answer, toolTrail, grounding: [], error: refusal, rounds };
    }

    const roundText = textOfMessage(response);
    if (roundText && !settings.streamResponses) callbacks.onText(roundText);
    if (roundText) answer += roundText;

    const toolUses = toolUsesOfMessage(response);
    if (!toolUses.length) {
      return { text: answer.trim(), toolTrail, grounding: [], error: null, rounds };
    }

    // Echo the assistant turn back verbatim so tool_use ids stay paired.
    messages.push({ role: 'assistant', content: response.content });

    const results: ContentBlock[] = [];
    for (const use of toolUses) {
      if (args.signal?.aborted) break;
      const callArgs = (use.input ?? {}) as Record<string, unknown>;
      callbacks.onToolStart?.(use.name, callArgs);

      const result = await runTool(use.name, callArgs, toolCtx);
      const entry: ToolTrailEntry = {
        name: use.name,
        args: callArgs,
        ok: result.ok,
        summary: result.summary,
      };
      toolTrail.push(entry);
      callbacks.onToolEnd?.(entry);

      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: JSON.stringify(result.data),
        ...(result.ok ? {} : { is_error: true }),
      });
    }
    // All results for one assistant turn go back in a single user message.
    messages.push({ role: 'user', content: results });

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
  credential: AnthropicCredential;
  request: MessagesRequest;
  callbacks: AgentCallbacks;
}): Promise<MessagesResponse> {
  return new Promise((resolve, reject) => {
    streamMessage({
      credential,
      request,
      handlers: { onText: callbacks.onText, onDone: resolve, onError: reject },
    });
  });
}

/** One-shot generation with no tools — used by the module and rule authors. */
export async function claudeAsk({
  credential,
  model,
  prompt,
  system,
  maxTokens = 16_000,
  effort = 'high',
  signal,
}: {
  credential: AnthropicCredential;
  model: string;
  prompt: string;
  system?: string;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  signal?: AbortSignal;
}): Promise<string> {
  const res = await createMessage({
    credential,
    signal,
    request: {
      model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
      thinking: { type: 'adaptive' },
      output_config: { effort },
    },
  });

  const refusal = refusalMessage(res);
  if (refusal) throw new AnthropicError(refusal, 200, 'REFUSAL');
  return truncate(textOfMessage(res).trim(), 400_000);
}
