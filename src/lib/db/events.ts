import { EventItem, ExtractedEvent } from '../types';
import { slugKey, uid } from '../util';
import { isDateOnly, parseEventDate } from '../util/date';
import { boolToInt, getDb, intToBool } from './index';

interface EventRow {
  id: string;
  source_id: string | null;
  fingerprint: string;
  title: string;
  description: string | null;
  starts_at: string | null;
  ends_at: string | null;
  all_day: number;
  location: string | null;
  url: string | null;
  price: string | null;
  category: string | null;
  deadline_at: string | null;
  deadline_label: string | null;
  confidence: number;
  is_new: number;
  starred: number;
  dismissed: number;
  calendar_event_id: string | null;
  reminder_id: string | null;
  first_seen_at: number;
  last_seen_at: number;
}

function toEvent(r: EventRow): EventItem {
  return {
    id: r.id,
    sourceId: r.source_id,
    fingerprint: r.fingerprint,
    title: r.title,
    description: r.description,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    allDay: intToBool(r.all_day),
    location: r.location,
    url: r.url,
    price: r.price,
    category: r.category,
    deadlineAt: r.deadline_at,
    deadlineLabel: r.deadline_label,
    confidence: r.confidence,
    isNew: intToBool(r.is_new),
    starred: intToBool(r.starred),
    dismissed: intToBool(r.dismissed),
    calendarEventId: r.calendar_event_id,
    reminderId: r.reminder_id,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
  };
}

/**
 * Identity of an event within its source. Title + date is deliberate: the same
 * title on a new date is a new event, and re-worded descriptions or a changed
 * price should not resurrect an item as "new".
 */
export function fingerprintOf(e: Pick<ExtractedEvent, 'title' | 'startsAt'>): string {
  const datePart = e.startsAt ? e.startsAt.slice(0, 10) : 'nodate';
  return `${slugKey(e.title).slice(0, 80)}|${datePart}`;
}

export interface EventQuery {
  sourceId?: string;
  includeDismissed?: boolean;
  includePast?: boolean;
  onlyNew?: boolean;
  onlyStarred?: boolean;
  onlyDeadlines?: boolean;
  search?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export async function queryEvents(q: EventQuery = {}): Promise<EventItem[]> {
  const db = await getDb();
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (q.sourceId) {
    where.push('source_id = ?');
    params.push(q.sourceId);
  }
  if (!q.includeDismissed) where.push('dismissed = 0');
  if (q.onlyNew) where.push('is_new = 1');
  if (q.onlyStarred) where.push('starred = 1');
  if (q.onlyDeadlines) where.push('deadline_at IS NOT NULL');
  if (q.search) {
    // Single quotes: SQLite reads "" as an identifier, not an empty string.
    where.push(`(title LIKE ? OR IFNULL(description, '') LIKE ? OR IFNULL(location, '') LIKE ?)`);
    const like = `%${q.search}%`;
    params.push(like, like, like);
  }
  if (q.from) {
    where.push('(starts_at IS NULL OR starts_at >= ?)');
    params.push(q.from);
  }
  if (q.to) {
    where.push('(starts_at IS NULL OR starts_at <= ?)');
    params.push(q.to);
  }

  const sql = `SELECT * FROM events
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY starts_at IS NULL, starts_at ASC
    LIMIT ?`;
  params.push(q.limit ?? 500);

  const rows = await db.getAllAsync<EventRow>(sql, params);
  const events = rows.map(toEvent);
  if (q.includePast) return events;

  // "Upcoming" keeps undated items (they may still be relevant) and anything
  // whose start or deadline has not passed.
  return events.filter((e) => {
    if (!e.startsAt && !e.deadlineAt) return true;
    return !isFullyPast(e);
  });
}

function isFullyPast(e: EventItem): boolean {
  const now = Date.now();
  const start = parseEventDate(e.startsAt);
  const end = parseEventDate(e.endsAt);
  const deadline = parseEventDate(e.deadlineAt);
  const candidates = [end, start, deadline].filter(Boolean) as Date[];
  if (!candidates.length) return false;
  const last = Math.max(
    ...candidates.map((d, i) => {
      // A date-only value stays "current" until the end of that day.
      const iso = [e.endsAt, e.startsAt, e.deadlineAt][i];
      return isDateOnly(iso) ? d.getTime() + 86_400_000 : d.getTime();
    }),
  );
  return last < now;
}

export async function getEvent(id: string): Promise<EventItem | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<EventRow>('SELECT * FROM events WHERE id = ?', id);
  return row ? toEvent(row) : null;
}

export interface UpsertResult {
  created: EventItem[];
  updated: number;
}

/**
 * Merges a freshly extracted batch into the store.
 *
 * Existing rows are refreshed in place (so a corrected time or added location
 * shows up) while `first_seen_at` and the user's star/dismiss state survive.
 * Only genuinely unseen fingerprints come back in `created` — that list is what
 * drives notifications.
 */
