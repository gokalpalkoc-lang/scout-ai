import { GroundingRef, ToolTrailEntry } from '../types';

/**
 * The contract both providers implement.
 *
 * Extracted into its own module so `src/lib/gemini` and `src/lib/anthropic` can
 * each depend on it without depending on each other — importing the Gemini agent
 * from the Anthropic one would drag Gemini's whole wire layer into every bundle
 * path and make the two providers circular.
 */

export interface AgentCallbacks {
  /** Streamed text of the answer. */
  onText: (delta: string) => void;
  /** A tool is about to run — lets the UI show "Checking Salon IKSV…". */
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  onToolEnd?: (entry: ToolTrailEntry) => void;
}

export interface AgentResult {
  text: string;
  toolTrail: ToolTrailEntry[];
  /** Web-search citations. Gemini-only; always empty on Claude. */
  grounding: GroundingRef[];
  /** Set when the turn ended badly; `text` then holds a user-facing message. */
  error: string | null;
  rounds: number;
}

export type AssistantProvider = 'gemini' | 'claude';

export const PROVIDER_LABELS: Record<AssistantProvider, string> = {
  gemini: 'Gemini',
  claude: 'Claude',
};
