import { Settings } from '../../store/settings';
import { AgentCallbacks, AgentResult } from '../ai/contract';
import { ChatMessage, GroundingRef, ToolTrailEntry } from '../types';
import { errorMessage, truncate } from '../util';
import { nowContextLine } from '../util/date';
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

function systemPrompt(settings: Settings, siteCount: number): string {
  return [
    'You are Scout, a personal assistant living inside a mobile app. Your speciality is watching',
    'websites for events and keeping the user ahead of dates and deadlines, but you help with',
    'ordinary questions and routine tasks too.',
    '',
    `Context: it is ${nowContextLine()}. The user currently watches ${siteCount} website(s).`,
    '',
    'How to work:',
    '- Prefer acting over asking. If the user says "watch this page" or "check my sites", use the tools.',
    '- Never claim you checked, saved, scheduled or added something unless a tool call actually did it.',
    '- Use search_events before answering questions about what is coming up; do not answer from memory.',
    '- When you need a page\'s contents, call read_url or scan_url_for_events. You cannot browse otherwise.',
    '- Ask for a URL when the user names a site you do not have. Do not guess at addresses.',
    '- Confirm before anything destructive: removing a watched site, dismissing many events, deleting routines.',
    '',
    'How to write:',
    '- Mobile screen. Short paragraphs, no preamble, no restating the question.',
    '- Lead with the answer. Use "- " bullets for lists of events, with the date first.',
    '- Bold sparingly with **, for names and dates. No tables, no headings above ###.',
    '- Be specific about dates: "Sat 14 Sep, 20:30", not "next Saturday".',
    '- If a tool failed, say plainly what failed and what the user can do about it.',
    settings.webGrounding
      ? '- Google Search is available for general questions. Prefer the app\'s own tools for anything about the user\'s sites or events.'
      : '- You have no web search. Use read_url for specific pages, and say so if you cannot verify something.',
  ].join('\n');
}

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
      systemInstruction: { parts: [{ text: systemPrompt(settings, args.siteCount) }] },
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
