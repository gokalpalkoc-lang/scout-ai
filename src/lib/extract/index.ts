import { Credential } from '../gemini/auth';
import { generateContent } from '../gemini/client';
import { CHANGE_SCHEMA, EXTRACTION_SCHEMA } from '../gemini/schemas';
import { textOf } from '../gemini/types';
import { ExtractedEvent } from '../types';
import { clamp, truncate } from '../util';
import { nowContextLine, parseEventDate } from '../util/date';
import { FetchedPage, TextDiff } from '../web/fetchPage';

/**
 * Wraps Gemini with the prompts and post-processing that turn a scraped page
 * into rows we are willing to store.
 *
 * The model is treated as a lossy extractor, not an oracle: everything it
 * returns is re-validated here (dates parsed, URLs sanity-checked, duplicates
 * merged, absurd horizons discarded) before it reaches the database.
 */

/** Page text is capped so a bloated page cannot blow the request up. */
const MAX_PAGE_CHARS = 120_000;
const MAX_JSONLD_CHARS = 20_000;

export interface ExtractionResult {
  events: ExtractedEvent[];
  pageKind: 'listing' | 'single' | 'none' | 'blocked';
  note: string;
  /** True when the page yielded no usable text — worth telling the user. */
  unreadable: boolean;
}

interface RawEvent {
  title?: string;
  startsAt?: string;
  endsAt?: string;
  allDay?: boolean;
  location?: string;
  url?: string;
  price?: string;
  category?: string;
  description?: string;
  deadlineAt?: string;
  deadlineLabel?: string;
  confidence?: number;
}

interface RawExtraction {
  pageKind?: string;
  events?: RawEvent[];
  note?: string;
}

function buildExtractionPrompt(page: FetchedPage, hint: string | null): string {
  const parts: string[] = [];

  parts.push(`Right now it is ${nowContextLine()}.`);
  parts.push(
    `Extract every event, session, deadline or dated item published on this page. ` +
      `Return them in chronological order.`,
  );
  parts.push(
    [
      'Rules:',
      '- Only report items that are actually on the page. Never invent, complete or guess an event.',
      '- Resolve relative dates ("this Saturday", "next month") against the current date above.',
      '- A year is often omitted. Choose the year that makes the date fall in the next 12 months.',
      '- Turkish, German and other non-English month names are common — handle them.',
      '- Take each event\'s url from the <...> markers that follow its title in the text.',
      '- If the page shows a registration or application cutoff, put it in deadlineAt, not startsAt.',
      '- Skip navigation, past-event archives older than a month, adverts and cookie notices.',
      '- If the page is a cookie wall, a login screen or an empty JavaScript shell, return pageKind "blocked" and no events.',
      '- Merge duplicates: the same event listed twice on the page is one event.',
    ].join('\n'),
  );

  if (hint?.trim()) {
    parts.push(`The user's instruction for this page, follow it closely: "${hint.trim()}"`);
  }

  parts.push(`SOURCE URL: ${page.finalUrl}`);
  if (page.page.title) parts.push(`PAGE TITLE: ${page.page.title}`);

  if (page.jsonLdSummary) {
    parts.push(
      `STRUCTURED DATA the site publishes about itself. This is authoritative — prefer it over the page text wherever they disagree:\n${truncate(
        page.jsonLdSummary,
        MAX_JSONLD_CHARS,
      )}`,
    );
  }

  parts.push(`PAGE TEXT:\n${truncate(page.page.text, MAX_PAGE_CHARS)}`);

  return parts.join('\n\n');
}

export interface ExtractArgs {
  credential: Credential;
  model: string;
  page: FetchedPage;
  hint: string | null;
  /** Ignore anything starting further out than this. */
  horizonDays?: number;
  signal?: AbortSignal;
}

