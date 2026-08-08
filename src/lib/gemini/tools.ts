import { Settings } from '../../store/settings';
import { exportEvent } from '../calendar';
import {
  createManualEvent,
  eventStats,
  getEvent,
  queryEvents,
  updateEvent,
  upcomingDeadlines,
  upsertEvents,
} from '../db/events';
import {
  createSource,
  deleteSource,
  findSourceByUrl,
  getSource,
  listChecks,
  listSources,
  updateSource,
} from '../db/sources';
import { createModule, listModules, reviseModule } from '../db/modules';
import { createRoutine, deleteRoutine, listRoutines } from '../db/routines';
import { createRule, deleteRule, listRules, updateRule } from '../db/rules';
import { generateModule } from '../modules/generate';
import { previewRule } from '../rules/engine';
import { generateRule } from '../rules/generate';
import { describeRule } from '../rules/types';
import { checkSource, sweep } from '../engine/checkSource';
import { extractEvents } from '../extract';
import { scheduleDeadlineReminder } from '../notify';
import { EventItem, Source, WatchMode } from '../types';
import { clamp, errorMessage, hostOf, normalizeUrl, titleFromUrl, truncate } from '../util';
import { formatEventDate, relative } from '../util/date';
import { fetchPage } from '../web/fetchPage';
import { Credential } from './auth';
import { FunctionDeclaration } from './types';

/**
 * The assistant's hands.
 *
 * Each declaration is written for the model to read: the description says when
 * to reach for the tool, not just what it does. Every handler returns a plain
 * object — small, already-formatted, and safe to show in the activity trail.
 */

export interface ToolContext {
  credential: Credential;
  settings: Settings;
  /** Lets the UI refresh lists after a tool mutates data. */
  onDataChanged?: () => void;
  signal?: AbortSignal;
}

export interface ToolResult {
  /** Payload handed back to the model. */
  data: Record<string, unknown>;
  /** One line for the user-facing activity trail. */
  summary: string;
  ok: boolean;
}

type Handler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

// ------------------------------------------------------------------- helpers

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
};
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

function ok(summary: string, data: Record<string, unknown> = {}): ToolResult {
  return { ok: true, summary, data: { ok: true, ...data } };
}
function err(summary: string, data: Record<string, unknown> = {}): ToolResult {
  return { ok: false, summary, data: { ok: false, error: summary, ...data } };
}

/** Trimmed event shape for the model: enough to reason with, no noise. */
function eventForModel(e: EventItem) {
  return {
    id: e.id,
    title: e.title,
    when: e.startsAt ? formatEventDate(e.startsAt) : 'date unknown',
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    location: e.location,
    price: e.price,
    category: e.category,
    url: e.url,
    deadlineAt: e.deadlineAt,
    deadlineLabel: e.deadlineLabel,
    isNew: e.isNew,
    starred: e.starred,
    inCalendar: !!e.calendarEventId,
    description: e.description ? truncate(e.description, 260) : null,
  };
}

function sourceForModel(s: Source) {
  return {
    id: s.id,
    title: s.title,
    url: s.url,
    mode: s.mode,
    category: s.category,
    hint: s.hint,
    everyMinutes: s.intervalMin,
    enabled: s.enabled,
    lastChecked: s.lastCheckedAt ? relative(s.lastCheckedAt) : 'never',
    lastStatus: s.lastStatus,
    lastError: s.lastError,
    lastSummary: s.lastSummary,
  };
}

/** Resolves a source from an id, a URL or a fuzzy title match. */
async function resolveSource(args: Record<string, unknown>): Promise<Source | null> {
  const id = str(args.sourceId ?? args.id);
  if (id) {
    const byId = await getSource(id);
    if (byId) return byId;
  }
  const url = str(args.url);
  if (url) {
    const normalized = normalizeUrl(url);
    if (normalized) {
      const byUrl = await findSourceByUrl(normalized);
      if (byUrl) return byUrl;
    }
  }
  const name = str(args.title ?? args.name ?? args.sourceId ?? args.id);
  if (name) {
    const all = await listSources();
    const needle = name.toLowerCase();
    return (
      all.find((s) => s.title.toLowerCase() === needle) ??
      all.find((s) => s.title.toLowerCase().includes(needle)) ??
      all.find((s) => s.url.toLowerCase().includes(needle)) ??
      null
    );
  }
  return null;
}

