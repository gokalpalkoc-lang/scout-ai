import {
  addDays,
  differenceInCalendarDays,
  format,
  formatDistanceToNowStrict,
  isValid,
  parseISO,
  startOfDay,
} from 'date-fns';

/**
 * Event dates arrive from the model as either date-only ("2026-09-14") or a full
 * ISO timestamp. Everything downstream goes through these helpers so the two
 * cases render consistently and never shift by a timezone.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function isDateOnly(iso: string | null | undefined): boolean {
  return !!iso && DATE_ONLY.test(iso.trim());
}

/** Parses an event date safely. Date-only values anchor to local midnight. */
export function parseEventDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const trimmed = iso.trim();
  if (!trimmed) return null;
  if (DATE_ONLY.test(trimmed)) {
    const [y, m, d] = trimmed.split('-').map(Number);
    const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
    return isValid(dt) ? dt : null;
  }
  const dt = parseISO(trimmed);
  return isValid(dt) ? dt : null;
}

/** "Sat 14 Sep · 20:30" / "Sat 14 Sep" when no time is known. */
export function formatEventDate(iso: string | null | undefined): string {
  const d = parseEventDate(iso);
  if (!d) return 'Date unknown';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const datePart = format(d, sameYear ? 'EEE d MMM' : 'EEE d MMM yyyy');
  return isDateOnly(iso) ? datePart : `${datePart} · ${format(d, 'HH:mm')}`;
}

/** Heading key used to group the agenda: "Today", "Tomorrow", "Mon 14 Sep". */
export function dayHeading(iso: string | null | undefined): string {
  const d = parseEventDate(iso);
  if (!d) return 'No date';
  const diff = differenceInCalendarDays(d, new Date());
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff < 0) return format(d, 'EEE d MMM yyyy');
  if (diff < 7) return format(d, 'EEEE d MMM');
  return format(d, 'EEE d MMM yyyy');
}

/** Sortable numeric key; undated items sink to the bottom. */
export function sortKey(iso: string | null | undefined): number {
  const d = parseEventDate(iso);
  return d ? d.getTime() : Number.MAX_SAFE_INTEGER;
}

export function daysUntil(iso: string | null | undefined): number | null {
  const d = parseEventDate(iso);
  if (!d) return null;
  return differenceInCalendarDays(startOfDay(d), startOfDay(new Date()));
}

/** "in 3 days" / "2 hours ago". */
export function relative(input: string | number | Date | null | undefined): string {
  if (input === null || input === undefined) return 'never';
  const d =
    typeof input === 'number' ? new Date(input) : input instanceof Date ? input : parseEventDate(input);
  if (!d || !isValid(d)) return 'unknown';
  try {
    return formatDistanceToNowStrict(d, { addSuffix: true });
  } catch {
    return 'unknown';
  }
}

export function isPast(iso: string | null | undefined): boolean {
  const d = parseEventDate(iso);
  if (!d) return false;
  // Date-only events count as "today" for the whole day.
  const end = isDateOnly(iso) ? addDays(startOfDay(d), 1) : d;
  return end.getTime() < Date.now();
}

/** Today's date as YYYY-MM-DD in local time — used to ground the model. */
export function todayISO(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

export function nowContextLine(): string {
  const now = new Date();
  return `${format(now, "EEEE d MMMM yyyy, HH:mm")} (local time, timezone offset ${
    -now.getTimezoneOffset() / 60
  }h)`;
}

export function formatClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Next occurrence of hour:minute (optionally on a weekday), in the future. */
export function nextOccurrence(hour: number, minute: number, weekday?: number): Date {
  const now = new Date();
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (weekday !== undefined) {
    // expo weekday is 1..7 with 1 = Sunday; JS getDay() is 0..6 with 0 = Sunday.
    const targetDow = (weekday - 1) % 7;
    let delta = (targetDow - d.getDay() + 7) % 7;
    if (delta === 0 && d.getTime() <= now.getTime()) delta = 7;
    d.setDate(d.getDate() + delta);
    return d;
  }
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}
