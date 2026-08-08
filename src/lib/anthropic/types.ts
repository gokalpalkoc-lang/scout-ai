/** Wire types for Anthropic's Messages API (the subset Scout uses). */

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

/** Anthropic tools take a plain JSON Schema, unlike Gemini's OpenAPI subset. */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface MessagesRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  tools?: AnthropicTool[];
  /** Adaptive thinking; `budget_tokens` is rejected on current models. */
  thinking?: { type: 'adaptive' | 'disabled'; display?: 'summarized' | 'omitted' };
  output_config?: {
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    format?: { type: 'json_schema'; schema: Record<string, unknown> };
  };
  stream?: boolean;
}

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface MessagesResponse {
  id?: string;
  type?: 'message';
  role?: 'assistant';
  model?: string;
  content: ContentBlock[];
  /** `refusal` means safety classifiers declined — check before reading content. */
  stop_reason?: 'end_turn' | 'max_tokens' | 'tool_use' | 'refusal' | 'pause_turn' | 'stop_sequence';
  stop_details?: { type?: string; category?: string | null; explanation?: string } | null;
  usage?: AnthropicUsage;
}

export interface AnthropicModelInfo {
  id: string;
  display_name: string;
  max_input_tokens?: number;
  max_tokens?: number;
}

export function isTextBlock(b: ContentBlock): b is TextBlock {
  return b.type === 'text';
}
export function isToolUseBlock(b: ContentBlock): b is ToolUseBlock {
  return b.type === 'tool_use';
}

export function textOfMessage(res: MessagesResponse): string {
  return (res.content ?? [])
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('');
}

export function toolUsesOfMessage(res: MessagesResponse): ToolUseBlock[] {
  return (res.content ?? []).filter(isToolUseBlock);
}
