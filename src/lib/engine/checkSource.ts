import { Settings, readSettings, writeSettings } from '../../store/settings';
import { queryEvents, updateEvent, upsertEvents } from '../db/events';
import {
  getSnapshot,
  getSource,
  listDueSources,
  listSources,
  recordCheck,
  saveSnapshot,
  updateSource,
} from '../db/sources';
import { listRules, recordFirings } from '../db/rules';
import { ChangeVerdict, extractEvents, summarizeChange } from '../extract';
import { applyRules } from '../rules/engine';
import { Credential, resolveCredential } from '../gemini/auth';
import { GeminiError } from '../gemini/client';
import * as notify from '../notify';
import { EventItem, Source } from '../types';
import { errorMessage } from '../util';
import { parseEventDate } from '../util/date';
import { FetchError, diffText, fetchPage } from '../web/fetchPage';

/**
 * One place where a "check" is defined, so a manual tap, a background wake and
 * an assistant tool call all behave identically.
 *
 * The sequence is deliberately cheap-first: fetch, hash, and only spend a
 * Gemini request when the page actually changed or has never been extracted.
 * That keeps a watchlist of twenty pages affordable on the free tier.
 */

export type CheckTrigger = 'manual' | 'background' | 'routine' | 'assistant';

export interface CheckOutcome {
  sourceId: string;
  sourceTitle: string;
  ok: boolean;
  /** Page content changed since the previous snapshot. */
  changed: boolean;
  /** Events stored for the first time on this run. */
  newEvents: EventItem[];
  totalEvents: number;
  /** Present when the page changed and the change was judged. */
  change: ChangeVerdict | null;
  note: string;
  error: string | null;
  durationMs: number;
  /** True when nothing was spent because the page was byte-identical. */
  skippedExtraction: boolean;
  /** How many rule actions fired on this run. */
  ruleFirings: number;
}

export interface CheckOptions {
  trigger: CheckTrigger;
  /** Extract even when the hash is unchanged. */
  force?: boolean;
  /** Suppress notifications (used by the "check now" button — the UI shows it). */
  silent?: boolean;
  settings?: Settings;
  credential?: Credential;
  signal?: AbortSignal;
}

