/** Wire types for the Gemini `generateContent` REST API (subset we use). */

export interface TextPart {
  text: string;
}
export interface FunctionCallPart {
  functionCall: { name: string; args?: Record<string, unknown> };
}
export interface FunctionResponsePart {
  functionResponse: { name: string; response: Record<string, unknown> };
}

export type Part = TextPart | FunctionCallPart | FunctionResponsePart;

export interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  /** OpenAPI-subset schema. Omit entirely for a no-argument tool. */
  parameters?: SchemaNode;
}

export interface SchemaNode {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  nullable?: boolean;
  enum?: string[];
  format?: string;
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  propertyOrdering?: string[];
}

export interface Tool {
  functionDeclarations?: FunctionDeclaration[];
  /** Built-in Google Search grounding. */
  googleSearch?: Record<string, never>;
  urlContext?: Record<string, never>;
}

export interface GenerationConfig {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
  responseSchema?: SchemaNode;
  stopSequences?: string[];
  thinkingConfig?: { thinkingBudget?: number; includeThoughts?: boolean };
}

export interface GenerateContentRequest {
  contents: Content[];
  tools?: Tool[];
  toolConfig?: { functionCallingConfig?: { mode?: 'AUTO' | 'ANY' | 'NONE'; allowedFunctionNames?: string[] } };
  systemInstruction?: { parts: TextPart[] };
  generationConfig?: GenerationConfig;
  safetySettings?: { category: string; threshold: string }[];
}

export interface GroundingChunk {
  web?: { uri?: string; title?: string };
}

export interface Candidate {
  content?: Content;
  finishReason?: string;
  groundingMetadata?: {
    groundingChunks?: GroundingChunk[];
    webSearchQueries?: string[];
  };
}

export interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
}

export interface GenerateContentResponse {
  candidates?: Candidate[];
  usageMetadata?: UsageMetadata;
  promptFeedback?: { blockReason?: string };
}

export interface ModelInfo {
  /** Full resource name, e.g. "models/gemini-2.5-flash". */
  name: string;
  /** Bare id, e.g. "gemini-2.5-flash". */
  id: string;
  displayName: string;
  description: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
  supportedActions: string[];
}

export function isTextPart(p: Part): p is TextPart {
  return typeof (p as TextPart).text === 'string';
}
export function isFunctionCallPart(p: Part): p is FunctionCallPart {
  return !!(p as FunctionCallPart).functionCall;
}

/** Concatenates all text parts of the first candidate. */
export function textOf(res: GenerateContentResponse): string {
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter(isTextPart)
    .map((p) => p.text)
    .join('');
}

export function functionCallsOf(res: GenerateContentResponse) {
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  return parts.filter(isFunctionCallPart).map((p) => p.functionCall);
}

export function groundingOf(res: GenerateContentResponse) {
  const chunks = res.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  return chunks
    .map((c) => ({ title: c.web?.title ?? '', uri: c.web?.uri ?? '' }))
    .filter((r) => !!r.uri);
}
