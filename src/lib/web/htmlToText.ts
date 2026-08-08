/**
 * Turns a raw HTML page into compact, model-friendly text.
 *
 * The goal is not a faithful render — it is to preserve exactly the signals an
 * event extractor needs while cutting the token count by an order of magnitude:
 *
 *  - `<time datetime>` machine dates, surfaced inline as `text [2026-09-14]`
 *  - link targets, so an extracted event can carry a real URL
 *  - list and table structure, because listings are nearly always one or other
 *  - schema.org JSON-LD, pulled out separately — when a site publishes it, it
 *    is far more reliable than anything scraped from the prose
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  euro: '€',
  pound: '£',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
  szlig: 'ß',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  ccedil: 'ç',
  Ccedil: 'Ç',
  ge: '≥',
  le: '≤',
  shy: '',
  zwj: '',
  zwnj: '',
};

export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,10});/g, (m, name: string) =>
      name in ENTITIES ? ENTITIES[name] : m,
    );
}

function safeCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return '';
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

/** Elements whose contents carry no readable value. */
const DROP_TAGS = [
  'script',
  'style',
  'noscript',
  'svg',
  'canvas',
  'iframe',
  'template',
  'form',
  'select',
  'button',
  'picture',
  'source',
  'video',
  'audio',
  'map',
];

const BLOCK_TAGS = [
  'p',
  'div',
  'section',
  'article',
  'main',
  'aside',
  'header',
  'footer',
  'nav',
  'ul',
  'ol',
  'dl',
  'dd',
  'dt',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'figure',
  'figcaption',
  'blockquote',
  'address',
  'fieldset',
  'details',
  'summary',
  'hr',
];

export interface PageText {
  /** Page `<title>`. */
  title: string;
  /** `<meta name="description">` or the OpenGraph equivalent. */
  description: string;
  /** Cleaned body text. */
  text: string;
  /** schema.org objects found in `application/ld+json` blocks. */
  jsonLd: unknown[];
  /** True when the page yielded almost no text — usually a JS-rendered site. */
  looksEmpty: boolean;
}

