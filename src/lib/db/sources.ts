import { CheckRun, CheckStatus, Source, SourceDraft, WatchMode } from '../types';
import { uid } from '../util';
import { boolToInt, getDb, intToBool } from './index';

interface SourceRow {
  id: string;
  url: string;
  title: string;
  category: string | null;
  mode: string;
  hint: string | null;
  interval_min: number;
  enabled: number;
  notify: number;
  last_checked_at: number | null;
  last_status: string;
  last_error: string | null;
  content_hash: string | null;
  last_summary: string | null;
  created_at: number;
}

function toSource(r: SourceRow): Source {
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    category: r.category,
    mode: r.mode as WatchMode,
    hint: r.hint,
    intervalMin: r.interval_min,
    enabled: intToBool(r.enabled),
    notify: intToBool(r.notify),
    lastCheckedAt: r.last_checked_at,
    lastStatus: r.last_status as CheckStatus,
    lastError: r.last_error,
    contentHash: r.content_hash,
    lastSummary: r.last_summary,
    createdAt: r.created_at,
  };
}

export async function listSources(): Promise<Source[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<SourceRow>(
    'SELECT * FROM sources ORDER BY enabled DESC, title COLLATE NOCASE ASC',
  );
  return rows.map(toSource);
}

export async function getSource(id: string): Promise<Source | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<SourceRow>('SELECT * FROM sources WHERE id = ?', id);
  return row ? toSource(row) : null;
}

export async function findSourceByUrl(url: string): Promise<Source | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<SourceRow>('SELECT * FROM sources WHERE url = ?', url);
  return row ? toSource(row) : null;
}

/** Sources whose interval has elapsed (or that were never checked). */
export async function listDueSources(now = Date.now()): Promise<Source[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<SourceRow>(
    `SELECT * FROM sources
      WHERE enabled = 1
        AND (last_checked_at IS NULL OR last_checked_at + interval_min * 60000 <= ?)
      ORDER BY IFNULL(last_checked_at, 0) ASC`,
    now,
  );
  return rows.map(toSource);
}

export async function createSource(draft: SourceDraft): Promise<Source> {
  const db = await getDb();
  const id = draft.id ?? uid('src_');
  const createdAt = Date.now();
  await db.runAsync(
    `INSERT INTO sources
       (id, url, title, category, mode, hint, interval_min, enabled, notify, last_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'never', ?)`,
    id,
    draft.url,
    draft.title,
    draft.category,
    draft.mode,
    draft.hint,
    draft.intervalMin,
    boolToInt(draft.enabled),
    boolToInt(draft.notify),
    createdAt,
  );
  const created = await getSource(id);
  if (!created) throw new Error('Failed to create source');
  return created;
}

const UPDATABLE: Record<string, string> = {
  url: 'url',
  title: 'title',
  category: 'category',
  mode: 'mode',
  hint: 'hint',
  intervalMin: 'interval_min',
  enabled: 'enabled',
  notify: 'notify',
  lastCheckedAt: 'last_checked_at',
  lastStatus: 'last_status',
  lastError: 'last_error',
  contentHash: 'content_hash',
  lastSummary: 'last_summary',
};

export async function updateSource(id: string, patch: Partial<Source>): Promise<void> {
  const entries = Object.entries(patch).filter(([k]) => k in UPDATABLE);
  if (!entries.length) return;

  const db = await getDb();
  const sets = entries.map(([k]) => `${UPDATABLE[k]} = ?`).join(', ');
  const values = entries.map(([, v]) => (typeof v === 'boolean' ? boolToInt(v) : (v ?? null)));
  await db.runAsync(`UPDATE sources SET ${sets} WHERE id = ?`, [...values, id]);
}

export async function deleteSource(id: string): Promise<void> {
  const db = await getDb();
  // Cascade covers events/snapshots/checks; delete explicitly in case the
  // foreign_keys pragma was not applied on an older connection.
  await db.runAsync('DELETE FROM events WHERE source_id = ?', id);
  await db.runAsync('DELETE FROM snapshots WHERE source_id = ?', id);
  await db.runAsync('DELETE FROM checks WHERE source_id = ?', id);
  await db.runAsync('DELETE FROM sources WHERE id = ?', id);
}

// ---------------------------------------------------------------- snapshots

export async function getSnapshot(sourceId: string): Promise<{ text: string; hash: string } | null> {
  const db = await getDb();
  return db.getFirstAsync<{ text: string; hash: string }>(
    'SELECT text, hash FROM snapshots WHERE source_id = ?',
    sourceId,
  );
}

export async function saveSnapshot(sourceId: string, text: string, hash: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO snapshots (source_id, text, hash, taken_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (source_id) DO UPDATE SET text = excluded.text, hash = excluded.hash, taken_at = excluded.taken_at`,
    sourceId,
    text,
    hash,
    Date.now(),
  );
}

// ------------------------------------------------------------------- checks

interface CheckRow {
  id: string;
  source_id: string;
  ran_at: number;
  status: string;
  changed: number;
  new_events: number;
  total_events: number;
  duration_ms: number;
  note: string | null;
  trigger: string;
}

function toCheck(r: CheckRow): CheckRun {
  return {
    id: r.id,
    sourceId: r.source_id,
    ranAt: r.ran_at,
    status: r.status as CheckRun['status'],
    changed: intToBool(r.changed),
    newEvents: r.new_events,
    totalEvents: r.total_events,
    durationMs: r.duration_ms,
    note: r.note,
    trigger: r.trigger as CheckRun['trigger'],
  };
}

export async function recordCheck(run: Omit<CheckRun, 'id'>): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO checks
       (id, source_id, ran_at, status, changed, new_events, total_events, duration_ms, note, trigger)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    uid('chk_'),
    run.sourceId,
    run.ranAt,
    run.status,
    boolToInt(run.changed),
    run.newEvents,
    run.totalEvents,
    run.durationMs,
    run.note,
    run.trigger,
  );
  // Keep only the 30 most recent runs per source.
  await db.runAsync(
    `DELETE FROM checks WHERE source_id = ? AND id NOT IN (
       SELECT id FROM checks WHERE source_id = ? ORDER BY ran_at DESC LIMIT 30
     )`,
    run.sourceId,
    run.sourceId,
  );
}

export async function listChecks(sourceId: string, limit = 15): Promise<CheckRun[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<CheckRow>(
    'SELECT * FROM checks WHERE source_id = ? ORDER BY ran_at DESC LIMIT ?',
    sourceId,
    limit,
  );
  return rows.map(toCheck);
}

export async function recentActivity(limit = 20): Promise<(CheckRun & { sourceTitle: string })[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<CheckRow & { source_title: string }>(
    `SELECT c.*, s.title AS source_title
       FROM checks c JOIN sources s ON s.id = c.source_id
      ORDER BY c.ran_at DESC LIMIT ?`,
    limit,
  );
  return rows.map((r) => ({ ...toCheck(r), sourceTitle: r.source_title }));
}
