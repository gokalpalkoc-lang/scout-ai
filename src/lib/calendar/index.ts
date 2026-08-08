import * as Calendar from 'expo-calendar';
import { Platform } from 'react-native';

import { updateEvent } from '../db/events';
import { EventItem } from '../types';
import { errorMessage } from '../util';
import { isDateOnly, parseEventDate } from '../util/date';

/**
 * Writes Scout events into the phone's own calendar.
 *
 * Scout stays the place where events are found; the calendar stays the place
 * where the user's day lives. Exporting rather than reimplementing a calendar
 * means reminders, sharing and widgets all keep working.
 */

export interface CalendarTarget {
  id: string;
  title: string;
  source: string;
  isPrimary: boolean;
}

export async function requestAccess(): Promise<{ granted: boolean; reason?: string }> {
  if (Platform.OS === 'web') {
    return { granted: false, reason: 'Calendar access is not available on web.' };
  }
  const { granted, canAskAgain } = await Calendar.requestCalendarPermissionsAsync();
  if (granted) return { granted: true };
  return {
    granted: false,
    reason: canAskAgain
      ? 'Calendar permission was declined.'
      : 'Calendar access is blocked. Enable it for Scout in the system settings.',
  };
}

/** Writable calendars, most likely default first. */
export async function listWritableCalendars(): Promise<CalendarTarget[]> {
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  return calendars
    .filter((c) => c.allowsModifications)
    .map((c) => ({
      id: c.id,
      title: c.title,
      source:
        typeof c.source === 'object' && c.source ? (c.source.name ?? '') : String(c.source ?? ''),
      isPrimary: !!(c as { isPrimary?: boolean }).isPrimary,
    }))
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
}

async function pickCalendarId(preferred?: string | null): Promise<string> {
  const calendars = await listWritableCalendars();
  if (!calendars.length) {
    throw new Error('No writable calendar found on this device.');
  }
  if (preferred && calendars.some((c) => c.id === preferred)) return preferred;

  if (Platform.OS === 'ios') {
    try {
      const def = await Calendar.getDefaultCalendarAsync();
      if (def?.id && calendars.some((c) => c.id === def.id)) return def.id;
    } catch {
      /* fall through to the first writable calendar */
    }
  }
  return calendars[0].id;
}

/**
 * Chooses a sensible start/end for an event that may only have a date.
 * A dateless event cannot be exported; an untimed one becomes all-day.
 */
function resolveWindow(event: EventItem): { start: Date; end: Date; allDay: boolean } | null {
  const start = parseEventDate(event.startsAt);
  if (!start) return null;

  const explicitEnd = parseEventDate(event.endsAt);
  const allDay = event.allDay || isDateOnly(event.startsAt);

  if (allDay) {
    const dayStart = new Date(start);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = explicitEnd ?? new Date(dayStart.getTime() + 86_400_000);
    return { start: dayStart, end: dayEnd, allDay: true };
  }

  const end =
    explicitEnd && explicitEnd.getTime() > start.getTime()
      ? explicitEnd
      : // No published end time: two hours is the least surprising default.
        new Date(start.getTime() + 2 * 3_600_000);
  return { start, end, allDay: false };
}

export interface ExportResult {
  ok: boolean;
  calendarEventId?: string;
  error?: string;
}

export async function exportEvent(
  event: EventItem,
  opts: { calendarId?: string | null; sourceLabel?: string } = {},
): Promise<ExportResult> {
  const access = await requestAccess();
  if (!access.granted) return { ok: false, error: access.reason };

  const window = resolveWindow(event);
  if (!window) {
    return { ok: false, error: 'This event has no date, so it cannot go in the calendar yet.' };
  }

  try {
    const calendarId = await pickCalendarId(opts.calendarId);

    const notes = [
      event.description,
      event.price ? `Price: ${event.price}` : '',
      event.deadlineAt ? `Deadline (${event.deadlineLabel ?? 'registration'}): ${event.deadlineAt}` : '',
      event.url,
      opts.sourceLabel ? `Found by Scout on ${opts.sourceLabel}` : 'Added by Scout',
    ]
      .filter(Boolean)
      .join('\n\n');

    const id = await Calendar.createEventAsync(calendarId, {
      title: event.title,
      startDate: window.start,
      endDate: window.end,
      allDay: window.allDay,
      location: event.location ?? undefined,
      // The event URL rides along in the notes: `url` is iOS-only on this API.
      notes,
    });

    await updateEvent(event.id, { calendarEventId: id });
    return { ok: true, calendarEventId: id };
  } catch (e) {
    return { ok: false, error: `Could not add to calendar: ${errorMessage(e)}` };
  }
}

export async function removeExportedEvent(event: EventItem): Promise<ExportResult> {
  if (!event.calendarEventId) return { ok: true };
  try {
    await Calendar.deleteEventAsync(event.calendarEventId);
  } catch {
    // The user may already have deleted it in their calendar app; treat the
    // local link as stale either way.
  }
  await updateEvent(event.id, { calendarEventId: null });
  return { ok: true };
}

/** Bulk export, used by "Add all starred to calendar". */
export async function exportMany(
  events: EventItem[],
  opts: { calendarId?: string | null } = {},
): Promise<{ added: number; skipped: number; errors: string[] }> {
  const access = await requestAccess();
  if (!access.granted) return { added: 0, skipped: events.length, errors: [access.reason ?? ''] };

  let added = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const event of events) {
    if (event.calendarEventId) {
      skipped += 1;
      continue;
    }
    const res = await exportEvent(event, opts);
    if (res.ok) added += 1;
    else {
      skipped += 1;
      if (res.error) errors.push(`${event.title}: ${res.error}`);
    }
  }
  return { added, skipped, errors };
}
