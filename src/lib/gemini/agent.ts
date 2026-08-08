import { Settings } from '../../store/settings';
import { AgentCallbacks, AgentResult } from '../ai/contract';
import { assistantSystemPrompt } from '../ai/prompt';
import { ChatMessage, GroundingRef, ToolTrailEntry } from '../types';
import { errorMessage, truncate } from '../util';
import { Credential } from './auth';
import { GeminiError, generateContent, streamGenerateContent } from './client';
import { TOOL_DECLARATIONS, ToolContext, runTool } from './tools';
import {
  Content,
  GenerateContentRequest,
  GenerateContentResponse,
  Part,
  Tool,
  functionCallsOf,
  groundingOf,
  textOf,
} from './types';

/**
 * The assistant loop: prompt → optional tool calls → answer.
 *
 * Tool rounds and the final answer both stream, so the user sees the model
 * working rather than a spinner. The loop is bounded and every tool result is
 * fed back verbatim, which keeps a wrong tool call recoverable instead of fatal.
 */

const MAX_TOOL_ROUNDS = 6;

/** Chat history → Gemini `contents`, dropping errored turns. */
export function historyToContents(messages: ChatMessage[], maxTurns = 24): Content[] {
  const usable = messages.filter((m) => !m.error && m.text.trim() && m.role !== 'system');
  return usable.slice(-maxTurns).map<Content>((m) => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.text }],
  }));
}

// The callback and result shapes are shared with the Claude provider so the chat
// store does not care which one is active — see src/lib/ai/contract.ts.
export type { AgentCallbacks, AgentResult } from '../ai/contract';

export interface AgentRunArgs {
  credential: Credential;
  settings: Settings;
  /** Conversation so far, excluding the message being answered. */
  history: ChatMessage[];
  userMessage: string;
  siteCount: number;
  callbacks: AgentCallbacks;
  onDataChanged?: () => void;
  signal?: AbortSignal;
}

export async function runAgentTurn(args: AgentRunArgs): Promise<AgentResult> {
  const { credential, settings, history, userMessage, callbacks } = args;

  const contents: Content[] = [
    ...historyToContents(history),
    { role: 'user', parts: [{ text: userMessage }] },
  ];

  const toolTrail: ToolTrailEntry[] = [];
  const grounding: GroundingRef[] = [];
  let answer = '';
  let rounds = 0;

  const toolCtx: ToolContext = {
    credential,
    settings,
    onDataChanged: args.onDataChanged,
    signal: args.signal,
  };

  const tools: Tool[] = [{ functionDeclarations: TOOL_DECLARATIONS }];
  // Grounding and function calling can be combined; if the API rejects the
  // pairing we retry without grounding rather than failing the turn.
  let allowGrounding = settings.webGrounding;

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds += 1;
    if (args.signal?.aborted) break;

    const request: GenerateContentRequest = {
      systemInstruction: {
        parts: [
          {
            text: assistantSystemPrompt({
              siteCount: args.siteCount,
              grounding: allowGrounding,
              modules: true,
            }),
          },
        ],
      },
      contents,
      tools: allowGrounding ? [...tools, { googleSearch: {} }] : tools,
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 8192,
      },
    };

    let response: GenerateContentResponse;
    try {
      response = settings.streamResponses
        ? await streamOnce({ credential, model: settings.chatModel, request, callbacks })
        : await generateContent({ credential, model: settings.chatModel, request, signal: args.signal });
    } catch (e) {
      // A model or endpoint that refuses google_search alongside tools.
      if (allowGrounding && e instanceof GeminiError && e.status === 400) {
        allowGrounding = false;
        rounds -= 1;
        continue;
      }
      const message = e instanceof GeminiError ? e.message : errorMessage(e);
      return { text: answer, toolTrail, grounding, error: message, rounds };
    }

    grounding.push(...groundingOf(response));

    const calls = functionCallsOf(response);
    const roundText = textOf(response);

    // Non-streaming mode has not emitted anything yet.
    if (roundText && !settings.streamResponses) callbacks.onText(roundText);
    if (roundText) answer += roundText;

    if (!calls.length) {
      return {
        text: answer.trim(),
        toolTrail,
        grounding: dedupeGrounding(grounding),
        error: null,
        rounds,
      };
    }

    // Echo the model's turn back so it can see its own tool requests.
    const modelParts: Part[] = [];
    if (roundText) modelParts.push({ text: roundText });
    for (const call of calls) modelParts.push({ functionCall: call });
    contents.push({ role: 'model', parts: modelParts });

    const responseParts: Part[] = [];
    for (const call of calls) {
      if (args.signal?.aborted) break;
      const callArgs = (call.args ?? {}) as Record<string, unknown>;
      callbacks.onToolStart?.(call.name, callArgs);

      const result = await runTool(call.name, callArgs, toolCtx);
      const entry: ToolTrailEntry = {
        name: call.name,
        args: callArgs,
        ok: result.ok,
        summary: result.summary,
      };
      toolTrail.push(entry);
      callbacks.onToolEnd?.(entry);

      responseParts.push({
        functionResponse: { name: call.name, response: result.data },
      });
    }
    contents.push({ role: 'user', parts: responseParts });

    // A blank line keeps streamed prose readable across tool rounds.
    if (answer && !answer.endsWith('\n')) {
      answer += '\n\n';
      callbacks.onText('\n\n');
    }
  }

  return {
    text: answer.trim(),
    toolTrail,
    grounding: dedupeGrounding(grounding),
    error: answer.trim()
      ? null
      : `Stopped after ${MAX_TOOL_ROUNDS} tool rounds without reaching an answer. Try asking for one thing at a time.`,
    rounds,
  };
}

/** Promise wrapper around the callback-based streaming client. */
function streamOnce({
  credential,
  model,
  request,
  callbacks,
}: {
  credential: Credential;
  model: string;
  request: GenerateContentRequest;
  callbacks: AgentCallbacks;
}): Promise<GenerateContentResponse> {
  return new Promise((resolve, reject) => {
    streamGenerateContent({
      credential,
      model,
      request,
      handlers: {
        onText: callbacks.onText,
        onDone: resolve,
        onError: reject,
      },
    });
  });
}

function dedupeGrounding(refs: GroundingRef[]): GroundingRef[] {
  const seen = new Set<string>();
  const out: GroundingRef[] = [];
  for (const r of refs) {
    if (!r.uri || seen.has(r.uri)) continue;
    seen.add(r.uri);
    out.push({ title: truncate(r.title || r.uri, 90), uri: r.uri });
  }
  return out.slice(0, 8);
}

/**
 * One-shot generation with no tools and no history — used by routines that just
 * need text back, and by the "suggest a hint" helper on the source editor.
 */
export async function quickAsk({
  credential,
  model,
  prompt,
  system,
  maxOutputTokens = 4096,
  signal,
}: {
  credential: Credential;
  model: string;
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const res = await generateContent({
    credential,
    model,
    signal,
    request: {
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens },
    },
  });
  return textOf(res).trim();
}
