import AsyncStorage from '@react-native-async-storage/async-storage';

import { OpenAiBackendId } from '../openai/catalog';
import { clamp } from '../util';

/**
 * Rotation state for the free model pool.
 *
 * The pool's job is to spread a turn across several free tiers and to stop
 * asking a backend that has just told us to go away. Two rules shape everything
 * here:
 *
 *  1. **Quotas are learned, not configured.** Free tiers publish limits that
 *     change without notice, so the only reliable signal is a 429 with its
 *     `Retry-After`. A backend that rate limits is benched for as long as it
 *     asked for, and longer each time it happens again in a row.
 *  2. **Health outlives the process.** Background sweeps and cold starts would
 *     otherwise walk straight back into a backend that is out of quota for the
 *     day, so this lives in AsyncStorage rather than in memory.
 *
 * Keys never appear here — those stay in `expo-secure-store`. This file holds
 * only timings and counters.
 */

const STORAGE_KEY = 'scout.pool.health.v1';

/** Escalating bench times for consecutive failures, when the backend gives no hint. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 3 * 60 * 60_000];
/** A rejected key will not fix itself; stop asking until the user edits it. */
const AUTH_BENCH_MS = 24 * 60 * 60_000;
/** A transport blip deserves far less than a quota refusal. */
const NETWORK_BENCH_MS = 30_000;
/**
 * Ceiling on a *learned* bench, so a backend claiming a week-long `Retry-After`
 * cannot strand the pool. The auth bench is exempt: it is a decision rather than
 * a guess, and it clears the moment the user saves a new key.
 */
const MAX_BENCH_MS = 6 * 60 * 60_000;

export interface BackendHealth {
  /** Epoch ms before which this backend should not be asked again. */
  benchedUntil: number;
  /** Consecutive failures; reset by any success. */
  strikes: number;
  /** Last failure message, for the Settings screen. */
  lastError: string | null;
  lastErrorAt: number | null;
  lastOkAt: number | null;
  /** Set when the key itself was refused, so the UI can say so plainly. */
  keyRejected: boolean;
  /** Lifetime counters, purely informational. */
  successes: number;
  failures: number;
}

interface PoolState {
  /** Round-robin position, so consecutive turns do not all land on one backend. */
  cursor: number;
  health: Record<string, BackendHealth>;
}

const EMPTY_HEALTH: BackendHealth = {
  benchedUntil: 0,
  strikes: 0,
  lastError: null,
  lastErrorAt: null,
  lastOkAt: null,
  keyRejected: false,
  successes: 0,
  failures: 0,
};

// Read once, then kept in memory: the pool is consulted on every turn and every
// background sweep, and a disk read per turn buys nothing.
let cache: PoolState | null = null;
let writeQueue: Promise<void> = Promise.resolve();

async function load(): Promise<PoolState> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<PoolState>) : {};
    cache = {
      cursor: typeof parsed.cursor === 'number' ? parsed.cursor : 0,
      health: parsed.health ?? {},
    };
  } catch {
    cache = { cursor: 0, health: {} };
  }
  return cache;
}

/** Serialised so two turns finishing together cannot lose one another's write. */
function persist(): void {
  const snapshot = cache;
  if (!snapshot) return;
  writeQueue = writeQueue
    .then(() => AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)))
    .catch(() => {
      /* health is best-effort; a failed write must not break a turn */
    });
}

function healthOf(state: PoolState, id: string): BackendHealth {
  return state.health[id] ?? { ...EMPTY_HEALTH };
}

export async function readHealth(): Promise<Record<string, BackendHealth>> {
  const state = await load();
  return { ...state.health };
}

export function isBenched(health: BackendHealth, now = Date.now()): boolean {
  return health.benchedUntil > now;
}

/**
 * Orders candidates for one turn.
 *
 * Ready backends come first in round-robin order; benched ones follow, soonest
 * to free up first. The benched tail is deliberate — if every backend is out of
 * quota it is better to try the least-recently-refused one and let the user see
 * a real error than to refuse to make a request at all.
 */
