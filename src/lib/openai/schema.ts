import { toParameterSchema } from '../ai/jsonSchema';
import { FunctionDeclaration } from '../gemini/types';
import { ChatTool } from './types';

/**
 * Scout's canonical tool declarations → OpenAI `tools`.
 *
 * The schema translation itself is shared with the Anthropic path in
 * `src/lib/ai/jsonSchema.ts`; only the envelope differs.
 */
export function toChatTool(declaration: FunctionDeclaration): ChatTool {
  return {
    type: 'function',
    function: {
      name: declaration.name,
      description: declaration.description,
      parameters: toParameterSchema(declaration),
    },
  };
}

export function toChatTools(declarations: FunctionDeclaration[]): ChatTool[] {
  return declarations.map(toChatTool);
}
