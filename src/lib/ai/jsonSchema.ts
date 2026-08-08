import { FunctionDeclaration, SchemaNode } from '../gemini/types';

/**
 * Gemini's OpenAPI-subset schema → plain JSON Schema.
 *
 * The 24 tools are declared once, in Gemini's shape, in `src/lib/gemini/tools.ts`.
 * Every other provider wants JSON Schema: Anthropic under `input_schema`, the
 * OpenAI-compatible backends under `function.parameters`. Translating in one
 * place is what keeps a third and fourth provider from each growing their own
 * copy of the declarations.
 *
 * The differences that matter: `propertyOrdering` is Gemini-only, and `nullable`
 * becomes a union with `"null"`.
 */
export function toJsonSchema(node: SchemaNode): Record<string, unknown> {
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

/** The object schema for a tool's arguments — `{}` for a no-argument tool. */
export function toParameterSchema(declaration: FunctionDeclaration): {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
} {
  const params = declaration.parameters;
  if (!params || params.type !== 'object') {
    return { type: 'object', properties: {} };
  }

  const converted = toJsonSchema(params);
  return {
    type: 'object',
    properties: (converted.properties as Record<string, unknown>) ?? {},
    ...(Array.isArray(converted.required) ? { required: converted.required as string[] } : {}),
  };
}