export async function checkSource(sourceId: string, options: CheckOptions): Promise<CheckOutcome> {
  const started = Date.now();
  const settings = options.settings ?? (await readSettings());

  const source = await getSource(sourceId);
  if (!source) {
    return fail(sourceId, 'Unknown source', 'That source no longer exists.', started);
  }

  const credential =
    options.credential ??
    (await (async () => {
      const resolved = await resolveCredential(settings);
      return 'credential' in resolved ? resolved.credential : null;
    })());

  if (!credential) {
    const message = 'No usable Gemini credential. Add an API key in Settings.';
    await updateSource(source.id, {
      lastCheckedAt: Date.now(),
      lastStatus: 'error',
      lastError: message,
    });
    await record(source, 'error', false, 0, 0, started, message, options.trigger);
    return fail(source.id, source.title, message, started);
  }

  // ------------------------------------------------------------------- fetch
  let fetched;
  try {
    fetched = await fetchPage(source.url);
  } catch (e) {
    const message =
      e instanceof FetchError ? e.message : `Could not fetch the page: ${errorMessage(e)}`;
    await updateSource(source.id, {
      lastCheckedAt: Date.now(),
      lastStatus: 'error',
      lastError: message,
    });
    await record(source, 'error', false, 0, 0, started, message, options.trigger);
    if (settings.notifyErrors && !options.silent) {
      await notify.notifyError(`${source.title} check failed`, message);
    }
    return fail(source.id, source.title, message, started);
  }

  const previous = await getSnapshot(source.id);
  const changed = !previous || previous.hash !== fetched.hash;
  const firstEverCheck = !previous;

  // A byte-identical page needs no model call at all.
  if (!changed && !options.force) {
    await updateSource(source.id, {
      lastCheckedAt: Date.now(),
      lastStatus: 'ok',
      lastError: null,
    });
    await record(source, 'ok', false, 0, 0, started, 'No change', options.trigger);
    return {
      sourceId: source.id,
      sourceTitle: source.title,
      ok: true,
      changed: false,
      newEvents: [],
      totalEvents: 0,
      change: null,
      note: 'No change since the last check.',
      error: null,
      durationMs: Date.now() - started,
      skippedExtraction: true,
      ruleFirings: 0,
    };
  }

  const wantsEvents = source.mode === 'events' || source.mode === 'both';
  const wantsChanges = source.mode === 'changes' || source.mode === 'both';

  let newEvents: EventItem[] = [];
  let totalEvents = 0;
  let note = '';
  let verdict: ChangeVerdict | null = null;
  let ruleFirings = 0;
  const problems: string[] = [];

  // ----------------------------------------------------------------- extract
  if (wantsEvents) {
    try {
      const result = await extractEvents({
        credential,
        model: settings.extractModel,
        page: fetched,
        hint: source.hint,
        horizonDays: settings.horizonDays,
        signal: options.signal,
      });

      const keep = result.events.filter((e) => e.confidence >= settings.minConfidence);
      totalEvents = keep.length;
      note = result.note;

      const { created } = await upsertEvents(source.id, keep);

      // On a first check the whole page is "new"; announcing 40 events as fresh
      // finds would be noise, so they are recorded but not flagged.
      if (firstEverCheck) {
        for (const e of created) await updateEvent(e.id, { isNew: false });
      } else {
        newEvents = created;
      }

      if (settings.autoDeadlineReminders) {
        await scheduleRemindersFor(created, settings);
      }

      // Rules run on newly stored events only. Re-running them over the whole
      // table would fight the user's own stars and dismissals on every check.
      if (created.length) {
        try {
          const rules = await listRules();
          if (rules.some((r) => r.enabled)) {
            const outcome = await applyRules(rules, created, await listSources(), settings, {
              silent: options.silent,
            });
            if (outcome.firings.length) {
              const counts = new Map<string, number>();
              for (const f of outcome.firings) {
                counts.set(f.ruleId, (counts.get(f.ruleId) ?? 0) + 1);
              }
              await recordFirings(counts);
              ruleFirings = outcome.firings.length;
            }
            problems.push(...outcome.errors);
          }
        } catch (e) {
          problems.push(`Rules failed: ${errorMessage(e)}`);
        }
      }
    } catch (e) {
      const message =
        e instanceof GeminiError ? e.message : `Event extraction failed: ${errorMessage(e)}`;
      problems.push(message);
    }
  }

  // ------------------------------------------------------------ change digest
  if (wantsChanges && changed && previous) {
    const diff = diffText(previous.text, fetched.page.text);
    if (diff.changed) {
      try {
        verdict = await summarizeChange({
          credential,
          model: settings.extractModel,
          title: source.title,
          url: source.url,
          diff,
          signal: options.signal,
        });
      } catch (e) {
        problems.push(`Change summary failed: ${errorMessage(e)}`);
      }
    }
  }

  await saveSnapshot(source.id, fetched.page.text, fetched.hash);

  const hardFailure = problems.length > 0 && totalEvents === 0 && !verdict;
  const summaryLine =
    verdict?.headline ||
    note ||
    (newEvents.length ? `${newEvents.length} new` : changed ? 'Page changed' : 'No change');

  await updateSource(source.id, {
    lastCheckedAt: Date.now(),
    lastStatus: hardFailure ? 'error' : 'ok',
    lastError: hardFailure ? problems[0] : null,
    contentHash: fetched.hash,
    lastSummary: summaryLine,
  });

  await record(
    source,
    hardFailure ? 'error' : 'ok',
    changed,
    newEvents.length,
    totalEvents,
    started,
    problems[0] ?? summaryLine,
    options.trigger,
  );

  // ------------------------------------------------------------ notifications
  if (!options.silent && source.notify) {
    if (settings.notifyNewEvents && newEvents.length) {
      await notify.notifyNewEvents(source.title, source.id, newEvents);
    }
    // Don't double-notify: a "3 new events" alert already covers the change.
    if (
      settings.notifyChanges &&
      verdict?.significant &&
      !(settings.notifyNewEvents && newEvents.length)
    ) {
      await notify.notifyChange(source.title, source.id, verdict.headline, verdict.detail);
    }
    if (settings.notifyErrors && hardFailure) {
      await notify.notifyError(`${source.title} check failed`, problems[0]);
    }
  }

  return {
    sourceId: source.id,
    sourceTitle: source.title,
    ok: !hardFailure,
    changed,
    newEvents,
    totalEvents,
    change: verdict,
    note: problems[0] ?? note ?? summaryLine,
    error: hardFailure ? problems[0] : null,
    durationMs: Date.now() - started,
    skippedExtraction: false,
    ruleFirings,
  };
}

function fail(
  sourceId: string,
  sourceTitle: string,
  error: string,
  started: number,
): CheckOutcome {
  return {
    sourceId,
    sourceTitle,
    ok: false,
    changed: false,
    newEvents: [],
    totalEvents: 0,
    change: null,
    note: error,
    error,
    durationMs: Date.now() - started,
    skippedExtraction: false,
    ruleFirings: 0,
  };
}

