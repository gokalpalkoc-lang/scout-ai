/**
 * Wire types for the OpenAI Chat Completions API (the subset Scout uses).
 *
 * One set of types covers every backend in `catalog.ts` — Groq, Cerebras,
 * OpenRouter, Mistral, GitHub Models and any self-hosted server — because they
 * all speak this shape. Where they differ is in which optional fields they
 * honour, so nothing here is required beyond what all of them accept.
 */

export interface ChatToolCall {
  /** Absent on some backends until the call completes; the agent tolerates it. */
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessageParam {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** `null` on an assistant turn that is nothing but tool calls. */
  content?: string | null;
  tool_calls?: ChatToolCall[];
  /** Pairs a `tool` message with the `tool_calls[].id` it answers. */
  tool_call_id?: string;
}

export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessageParam[];
  tools?: ChatTool[];
  tool_choice?: 'auto' | 'none' | 'required';
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  /** Groq and OpenRouter report usage on the final SSE frame when asked. */
  stream_options?: { include_usage?: boolean };
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatChoice {
  index?: number;
  message?: ChatMessageParam;
  /** Streaming only — the incremental half of `message`. */
  delta?: {
    role?: string;
    content?: string | null;
    tool_calls?: {
      index?: number;
      id?: string;
      type?: 'function';
      function?: { name?: string; arguments?: string };
    }[];
  };
  finish_reason?: string | null;
}

export interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: ChatChoice[];
  usage?: ChatUsage;
  /** Some OpenAI-compatible servers return errors with HTTP 200. */
  error?: { message?: string; type?: string; code?: string | number };
}

export interface OpenAiModelInfo {
  id: string;
  /** OpenRouter and GitHub Models supply a friendly name; most others do not. */
  displayName: string;
  contextLength?: number;
}

/** Concatenates assistant text from a non-streaming response. */
export function textOfCompletion(res: ChatCompletionResponse): string {
  const content = res.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

export function toolCallsOfCompletion(res: ChatCompletionResponse): ChatToolCall[] {
  return res.choices?.[0]?.message?.tool_calls ?? [];
}

/**
 * Parses a tool call's arguments.
 *
 * Weaker models emit invalid JSON here often enough that it has to be a normal
 * outcome rather than an exception: an empty object reaches the dispatcher,
 * which reports a usable error the model can correct on the next round.
 */
export function parseToolArgs(call: ChatToolCall): Record<string, unknown> {
  const raw = call.function?.arguments?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
