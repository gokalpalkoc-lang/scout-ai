/** Domain types shared across the data layer, extraction engine and UI. */

export type WatchMode = 'events' | 'changes' | 'both';
export type CheckStatus = 'never' | 'ok' | 'error';

export interface Source {
  id: string;
  url: string;
  title: string;
  category: string | null;
  mode: WatchMode;
  /** Free-text steer for the extractor, e.g. "only the workshops table". */
  hint: string | null;
  intervalMin: number;
  enabled: boolean;
  notify: boolean;
  lastCheckedAt: number | null;
  lastStatus: CheckStatus;
  lastError: string | null;
  contentHash: string | null;
  lastSummary: string | null;
  createdAt: number;
}

export type SourceDraft = Omit<
  Source,
  'id' | 'lastCheckedAt' | 'lastStatus' | 'lastError' | 'contentHash' | 'lastSummary' | 'createdAt'
> &
  Partial<Pick<Source, 'id'>>;

export interface EventItem {
  id: string;
  sourceId: string | null;
  /** Stable identity within a source, used to tell new items from repeats. */
  fingerprint: string;
  title: string;
  description: string | null;
  /** ISO-8601. Date-only ("2026-09-14") when no time was published. */
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  location: string | null;
  url: string | null;
  price: string | null;
  category: string | null;
  /** Registration / application cutoff, when the page states one. */
  deadlineAt: string | null;
  deadlineLabel: string | null;
  confidence: number;
  isNew: boolean;
  starred: boolean;
  dismissed: boolean;
  calendarEventId: string | null;
  reminderId: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
}

export type ExtractedEvent = Omit<
  EventItem,
  | 'id'
  | 'sourceId'
  | 'fingerprint'
  | 'isNew'
  | 'starred'
  | 'dismissed'
  | 'calendarEventId'
  | 'reminderId'
  | 'firstSeenAt'
  | 'lastSeenAt'
>;

export interface CheckRun {
  id: string;
  sourceId: string;
  ranAt: number;
  status: 'ok' | 'error' | 'skipped';
  changed: boolean;
  newEvents: number;
  totalEvents: number;
  durationMs: number;
  note: string | null;
  trigger: 'manual' | 'background' | 'routine' | 'assistant';
}

export type RoutineKind = 'check_all' | 'digest' | 'prompt' | 'reminder';
export type ScheduleKind = 'daily' | 'weekly' | 'interval';

export interface Routine {
  id: string;
  name: string;
  kind: RoutineKind;
  /** For `prompt`/`digest`: the instruction handed to Gemini. */
  prompt: string | null;
  scheduleKind: ScheduleKind;
  hour: number;
  minute: number;
  /** 1 = Sunday … 7 = Saturday (matches expo-notifications weekday). */
  weekday: number;
  intervalMin: number;
  enabled: boolean;
  lastRunAt: number | null;
  lastResult: string | null;
  notificationId: string | null;
  createdAt: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model' | 'system';
  text: string;
  /** Tool calls performed while producing this message, for the activity trail. */
  toolTrail: ToolTrailEntry[] | null;
  grounding: GroundingRef[] | null;
  createdAt: number;
  error: boolean;
}

export interface ToolTrailEntry {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
}

export interface GroundingRef {
  title: string;
  uri: string;
}

export interface Snapshot {
  sourceId: string;
  text: string;
  hash: string;
  takenAt: number;
}
