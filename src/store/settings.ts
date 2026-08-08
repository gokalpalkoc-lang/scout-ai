import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { AssistantProvider } from '../lib/ai/contract';
import { AnthropicModelInfo } from '../lib/anthropic/types';
import { ProviderId } from '../lib/gemini/auth';
import { ModelInfo } from '../lib/gemini/types';
import { ThemePreference } from '../theme';

const STORAGE_KEY = 'scout.settings.v1';

export interface Settings {
  // -------------------------------------------------------- assistant provider
  /** Which model answers you in the Assistant tab and authors rules/modules. */
  assistantProvider: AssistantProvider;
  claudeModel: string;
  /** Claude's thinking-depth dial; `high` is the API default. */
  claudeEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  knownClaudeModels: AnthropicModelInfo[];
  claudeModelsFetchedAt: number | null;
  claudeVerifiedAt: number | null;

  // ------------------------------------------------------------ Gemini access
  provider: ProviderId;
  vertexProject: string;
  vertexLocation: string;
  /** Model used for chat and routines. */
  chatModel: string;
  /** Model used for page extraction — usually a cheaper one. */
  extractModel: string;
  /** Models discovered from the live API; falls back to a curated list. */
  knownModels: ModelInfo[];
  modelsFetchedAt: number | null;
  credentialVerifiedAt: number | null;

  // ----------------------------------------------------------------- behaviour
  /** Let the assistant use Google Search grounding for questions about the web. */
  webGrounding: boolean;
  streamResponses: boolean;
  /** Ignore extracted events further out than this many days. */
  horizonDays: number;
  /** Interval applied to newly added sources. */
  defaultCheckIntervalMin: number;
  /** Only surface events the model was at least this confident about. */
  minConfidence: number;

  // ------------------------------------------------------------- notifications
  notifyNewEvents: boolean;
  notifyChanges: boolean;
  notifyErrors: boolean;
  autoDeadlineReminders: boolean;
  /** Days before a deadline to fire a reminder, e.g. [7, 1]. */
  deadlineReminderDays: number[];

  // --------------------------------------------------------------- background
  backgroundEnabled: boolean;
  /** Requested OS wake interval in minutes; the system may run it less often. */
  backgroundIntervalMin: number;
  /** Skip background work when the app has not been opened in this many days. */
  backgroundPauseAfterDays: number;
  lastBackgroundRunAt: number | null;
  lastForegroundSweepAt: number | null;

  // ------------------------------------------------------------------ interface
  theme: ThemePreference;
  compactEvents: boolean;
  hasOnboarded: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  assistantProvider: 'gemini',
  claudeModel: 'claude-opus-5',
  claudeEffort: 'high',
  knownClaudeModels: [],
  claudeModelsFetchedAt: null,
  claudeVerifiedAt: null,

  provider: 'aistudio',
  vertexProject: '',
  vertexLocation: 'us-central1',
  chatModel: 'gemini-2.5-flash',
  extractModel: 'gemini-2.5-flash',
  knownModels: [],
  modelsFetchedAt: null,
  credentialVerifiedAt: null,

  webGrounding: true,
  streamResponses: true,
  horizonDays: 400,
  defaultCheckIntervalMin: 720,
  minConfidence: 0.35,

  notifyNewEvents: true,
  notifyChanges: true,
  notifyErrors: false,
  autoDeadlineReminders: true,
  deadlineReminderDays: [7, 1],

  backgroundEnabled: true,
  backgroundIntervalMin: 240,
  backgroundPauseAfterDays: 14,
  lastBackgroundRunAt: null,
  lastForegroundSweepAt: null,

  theme: 'system',
  compactEvents: false,
  hasOnboarded: false,
};

interface SettingsState extends Settings {
  hydrated: boolean;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  patch: (patch: Partial<Settings>) => void;
  reset: () => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      hydrated: false,
      set: (key, value) => set({ [key]: value } as Partial<SettingsState>),
      patch: (patch) => set(patch as Partial<SettingsState>),
      reset: () => set({ ...DEFAULT_SETTINGS }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => AsyncStorage),
      // `hydrated` is runtime-only; everything else round-trips.
      partialize: ({ hydrated: _hydrated, set: _set, patch: _patch, reset: _reset, ...rest }) =>
        rest as Settings,
      onRehydrateStorage: () => () => {
        useSettings.setState({ hydrated: true });
      },
    },
  ),
);

/**
 * Reads settings without React.
 *
 * Background tasks execute outside the component tree, where the Zustand store
 * may not have hydrated yet, so they go straight to AsyncStorage.
 */
export async function readSettings(): Promise<Settings> {
  const live = useSettings.getState();
  if (live.hydrated) {
    const { hydrated: _h, set: _s, patch: _p, reset: _r, ...rest } = live;
    return rest as Settings;
  }
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as { state?: Partial<Settings> };
    return { ...DEFAULT_SETTINGS, ...(parsed.state ?? {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Writes settings from outside React, keeping the live store in sync. */
export async function writeSettings(patch: Partial<Settings>): Promise<void> {
  const state = useSettings.getState();
  if (state.hydrated) {
    state.patch(patch);
    return;
  }
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { state?: Partial<Settings>; version?: number }) : {};
    const next = {
      ...parsed,
      state: { ...DEFAULT_SETTINGS, ...(parsed.state ?? {}), ...patch },
    };
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* nothing useful to do if storage is unavailable */
  }
}
