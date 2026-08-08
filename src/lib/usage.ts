import AsyncStorage from '@react-native-async-storage/async-storage';

import { UsageMetadata } from './gemini/types';
import { errorMessage } from './util';
import { todayISO } from './util/date';

/**
 * Local token accounting.
 *
 * Google does not expose a per-key consumption API, so the only honest way to
 * show "what have I spent" is to add up what every response reports. Kept in
 * AsyncStorage (not the Zustand store) because background checks write to it
 * from outside React.
 */

const STORAGE_KEY = 'scout.usage.v1';
const KEEP_DAYS = 60;

export interface DayUsage {
  /** YYYY-MM-DD, local time. */
  day: string;
  requests: number;
  promptTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
}

export interface UsageLedger {
  days: DayUsage[];
  byModel: Record<string, { requests: number; totalTokens: number }>;
  since: number;
}

const EMPTY: UsageLedger = { days: [], byModel: {}, since: Date.now() };

let cache: UsageLedger | null = null;
let writeQueue: Promise<void> = Promise.resolve();
const listeners = new Set<(ledger: UsageLedger) => void>();

export async function loadUsage(): Promise<UsageLedger> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    cache = raw ? { ...EMPTY, ...(JSON.parse(raw) as UsageLedger) } : { ...EMPTY };
  } catch {
    cache = { ...EMPTY };
  }
  return cache;
}

function emit(ledger: UsageLedger) {
  for (const l of listeners) {
    try {
      l(ledger);
    } catch {
      /* a bad listener must not stop the others */
    }
  }
}

export function subscribeUsage(fn: (ledger: UsageLedger) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Adds one response's usage to the ledger. Fire-and-forget by design. */
export function recordUsage(model: string, usage: UsageMetadata | undefined): void {
  writeQueue = writeQueue
    .then(async () => {
      const ledger = await loadUsage();
      const day = todayISO();
      const prompt = usage?.promptTokenCount ?? 0;
      const output = usage?.candidatesTokenCount ?? 0;
      const thoughts = usage?.thoughtsTokenCount ?? 0;
      const total = usage?.totalTokenCount ?? prompt + output + thoughts;

      let entry = ledger.days.find((d) => d.day === day);
      if (!entry) {
        entry = {
          day,
          requests: 0,
          promptTokens: 0,
          outputTokens: 0,
          thoughtTokens: 0,
          totalTokens: 0,
        };
        ledger.days.push(entry);
      }
      entry.requests += 1;
      entry.promptTokens += prompt;
      entry.outputTokens += output;
      entry.thoughtTokens += thoughts;
      entry.totalTokens += total;

      const perModel = ledger.byModel[model] ?? { requests: 0, totalTokens: 0 };
      perModel.requests += 1;
      perModel.totalTokens += total;
      ledger.byModel[model] = perModel;

      ledger.days.sort((a, b) => a.day.localeCompare(b.day));
      if (ledger.days.length > KEEP_DAYS) ledger.days = ledger.days.slice(-KEEP_DAYS);

      cache = ledger;
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(ledger));
      emit(ledger);
    })
    .catch((e) => {
      console.warn('[usage] could not record usage', errorMessage(e));
    });
}

export async function resetUsage(): Promise<void> {
  cache = { ...EMPTY, since: Date.now() };
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  emit(cache);
}

export interface UsageSummary {
  today: DayUsage;
  last7Days: DayUsage;
  allTime: DayUsage;
  topModels: { model: string; requests: number; totalTokens: number }[];
  /** Per-day totals for the sparkline, oldest first, padded to 14 entries. */
  trend: { day: string; totalTokens: number }[];
  since: number;
}

const zeroDay = (day: string): DayUsage => ({
  day,
  requests: 0,
  promptTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  totalTokens: 0,
});

function sum(days: DayUsage[], label: string): DayUsage {
  return days.reduce<DayUsage>(
    (acc, d) => ({
      day: label,
      requests: acc.requests + d.requests,
      promptTokens: acc.promptTokens + d.promptTokens,
      outputTokens: acc.outputTokens + d.outputTokens,
      thoughtTokens: acc.thoughtTokens + d.thoughtTokens,
      totalTokens: acc.totalTokens + d.totalTokens,
    }),
    zeroDay(label),
  );
}

export function summarize(ledger: UsageLedger): UsageSummary {
  const today = todayISO();
  const days = ledger.days;

  const cutoff7 = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  const trendDays: { day: string; totalTokens: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    trendDays.push({ day: d, totalTokens: days.find((x) => x.day === d)?.totalTokens ?? 0 });
  }

  return {
    today: days.find((d) => d.day === today) ?? zeroDay(today),
    last7Days: sum(
      days.filter((d) => d.day >= cutoff7),
      'last 7 days',
    ),
    allTime: sum(days, 'all time'),
    topModels: Object.entries(ledger.byModel)
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 5),
    trend: trendDays,
    since: ledger.since,
  };
}

/** "12.4k" / "1.2M" — token counts get large fast. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
