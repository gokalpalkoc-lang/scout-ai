import { FunctionDeclaration, SchemaNode } from '../gemini/types';
import { AnthropicTool } from './types';

/**
 * Converts Scout's tool declarations to Anthropic's format.
 *
 * The 17 tools in `src/lib/gemini/tools.ts` are declared once in Gemini's
 * OpenAPI-subset shape. Anthropic takes plain JSON Schema, so rather than
 * maintaining two copies of every declaration (which would drift), the
 * declarations stay canonical and get translated here.
 *
 * The differences that matter: `propertyOrdering` is Gemini-only, and `nullable`
 * becomes a union with `"null"`.
 */
function toJsonSchema(node: SchemaNode): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: node.nullable ? [node.type, 'null'] : node.type,
  };

  if (node.description) out.description = node.description;
  if (node.enum?.length) out.enum = node.enum;
  if (node.format) out.format = node.format;
  if (node.items) out.items = toJsonSchema(node.items);

  if (node.properties) {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.properties)) {
      properties[key] = toJsonSchema(value);
    }
    out.properties = properties;
  }
  if (node.required?.length) out.required = node.required;

  return out;
}

/** An Anthropic tool always needs an object schema, even for a no-arg tool. */
export function toAnthropicTool(declaration: FunctionDeclaration): AnthropicTool {
  const params = declaration.parameters;

  if (!params || params.type !== 'object') {
    return {
      name: declaration.name,
      description: declaration.description,
      input_schema: { type: 'object', properties: {} },
    };
  }

  const converted = toJsonSchema(params);
  return {
    name: declaration.name,
    description: declaration.description,
    input_schema: {
      type: 'object',
      properties: (converted.properties as Record<string, unknown>) ?? {},
      ...(Array.isArray(converted.required) ? { required: converted.required as string[] } : {}),
    },
  };
}

export function toAnthropicTools(declarations: FunctionDeclaration[]): AnthropicTool[] {
  return declarations.map(toAnthropicTool);
}

/** Same conversion for structured-output schemas (module and rule authoring). */
export function toResponseJsonSchema(node: SchemaNode): Record<string, unknown> {
  return toJsonSchema(node);
}
