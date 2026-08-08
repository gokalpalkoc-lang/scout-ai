/**
 * The rule language — Layer 2 of "the app changes itself".
 *
 * A rule is data, not code. The assistant authors one from a sentence like
 * "star anything free at Salon IKSV", and the engine in `src/lib/rules/engine.ts`
 * executes it deterministically on every new event. The model is involved when
 * the rule is *written*, never when it *runs*, which is what makes this safe:
 * a bad rule produces a wrong star, not arbitrary behaviour.
 *
 * Every field and operator below is a closed set. Anything outside it is
 * rejected by `parseRule` before it can reach the database.
 */

export const TEXT_FIELDS = [
  'title',
  'description',
  'location',
  'category',
  'price',
  'sourceTitle',
] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

export const TEXT_OPS = ['contains', 'notContains', 'equals', 'startsWith'] as const;
export type TextOp = (typeof TEXT_OPS)[number];

export const DATE_FIELDS = ['startsAt', 'deadlineAt'] as const;
export type DateField = (typeof DATE_FIELDS)[number];

export const DATE_OPS = ['withinDays', 'afterDays', 'isSet', 'isNotSet'] as const;
export type DateOp = (typeof DATE_OPS)[number];

export const FLAG_FIELDS = ['isNew', 'starred', 'hasUrl', 'allDay'] as const;
export type FlagField = (typeof FLAG_FIELDS)[number];

export interface TextCondition {
  kind: 'text';
  field: TextField;
  op: TextOp;
  /** Compared case-insensitively. */
  value: string;
}

export interface DateCondition {
  kind: 'date';
  field: DateField;
  op: DateOp;
  /** Required for withinDays / afterDays; ignored otherwise. */
  days?: number;
}

export interface NumberCondition {
  kind: 'number';
  field: 'confidence';
  op: 'gte' | 'lte';
  value: number;
}

export interface FlagCondition {
  kind: 'flag';
  field: FlagField;
  value: boolean;
}

export type Condition = TextCondition | DateCondition | NumberCondition | FlagCondition;

export const ACTION_TYPES = [
  'star',
  'dismiss',
  'notify',
  'addToCalendar',
  'setCategory',
  'setReminder',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface Action {
  type: ActionType;
  /** For setCategory. */
  value?: string;
  /** For setReminder: days before the deadline. */
  days?: number;
  /** For notify: overrides the default title. */
  title?: string;
}

export interface RuleBody {
  /** Every condition must hold. */
  all: Condition[];
  /** At least one must hold, when present. */
  any: Condition[];
  actions: Action[];
}

export interface Rule extends RuleBody {
  id: string;
  name: string;
  enabled: boolean;
  /** Lower runs first; ties broken by creation order. */
  priority: number;
  /** Restrict to one watched site, or null for all. */
  sourceId: string | null;
  /** 'user' if hand-made, 'assistant' if the model wrote it. */
  author: 'user' | 'assistant';
  createdAt: number;
  updatedAt: number;
  lastFiredAt: number | null;
  fireCount: number;
}

export type RuleDraft = Omit<
  Rule,
  'id' | 'createdAt' | 'updatedAt' | 'lastFiredAt' | 'fireCount'
>;

// ------------------------------------------------------------------ rendering

function conditionText(c: Condition): string {
  switch (c.kind) {
    case 'text': {
      const verb = {
        contains: 'contains',
        notContains: 'does not contain',
        equals: 'is exactly',
        startsWith: 'starts with',
      }[c.op];
      return `${c.field} ${verb} “${c.value}”`;
    }
    case 'date': {
      if (c.op === 'isSet') return `${c.field} is set`;
      if (c.op === 'isNotSet') return `${c.field} is missing`;
      const n = c.days ?? 0;
      return c.op === 'withinDays'
        ? `${c.field} is within ${n} day${n === 1 ? '' : 's'}`
        : `${c.field} is more than ${n} day${n === 1 ? '' : 's'} away`;
    }
    case 'number':
      return `confidence ${c.op === 'gte' ? '≥' : '≤'} ${c.value}`;
    case 'flag':
      return `${c.field} is ${c.value ? 'true' : 'false'}`;
  }
}

function actionText(a: Action): string {
  switch (a.type) {
    case 'star':
      return 'star it';
    case 'dismiss':
      return 'hide it';
    case 'notify':
      return 'send a notification';
    case 'addToCalendar':
      return 'add it to the calendar';
    case 'setCategory':
      return `set its category to “${a.value ?? ''}”`;
    case 'setReminder':
      return `remind me ${a.days ?? 1} day(s) before the deadline`;
  }
}

/** One-line plain-English summary, shown under the rule in Studio. */
export function describeRule(rule: RuleBody): string {
  const parts: string[] = [];
  if (rule.all.length) parts.push(rule.all.map(conditionText).join(' and '));
  if (rule.any.length) parts.push(`(${rule.any.map(conditionText).join(' or ')})`);
  const when = parts.length ? parts.join(' and ') : 'any new event';
  const then = rule.actions.map(actionText).join(', then ');
  return `When ${when} → ${then}`;
}