export async function extractEvents({
  credential,
  model,
  page,
  hint,
  horizonDays = 400,
  signal,
}: ExtractArgs): Promise<ExtractionResult> {
  // Don't spend a request on a page that has no text to read.
  if (page.page.looksEmpty && !page.jsonLdSummary) {
    return {
      events: [],
      pageKind: 'blocked',
      note: 'The page returned almost no readable text. It probably renders its content with JavaScript, which Scout cannot run.',
      unreadable: true,
    };
  }

  const res = await generateContent({
    credential,
    model,
    signal,
    request: {
      systemInstruction: {
        parts: [
          {
            text:
              'You are a precise event-listing extractor. You read scraped web pages and return ' +
              'structured events. You never fabricate data: an empty string is always better than ' +
              'a guess, and a low confidence score is always better than a confident mistake.',
          },
        ],
      },
      contents: [{ role: 'user', parts: [{ text: buildExtractionPrompt(page, hint) }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: EXTRACTION_SCHEMA,
        maxOutputTokens: 32_768,
      },
    },
  });

  const raw = parseJson<RawExtraction>(textOf(res));
  if (!raw) {
    return {
      events: [],
      pageKind: 'none',
      note: 'Gemini did not return usable JSON for this page.',
      unreadable: false,
    };
  }

  const events = sanitizeEvents(raw.events ?? [], page.finalUrl, horizonDays);

  return {
    events,
    pageKind: (['listing', 'single', 'none', 'blocked'] as const).includes(raw.pageKind as never)
      ? (raw.pageKind as ExtractionResult['pageKind'])
      : events.length
        ? 'listing'
        : 'none',
    note: (raw.note ?? '').trim() || (events.length ? `Found ${events.length} event(s).` : ''),
    unreadable: raw.pageKind === 'blocked',
  };
}

function parseJson<T>(text: string): T | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Salvage the outermost JSON object if the model wrapped it in prose.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
}

const EMPTY_MARKERS = /^(n\/?a|none|unknown|tbd|tba|null|undefined|-|—|not specified)$/i;

function clean(value: string | undefined | null): string | null {
  const v = (value ?? '').trim();
  if (!v || EMPTY_MARKERS.test(v)) return null;
  return v;
}

/** Normalises loose ISO-ish strings the model may emit. */
function cleanDate(value: string | undefined): string | null {
  const v = clean(value);
  if (!v) return null;

  // Accept "2026-09-14 20:30" as well as the ISO "T" form.
  const candidate = v.replace(' ', 'T').replace(/Z$/, '');
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.exec(candidate);
  if (dateOnly) return candidate;

  const dateTime = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(candidate);
  if (dateTime) return `${dateTime[1]}T${dateTime[2]}:${dateTime[3]}`;

  // Anything else: only keep it if Date can make sense of it.
  const parsed = parseEventDate(candidate);
  if (!parsed) return null;
  const iso = parsed.toISOString();
  return iso.slice(0, 16);
}

function cleanUrl(value: string | undefined, base: string): string | null {
  const v = clean(value);
  if (!v) return null;
  try {
    const u = new URL(v, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Validates and de-duplicates a model batch. Anything without a title is
 * dropped; anything with an implausible date loses its date rather than the
 * whole row, since an undated event a user can still click through is useful.
 */
export function sanitizeEvents(
  raw: RawEvent[],
  baseUrl: string,
  horizonDays: number,
): ExtractedEvent[] {
  const horizonMs = Date.now() + horizonDays * 86_400_000;
  const floorMs = Date.now() - 45 * 86_400_000;
  const byKey = new Map<string, ExtractedEvent>();

  for (const r of raw) {
    const title = clean(r.title);
    if (!title || title.length < 2) continue;

    let startsAt = cleanDate(r.startsAt);
    const startDate = parseEventDate(startsAt);
    if (startDate) {
      const t = startDate.getTime();
      // A date far outside a sensible window is a parsing artefact, not an event.
      if (t > horizonMs || t < floorMs) startsAt = null;
    }

    const endsAt = cleanDate(r.endsAt);
    const deadlineAt = cleanDate(r.deadlineAt);

    const event: ExtractedEvent = {
      title: truncate(title, 200),
      description: clean(r.description) ? truncate(clean(r.description)!, 1200) : null,
      startsAt,
      // Drop an end date that precedes the start.
      endsAt:
        endsAt && startsAt && (parseEventDate(endsAt)?.getTime() ?? 0) < (startDate?.getTime() ?? 0)
          ? null
          : endsAt,
      // A date-only value is all-day whatever the model claimed.
      allDay: !startsAt || startsAt.length <= 10 ? true : (r.allDay ?? false),
      location: clean(r.location) ? truncate(clean(r.location)!, 200) : null,
      url: cleanUrl(r.url, baseUrl),
      price: clean(r.price) ? truncate(clean(r.price)!, 60) : null,
      category: clean(r.category)?.toLowerCase().slice(0, 30) ?? null,
      deadlineAt,
      deadlineLabel: deadlineAt ? (clean(r.deadlineLabel) ?? 'registration') : null,
      confidence: clamp(typeof r.confidence === 'number' ? r.confidence : 0.5, 0, 1),
    };

    // Same title on the same day is the same event, however it was listed.
    const key = `${event.title.toLowerCase().replace(/\s+/g, ' ')}|${event.startsAt?.slice(0, 10) ?? ''}`;
    const existing = byKey.get(key);
    if (!existing || event.confidence > existing.confidence) byKey.set(key, event);
  }

  return [...byKey.values()].sort((a, b) => {
    const at = parseEventDate(a.startsAt)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bt = parseEventDate(b.startsAt)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return at - bt;
  });
}

// ------------------------------------------------------------ change summaries

export interface ChangeVerdict {
  significant: boolean;
  headline: string;
  detail: string;
  kind: string;
}

/**
 * Asks the model whether a diff is worth a notification.
 *
 * This is the difference between a useful watcher and one you mute: a hash
 * change fires on rotating banners and view counters, so the diff gets judged
 * before anything reaches the notification tray.
 */
export async function summarizeChange({
  credential,
  model,
  title,
  url,
  diff,
  signal,
}: {
  credential: Credential;
  model: string;
  title: string;
  url: string;
  diff: TextDiff;
  signal?: AbortSignal;
}): Promise<ChangeVerdict> {
  const prompt = [
    `The page "${title}" (${url}) changed since the last check. Today is ${nowContextLine()}.`,
    'Decide whether someone watching this page would want a notification.',
    'Treat as NOT significant: rotating banners, view/like counters, timestamps, adverts, reordering, cookie notices, unchanged content in a new wrapper.',
    'Treat as significant: a new listing or event, a removed listing, a changed date or venue, a new deadline, an opened or closed registration.',
    '',
    'Lines added (+) and removed (-):',
    truncate(diff.summary, 12_000) || '(no line-level differences captured)',
  ].join('\n');

  const res = await generateContent({
    credential,
    model,
    signal,
    request: {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: CHANGE_SCHEMA,
        maxOutputTokens: 2048,
      },
    },
  });

  const raw = parseJson<Partial<ChangeVerdict>>(textOf(res));
  if (!raw) {
    return {
      significant: false,
      headline: 'Page changed',
      detail: 'Scout could not classify the change.',
      kind: 'content-edit',
    };
  }

  return {
    significant: !!raw.significant,
    headline: truncate((raw.headline ?? 'Page changed').trim(), 100),
    detail: (raw.detail ?? '').trim(),
    kind: raw.kind ?? 'content-edit',
  };
}
