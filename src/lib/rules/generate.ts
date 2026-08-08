import { Settings } from '../../store/settings';
import { askOnce } from '../ai/ask';
import { Source } from '../types';
import { truncate } from '../util';
import { RULE_LANGUAGE_REFERENCE, parseRule } from './parse';
import { RuleBody } from './types';

/**
 * Turns "star anything free at Salon IKSV" into a validated rule.
 *
 * The model only ever proposes; `parseRule` decides. That split is what makes
 * Layer 2 safe to hand to a model — the worst a bad proposal can do is fail
 * validation and produce an error message.
 */

const SYSTEM = [
  'You convert a plain-English automation request into a strict JSON rule.',
  'You output only JSON — no prose, no markdown fences, no explanation.',
].join(' ');

export interface GenerateRuleArgs {
  settings: Settings;
  request: string;
  sources: Source[];
  signal?: AbortSignal;
}

export interface GeneratedRule extends RuleBody {
  name: string;
  /** Set when the request named a specific watched site. */
  sourceId: string | null;
}

function buildPrompt(args: GenerateRuleArgs): string {
  const siteList = args.sources.length
    ? args.sources.map((s) => `- ${s.title} (id: ${s.id})`).join('\n')
    : '(the user watches no sites yet)';

  return [
    RULE_LANGUAGE_REFERENCE,
    '',
    "The user's watched sites:",
    siteList,
    '',
    'If the request clearly concerns one specific site, add "sourceId" with that id.',
    'Otherwise omit sourceId so the rule applies everywhere.',
    '',
    `Request: ${args.request}`,
    '',
    'Return one JSON object with keys: name, all, any, actions, and optionally sourceId.',
  ].join('\n');
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export async function generateRule(
  args: GenerateRuleArgs,
): Promise<{ ok: true; rule: GeneratedRule } | { ok: false; error: string; problems?: string[] }> {
  const prompt = buildPrompt(args);

  const asked = await askOnce({
    settings: args.settings,
    system: SYSTEM,
    prompt,
    maxTokens: 4_000,
    effort: 'medium',
    signal: args.signal,
  });
  if (!asked.ok) return { ok: false, error: asked.error };

  const raw = extractJson(asked.text);
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'The model did not return a usable rule.' };
  }

  const parsed = parseRule(raw);
  if (!parsed.ok || !parsed.rule) {
    return {
      ok: false,
      error: 'The proposed rule did not pass validation.',
      problems: parsed.problems,
    };
  }

  const obj = raw as Record<string, unknown>;
  const name =
    typeof obj.name === 'string' && obj.name.trim()
      ? truncate(obj.name.trim(), 40)
      : truncate(args.request, 40);

  // Only accept a source id that actually exists.
  const proposedSource = typeof obj.sourceId === 'string' ? obj.sourceId : null;
  const sourceId = args.sources.some((s) => s.id === proposedSource) ? proposedSource : null;

  return { ok: true, rule: { ...parsed.rule, name, sourceId } };
}