export async function orderCandidates<T extends { id: string }>(members: T[]): Promise<T[]> {
  if (members.length <= 1) return members;
  const state = await load();
  const now = Date.now();

  const start = state.cursor % members.length;
  const rotated = [...members.slice(start), ...members.slice(0, start)];

  const ready = rotated.filter((m) => !isBenched(healthOf(state, m.id), now));
  const benched = rotated
    .filter((m) => isBenched(healthOf(state, m.id), now))
    .sort((a, b) => healthOf(state, a.id).benchedUntil - healthOf(state, b.id).benchedUntil);

  return [...ready, ...benched];
}

/** Advances the round-robin cursor past the backend that just answered. */
export async function advanceCursor(members: { id: string }[], usedId: string): Promise<void> {
  if (members.length <= 1) return;
  const state = await load();
  const index = members.findIndex((m) => m.id === usedId);
  state.cursor = ((index === -1 ? state.cursor : index) + 1) % members.length;
  persist();
}

export async function recordSuccess(id: string): Promise<void> {
  const state = await load();
  const current = healthOf(state, id);
  state.health[id] = {
    ...current,
    benchedUntil: 0,
    strikes: 0,
    lastError: null,
    keyRejected: false,
    lastOkAt: Date.now(),
    successes: current.successes + 1,
  };
  persist();
}

export interface FailureInfo {
  message: string;
  /** The backend's own `Retry-After`, when it sent one. */
  retryAfterMs?: number | null;
  /** The key was refused rather than the quota exhausted. */
  authFailure?: boolean;
  /** A transport failure rather than a decision by the backend. */
  network?: boolean;
}

export async function recordFailure(id: string, info: FailureInfo): Promise<void> {
  const state = await load();
  const current = healthOf(state, id);
  const strikes = current.strikes + 1;

  const bench = (() => {
    if (info.authFailure) return AUTH_BENCH_MS;
    if (info.retryAfterMs && info.retryAfterMs > 0) {
      // Trust the backend, but never below a second — some send `Retry-After: 0`
      // on a limit that has genuinely not reset yet.
      return clamp(info.retryAfterMs, 1_000, MAX_BENCH_MS);
    }
    if (info.network) return NETWORK_BENCH_MS;
    return BACKOFF_MS[Math.min(strikes - 1, BACKOFF_MS.length - 1)];
  })();

  const cap = info.authFailure ? AUTH_BENCH_MS : MAX_BENCH_MS;
  state.health[id] = {
    ...current,
    benchedUntil: Date.now() + Math.min(bench, cap),
    strikes,
    lastError: info.message,
    lastErrorAt: Date.now(),
    keyRejected: !!info.authFailure,
    failures: current.failures + 1,
  };
  persist();
}

/** Clears a bench so the user can retry immediately after fixing a key. */
export async function clearBench(id: string): Promise<void> {
  const state = await load();
  const current = healthOf(state, id);
  state.health[id] = { ...current, benchedUntil: 0, strikes: 0, keyRejected: false, lastError: null };
  persist();
}

/** Drops all history for a backend the user removed. */
export async function forgetBackend(id: OpenAiBackendId | string): Promise<void> {
  const state = await load();
  delete state.health[id];
  persist();
}

/** One line per backend for the Settings screen. */
export function describeHealth(health: BackendHealth, now = Date.now()): string {
  if (health.keyRejected) return 'Key rejected — replace it';
  if (isBenched(health, now)) {
    const seconds = Math.ceil((health.benchedUntil - now) / 1000);
    if (seconds < 90) return `Resting ${seconds}s`;
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 90) return `Resting ${minutes}m`;
    return `Resting ${Math.ceil(minutes / 60)}h`;
  }
  if (health.lastOkAt) return `Ready · ${health.successes} used`;
  if (health.failures) return 'Ready · last attempt failed';
  return 'Ready';
}
