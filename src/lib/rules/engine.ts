import { Settings } from '../../store/settings';
import { exportEvent } from '../calendar';
import { updateEvent } from '../db/events';
import * as notify from '../notify';
import { EventItem, Source } from '../types';
import { errorMessage, truncate } from '../util';
import { daysUntil } from '../util/date';
import { Condition, Rule } from './types';

/**
 * Executes rules against newly stored events.
 *
 * Deterministic and model-free: the assistant may have *written* the rule, but
 * this code decides what happens, so the worst outcome of a bad rule is a wrong
 * star rather than arbitrary behaviour. Runs from `checkSource` right after the
 * upsert, on `created` events only — re-running on every existing event would
 * fight the user's manual stars and dismissals forever.
 */

export interface RuleFiring {
  ruleId: string;
  ruleName: string;
  eventId: string;
  eventTitle: string;
  actions: string[];
}

export interface RuleRunResult {
  firings: RuleFiring[];
  errors: string[];
}

const norm = (s: string | null | undefined): string => (s ?? '').toLowerCase();

function textValue(event: EventItem, field: string, sourceTitle: string | null): string {
  switch (field) {
    case 'title':
      return norm(event.title);
    case 'description':
      return norm(event.description);
    case 'location':
      return norm(event.location);
    case 'category':
      return norm(event.category);
    case 'price':
      return norm(event.price);
    case 'sourceTitle':
      return norm(sourceTitle);
    default:
      return '';
  }
}

export function conditionMatches(
  condition: Condition,
  event: EventItem,
  sourceTitle: string | null,
): boolean {
  switch (condition.kind) {
    case 'text': {
      const haystack = textValue(event, condition.field, sourceTitle);
      const needle = condition.value.toLowerCase();
      switch (condition.op) {
        case 'contains':
          return haystack.includes(needle);
        case 'notContains':
          return !haystack.includes(needle);
        case 'equals':
          return haystack === needle;
        case 'startsWith':
          return haystack.startsWith(needle);
      }
      return false;
    }
    case 'date': {
      const iso = condition.field === 'startsAt' ? event.startsAt : event.deadlineAt;
      if (condition.op === 'isSet') return !!iso;
      if (condition.op === 'isNotSet') return !iso;
      const days = daysUntil(iso);
      if (days === null) return false;
      // Past dates never satisfy a forward-looking window.
      if (condition.op === 'withinDays') return days >= 0 && days <= (condition.days ?? 0);
      return days > (condition.days ?? 0);
    }
    case 'number':
      return condition.op === 'gte'
        ? event.confidence >= condition.value
        : event.confidence <= condition.value;
    case 'flag': {
      const actual =
        condition.field === 'isNew'
          ? event.isNew
          : condition.field === 'starred'
            ? event.starred
            : condition.field === 'hasUrl'
              ? !!event.url
              : event.allDay;
      return actual === condition.value;
    }
  }
}

export function ruleMatches(rule: Rule, event: EventItem, sourceTitle: string | null): boolean {
  if (rule.sourceId && rule.sourceId !== event.sourceId) return false;
  if (!rule.all.every((c) => conditionMatches(c, event, sourceTitle))) return false;
  if (rule.any.length && !rule.any.some((c) => conditionMatches(c, event, sourceTitle))) {
    return false;
  }
  return true;
}

/**
 * Applies every enabled rule to a batch of new events.
 *
 * `silent` suppresses notify actions — used by manual "check now", where the UI
 * already reports the outcome, and by the rule previewer.
 */
export async function applyRules(
  rules: Rule[],
  events: EventItem[],
  sources: Source[],
  settings: Settings,
  opts: { silent?: boolean } = {},
): Promise<RuleRunResult> {
  const active = rules
    .filter((r) => r.enabled)
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);

  const result: RuleRunResult = { firings: [], errors: [] };
  if (!active.length || !events.length) return result;

  const titleOf = new Map(sources.map((s) => [s.id, s.title]));

  for (const event of events) {
    // Mutated as actions apply, so later rules see earlier rules' effects.
    let current = { ...event };
    const sourceTitle = current.sourceId ? (titleOf.get(current.sourceId) ?? null) : null;

    for (const rule of active) {
      if (!ruleMatches(rule, current, sourceTitle)) continue;

      const applied: string[] = [];
      for (const action of rule.actions) {
        try {
          switch (action.type) {
            case 'star':
              await updateEvent(current.id, { starred: true });
              current = { ...current, starred: true };
              applied.push('starred');
              break;

            case 'dismiss':
              await updateEvent(current.id, { dismissed: true, isNew: false });
              current = { ...current, dismissed: true, isNew: false };
              applied.push('hidden');
              break;

            case 'setCategory':
              if (action.value) {
                await updateEvent(current.id, { category: action.value });
                current = { ...current, category: action.value };
                applied.push(`category → ${action.value}`);
              }
              break;

            case 'notify':
              if (!opts.silent && settings.notifyNewEvents) {
                await notify.notifyNewEvents(
                  action.title ?? rule.name,
                  current.sourceId ?? 'rule',
                  [current],
                );
                applied.push('notified');
              }
              break;

            case 'addToCalendar':
              if (!current.calendarEventId && current.startsAt) {
                const res = await exportEvent(current, { sourceLabel: sourceTitle ?? undefined });
                if (res.ok) {
                  current = { ...current, calendarEventId: res.calendarEventId ?? null };
                  applied.push('added to calendar');
                } else if (res.error) {
                  result.errors.push(`${rule.name}: ${res.error}`);
                }
              }
              break;

            case 'setReminder': {
              if (!current.deadlineAt) break;
              const id = await notify.scheduleDeadlineReminder(current, action.days ?? 1);
              if (id) {
                await notify.cancel(current.reminderId);
                await updateEvent(current.id, { reminderId: id });
                current = { ...current, reminderId: id };
                applied.push(`reminder ${action.days ?? 1}d before`);
              }
              break;
            }
          }
        } catch (e) {
          result.errors.push(`${rule.name}: ${errorMessage(e)}`);
        }
      }

      if (applied.length) {
        result.firings.push({
          ruleId: rule.id,
          ruleName: rule.name,
          eventId: current.id,
          eventTitle: truncate(current.title, 60),
          actions: applied,
        });
      }

      // A dismissed event is out of play; stop evaluating further rules for it.
      if (current.dismissed) break;
    }
  }

  return result;
}

/**
 * Dry run: which of these events would a rule match, and what would it do?
 * Nothing is written — this backs the "Test rule" button and lets the assistant
 * show its work before the user enables anything.
 */
export function previewRule(
  rule: Rule,
  events: EventItem[],
  sources: Source[],
): { matched: EventItem[]; wouldDo: string[] } {
  const titleOf = new Map(sources.map((s) => [s.id, s.title]));
  const matched = events.filter((e) =>
    ruleMatches(rule, e, e.sourceId ? (titleOf.get(e.sourceId) ?? null) : null),
  );
  const wouldDo = rule.actions.map((a) =>
    a.type === 'setCategory'
      ? `set category to ${a.value}`
      : a.type === 'setReminder'
        ? `set a reminder ${a.days ?? 1} day(s) before the deadline`
        : a.type,
  );
  return { matched, wouldDo };
}