// -------------------------------------------------------------- declarations

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'list_watched_sites',
    description:
      'List the websites the user has Scout watching, with when each was last checked and what it found. Call this before answering anything about "my sites" or "what am I tracking".',
  },
  {
    name: 'add_watched_site',
    description:
      'Start watching a website for events or changes. Use when the user names a URL they want tracked. If they only describe a site without a URL, ask them for the link first.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full page URL to watch.' },
        title: { type: 'string', description: 'Short label, e.g. "Salon IKSV". Derived from the domain if omitted.' },
        mode: {
          type: 'string',
          description:
            'events = pull event listings out of the page; changes = tell me when the page changes; both = do both. Default both.',
          enum: ['events', 'changes', 'both'],
        },
        category: { type: 'string', description: 'Optional grouping label, e.g. "music", "work", "university".' },
        hint: {
          type: 'string',
          description:
            'Instruction for the extractor, e.g. "only the concerts section" or "ignore past events". Pass the user\'s own words.',
        },
        everyMinutes: { type: 'integer', description: 'Check interval in minutes. Minimum 15, default 720 (twice a day).' },
        checkNow: { type: 'boolean', description: 'Run the first check immediately. Default true.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'update_watched_site',
    description:
      'Change a watched site: rename it, pause or resume it, adjust the interval, change the mode, or set the extraction hint.',
    parameters: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Id, URL or name of the site.' },
        title: { type: 'string' },
        mode: { type: 'string', enum: ['events', 'changes', 'both'] },
        category: { type: 'string' },
        hint: { type: 'string' },
        everyMinutes: { type: 'integer' },
        enabled: { type: 'boolean', description: 'False pauses checking without deleting anything.' },
        notify: { type: 'boolean', description: 'Whether this site may raise notifications.' },
      },
      required: ['sourceId'],
    },
  },
  {
    name: 'remove_watched_site',
    description:
      'Stop watching a site and delete the events found through it. Confirm with the user before calling this.',
    parameters: {
      type: 'object',
      properties: { sourceId: { type: 'string', description: 'Id, URL or name of the site.' } },
      required: ['sourceId'],
    },
  },
  {
    name: 'check_site_now',
    description:
      'Fetch a watched site right now, extract events and report what is new. Use for "check X", "anything new on X", "refresh X".',
    parameters: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Id, URL or name of the site. Omit to check every site that is due.' },
        force: { type: 'boolean', description: 'Re-extract even if the page has not changed.' },
      },
    },
  },
  {
    name: 'scan_url_for_events',
    description:
      'Fetch any URL once and pull the events out of it, without adding it to the watchlist. Use for "what is on at this link" or to preview a page before watching it. Set save=true to keep the events.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Page to read.' },
        hint: { type: 'string', description: 'What to focus on, in the user\'s words.' },
        save: { type: 'boolean', description: 'Store the events in the user\'s agenda. Default false.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'read_url',
    description:
      'Fetch a page and return its readable text, for questions the page answers that are not events (opening hours, prices, rules, contact details).',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        maxChars: { type: 'integer', description: 'Excerpt size, default 8000, maximum 40000.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'search_events',
    description:
      'Search the events Scout has already collected. Use for "what is on this weekend", "any concerts in October", "show me deadlines".',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text matched against title, description and location.' },
        from: { type: 'string', description: 'Earliest start date, YYYY-MM-DD.' },
        to: { type: 'string', description: 'Latest start date, YYYY-MM-DD.' },
        onlyNew: { type: 'boolean', description: 'Only events the user has not seen yet.' },
        onlyStarred: { type: 'boolean' },
        onlyDeadlines: { type: 'boolean', description: 'Only items that carry a deadline.' },
        includePast: { type: 'boolean' },
        limit: { type: 'integer', description: 'Default 30, maximum 100.' },
      },
    },
  },
  {
    name: 'save_event',
    description:
      'Add an event by hand, for something the user tells you about directly rather than something found on a page.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        startsAt: { type: 'string', description: 'YYYY-MM-DD or YYYY-MM-DDTHH:mm.' },
        endsAt: { type: 'string' },
        location: { type: 'string' },
        url: { type: 'string' },
        price: { type: 'string' },
        category: { type: 'string' },
        description: { type: 'string' },
        deadlineAt: { type: 'string', description: 'Registration cutoff, YYYY-MM-DD.' },
        deadlineLabel: { type: 'string' },
      },
      required: ['title', 'startsAt'],
    },
  },
  {
    name: 'update_event',
    description: 'Star, unstar, dismiss or correct an event that is already saved.',
    parameters: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        starred: { type: 'boolean' },
        dismissed: { type: 'boolean', description: 'True hides it from the agenda.' },
        title: { type: 'string' },
        startsAt: { type: 'string' },
        location: { type: 'string' },
        deadlineAt: { type: 'string' },
        notes: { type: 'string', description: 'Replaces the description.' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'add_event_to_calendar',
    description:
      'Put a saved event into the phone calendar. Ask first unless the user clearly asked for it.',
    parameters: {
      type: 'object',
      properties: { eventId: { type: 'string' } },
      required: ['eventId'],
    },
  },
  {
    name: 'remind_me',
    description:
      'Schedule a one-off reminder ahead of an event deadline. For repeating reminders use create_routine instead.',
    parameters: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        daysBefore: { type: 'integer', description: 'How many days before the deadline. 0 means on the day.' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'list_routines',
    description: 'List the user\'s scheduled routines and when each last ran.',
  },
  {
    name: 'create_routine',
    description:
      'Create a scheduled routine. check_all re-checks every watched site; digest sends a summary of what is coming up; prompt runs an instruction you write and notifies the result.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name shown in the app.' },
        kind: { type: 'string', enum: ['check_all', 'digest', 'prompt'] },
        prompt: { type: 'string', description: 'Required for kind=prompt: the instruction to run each time.' },
        scheduleKind: { type: 'string', enum: ['daily', 'weekly', 'interval'] },
        hour: { type: 'integer', description: '0–23, local time.' },
        minute: { type: 'integer', description: '0–59.' },
        weekday: { type: 'integer', description: 'For weekly: 1 = Sunday … 7 = Saturday.' },
        everyMinutes: { type: 'integer', description: 'For interval schedules. Minimum 15.' },
      },
      required: ['name', 'kind'],
    },
  },
  {
    name: 'delete_routine',
    description: 'Delete a routine by id or name.',
    parameters: {
      type: 'object',
      properties: { routineId: { type: 'string' } },
      required: ['routineId'],
    },
  },
  {
    name: 'list_rules',
    description:
      'List the automation rules that run on newly found events (star, hide, notify, categorise, remind).',
  },
  {
    name: 'create_rule',
    description:
      'Create an automation from a plain-English description, e.g. "star anything free at Salon IKSV" or "remind me 3 days before any abstract deadline". The rule then runs by itself on every new event. Describe what the user asked for in your own words and Scout builds and validates it.',
    parameters: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: "The automation in one sentence, in the user's own terms.",
        },
        enabled: { type: 'boolean', description: 'Turn it on immediately. Default true.' },
      },
      required: ['request'],
    },
  },
  {
    name: 'update_rule',
    description: 'Enable, disable or rename an existing rule.',
    parameters: {
      type: 'object',
      properties: {
        ruleId: { type: 'string', description: 'Id or name of the rule.' },
        enabled: { type: 'boolean' },
        name: { type: 'string' },
      },
      required: ['ruleId'],
    },
  },
  {
    name: 'delete_rule',
    description: 'Delete an automation rule. Confirm with the user first.',
    parameters: {
      type: 'object',
      properties: { ruleId: { type: 'string' } },
      required: ['ruleId'],
    },
  },
  {
    name: 'list_modules',
    description:
      "List the custom panels ('modules') that have been built for this app, with their version and permissions.",
  },
  {
    name: 'create_module',
    description:
      "Build a new panel for the app from a description — a chart, a table, a checklist, a different view of the agenda. Use this when the user asks the app to gain a feature, e.g. 'add a panel showing which venues post most often' or 'build me a weekly overview'. The panel is real code that runs on the device and persists.",
    parameters: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description:
            "What the panel should do and show, in as much detail as the user gave. Include any specific numbers, groupings or ordering they mentioned.",
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'revise_module',
    description:
      "Change an existing panel — fix it, restyle it, or add to it. The previous version is kept so it can be rolled back.",
    parameters: {
      type: 'object',
      properties: {
        moduleId: { type: 'string', description: 'Id or name of the panel.' },
        request: { type: 'string', description: 'What should change.' },
      },
      required: ['moduleId', 'request'],
    },
  },
  {
    name: 'get_overview',
    description:
      'Snapshot of the whole app: counts of events, what is new, upcoming deadlines, sites due for a check, and any sites erroring. Call this for "what should I know" or "give me a status".',
  },
  {
    name: 'get_site_history',
    description: 'Recent check history for one site — useful when the user asks why a site is failing.',
    parameters: {
      type: 'object',
      properties: { sourceId: { type: 'string' } },
      required: ['sourceId'],
    },
  },
];

