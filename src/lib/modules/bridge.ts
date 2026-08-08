import { queryEvents, eventStats, updateEvent } from '../db/events';
import { moduleStorageGet, moduleStorageSet } from '../db/modules';
import { listRoutines } from '../db/routines';
import { listSources } from '../db/sources';
import { checkSource } from '../engine/checkSource';
import * as notify from '../notify';
import { clamp, errorMessage, truncate } from '../util';
import { formatClock } from '../util/date';
import { Capability, Module } from './types';

/**
 * The app side of the module bridge.
 *
 * Every method is mapped to exactly one capability, and a module that was not
 * granted that capability gets a refusal rather than data. This is the whole
 * security model for generated code: the WebView cannot reach the network (CSP),
 * cannot see credentials, and can only touch the database through the handlers
 * below — each of which validates and clamps its own arguments.
 */

export interface BridgeRequest {
  kind: 'call' | 'ready' | 'resize' | 'error';
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  height?: number;
  message?: string;
}

export interface BridgeResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

type Handler = (
  params: Record<string, unknown>,
  module: Module,
) => Promise<Record<string, unknown>>;

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/** Method → capability it requires. */
const METHOD_CAPABILITY: Record<string, Capability> = {
  'events.query': 'events.read',
  'events.update': 'events.write',
  'stats.get': 'stats.read',
  'sources.list': 'sources.read',
  'sources.check': 'sources.check',
  'routines.list': 'routines.read',
  'storage.get': 'storage',
  'storage.set': 'storage',
  'notify.send': 'notify',
};

const handlers: Record<string, Handler> = {
  async 'events.query'(params) {
    const sources = await listSources();
    const titleOf = new Map(sources.map((s) => [s.id, s.title]));

    const events = await queryEvents({
      search: str(params.search) ?? undefined,
      from: str(params.from) ?? undefined,
      to: str(params.to) ?? undefined,
      onlyNew: bool(params.onlyNew),
      onlyStarred: bool(params.onlyStarred),
      onlyDeadlines: bool(params.onlyDeadlines),
      includePast: bool(params.includePast),
      limit: clamp(num(params.limit) ?? 100, 1, 400),
    });

    return {
      events: events.map((e) => ({
        id: e.id,
        title: e.title,
        description: e.description,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        allDay: e.allDay,
        location: e.location,
        url: e.url,
        price: e.price,
        category: e.category,
        deadlineAt: e.deadlineAt,
        deadlineLabel: e.deadlineLabel,
        confidence: e.confidence,
        isNew: e.isNew,
        starred: e.starred,
        sourceId: e.sourceId,
        sourceTitle: e.sourceId ? (titleOf.get(e.sourceId) ?? null) : null,
      })),
    };
  },

  async 'events.update'(params) {
    const id = str(params.id);
    if (!id) throw new Error('events.update needs an event id');

    const patch: Parameters<typeof updateEvent>[1] = {};
    const starred = bool(params.starred);
    if (starred !== undefined) patch.starred = starred;
    const dismissed = bool(params.dismissed);
    if (dismissed !== undefined) patch.dismissed = dismissed;
    const category = str(params.category);
    if (category) patch.category = truncate(category.toLowerCase(), 30);

    if (!Object.keys(patch).length) throw new Error('Nothing to change was specified');
    await updateEvent(id, patch);
    return { ok: true };
  },

  async 'stats.get'() {
    return { ...(await eventStats()) };
  },

  async 'sources.list'() {
    const [sources, events] = await Promise.all([listSources(), queryEvents({ limit: 1000 })]);
    const counts = new Map<string, number>();
    for (const e of events) {
      if (e.sourceId) counts.set(e.sourceId, (counts.get(e.sourceId) ?? 0) + 1);
    }
    return {
      sources: sources.map((s) => ({
        id: s.id,
        title: s.title,
        url: s.url,
        category: s.category,
        mode: s.mode,
        enabled: s.enabled,
        intervalMin: s.intervalMin,
        lastCheckedAt: s.lastCheckedAt,
        lastStatus: s.lastStatus,
        eventCount: counts.get(s.id) ?? 0,
      })),
    };
  },

  async 'sources.check'(params) {
    const id = str(params.id);
    if (!id) throw new Error('sources.check needs a source id');
    const outcome = await checkSource(id, { trigger: 'assistant', silent: true });
    return {
      ok: outcome.ok,
      newEvents: outcome.newEvents.length,
      note: outcome.note,
      error: outcome.error,
    };
  },

  async 'routines.list'() {
    const routines = await listRoutines();
    return {
      routines: routines.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        enabled: r.enabled,
        schedule:
          r.scheduleKind === 'interval'
            ? `every ${r.intervalMin} min`
            : `${r.scheduleKind} at ${formatClock(r.hour, r.minute)}`,
        lastRunAt: r.lastRunAt,
      })),
    };
  },

  async 'storage.get'(params, module) {
    const key = str(params.key);
    if (!key) throw new Error('storage.get needs a key');
    return { value: await moduleStorageGet(module.id, truncate(key, 120)) };
  },

  async 'storage.set'(params, module) {
    const key = str(params.key);
    if (!key) throw new Error('storage.set needs a key');
    const value = typeof params.value === 'string' ? params.value : JSON.stringify(params.value);
    if (value.length > 100_000) throw new Error('That value is too large to store (100KB limit)');
    await moduleStorageSet(module.id, truncate(key, 120), value);
    return { ok: true };
  },

  async 'notify.send'(params, module) {
    const title = str(params.title) ?? module.name;
    const body = str(params.body) ?? '';
    await notify.notifyDigest(truncate(title, 60), truncate(body, 240));
    return { ok: true };
  },
};

/** Dispatches one bridge call, enforcing the module's granted capabilities. */
export async function handleBridgeCall(
  method: string,
  params: Record<string, unknown>,
  module: Module,
): Promise<BridgeResponse> {
  const id = 'unused';
  const required = METHOD_CAPABILITY[method];
  const handler = handlers[method];

  if (!handler || !required) {
    return { id, ok: false, error: `Scout has no method called "${method}"` };
  }
  if (!module.capabilities.includes(required)) {
    return {
      id,
      ok: false,
      error: `This module was not granted "${required}". Enable it in the module's settings.`,
    };
  }

  try {
    const data = await handler(params ?? {}, module);
    return { id, ok: true, data };
  } catch (e) {
    return { id, ok: false, error: errorMessage(e) };
  }
}

/** Which capabilities a fragment's code appears to need — used to pre-tick grants. */
export function inferCapabilities(fragment: string): Capability[] {
  const needed = new Set<Capability>();
  for (const [method, capability] of Object.entries(METHOD_CAPABILITY)) {
    if (fragment.includes(`'${method}'`) || fragment.includes(`"${method}"`)) {
      needed.add(capability);
    }
  }
  return [...needed];
}
