import { errorMessage, hash, truncate, withTimeout } from '../util';
import { PageText, htmlToText, summarizeJsonLdEvents } from './htmlToText';

/** Pretend to be a normal browser; many sites 403 an unknown agent. */
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

const MAX_BYTES = 3_000_000;
const FETCH_TIMEOUT_MS = 30_000;

export interface FetchedPage {
  url: string;
  /** Final URL after redirects. */
  finalUrl: string;
  status: number;
  contentType: string;
  page: PageText;
  /** JSON-LD events rendered as terse lines, or '' when none were published. */
  jsonLdSummary: string;
  /** Hash of the normalised text — the change-detection key. */
  hash: string;
  fetchedAt: number;
  bytes: number;
  truncated: boolean;
}

export class FetchError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'FetchError';
    this.status = status;
  }
}

/** Downloads a page and reduces it to text plus a change hash. */
export async function fetchPage(url: string): Promise<FetchedPage> {
  let res: Response;
  try {
    res = await withTimeout(
      fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en;q=0.9,*;q=0.5',
          'Cache-Control': 'no-cache',
        },
        redirect: 'follow',
      }),
      FETCH_TIMEOUT_MS,
      `Fetching ${url}`,
    );
  } catch (e) {
    throw new FetchError(`Could not reach the page: ${errorMessage(e)}`);
  }

  const contentType = res.headers.get('content-type') ?? '';

  if (!res.ok) {
    const hint =
      res.status === 403
        ? ' The site is blocking automated requests.'
        : res.status === 404
          ? ' Check the URL is still valid.'
          : res.status === 429
            ? ' The site is rate-limiting us; try a longer check interval.'
            : '';
    throw new FetchError(`Site returned HTTP ${res.status}.${hint}`, res.status);
  }

  if (contentType && !/text\/|html|xml|json|rss|atom/i.test(contentType)) {
    throw new FetchError(`Unsupported content type "${contentType}" — Scout reads web pages.`, 415);
  }

  let body: string;
  try {
    body = await res.text();
  } catch (e) {
    throw new FetchError(`Could not read the response body: ${errorMessage(e)}`);
  }

  const bytes = body.length;
  const truncated = bytes > MAX_BYTES;
  if (truncated) body = body.slice(0, MAX_BYTES);

  const isFeed = /xml|rss|atom/i.test(contentType) || /^\s*<\?xml/.test(body);
  const page = isFeed ? feedToText(body) : htmlToText(body, res.url || url);

  return {
    url,
    finalUrl: res.url || url,
    status: res.status,
    contentType,
    page,
    jsonLdSummary: summarizeJsonLdEvents(page.jsonLd),
    hash: hash(normalizeForHash(page.text)),
    fetchedAt: Date.now(),
    bytes,
    truncated,
  };
}

/**
 * RSS/Atom is common on event pages and much cleaner than HTML — handle it
 * directly instead of running the HTML path over it.
 */
function feedToText(xml: string): PageText {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(xml)?.[1] ?? '';
  const itemRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  const lines: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = itemRe.exec(xml)) !== null && lines.length < 200) {
    const block = m[2];
    const pick = (tag: string) => {
      const value = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i').exec(block)?.[1];
      return (value ?? '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    };
    const link =
      pick('link') || /<link[^>]+href=["']([^"']+)["']/i.exec(block)?.[1]?.trim() || '';
    const parts = [
      pick('title'),
      pick('pubDate') || pick('published') || pick('updated'),
      truncate(pick('description') || pick('summary') || pick('content'), 300),
      link ? `<${link}>` : '',
    ].filter(Boolean);
    lines.push(`• ${parts.join(' | ')}`);
  }

  const text = lines.join('\n');
  return {
    title: title.replace(/<[^>]*>/g, '').trim(),
    description: '',
    text,
    jsonLd: [],
    looksEmpty: text.length < 40,
  };
}

/**
 * Strips the parts of a page that churn without meaning — timestamps, counters,
 * cache-busting ids — so a hash comparison flags real content changes only.
 */
export function normalizeForHash(text: string): string {
  return text
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '<t>')
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.+Z-]+/g, '<ts>')
    .replace(/\?[a-z_]*(v|ver|version|cb|t|ts|_)=\d+/gi, '')
    .replace(/\b(csrf|nonce|token|session|sid)[=:]\s*[\w-]+/gi, '')
    .replace(/\b\d+\s*(views?|comments?|likes?|shares?|online|users?)\b/gi, '<n> $1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface TextDiff {
  changed: boolean;
  added: string[];
  removed: string[];
  /** Rendered for the model / the UI: "+ new line" / "- gone line". */
  summary: string;
}

/**
 * Line-level set difference between two snapshots.
 *
 * A full LCS diff would be overkill: what matters for a watch is "which lines
 * exist now that did not before", which is exactly what a listing page shows
 * when a new event is posted.
 */
export function diffText(previous: string, current: string, maxLines = 60): TextDiff {
  const norm = (s: string) =>
    s
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 2);

  const before = norm(previous);
  const after = norm(current);
  const beforeSet = new Set(before.map((l) => l.toLowerCase()));
  const afterSet = new Set(after.map((l) => l.toLowerCase()));

  const added = after.filter((l) => !beforeSet.has(l.toLowerCase()));
  const removed = before.filter((l) => !afterSet.has(l.toLowerCase()));

  const summary = [
    ...added.slice(0, maxLines).map((l) => `+ ${truncate(l, 220)}`),
    ...removed.slice(0, Math.max(0, Math.floor(maxLines / 3))).map((l) => `- ${truncate(l, 160)}`),
  ].join('\n');

  return {
    changed: added.length > 0 || removed.length > 0,
    added,
    removed,
    summary,
  };
}