// ------------------------------------------------------------------ handlers

const handlers: Record<string, Handler> = {
  async list_watched_sites() {
    const sources = await listSources();
    return ok(
      sources.length ? `Read ${sources.length} watched site${sources.length === 1 ? '' : 's'}` : 'No sites watched yet',
      { count: sources.length, sites: sources.map(sourceForModel) },
    );
  },

  async add_watched_site(args, ctx) {
    const rawUrl = str(args.url);
    if (!rawUrl) return err('No URL given');
    const url = normalizeUrl(rawUrl);
    if (!url) return err(`"${rawUrl}" is not a usable URL`);

    const existing = await findSourceByUrl(url);
    if (existing) {
      return ok(`Already watching ${existing.title}`, {
        alreadyWatched: true,
        site: sourceForModel(existing),
      });
    }

    const modeArg = str(args.mode);
    const mode: WatchMode =
      modeArg === 'events' || modeArg === 'changes' || modeArg === 'both' ? modeArg : 'both';

    const source = await createSource({
      url,
      title: str(args.title) ?? titleFromUrl(url),
      category: str(args.category),
      mode,
      hint: str(args.hint),
      intervalMin: clamp(num(args.everyMinutes) ?? ctx.settings.defaultCheckIntervalMin, 15, 20_160),
      enabled: true,
      notify: true,
    });
    ctx.onDataChanged?.();

    if (bool(args.checkNow) !== false) {
      const outcome = await checkSource(source.id, {
        trigger: 'assistant',
        silent: true,
        settings: ctx.settings,
        credential: ctx.credential,
        signal: ctx.signal,
      });
      ctx.onDataChanged?.();
      return ok(`Watching ${source.title} — first check found ${outcome.totalEvents} event(s)`, {
        site: sourceForModel(source),
        firstCheck: {
          ok: outcome.ok,
          eventsFound: outcome.totalEvents,
          note: outcome.note,
          error: outcome.error,
        },
      });
    }

    return ok(`Now watching ${source.title}`, { site: sourceForModel(source) });
  },

  async update_watched_site(args, ctx) {
    const source = await resolveSource(args);
    if (!source) return err('Could not find that site in the watchlist');

    const patch: Partial<Source> = {};
    const title = str(args.title);
    if (title) patch.title = title;
    const mode = str(args.mode);
    if (mode === 'events' || mode === 'changes' || mode === 'both') patch.mode = mode;
    if ('category' in args) patch.category = str(args.category);
    if ('hint' in args) patch.hint = str(args.hint);
    const every = num(args.everyMinutes);
    if (every !== null) patch.intervalMin = clamp(every, 15, 20_160);
    const enabled = bool(args.enabled);
    if (enabled !== null) patch.enabled = enabled;
    const notify = bool(args.notify);
    if (notify !== null) patch.notify = notify;

    if (!Object.keys(patch).length) return err('Nothing to change was specified');

    await updateSource(source.id, patch);
    ctx.onDataChanged?.();
    const fresh = await getSource(source.id);
    return ok(`Updated ${fresh?.title ?? source.title}`, {
      site: fresh ? sourceForModel(fresh) : null,
      changed: Object.keys(patch),
    });
  },

  async remove_watched_site(args, ctx) {
    const source = await resolveSource(args);
    if (!source) return err('Could not find that site in the watchlist');
    await deleteSource(source.id);
    ctx.onDataChanged?.();
    return ok(`Removed ${source.title}`, { removed: source.title });
  },

  async check_site_now(args, ctx) {
    const wantsAll = !str(args.sourceId ?? args.url ?? args.title);

    if (wantsAll) {
      const result = await sweep({
        trigger: 'assistant',
        all: bool(args.force) === true,
        silent: true,
        signal: ctx.signal,
      });
      ctx.onDataChanged?.();
      return ok(
        `Checked ${result.checked} site(s): ${result.newEvents} new event(s)`,
        {
          checked: result.checked,
          unchanged: result.skipped,
          newEvents: result.newEvents,
          changedPages: result.changedPages,
          errors: result.errors,
        },
      );
    }

    const source = await resolveSource(args);
    if (!source) return err('Could not find that site in the watchlist');

    const outcome = await checkSource(source.id, {
      trigger: 'assistant',
      force: bool(args.force) === true,
      silent: true,
      settings: ctx.settings,
      credential: ctx.credential,
      signal: ctx.signal,
    });
    ctx.onDataChanged?.();

    return outcome.ok
      ? ok(
          outcome.skippedExtraction
            ? `${source.title}: no change`
            : `${source.title}: ${outcome.newEvents.length} new, ${outcome.totalEvents} total`,
          {
            site: source.title,
            changed: outcome.changed,
            unchanged: outcome.skippedExtraction,
            newEvents: outcome.newEvents.map(eventForModel),
            totalEventsOnPage: outcome.totalEvents,
            changeSummary: outcome.change?.headline ?? null,
            note: outcome.note,
          },
        )
      : err(`${source.title}: ${outcome.error}`, { site: source.title });
  },

  async scan_url_for_events(args, ctx) {
    const rawUrl = str(args.url);
    if (!rawUrl) return err('No URL given');
    const url = normalizeUrl(rawUrl);
    if (!url) return err(`"${rawUrl}" is not a usable URL`);

    try {
      const page = await fetchPage(url);
      const result = await extractEvents({
        credential: ctx.credential,
        model: ctx.settings.extractModel,
        page,
        hint: str(args.hint),
        horizonDays: ctx.settings.horizonDays,
        signal: ctx.signal,
      });

      const keep = result.events.filter((e) => e.confidence >= ctx.settings.minConfidence);
      let savedIds: string[] = [];

      if (bool(args.save) === true && keep.length) {
        const { created } = await upsertEvents(null, keep);
        savedIds = created.map((e) => e.id);
        ctx.onDataChanged?.();
      }

      return ok(`Scanned ${hostOf(url)} — ${keep.length} event(s)`, {
        url: page.finalUrl,
        pageTitle: page.page.title,
        pageKind: result.pageKind,
        note: result.note,
        saved: savedIds.length,
        events: keep.slice(0, 40).map((e) => ({
          title: e.title,
          startsAt: e.startsAt,
          location: e.location,
          url: e.url,
          price: e.price,
          category: e.category,
          deadlineAt: e.deadlineAt,
          confidence: e.confidence,
        })),
      });
    } catch (e) {
      return err(`Could not scan ${hostOf(url)}: ${errorMessage(e)}`);
    }
  },

  async read_url(args) {
    const rawUrl = str(args.url);
    if (!rawUrl) return err('No URL given');
    const url = normalizeUrl(rawUrl);
    if (!url) return err(`"${rawUrl}" is not a usable URL`);

    try {
      const page = await fetchPage(url);
      const limit = clamp(num(args.maxChars) ?? 8000, 500, 40_000);
      return ok(`Read ${hostOf(url)} (${page.page.text.length} chars)`, {
        url: page.finalUrl,
        title: page.page.title,
        description: page.page.description,
        looksEmpty: page.page.looksEmpty,
        structuredData: page.jsonLdSummary ? truncate(page.jsonLdSummary, 4000) : null,
        text: truncate(page.page.text, limit),
        truncated: page.page.text.length > limit,
      });
    } catch (e) {
      return err(`Could not read ${hostOf(url)}: ${errorMessage(e)}`);
    }
  },

  async search_events(args) {
    const events = await queryEvents({
      search: str(args.query) ?? undefined,
      from: str(args.from) ?? undefined,
      to: str(args.to) ?? undefined,
      onlyNew: bool(args.onlyNew) ?? undefined,
      onlyStarred: bool(args.onlyStarred) ?? undefined,
      onlyDeadlines: bool(args.onlyDeadlines) ?? undefined,
      includePast: bool(args.includePast) ?? undefined,
      limit: clamp(num(args.limit) ?? 30, 1, 100),
    });

    const sources = await listSources();
    const nameOf = new Map(sources.map((s) => [s.id, s.title]));

    return ok(`Found ${events.length} event(s)`, {
      count: events.length,
      events: events.map((e) => ({
        ...eventForModel(e),
        foundOn: e.sourceId ? (nameOf.get(e.sourceId) ?? null) : 'added by hand',
      })),
    });
  },

  async save_event(args, ctx) {
    const title = str(args.title);
    const startsAt = str(args.startsAt);
    if (!title) return err('An event needs a title');
    if (!startsAt) return err('An event needs a start date');

    const event = await createManualEvent({
      title,
      description: str(args.description),
      startsAt,
      endsAt: str(args.endsAt),
      allDay: startsAt.length <= 10,
      location: str(args.location),
      url: str(args.url),
      price: str(args.price),
      category: str(args.category) ?? 'other',
      deadlineAt: str(args.deadlineAt),
      deadlineLabel: str(args.deadlineLabel),
      confidence: 1,
    });
    ctx.onDataChanged?.();
    return ok(`Saved "${event.title}"`, { event: eventForModel(event) });
  },

  async update_event(args, ctx) {
    const id = str(args.eventId);
    if (!id) return err('No event id given');
    const event = await getEvent(id);
    if (!event) return err('No saved event with that id');

    const patch: Partial<EventItem> = {};
    const starred = bool(args.starred);
    if (starred !== null) patch.starred = starred;
    const dismissed = bool(args.dismissed);
    if (dismissed !== null) patch.dismissed = dismissed;
    const title = str(args.title);
    if (title) patch.title = title;
    const startsAt = str(args.startsAt);
    if (startsAt) patch.startsAt = startsAt;
    if ('location' in args) patch.location = str(args.location);
    if ('deadlineAt' in args) patch.deadlineAt = str(args.deadlineAt);
    if ('notes' in args) patch.description = str(args.notes);

    if (!Object.keys(patch).length) return err('Nothing to change was specified');

    await updateEvent(id, patch);
    ctx.onDataChanged?.();
    const fresh = await getEvent(id);
    return ok(`Updated "${fresh?.title ?? event.title}"`, {
      event: fresh ? eventForModel(fresh) : null,
    });
  },

  async add_event_to_calendar(args, ctx) {
    const id = str(args.eventId);
    if (!id) return err('No event id given');
    const event = await getEvent(id);
    if (!event) return err('No saved event with that id');
    if (event.calendarEventId) return ok(`"${event.title}" is already in the calendar`);

    const res = await exportEvent(event);
    ctx.onDataChanged?.();
    return res.ok
      ? ok(`Added "${event.title}" to the calendar`)
      : err(res.error ?? 'Could not add to calendar');
  },

  async remind_me(args, ctx) {
    const id = str(args.eventId);
    if (!id) return err('No event id given');
    const event = await getEvent(id);
    if (!event) return err('No saved event with that id');
    if (!event.deadlineAt) {
      return err(`"${event.title}" has no deadline to remind against`);
    }

    const days = clamp(num(args.daysBefore) ?? 1, 0, 365);
    const notificationId = await scheduleDeadlineReminder(event, days);
    if (!notificationId) return err('Could not schedule that reminder — the deadline may have passed');

    await updateEvent(event.id, { reminderId: notificationId });
    ctx.onDataChanged?.();
    return ok(
      `Reminder set for ${days === 0 ? 'the day of' : `${days} day(s) before`} the "${event.title}" deadline`,
    );
  },

  async list_routines() {
    const routines = await listRoutines();
    return ok(`Read ${routines.length} routine(s)`, {
      count: routines.length,
      routines: routines.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        schedule:
          r.scheduleKind === 'interval'
            ? `every ${r.intervalMin} minutes`
            : r.scheduleKind === 'daily'
              ? `daily at ${String(r.hour).padStart(2, '0')}:${String(r.minute).padStart(2, '0')}`
              : `weekly, day ${r.weekday} at ${String(r.hour).padStart(2, '0')}:${String(r.minute).padStart(2, '0')}`,
        enabled: r.enabled,
        prompt: r.prompt,
        lastRun: r.lastRunAt ? relative(r.lastRunAt) : 'never',
        lastResult: r.lastResult ? truncate(r.lastResult, 200) : null,
      })),
    });
  },

  async create_routine(args, ctx) {
    const name = str(args.name);
    const kindArg = str(args.kind);
    if (!name) return err('A routine needs a name');
    if (kindArg !== 'check_all' && kindArg !== 'digest' && kindArg !== 'prompt') {
      return err('kind must be check_all, digest or prompt');
    }
    const prompt = str(args.prompt);
    if (kindArg === 'prompt' && !prompt) return err('kind=prompt needs a prompt to run');

    const scheduleArg = str(args.scheduleKind);
    const scheduleKind =
      scheduleArg === 'weekly' || scheduleArg === 'interval' ? scheduleArg : 'daily';

    const routine = await createRoutine({
      name,
      kind: kindArg,
      prompt,
      scheduleKind,
      hour: clamp(num(args.hour) ?? 8, 0, 23),
      minute: clamp(num(args.minute) ?? 0, 0, 59),
      weekday: clamp(num(args.weekday) ?? 2, 1, 7),
      intervalMin: clamp(num(args.everyMinutes) ?? 720, 15, 20_160),
      enabled: true,
    });

    // Booking the OS notification lives with the routines engine.
    const { syncRoutineSchedule } = await import('../engine/routines');
    await syncRoutineSchedule(routine);
    ctx.onDataChanged?.();

    return ok(`Created routine "${routine.name}"`, { routineId: routine.id });
  },

  async delete_routine(args, ctx) {
    const key = str(args.routineId);
    if (!key) return err('No routine given');
    const routines = await listRoutines();
    const routine =
      routines.find((r) => r.id === key) ??
      routines.find((r) => r.name.toLowerCase() === key.toLowerCase()) ??
      routines.find((r) => r.name.toLowerCase().includes(key.toLowerCase()));
    if (!routine) return err('No routine matched that');

    const { cancel } = await import('../notify');
    await cancel(routine.notificationId);
    await deleteRoutine(routine.id);
    ctx.onDataChanged?.();
    return ok(`Deleted routine "${routine.name}"`);
  },

  // ------------------------------------------------------------------ rules

  async list_rules() {
    const rules = await listRules();
    return ok(`Read ${rules.length} rule(s)`, {
      count: rules.length,
      rules: rules.map((r) => ({
        id: r.id,
        name: r.name,
        enabled: r.enabled,
        describes: describeRule(r),
        scopedToSourceId: r.sourceId,
        timesFired: r.fireCount,
        lastFired: r.lastFiredAt ? relative(r.lastFiredAt) : 'never',
        author: r.author,
      })),
    });
  },

  async create_rule(args, ctx) {
    const request = str(args.request);
    if (!request) return err('Describe the automation you want in one sentence');

    const sources = await listSources();
    const generated = await generateRule({
      settings: ctx.settings,
      request,
      sources,
      signal: ctx.signal,
    });
    if (!generated.ok) {
      return err(generated.error, generated.problems ? { problems: generated.problems } : {});
    }

    const rule = await createRule({
      name: generated.rule.name,
      enabled: bool(args.enabled) !== false,
      priority: 100,
      sourceId: generated.rule.sourceId,
      author: 'assistant',
      all: generated.rule.all,
      any: generated.rule.any,
      actions: generated.rule.actions,
    });
    ctx.onDataChanged?.();

    // Show what it would have caught, so the user can sanity-check it.
    const existing = await queryEvents({ limit: 300 });
    const preview = previewRule(rule, existing, sources);

    return ok(`Created rule "${rule.name}"`, {
      ruleId: rule.id,
      name: rule.name,
      describes: describeRule(rule),
      enabled: rule.enabled,
      wouldHaveMatched: preview.matched.length,
      examples: preview.matched.slice(0, 5).map((e) => e.title),
      note: 'Rules apply to newly found events from now on, not to events already in the agenda.',
    });
  },

  async update_rule(args, ctx) {
    const key = str(args.ruleId);
    if (!key) return err('No rule given');
    const rules = await listRules();
    const rule =
      rules.find((r) => r.id === key) ??
      rules.find((r) => r.name.toLowerCase() === key.toLowerCase()) ??
      rules.find((r) => r.name.toLowerCase().includes(key.toLowerCase()));
    if (!rule) return err('No rule matched that');

    const patch: Parameters<typeof updateRule>[1] = {};
    const enabled = bool(args.enabled);
    if (enabled !== null) patch.enabled = enabled;
    const name = str(args.name);
    if (name) patch.name = name;
    if (!Object.keys(patch).length) return err('Nothing to change was specified');

    await updateRule(rule.id, patch);
    ctx.onDataChanged?.();
    return ok(`Updated rule "${patch.name ?? rule.name}"`, { ruleId: rule.id });
  },

  async delete_rule(args, ctx) {
    const key = str(args.ruleId);
    if (!key) return err('No rule given');
    const rules = await listRules();
    const rule =
      rules.find((r) => r.id === key) ??
      rules.find((r) => r.name.toLowerCase() === key.toLowerCase());
    if (!rule) return err('No rule matched that');
    await deleteRule(rule.id);
    ctx.onDataChanged?.();
    return ok(`Deleted rule "${rule.name}"`);
  },

  // ---------------------------------------------------------------- modules

  async list_modules() {
    const modules = await listModules();
    return ok(`Read ${modules.length} panel(s)`, {
      count: modules.length,
      modules: modules.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        version: m.version,
        enabled: m.enabled,
        permissions: m.capabilities,
        lastError: m.lastError,
      })),
    });
  },

  async create_module(args, ctx) {
    const request = str(args.request);
    if (!request) return err('Describe what the panel should do');

    const generated = await generateModule({
      settings: ctx.settings,
      request,
      signal: ctx.signal,
    });
    if (!generated.ok) {
      return err(generated.error, generated.problems ? { problems: generated.problems } : {});
    }

    const module = await createModule({
      name: generated.module.name,
      description: generated.module.description || null,
      icon: generated.module.icon,
      html: generated.module.fragment,
      prompt: request,
      capabilities: generated.module.capabilities,
      enabled: true,
      pinned: false,
    });
    ctx.onDataChanged?.();

    return ok(`Built the "${module.name}" panel`, {
      moduleId: module.id,
      name: module.name,
      description: module.description,
      permissions: module.capabilities,
      note: 'It is live in the Studio tab now. Tell the user what it does and that they can open it there.',
    });
  },

  async revise_module(args, ctx) {
    const key = str(args.moduleId);
    const request = str(args.request);
    if (!key) return err('No panel given');
    if (!request) return err('Describe what should change');

    const modules = await listModules();
    const module =
      modules.find((m) => m.id === key) ??
      modules.find((m) => m.name.toLowerCase() === key.toLowerCase()) ??
      modules.find((m) => m.name.toLowerCase().includes(key.toLowerCase()));
    if (!module) return err('No panel matched that');

    const generated = await generateModule({
      settings: ctx.settings,
      request,
      existing: { name: module.name, fragment: module.html },
      signal: ctx.signal,
    });
    if (!generated.ok) {
      return err(generated.error, generated.problems ? { problems: generated.problems } : {});
    }

    const revised = await reviseModule(module.id, generated.module.fragment, request, request);
    ctx.onDataChanged?.();

    return ok(`Updated "${revised.name}" to v${revised.version}`, {
      moduleId: revised.id,
      version: revised.version,
      note: 'The previous version is kept and can be rolled back from the panel\'s screen.',
    });
  },

  async get_overview() {
    const [stats, sources, routines, deadlines] = await Promise.all([
      eventStats(),
      listSources(),
      listRoutines(),
      upcomingDeadlines(30),
    ]);

    const now = Date.now();
    const due = sources.filter(
      (s) => s.enabled && (!s.lastCheckedAt || s.lastCheckedAt + s.intervalMin * 60_000 <= now),
    );
    const failing = sources.filter((s) => s.lastStatus === 'error');

    return ok('Read the overview', {
      events: {
        upcoming: stats.total,
        unseen: stats.newCount,
        starred: stats.starred,
        next7Days: stats.next7Days,
      },
      sites: {
        total: sources.length,
        paused: sources.filter((s) => !s.enabled).length,
        dueForCheck: due.map((s) => s.title),
        failing: failing.map((s) => ({ title: s.title, error: s.lastError })),
      },
      deadlines: deadlines.slice(0, 10).map((e) => ({
        title: e.title,
        deadlineAt: e.deadlineAt,
        label: e.deadlineLabel,
      })),
      routines: routines.filter((r) => r.enabled).map((r) => r.name),
    });
  },

  async get_site_history(args) {
    const source = await resolveSource(args);
    if (!source) return err('Could not find that site in the watchlist');
    const history = await listChecks(source.id, 12);
    return ok(`Read ${history.length} check(s) for ${source.title}`, {
      site: sourceForModel(source),
      checks: history.map((c) => ({
        ran: relative(c.ranAt),
        status: c.status,
        changed: c.changed,
        newEvents: c.newEvents,
        note: c.note,
        trigger: c.trigger,
      })),
    });
  },
};

export function toolNames(): string[] {
  return Object.keys(handlers);
}

/** Runs one model-requested tool call, never throwing. */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const handler = handlers[name];
  if (!handler) {
    return err(`Unknown tool "${name}"`, { availableTools: toolNames() });
  }
  try {
    return await handler(args ?? {}, ctx);
  } catch (e) {
    return err(`${name} failed: ${errorMessage(e)}`);
  }
}
