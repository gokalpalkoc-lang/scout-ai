import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { DEFAULT_SETTINGS, readSettings } from '../store/settings';
import { queryEvents, upsertEvents } from './db/events';
import { createRoutine, listRoutines } from './db/routines';
import { createSource, findSourceByUrl, listSources } from './db/sources';
import { syncRoutineSchedule } from './engine/routines';
import { EventItem, Routine, Source } from './types';
import { errorMessage, normalizeUrl } from './util';

/**
 * Backup and restore.
 *
 * Scout has no account and no server, so a phone reset would otherwise lose a
 * carefully built watchlist. The export is plain JSON the user can read, and
 * deliberately excludes secrets: an API key does not belong in a file that gets
 * shared through a messaging app.
 */

const FORMAT = 'scout-backup';
const FORMAT_VERSION = 1;

export interface Backup {
  format: typeof FORMAT;
  version: number;
  exportedAt: string;
  app: { name: string; version: string };
  settings: Record<string, unknown>;
  sources: Source[];
  events: EventItem[];
  routines: Routine[];
  counts: { sources: number; events: number; routines: number };
}

/** Secrets and device-local bookkeeping never go in a backup. */
const EXCLUDED_SETTINGS = new Set([
  'knownModels',
  'modelsFetchedAt',
  'credentialVerifiedAt',
  'lastBackgroundRunAt',
  'lastForegroundSweepAt',
  'hasOnboarded',
]);

export async function buildBackup(): Promise<Backup> {
  const [settings, sources, events, routines] = await Promise.all([
    readSettings(),
    listSources(),
    queryEvents({ includePast: true, includeDismissed: true, limit: 5000 }),
    listRoutines(),
  ]);

  const safeSettings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!EXCLUDED_SETTINGS.has(key)) safeSettings[key] = value;
  }

  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    app: { name: 'Scout', version: '1.0.0' },
    settings: safeSettings,
    sources,
    events,
    routines,
    counts: { sources: sources.length, events: events.length, routines: routines.length },
  };
}

export interface ExportResult {
  ok: boolean;
  uri?: string;
  error?: string;
}

/** Writes the backup to cache and opens the system share sheet. */
export async function exportBackup(): Promise<ExportResult> {
  try {
    const backup = await buildBackup();
    const stamp = backup.exportedAt.slice(0, 19).replace(/[:T]/g, '-');
    const dir = new Directory(Paths.cache, 'backups');
    if (!dir.exists) dir.create({ intermediates: true });

    const file = new File(dir, `scout-backup-${stamp}.json`);
    file.create({ intermediates: true, overwrite: true });
    file.write(JSON.stringify(backup, null, 2));

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(file.uri, {
        mimeType: 'application/json',
        dialogTitle: 'Scout backup',
        UTI: 'public.json',
      });
    }
    return { ok: true, uri: file.uri };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export interface RestoreResult {
  ok: boolean;
  added: { sources: number; events: number; routines: number };
  skipped: number;
  error?: string;
}

/**
 * Merges a backup into the current database.
 *
 * Additive on purpose — restoring must never silently delete something the user
 * added since the export. Sources already present by URL are left alone.
 */
export async function restoreBackup(json: string): Promise<RestoreResult> {
  const empty = { sources: 0, events: 0, routines: 0 };
  let parsed: Backup;

  try {
    parsed = JSON.parse(json) as Backup;
  } catch {
    return { ok: false, added: empty, skipped: 0, error: 'That file is not valid JSON.' };
  }

  if (parsed.format !== FORMAT) {
    return { ok: false, added: empty, skipped: 0, error: 'That file is not a Scout backup.' };
  }
  if (parsed.version > FORMAT_VERSION) {
    return {
      ok: false,
      added: empty,
      skipped: 0,
      error: 'That backup was made by a newer version of Scout.',
    };
  }

  const added = { ...empty };
  let skipped = 0;

  // Old id → new id, so events land under the right source.
  const remap = new Map<string, string>();

  for (const source of parsed.sources ?? []) {
    const url = normalizeUrl(source.url);
    if (!url) {
      skipped += 1;
      continue;
    }
    const existing = await findSourceByUrl(url);
    if (existing) {
      remap.set(source.id, existing.id);
      skipped += 1;
      continue;
    }
    const created = await createSource({
      url,
      title: source.title || url,
      category: source.category ?? null,
      mode: source.mode ?? 'both',
      hint: source.hint ?? null,
      intervalMin: source.intervalMin ?? DEFAULT_SETTINGS.defaultCheckIntervalMin,
      enabled: source.enabled ?? true,
      notify: source.notify ?? true,
    });
    remap.set(source.id, created.id);
    added.sources += 1;
  }

  // Group events by their new source id so each upsert batch is one transaction.
  const bySource = new Map<string | null, EventItem[]>();
  for (const event of parsed.events ?? []) {
    const target = event.sourceId ? (remap.get(event.sourceId) ?? null) : null;
    const list = bySource.get(target) ?? [];
    list.push(event);
    bySource.set(target, list);
  }

  for (const [sourceId, list] of bySource) {
    const { created } = await upsertEvents(
      sourceId,
      list.map((e) => ({
        title: e.title,
        description: e.description ?? null,
        startsAt: e.startsAt ?? null,
        endsAt: e.endsAt ?? null,
        allDay: !!e.allDay,
        location: e.location ?? null,
        url: e.url ?? null,
        price: e.price ?? null,
        category: e.category ?? null,
        deadlineAt: e.deadlineAt ?? null,
        deadlineLabel: e.deadlineLabel ?? null,
        confidence: typeof e.confidence === 'number' ? e.confidence : 0.5,
      })),
    );
    added.events += created.length;
  }

  const existingRoutines = await listRoutines();
  for (const routine of parsed.routines ?? []) {
    if (existingRoutines.some((r) => r.name === routine.name)) {
      skipped += 1;
      continue;
    }
    const created = await createRoutine({
      name: routine.name,
      kind: routine.kind,
      prompt: routine.prompt ?? null,
      scheduleKind: routine.scheduleKind ?? 'daily',
      hour: routine.hour ?? 8,
      minute: routine.minute ?? 0,
      weekday: routine.weekday ?? 2,
      intervalMin: routine.intervalMin ?? 720,
      enabled: routine.enabled ?? true,
    });
    await syncRoutineSchedule(created);
    added.routines += 1;
  }

  return { ok: true, added, skipped };
}
