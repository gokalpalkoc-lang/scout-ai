import { toJsonSchema, toParameterSchema } from '../ai/jsonSchema';
import { FunctionDeclaration, SchemaNode } from '../gemini/types';
import { AnthropicTool } from './types';

/**
 * Scout's canonical tool declarations → Anthropic's format.
 *
 * The conversion itself lives in `src/lib/ai/jsonSchema.ts` because the
 * OpenAI-compatible backends need exactly the same translation; this module is
 * only the Anthropic-shaped wrapper around it.
 */

/** An Anthropic tool always needs an object schema, even for a no-arg tool. */
export function toAnthropicTool(declaration: FunctionDeclaration): AnthropicTool {
  return {
    name: declaration.name,
    description: declaration.description,
    input_schema: toParameterSchema(declaration),
  };
}

export function toAnthropicTools(declarations: FunctionDeclaration[]): AnthropicTool[] {
  return declarations.map(toAnthropicTool);
}

/** Same conversion for structured-output schemas (module and rule authoring). */
export function toResponseJsonSchema(node: SchemaNode): Record<string, unknown> {
  return toJsonSchema(node);
}