async function record(
  source: Source,
  status: 'ok' | 'error' | 'skipped',
  changed: boolean,
  newEvents: number,
  totalEvents: number,
  started: number,
  note: string | null,
  trigger: CheckTrigger,
): Promise<void> {
  await recordCheck({
    sourceId: source.id,
    ranAt: Date.now(),
    status,
    changed,
    newEvents,
    totalEvents,
    durationMs: Date.now() - started,
    note,
    trigger,
  });
}

/** Books reminders for any newly stored event that carries a deadline. */
async function scheduleRemindersFor(events: EventItem[], settings: Settings): Promise<void> {
  for (const event of events) {
    const deadline = parseEventDate(event.deadlineAt);
    if (!deadline || deadline.getTime() < Date.now()) continue;
    // One reminder per event: the earliest lead time that is still in the future.
    const lead = [...settings.deadlineReminderDays]
      .sort((a, b) => b - a)
      .find((d) => deadline.getTime() - d * 86_400_000 > Date.now());
    if (lead === undefined) continue;
    const id = await notify.scheduleDeadlineReminder(event, lead);
    if (id) await updateEvent(event.id, { reminderId: id });
  }
}

// ------------------------------------------------------------------- sweeping

export interface SweepResult {
  checked: number;
  skipped: number;
  newEvents: number;
  changedPages: number;
  errors: { title: string; error: string }[];
  durationMs: number;
}

/**
 * Runs every due source, in sequence.
 *
 * Sequential on purpose: parallel requests would trip the free-tier rate limit
 * and drain the battery during a background wake, and a watchlist check is
 * never latency-critical.
 */
export async function sweep(
  options: {
    trigger: CheckTrigger;
    /** Cap the number of sources touched in one pass. */
    limit?: number;
    /** Check everything, not only what is due. */
    all?: boolean;
    silent?: boolean;
    onProgress?: (done: number, total: number, current: string) => void;
    signal?: AbortSignal;
  },
): Promise<SweepResult> {
  const started = Date.now();
  const settings = await readSettings();
  const resolved = await resolveCredential(settings);

  if ('error' in resolved) {
    return {
      checked: 0,
      skipped: 0,
      newEvents: 0,
      changedPages: 0,
      errors: [{ title: 'Gemini', error: resolved.error }],
      durationMs: Date.now() - started,
    };
  }

  const candidates = options.all
    ? (await listSources()).filter((s) => s.enabled)
    : await listDueSources();
  const targets = options.limit ? candidates.slice(0, options.limit) : candidates;

  const result: SweepResult = {
    checked: 0,
    skipped: 0,
    newEvents: 0,
    changedPages: 0,
    errors: [],
    durationMs: 0,
  };

  for (const [index, source] of targets.entries()) {
    if (options.signal?.aborted) break;
    options.onProgress?.(index, targets.length, source.title);

    const outcome = await checkSource(source.id, {
      trigger: options.trigger,
      silent: options.silent,
      settings,
      credential: resolved.credential,
      signal: options.signal,
    });

    if (outcome.skippedExtraction) result.skipped += 1;
    result.checked += 1;
    result.newEvents += outcome.newEvents.length;
    if (outcome.changed) result.changedPages += 1;
    if (outcome.error) result.errors.push({ title: source.title, error: outcome.error });
  }

  options.onProgress?.(targets.length, targets.length, '');

  if (options.trigger === 'background') {
    await writeSettings({ lastBackgroundRunAt: Date.now() });
  } else {
    await writeSettings({ lastForegroundSweepAt: Date.now() });
  }

  result.durationMs = Date.now() - started;
  return result;
}

/** Count of sources whose interval has elapsed — drives the "N due" badge. */
export async function dueCount(): Promise<number> {
  return (await listDueSources()).length;
}

/** Re-books deadline reminders, e.g. after the lead times change in Settings. */
export async function rebuildDeadlineReminders(): Promise<number> {
  const settings = await readSettings();
  const events = await queryEvents({ onlyDeadlines: true, limit: 500 });
  let booked = 0;

  for (const event of events) {
    await notify.cancel(event.reminderId);
    await updateEvent(event.id, { reminderId: null });
  }
  if (!settings.autoDeadlineReminders) return 0;

  for (const event of events) {
    const deadline = parseEventDate(event.deadlineAt);
    if (!deadline || deadline.getTime() < Date.now()) continue;
    const lead = [...settings.deadlineReminderDays]
      .sort((a, b) => b - a)
      .find((d) => deadline.getTime() - d * 86_400_000 > Date.now());
    if (lead === undefined) continue;
    const id = await notify.scheduleDeadlineReminder(event, lead);
    if (id) {
      await updateEvent(event.id, { reminderId: id });
      booked += 1;
    }
  }
  return booked;
}
