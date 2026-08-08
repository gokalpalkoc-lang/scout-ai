import { create } from 'zustand';

import * as eventsDb from '../lib/db/events';
import * as modulesDb from '../lib/db/modules';
import * as routinesDb from '../lib/db/routines';
import * as rulesDb from '../lib/db/rules';
import * as sourcesDb from '../lib/db/sources';
import { CheckOutcome, SweepResult, checkSource, sweep } from '../lib/engine/checkSource';
import { RoutineOutcome, runRoutine, syncRoutineSchedule } from '../lib/engine/routines';
import { cancel as cancelNotification } from '../lib/notify';
import { Module, ModuleVersion } from '../lib/modules/types';
import { Rule, RuleDraft } from '../lib/rules/types';
import { CheckRun, EventItem, Routine, Source, SourceDraft } from '../lib/types';
import { errorMessage } from '../lib/util';
import { readSettings } from './settings';

/**
 * Single store for the app's domain data.
 *
 * SQLite is the source of truth; this holds the last-read copy so screens render
 * synchronously. Anything that mutates the database calls `refresh*` afterwards
 * rather than patching state by hand — one code path, no drift.
 */

export interface AppState {
  sources: Source[];
  events: EventItem[];
  routines: Routine[];
  rules: Rule[];
  modules: Module[];
  stats: eventsDb.EventStats;

  loading: boolean;
  ready: boolean;
  /** Source ids currently being checked, for per-row spinners. */
  checking: string[];
  /** Non-null while a full sweep is running. */
  sweepProgress: { done: number; total: number; current: string } | null;
  lastSweep: SweepResult | null;
  error: string | null;

  // ------------------------------------------------------------------- reads
  init: () => Promise<void>;
  refreshAll: () => Promise<void>;
  refreshSources: () => Promise<void>;
  refreshEvents: () => Promise<void>;
  refreshRoutines: () => Promise<void>;
  refreshRules: () => Promise<void>;
  refreshModules: () => Promise<void>;

  // ----------------------------------------------------------------- sources
  addSource: (draft: SourceDraft, checkNow?: boolean) => Promise<Source>;
  editSource: (id: string, patch: Partial<Source>) => Promise<void>;
  removeSource: (id: string) => Promise<void>;
  checkOne: (id: string, opts?: { force?: boolean; silent?: boolean }) => Promise<CheckOutcome>;
  checkAll: (opts?: { all?: boolean }) => Promise<SweepResult>;
  historyFor: (id: string) => Promise<CheckRun[]>;

  // ------------------------------------------------------------------ events
  toggleStar: (id: string) => Promise<void>;
  dismissEvent: (id: string, dismissed?: boolean) => Promise<void>;
  removeEvent: (id: string) => Promise<void>;
  markSeen: (sourceId?: string) => Promise<void>;
  editEvent: (id: string, patch: Partial<EventItem>) => Promise<void>;

  // ---------------------------------------------------------------- routines
  addRoutine: (draft: routinesDb.RoutineDraft) => Promise<Routine>;
  editRoutine: (id: string, patch: Partial<Routine>) => Promise<void>;
  removeRoutine: (id: string) => Promise<void>;
  fireRoutine: (id: string) => Promise<RoutineOutcome | null>;

  // ------------------------------------------------------------------- rules
  addRule: (draft: RuleDraft) => Promise<Rule>;
  editRule: (id: string, patch: Partial<Rule>) => Promise<void>;
  removeRule: (id: string) => Promise<void>;

  // ----------------------------------------------------------------- modules
  editModule: (id: string, patch: Partial<Module>) => Promise<void>;
  removeModule: (id: string) => Promise<void>;
  moduleVersions: (id: string) => Promise<ModuleVersion[]>;
  rollbackModuleTo: (id: string, version: number) => Promise<void>;
}

const EMPTY_STATS: eventsDb.EventStats = {
  total: 0,
  newCount: 0,
  starred: 0,
  deadlinesSoon: 0,
  next7Days: 0,
};

