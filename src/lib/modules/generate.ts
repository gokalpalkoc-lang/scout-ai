import { Settings } from '../../store/settings';
import { askOnce } from '../ai/ask';
import { truncate } from '../util';
import { inferCapabilities } from './bridge';
import { MODULE_API_REFERENCE } from './sandbox';
import { Capability, Module } from './types';

/**
 * Turns a request in plain English into a runnable module.
 *
 * This is the "evolve on command" path. The generated fragment is real code, so
 * it is treated as untrusted input: `validateFragment` rejects anything that
 * tries to reach the network or escape the sandbox *before* it is stored, and the
 * CSP in `sandbox.ts` would block those attempts even if validation missed one.
 * Belt and braces, because the alternative is model output executing unchecked.
 */

const SYSTEM = [
  'You write small, self-contained web panels for a mobile app. You output code only.',
  'You never explain, never apologise, and never wrap output in markdown fences.',
  'Your panels are focused, readable on a phone, and handle empty data gracefully.',
].join(' ');

export interface GeneratedModule {
  name: string;
  description: string;
  icon: string;
  fragment: string;
  capabilities: Capability[];
}

export interface GenerateArgs {
  settings: Settings;
  /** What the user asked for, in their words. */
  request: string;
  /** Present when revising: the current code to improve rather than replace. */
  existing?: { name: string; fragment: string };
  signal?: AbortSignal;
}

/** Patterns that mean the fragment is trying to leave its sandbox. */
const FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bfetch\s*\(/i, reason: 'calls fetch()' },
  { pattern: /XMLHttpRequest/i, reason: 'uses XMLHttpRequest' },
  { pattern: /\bWebSocket\b/i, reason: 'opens a WebSocket' },
  { pattern: /\bimportScripts\b/i, reason: 'calls importScripts()' },
  { pattern: /<script[^>]+\bsrc\s*=/i, reason: 'loads an external script' },
  { pattern: /<iframe\b/i, reason: 'embeds an iframe' },
  { pattern: /https?:\/\/(?!localhost)/i, reason: 'references a remote URL' },
  { pattern: /\bnew\s+Function\s*\(/i, reason: 'builds code with new Function()' },
  { pattern: /\beval\s*\(/i, reason: 'calls eval()' },
  { pattern: /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/i, reason: 'uses browser storage instead of scout.call("storage.set")' },
  { pattern: /<!doctype|<html\b|<head\b|<body\b/i, reason: 'emits a full document instead of a body fragment' },
];

export interface ValidationResult {
  ok: boolean;
  problems: string[];
  /** Cleaned fragment, with any stray markdown fence removed. */
  fragment: string;
}

export function validateFragment(raw: string): ValidationResult {
  const problems: string[] = [];

  // Models occasionally wrap code in a fence despite being told not to.
  let fragment = raw.trim();
  const fenced = /^```(?:html|xml)?\s*\n([\s\S]*?)\n?```$/.exec(fragment);
  if (fenced) fragment = fenced[1].trim();

  if (fragment.length < 20) problems.push('The generated panel was empty.');
  if (fragment.length > 200_000) problems.push('The generated panel was too large (200KB limit).');

  for (const { pattern, reason } of FORBIDDEN) {
    if (pattern.test(fragment)) problems.push(`The panel ${reason}, which the sandbox forbids.`);
  }

  return { ok: problems.length === 0, problems, fragment };
}

function buildPrompt(args: GenerateArgs): string {
  const parts: string[] = [MODULE_API_REFERENCE, ''];

  if (args.existing) {
    parts.push(
      `You are REVISING an existing panel called "${args.existing.name}".`,
      'Here is its current code:',
      '---',
      args.existing.fragment,
      '---',
      `The user wants this change: ${args.request}`,
      'Return the complete revised body fragment, not a diff.',
    );
  } else {
    parts.push(`Build a panel that does this: ${args.request}`);
  }

  parts.push(
    '',
    'Respond with exactly two sections and nothing else:',
    'META: {"name": "...", "description": "...", "icon": "..."}',
    'CODE:',
    '<the body fragment>',
    '',
    'The name is 2-4 words. The description is one sentence. The icon is an Ionicons',
    'outline name such as calendar-outline, bar-chart-outline, list-outline, pricetag-outline,',
    'time-outline, alarm-outline, cash-outline, location-outline or sparkles-outline.',
  );

  return parts.join('\n');
}

interface ParsedOutput {
  name: string;
  description: string;
  icon: string;
  fragment: string;
}

/** Splits the META/CODE reply, tolerating the model drifting from the format. */
export function parseGeneratorOutput(text: string, fallbackName: string): ParsedOutput {
  const codeIndex = text.search(/^\s*CODE:\s*$/m);
  const metaMatch = /META:\s*(\{[\s\S]*?\})/.exec(codeIndex >= 0 ? text.slice(0, codeIndex) : text);

  let name = fallbackName;
  let description = '';
  let icon = 'cube-outline';

  if (metaMatch) {
    try {
      const meta = JSON.parse(metaMatch[1]) as Record<string, unknown>;
      if (typeof meta.name === 'string' && meta.name.trim()) name = truncate(meta.name.trim(), 40);
      if (typeof meta.description === 'string') description = truncate(meta.description.trim(), 160);
      if (typeof meta.icon === 'string' && /^[a-z0-9-]+$/.test(meta.icon.trim())) {
        icon = meta.icon.trim();
      }
    } catch {
      // Keep the fallbacks; the code matters more than the label.
    }
  }

  const fragment =
    codeIndex >= 0
      ? text.slice(codeIndex).replace(/^\s*CODE:\s*/m, '').trim()
      : // No CODE marker: assume everything after the meta object is the fragment.
        (metaMatch ? text.slice(text.indexOf(metaMatch[0]) + metaMatch[0].length) : text).trim();

  return { name, description, icon, fragment };
}

/** Generates (or revises) a module using whichever provider is configured. */
export async function generateModule(
  args: GenerateArgs,
): Promise<{ ok: true; module: GeneratedModule } | { ok: false; error: string; problems?: string[] }> {
  const prompt = buildPrompt(args);

  const asked = await askOnce({
    settings: args.settings,
    system: SYSTEM,
    prompt,
    maxTokens: 24_000,
    // Writing working code from a one-line brief benefits from the headroom.
    effort: 'high',
    signal: args.signal,
  });
  if (!asked.ok) return { ok: false, error: asked.error };
  if (!asked.text.trim()) return { ok: false, error: 'The model returned nothing.' };

  const parsed = parseGeneratorOutput(asked.text, args.existing?.name ?? 'New panel');
  const validation = validateFragment(parsed.fragment);

  if (!validation.ok) {
    return {
      ok: false,
      error: 'The generated panel was rejected by the sandbox checks.',
      problems: validation.problems,
    };
  }

  return {
    ok: true,
    module: {
      name: parsed.name,
      description: parsed.description,
      icon: parsed.icon,
      fragment: validation.fragment,
      capabilities: inferCapabilities(validation.fragment),
    },
  };
}

/** Summary line shown in the module list. */
export function moduleSummary(module: Module): string {
  const caps = module.capabilities.length;
  return [
    `v${module.version}`,
    caps ? `${caps} permission${caps === 1 ? '' : 's'}` : 'no permissions',
  ].join(' · ');
}