export function htmlToText(html: string, baseUrl?: string): PageText {
  const title = decodeEntities(
    (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim(),
  );

  const description = decodeEntities(
    (
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ??
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ??
      ''
    ).trim(),
  );

  const jsonLd = extractJsonLd(html);
  const base = resolveBase(html, baseUrl);

  let s = html;

  // Comments and conditional blocks.
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ');
  s = s.replace(/<!DOCTYPE[^>]*>/gi, ' ');

  // Whole subtrees with no readable content.
  for (const tag of DROP_TAGS) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
    s = s.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), ' ');
  }
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ');

  // Machine-readable dates are the single most valuable signal on an event page.
  s = s.replace(
    /<time\b[^>]*\bdatetime=["']([^"']+)["'][^>]*>([\s\S]*?)<\/time\s*>/gi,
    (_m, dt: string, inner: string) => ` ${inner} [${dt.trim()}] `,
  );
  s = s.replace(/<\/?time\b[^>]*>/gi, ' ');

  // Keep alt text; it often holds a poster's title.
  s = s.replace(/<img\b[^>]*\balt=["']([^"']{3,120})["'][^>]*>/gi, ' [image: $1] ');
  s = s.replace(/<img\b[^>]*>/gi, ' ');

  // Links become "label <absolute-url>" so the extractor can attach a real URL.
  s = s.replace(
    /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_m, href: string, label: string) => {
      const text = stripTags(label).replace(/\s+/g, ' ').trim();
      const abs = absolutize(href.trim(), base);
      if (!text) return abs && isContentLink(abs) ? ` <${abs}> ` : ' ';
      if (!abs || !isContentLink(abs)) return ` ${text} `;
      return ` ${text} <${abs}> `;
    },
  );
  s = s.replace(/<\/?a\b[^>]*>/gi, ' ');

  // Headings get a marker so the model can see page structure.
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, level: string, inner: string) => {
    const text = stripTags(inner).replace(/\s+/g, ' ').trim();
    return text ? `\n\n${'#'.repeat(Number(level))} ${text}\n` : '\n';
  });

  s = s.replace(/<br\b[^>]*>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n• ');
  s = s.replace(/<\/li\s*>/gi, ' ');
  s = s.replace(/<tr\b[^>]*>/gi, '\n');
  s = s.replace(/<\/(td|th)\s*>/gi, ' | ');
  s = s.replace(/<(td|th)\b[^>]*>/gi, ' ');

  for (const tag of BLOCK_TAGS) {
    s = s.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), '\n');
  }

  s = stripTags(s);
  s = decodeEntities(s);

  s = s
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0\u200b\u2009\u202f\ufeff]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    // A lone separator adds noise once the table markup is gone.
    .map((line) => (/^[|•\-–—\s]*$/.test(line) ? '' : line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  s = collapseRepeats(s);

  return {
    title,
    description,
    text: s,
    jsonLd,
    looksEmpty: s.replace(/\s/g, '').length < 200,
  };
}

/**
 * Removes leftover markup.
 *
 * The negative lookahead matters: link targets are emitted as `<https://…>`
 * markers earlier in the pipeline, and a naive tag-strip would delete every one
 * of them along with the real tags.
 */
function stripTags(s: string): string {
  return s.replace(/<(?!https?:\/\/)[^>]*>/g, ' ');
}

/** Navigation chrome repeated on every page; dropping it saves tokens. */
function collapseRepeats(text: string): string {
  const lines = text.split('\n');
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (const line of lines) {
    if (line.length < 3 || line.length > 60) {
      out.push(line);
      continue;
    }
    const n = (seen.get(line) ?? 0) + 1;
    seen.set(line, n);
    // Keep the first three occurrences; beyond that it is boilerplate.
    if (n <= 3) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Skips share links, mailto, anchors and asset URLs. */
function isContentLink(url: string): boolean {
  if (/^(mailto:|tel:|javascript:|#)/i.test(url)) return false;
  if (/\.(png|jpe?g|gif|webp|svg|ico|css|js|woff2?|ttf|zip)(\?|$)/i.test(url)) return false;
  if (/(facebook|twitter|x)\.com\/(sharer|intent)/i.test(url)) return false;
  return true;
}

function resolveBase(html: string, fallback?: string): string | undefined {
  const declared = /<base[^>]+href=["']([^"']+)["']/i.exec(html)?.[1];
  if (declared) {
    const abs = absolutize(declared, fallback);
    if (abs) return abs;
  }
  return fallback;
}

export function absolutize(href: string, base?: string): string | null {
  if (!href) return null;
  if (/^(mailto:|tel:|javascript:)/i.test(href)) return href;
  try {
    return base ? new URL(href, base).toString() : new URL(href).toString();
  } catch {
    return null;
  }
}

/**
 * Pulls schema.org blocks. Sites that publish `Event` objects hand us exact
 * dates and locations, which beats inferring them from layout every time.
 */
export function extractJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim().replace(/^\/\*[\s\S]*?\*\//, '');
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      out.push(parsed);
    } catch {
      // Some sites emit multiple concatenated objects; try a lenient split.
      for (const piece of raw.split(/}\s*{/)) {
        try {
          out.push(JSON.parse(piece.startsWith('{') ? piece : `{${piece}}`));
        } catch {
          /* give up on this block */
        }
      }
    }
    if (out.length > 40) break;
  }
  return out;
}

/**
 * Flattens JSON-LD down to Event-ish nodes and renders them as terse lines.
 * Passed to the model alongside the page text as high-confidence evidence.
 */
export function summarizeJsonLdEvents(nodes: unknown[]): string {
  const events: Record<string, unknown>[] = [];

  const visit = (node: unknown, depth = 0) => {
    if (!node || depth > 6 || events.length > 80) return;
    if (Array.isArray(node)) {
      node.forEach((n) => visit(n, depth + 1));
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;

    const type = obj['@type'];
    const types = Array.isArray(type) ? type.map(String) : type ? [String(type)] : [];
    if (types.some((t) => /event/i.test(t))) events.push(obj);

    for (const key of ['@graph', 'itemListElement', 'item', 'subEvent', 'events', 'hasPart']) {
      if (key in obj) visit(obj[key], depth + 1);
    }
  };

  nodes.forEach((n) => visit(n));
  if (!events.length) return '';

  const lines = events.slice(0, 60).map((e) => {
    const pick = (k: string): string => {
      const v = e[k];
      if (typeof v === 'string' || typeof v === 'number') return String(v);
      return '';
    };
    const place = (() => {
      const loc = e.location;
      if (typeof loc === 'string') return loc;
      if (loc && typeof loc === 'object') {
        const l = loc as Record<string, unknown>;
        const name = typeof l.name === 'string' ? l.name : '';
        const addr = l.address;
        const addrText =
          typeof addr === 'string'
            ? addr
            : addr && typeof addr === 'object'
              ? Object.values(addr as Record<string, unknown>)
                  .filter((v) => typeof v === 'string')
                  .join(', ')
              : '';
        return [name, addrText].filter(Boolean).join(' — ');
      }
      return '';
    })();

    const fields = [
      ['name', pick('name')],
      ['start', pick('startDate')],
      ['end', pick('endDate')],
      ['location', place],
      ['url', pick('url')],
      ['status', pick('eventStatus')],
      ['description', pick('description').slice(0, 200)],
    ].filter(([, v]) => !!v);

    return fields.map(([k, v]) => `${k}: ${v}`).join(' | ');
  });

  return lines.join('\n');
}
