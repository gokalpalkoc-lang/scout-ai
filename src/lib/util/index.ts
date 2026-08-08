/** Small dependency-free helpers used throughout the app. */

let counter = 0;

/** Collision-resistant enough for local rows; not a security token. */
export function uid(prefix = ''): string {
  counter = (counter + 1) % 0xffff;
  const time = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffffff).toString(36);
  return `${prefix}${time}${counter.toString(36)}${rand}`;
}

/** FNV-1a, 32-bit, hex. Fast and good enough for change detection. */
export function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Fold in the length so same-character permutations diverge more.
  h ^= input.length;
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function truncate(s: string, max: number, suffix = '…'): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

/** Normalises a user-typed URL: adds https://, trims trailing junk. */
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withProto);
    if (!u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function titleFromUrl(url: string): string {
  const host = hostOf(url);
  const base = host.split('.')[0] ?? host;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Case/whitespace/punctuation-insensitive key for de-duplicating titles. */
export function slugKey(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Runs `fn`, retrying transient failures with exponential backoff. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; retryable?: (e: unknown) => boolean } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 600;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (opts.retryable && !opts.retryable(e)) throw e;
      if (i < attempts - 1) await sleep(baseMs * 2 ** i + Math.random() * 200);
    }
  }
  throw lastError;
}

/** Resolves after `ms`, aborting the wrapped promise's usefulness. */
export async function withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Groups an array by a derived key, preserving insertion order. */
export function groupBy<T, K extends string>(items: T[], key: (t: T) => K): [K, T[]][] {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return [...map.entries()];
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