export const useApp = create<AppState>((set, get) => ({
  sources: [],
  events: [],
  routines: [],
  rules: [],
  modules: [],
  stats: EMPTY_STATS,

  loading: false,
  ready: false,
  checking: [],
  sweepProgress: null,
  lastSweep: null,
  error: null,

  async init() {
    if (get().ready || get().loading) return;
    set({ loading: true, error: null });
    try {
      await get().refreshAll();
      set({ ready: true });
    } catch (e) {
      set({ error: errorMessage(e) });
    } finally {
      set({ loading: false });
    }
  },

  async refreshAll() {
    const [sources, events, routines, rules, modules, stats] = await Promise.all([
      sourcesDb.listSources(),
      eventsDb.queryEvents({ limit: 600 }),
      routinesDb.listRoutines(),
      rulesDb.listRules(),
      modulesDb.listModules(),
      eventsDb.eventStats(),
    ]);
    set({ sources, events, routines, rules, modules, stats });
  },

  async refreshSources() {
    set({ sources: await sourcesDb.listSources() });
  },

  async refreshEvents() {
    const [events, stats] = await Promise.all([
      eventsDb.queryEvents({ limit: 600 }),
      eventsDb.eventStats(),
    ]);
    set({ events, stats });
  },

  async refreshRoutines() {
    set({ routines: await routinesDb.listRoutines() });
  },

  async refreshRules() {
    set({ rules: await rulesDb.listRules() });
  },

  async refreshModules() {
    set({ modules: await modulesDb.listModules() });
  },

  // ----------------------------------------------------------------- sources

  async addSource(draft, checkNow = true) {
    const source = await sourcesDb.createSource(draft);
    await get().refreshSources();
    if (checkNow) {
      // Not awaited: the list should appear immediately and fill in as it checks.
      void get().checkOne(source.id, { silent: true });
    }
    return source;
  },

  async editSource(id, patch) {
    await sourcesDb.updateSource(id, patch);
    await get().refreshSources();
  },

  async removeSource(id) {
    const events = await eventsDb.queryEvents({ sourceId: id, includePast: true, includeDismissed: true });
    for (const e of events) await cancelNotification(e.reminderId);
    await sourcesDb.deleteSource(id);
    await get().refreshAll();
  },

  async checkOne(id, opts = {}) {
    set({ checking: [...get().checking, id] });
    try {
      const outcome = await checkSource(id, {
        trigger: 'manual',
        force: opts.force,
        silent: opts.silent ?? true,
      });
      await Promise.all([get().refreshSources(), get().refreshEvents()]);
      return outcome;
    } finally {
      set({ checking: get().checking.filter((x) => x !== id) });
    }
  },

  async checkAll(opts = {}) {
    if (get().sweepProgress) return get().lastSweep ?? emptySweep();
    set({ sweepProgress: { done: 0, total: 0, current: 'Starting…' } });
    try {
      const result = await sweep({
        trigger: 'manual',
        all: opts.all,
        silent: true,
        onProgress: (done, total, current) => set({ sweepProgress: { done, total, current } }),
      });
      await get().refreshAll();
      set({ lastSweep: result });
      return result;
    } finally {
      set({ sweepProgress: null });
    }
  },

  async historyFor(id) {
    return sourcesDb.listChecks(id, 20);
  },

  // ------------------------------------------------------------------ events

  async toggleStar(id) {
    const event = get().events.find((e) => e.id === id) ?? (await eventsDb.getEvent(id));
    if (!event) return;
    await eventsDb.updateEvent(id, { starred: !event.starred, isNew: false });
    await get().refreshEvents();
  },

  async dismissEvent(id, dismissed = true) {
    const event = get().events.find((e) => e.id === id) ?? (await eventsDb.getEvent(id));
    if (event?.reminderId && dismissed) await cancelNotification(event.reminderId);
    await eventsDb.updateEvent(id, { dismissed, isNew: false });
    await get().refreshEvents();
  },

  async removeEvent(id) {
    const event = get().events.find((e) => e.id === id) ?? (await eventsDb.getEvent(id));
    if (event?.reminderId) await cancelNotification(event.reminderId);
    await eventsDb.deleteEvent(id);
    await get().refreshEvents();
  },

  async markSeen(sourceId) {
    await eventsDb.markAllSeen(sourceId);
    await get().refreshEvents();
  },

  async editEvent(id, patch) {
    await eventsDb.updateEvent(id, patch);
    await get().refreshEvents();
  },

  // ---------------------------------------------------------------- routines

  async addRoutine(draft) {
    const routine = await routinesDb.createRoutine(draft);
    await syncRoutineSchedule(routine);
    await get().refreshRoutines();
    return routine;
  },

  async editRoutine(id, patch) {
    await routinesDb.updateRoutine(id, patch);
    const fresh = await routinesDb.getRoutine(id);
    if (fresh) await syncRoutineSchedule(fresh);
    await get().refreshRoutines();
  },

  async removeRoutine(id) {
    const routine = await routinesDb.getRoutine(id);
    if (routine) await cancelNotification(routine.notificationId);
    await routinesDb.deleteRoutine(id);
    await get().refreshRoutines();
  },

  async fireRoutine(id) {
    const routine = await routinesDb.getRoutine(id);
    if (!routine) return null;
    const outcome = await runRoutine(routine, { silent: true });
    await get().refreshAll();
    return outcome;
  },

  // ------------------------------------------------------------------- rules

  async addRule(draft) {
    const rule = await rulesDb.createRule(draft);
    await get().refreshRules();
    return rule;
  },

  async editRule(id, patch) {
    await rulesDb.updateRule(id, patch);
    await get().refreshRules();
  },

  async removeRule(id) {
    await rulesDb.deleteRule(id);
    await get().refreshRules();
  },

  // ----------------------------------------------------------------- modules

  async editModule(id, patch) {
    await modulesDb.updateModule(id, patch);
    await get().refreshModules();
  },

  async removeModule(id) {
    await modulesDb.deleteModule(id);
    await get().refreshModules();
  },

  async moduleVersions(id) {
    return modulesDb.listVersions(id);
  },

  async rollbackModuleTo(id, version) {
    await modulesDb.rollbackModule(id, version);
    await get().refreshModules();
  },
}));

function emptySweep(): SweepResult {
  return { checked: 0, skipped: 0, newEvents: 0, changedPages: 0, errors: [], durationMs: 0 };
}

/**
 * Sources whose interval has elapsed — drives the "N due" hint on Watchlist.
 *
 * A plain helper, not a Zustand selector: it builds a new array on every call,
 * and Zustand v5 compares snapshots by identity, so using it as a selector would
 * make React re-render on every unrelated store change. Call it inside a
 * `useMemo` over `sources`, or select `.length` from it.
 */
export function dueSourcesOf(sources: Source[], now = Date.now()): Source[] {
  return sources.filter(
    (s) => s.enabled && (!s.lastCheckedAt || s.lastCheckedAt + s.intervalMin * 60_000 <= now),
  );
}

/** Runs a sweep of anything due, at most once per window. Used on app resume. */
export async function foregroundSweep(minGapMin = 30): Promise<void> {
  const settings = await readSettings();
  const last = settings.lastForegroundSweepAt ?? 0;
  if (Date.now() - last < minGapMin * 60_000) return;

  const due = await sourcesDb.listDueSources();
  if (!due.length) return;

  await useApp.getState().checkAll();
}
