import { Routine, RoutineKind, ScheduleKind } from '../types';
import { uid } from '../util';
import { boolToInt, getDb, intToBool } from './index';

interface RoutineRow {
  id: string;
  name: string;
  kind: string;
  prompt: string | null;
  schedule_kind: string;
  hour: number;
  minute: number;
  weekday: number;
  interval_min: number;
  enabled: number;
  last_run_at: number | null;
  last_result: string | null;
  notification_id: string | null;
  created_at: number;
}

function toRoutine(r: RoutineRow): Routine {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind as RoutineKind,
    prompt: r.prompt,
    scheduleKind: r.schedule_kind as ScheduleKind,
    hour: r.hour,
    minute: r.minute,
    weekday: r.weekday,
    intervalMin: r.interval_min,
    enabled: intToBool(r.enabled),
    lastRunAt: r.last_run_at,
    lastResult: r.last_result,
    notificationId: r.notification_id,
    createdAt: r.created_at,
  };
}

export async function listRoutines(): Promise<Routine[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<RoutineRow>(
    'SELECT * FROM routines ORDER BY enabled DESC, hour ASC, minute ASC',
  );
  return rows.map(toRoutine);
}

export async function getRoutine(id: string): Promise<Routine | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<RoutineRow>('SELECT * FROM routines WHERE id = ?', id);
  return row ? toRoutine(row) : null;
}

export type RoutineDraft = Omit<
  Routine,
  'id' | 'lastRunAt' | 'lastResult' | 'notificationId' | 'createdAt'
>;

export async function createRoutine(draft: RoutineDraft): Promise<Routine> {
  const db = await getDb();
  const id = uid('rtn_');
  await db.runAsync(
    `INSERT INTO routines
       (id, name, kind, prompt, schedule_kind, hour, minute, weekday, interval_min, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    draft.name,
    draft.kind,
    draft.prompt,
    draft.scheduleKind,
    draft.hour,
    draft.minute,
    draft.weekday,
    draft.intervalMin,
    boolToInt(draft.enabled),
    Date.now(),
  );
  const created = await getRoutine(id);
  if (!created) throw new Error('Failed to create routine');
  return created;
}

const ROUTINE_UPDATABLE: Record<string, string> = {
  name: 'name',
  kind: 'kind',
  prompt: 'prompt',
  scheduleKind: 'schedule_kind',
  hour: 'hour',
  minute: 'minute',
  weekday: 'weekday',
  intervalMin: 'interval_min',
  enabled: 'enabled',
  lastRunAt: 'last_run_at',
  lastResult: 'last_result',
  notificationId: 'notification_id',
};

export async function updateRoutine(id: string, patch: Partial<Routine>): Promise<void> {
  const entries = Object.entries(patch).filter(([k]) => k in ROUTINE_UPDATABLE);
  if (!entries.length) return;
  const db = await getDb();
  const sets = entries.map(([k]) => `${ROUTINE_UPDATABLE[k]} = ?`).join(', ');
  const values = entries.map(([, v]) => (typeof v === 'boolean' ? boolToInt(v) : (v ?? null)));
  await db.runAsync(`UPDATE routines SET ${sets} WHERE id = ?`, [...values, id]);
}

export async function deleteRoutine(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM routines WHERE id = ?', id);
}

/** Interval routines the app should execute now (checked on foreground + background). */
export async function listDueIntervalRoutines(now = Date.now()): Promise<Routine[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<RoutineRow>(
    `SELECT * FROM routines
      WHERE enabled = 1 AND schedule_kind = 'interval'
        AND (last_run_at IS NULL OR last_run_at + interval_min * 60000 <= ?)`,
    now,
  );
  return rows.map(toRoutine);
}
