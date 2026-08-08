import { clamp, truncate } from '../util';
import {
  ACTION_TYPES,
  Action,
  Condition,
  DATE_FIELDS,
  DATE_OPS,
  DateField,
  DateOp,
  FLAG_FIELDS,
  FlagField,
  RuleBody,
  TEXT_FIELDS,
  TEXT_OPS,
  TextField,
  TextOp,
} from './types';

/**
 * Validation for model-authored rules.
 *
 * This is the trust boundary for Layer 2. The assistant proposes JSON; nothing
 * reaches the database until it survives this function. Unknown fields, unknown
 * operators, absurd numbers and empty action lists are all rejected here rather
 * than blowing up inside the engine later.
 *
 * Unparseable *conditions* are dropped individually — one bad clause should not
 * throw away a rule that is otherwise fine — but a rule with no valid action is
 * rejected outright, because a rule that does nothing is a silent no-op the user
 * would never notice.
 */

export interface ParseResult {
  ok: boolean;
  rule?: RuleBody;
  /** Human-readable problems, safe to show the user. */
  problems: string[];
}

const asString = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

const asNumber = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

function parseCondition(raw: unknown, problems: string[]): Condition | null {
  if (!raw || typeof raw !== 'object') {
    problems.push('A condition was not an object.');
    return null;
  }
  const c = raw as Record<string, unknown>;
  const field = asString(c.field);
  const op = asString(c.op);

  if (!field) {
    problems.push('A condition had no field.');
    return null;
  }

  // Text
  if ((TEXT_FIELDS as readonly string[]).includes(field)) {
    if (!op || !(TEXT_OPS as readonly string[]).includes(op)) {
      problems.push(`"${op ?? 'missing'}" is not a valid operator for ${field}.`);
      return null;
    }
    const value = asString(c.value);
    if (!value) {
      problems.push(`The condition on ${field} had no value to compare.`);
      return null;
    }
    return { kind: 'text', field: field as TextField, op: op as TextOp, value: truncate(value, 200) };
  }

  // Date
  if ((DATE_FIELDS as readonly string[]).includes(field)) {
    if (!op || !(DATE_OPS as readonly string[]).includes(op)) {
      problems.push(`"${op ?? 'missing'}" is not a valid operator for ${field}.`);
      return null;
    }
    if (op === 'withinDays' || op === 'afterDays') {
      const days = asNumber(c.days ?? c.value);
      if (days === null) {
        problems.push(`${field} ${op} needs a number of days.`);
        return null;
      }
      return {
        kind: 'date',
        field: field as DateField,
        op: op as DateOp,
        days: clamp(Math.round(days), 0, 3650),
      };
    }
    return { kind: 'date', field: field as DateField, op: op as DateOp };
  }

  // Number
  if (field === 'confidence') {
    if (op !== 'gte' && op !== 'lte') {
      problems.push('confidence only supports gte or lte.');
      return null;
    }
    const value = asNumber(c.value);
    if (value === null) {
      problems.push('The confidence condition had no numeric value.');
      return null;
    }
    return { kind: 'number', field: 'confidence', op, value: clamp(value, 0, 1) };
  }

  // Flag
  if ((FLAG_FIELDS as readonly string[]).includes(field)) {
    const value = typeof c.value === 'boolean' ? c.value : true;
    return { kind: 'flag', field: field as FlagField, value };
  }

  problems.push(`"${field}" is not a field a rule can test.`);
  return null;
}

function parseAction(raw: unknown, problems: string[]): Action | null {
  if (!raw || typeof raw !== 'object') {
    problems.push('An action was not an object.');
    return null;
  }
  const a = raw as Record<string, unknown>;
  const type = asString(a.type);
  if (!type || !(ACTION_TYPES as readonly string[]).includes(type)) {
    problems.push(`"${type ?? 'missing'}" is not an action Scout can perform.`);
    return null;
  }

  if (type === 'setCategory') {
    const value = asString(a.value);
    if (!value) {
      problems.push('setCategory needs a category name.');
      return null;
    }
    return { type: 'setCategory', value: truncate(value.toLowerCase(), 30) };
  }

  if (type === 'setReminder') {
    const days = asNumber(a.days ?? a.value);
    return { type: 'setReminder', days: clamp(Math.round(days ?? 1), 0, 365) };
  }

  if (type === 'notify') {
    const title = asString(a.title);
    return title ? { type: 'notify', title: truncate(title, 80) } : { type: 'notify' };
  }

  return { type: type as Action['type'] };
}

/** Validates a model- or user-supplied rule body. */
export function parseRule(raw: unknown): ParseResult {
  const problems: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, problems: ['The rule was not an object.'] };
  }
  const r = raw as Record<string, unknown>;

  const all = Array.isArray(r.all)
    ? (r.all.map((c) => parseCondition(c, problems)).filter(Boolean) as Condition[])
    : [];
  const any = Array.isArray(r.any)
    ? (r.any.map((c) => parseCondition(c, problems)).filter(Boolean) as Condition[])
    : [];
  const actions = Array.isArray(r.actions)
    ? (r.actions.map((a) => parseAction(a, problems)).filter(Boolean) as Action[])
    : [];

  if (!actions.length) {
    problems.push('A rule needs at least one action that Scout understands.');
    return { ok: false, problems };
  }

  // A rule with no conditions fires on every single event — almost never what
  // anyone means, and destructive with a `dismiss` action.
  if (!all.length && !any.length) {
    problems.push('A rule needs at least one condition, otherwise it matches every event.');
    return { ok: false, problems };
  }

  if (all.length + any.length > 12) {
    problems.push('A rule can test at most 12 conditions.');
    return { ok: false, problems };
  }

  return {
    ok: true,
    rule: { all, any, actions: actions.slice(0, 6) },
    problems,
  };
}

/** JSON Schema handed to the model when it authors a rule. */
export const RULE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short name for the rule, 2-40 characters.' },
    all: {
      type: 'array',
      description: 'Conditions that must ALL hold.',
      items: { type: 'object' },
    },
    any: {
      type: 'array',
      description: 'Conditions where at least ONE must hold. Usually empty.',
      items: { type: 'object' },
    },
    actions: {
      type: 'array',
      description: 'What to do when the rule matches.',
      items: { type: 'object' },
    },
  },
  required: ['name', 'actions'],
} as const;

/** Reference text describing the language, injected into the authoring prompt. */
export const RULE_LANGUAGE_REFERENCE = `
A rule is JSON: { "name": string, "all": Condition[], "any": Condition[], "actions": Action[] }

Condition is one of:
  { "field": "title"|"description"|"location"|"category"|"price"|"sourceTitle",
    "op": "contains"|"notContains"|"equals"|"startsWith", "value": string }
  { "field": "startsAt"|"deadlineAt", "op": "withinDays"|"afterDays", "days": number }
  { "field": "startsAt"|"deadlineAt", "op": "isSet"|"isNotSet" }
  { "field": "confidence", "op": "gte"|"lte", "value": number between 0 and 1 }
  { "field": "isNew"|"starred"|"hasUrl"|"allDay", "value": boolean }

Action is one of:
  { "type": "star" }
  { "type": "dismiss" }                      // hides the event
  { "type": "notify", "title": string? }
  { "type": "addToCalendar" }
  { "type": "setCategory", "value": string }
  { "type": "setReminder", "days": number }  // days before the deadline

Rules:
- At least one condition and one action. A rule with no conditions is rejected.
- Text comparisons are case-insensitive.
- Prefer "all" over "any" unless the user clearly described alternatives.
- Never combine "dismiss" with other actions.
`.trim();