export async function upsertEvents(
  sourceId: string | null,
  extracted: ExtractedEvent[],
): Promise<UpsertResult> {
  const db = await getDb();
  const now = Date.now();
  const created: EventItem[] = [];
  let updated = 0;

  await db.withTransactionAsync(async () => {
    for (const e of extracted) {
      const fingerprint = fingerprintOf(e);
      const existing = await db.getFirstAsync<EventRow>(
        `SELECT * FROM events WHERE IFNULL(source_id, '') = IFNULL(?, '') AND fingerprint = ?`,
        sourceId,
        fingerprint,
      );

      if (existing) {
        await db.runAsync(
          `UPDATE events SET
             title = ?, description = ?, starts_at = ?, ends_at = ?, all_day = ?,
             location = ?, url = ?, price = ?, category = ?,
             deadline_at = ?, deadline_label = ?, confidence = ?, last_seen_at = ?
           WHERE id = ?`,
          e.title,
          e.description,
          e.startsAt,
          e.endsAt,
          boolToInt(e.allDay),
          e.location,
          e.url,
          e.price,
          e.category,
          e.deadlineAt,
          e.deadlineLabel,
          e.confidence,
          now,
          existing.id,
        );
        updated += 1;
        continue;
      }

      const id = uid('evt_');
      await db.runAsync(
        `INSERT INTO events
           (id, source_id, fingerprint, title, description, starts_at, ends_at, all_day,
            location, url, price, category, deadline_at, deadline_label, confidence,
            is_new, starred, dismissed, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?)`,
        id,
        sourceId,
        fingerprint,
        e.title,
        e.description,
        e.startsAt,
        e.endsAt,
        boolToInt(e.allDay),
        e.location,
        e.url,
        e.price,
        e.category,
        e.deadlineAt,
        e.deadlineLabel,
        e.confidence,
        now,
        now,
      );
      const row = await db.getFirstAsync<EventRow>('SELECT * FROM events WHERE id = ?', id);
      if (row) created.push(toEvent(row));
    }
  });

  return { created, updated };
}

const EVENT_UPDATABLE: Record<string, string> = {
  title: 'title',
  description: 'description',
  startsAt: 'starts_at',
  endsAt: 'ends_at',
  allDay: 'all_day',
  location: 'location',
  url: 'url',
  price: 'price',
  category: 'category',
  deadlineAt: 'deadline_at',
  deadlineLabel: 'deadline_label',
  isNew: 'is_new',
  starred: 'starred',
  dismissed: 'dismissed',
  calendarEventId: 'calendar_event_id',
  reminderId: 'reminder_id',
};

export async function updateEvent(id: string, patch: Partial<EventItem>): Promise<void> {
  const entries = Object.entries(patch).filter(([k]) => k in EVENT_UPDATABLE);
  if (!entries.length) return;
  const db = await getDb();
  const sets = entries.map(([k]) => `${EVENT_UPDATABLE[k]} = ?`).join(', ');
  const values = entries.map(([, v]) => (typeof v === 'boolean' ? boolToInt(v) : (v ?? null)));
  await db.runAsync(`UPDATE events SET ${sets} WHERE id = ?`, [...values, id]);
}

export async function deleteEvent(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM events WHERE id = ?', id);
}

export async function markAllSeen(sourceId?: string): Promise<void> {
  const db = await getDb();
  if (sourceId) await db.runAsync('UPDATE events SET is_new = 0 WHERE source_id = ?', sourceId);
  else await db.runAsync('UPDATE events SET is_new = 0');
}

/** Inserts a user-authored event that no source owns. */
export async function createManualEvent(e: ExtractedEvent): Promise<EventItem> {
  const { created } = await upsertEvents(null, [e]);
  if (created.length) return created[0];
  const db = await getDb();
  const row = await db.getFirstAsync<EventRow>(
    'SELECT * FROM events WHERE source_id IS NULL AND fingerprint = ?',
    fingerprintOf(e),
  );
  if (!row) throw new Error('Failed to save event');
  return toEvent(row);
}

export interface EventStats {
  total: number;
  newCount: number;
  starred: number;
  deadlinesSoon: number;
  next7Days: number;
}

export async function eventStats(): Promise<EventStats> {
  const upcoming = await queryEvents({ limit: 1000 });
  const in7 = Date.now() + 7 * 86_400_000;
  const in14 = Date.now() + 14 * 86_400_000;
  return {
    total: upcoming.length,
    newCount: upcoming.filter((e) => e.isNew).length,
    starred: upcoming.filter((e) => e.starred).length,
    deadlinesSoon: upcoming.filter((e) => {
      const d = parseEventDate(e.deadlineAt);
      return !!d && d.getTime() <= in14 && d.getTime() >= Date.now() - 86_400_000;
    }).length,
    next7Days: upcoming.filter((e) => {
      const d = parseEventDate(e.startsAt);
      return !!d && d.getTime() <= in7;
    }).length,
  };
}

/** Events with a deadline inside `days`, soonest first. */
export async function upcomingDeadlines(days = 30): Promise<EventItem[]> {
  const events = await queryEvents({ onlyDeadlines: true, limit: 500 });
  const cutoff = Date.now() + days * 86_400_000;
  return events
    .filter((e) => {
      const d = parseEventDate(e.deadlineAt);
      return !!d && d.getTime() <= cutoff;
    })
    .sort(
      (a, b) =>
        (parseEventDate(a.deadlineAt)?.getTime() ?? 0) -
        (parseEventDate(b.deadlineAt)?.getTime() ?? 0),
    );
}
