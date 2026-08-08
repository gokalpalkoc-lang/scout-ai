import * as SQLite from 'expo-sqlite';

const DB_NAME = 'scout.db';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/**
 * Schema is applied with `user_version` migrations so the app can evolve
 * without wiping the user's watchlist. Add a new entry to MIGRATIONS; never
 * edit an existing one.
 */
const MIGRATIONS: ((db: SQLite.SQLiteDatabase) => Promise<void>)[] = [
  // v1 — initial schema
  async (db) => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS sources (
        id              TEXT PRIMARY KEY NOT NULL,
        url             TEXT NOT NULL,
        title           TEXT NOT NULL,
        category        TEXT,
        mode            TEXT NOT NULL DEFAULT 'both',
        hint            TEXT,
        interval_min    INTEGER NOT NULL DEFAULT 720,
        enabled         INTEGER NOT NULL DEFAULT 1,
        notify          INTEGER NOT NULL DEFAULT 1,
        last_checked_at INTEGER,
        last_status     TEXT NOT NULL DEFAULT 'never',
        last_error      TEXT,
        content_hash    TEXT,
        last_summary    TEXT,
        created_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id                TEXT PRIMARY KEY NOT NULL,
        source_id         TEXT,
        fingerprint       TEXT NOT NULL,
        title             TEXT NOT NULL,
        description       TEXT,
        starts_at         TEXT,
        ends_at           TEXT,
        all_day           INTEGER NOT NULL DEFAULT 0,
        location          TEXT,
        url               TEXT,
        price             TEXT,
        category          TEXT,
        deadline_at       TEXT,
        deadline_label    TEXT,
        confidence        REAL NOT NULL DEFAULT 0.5,
        is_new            INTEGER NOT NULL DEFAULT 1,
        starred           INTEGER NOT NULL DEFAULT 0,
        dismissed         INTEGER NOT NULL DEFAULT 0,
        calendar_event_id TEXT,
        reminder_id       TEXT,
        first_seen_at     INTEGER NOT NULL,
        last_seen_at      INTEGER NOT NULL,
        FOREIGN KEY (source_id) REFERENCES sources (id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_identity
        ON events (IFNULL(source_id, ''), fingerprint);
      CREATE INDEX IF NOT EXISTS idx_events_starts ON events (starts_at);
      CREATE INDEX IF NOT EXISTS idx_events_deadline ON events (deadline_at);
      CREATE INDEX IF NOT EXISTS idx_events_source ON events (source_id);

      CREATE TABLE IF NOT EXISTS snapshots (
        source_id TEXT PRIMARY KEY NOT NULL,
        text      TEXT NOT NULL,
        hash      TEXT NOT NULL,
        taken_at  INTEGER NOT NULL,
        FOREIGN KEY (source_id) REFERENCES sources (id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS checks (
        id           TEXT PRIMARY KEY NOT NULL,
        source_id    TEXT NOT NULL,
        ran_at       INTEGER NOT NULL,
        status       TEXT NOT NULL,
        changed      INTEGER NOT NULL DEFAULT 0,
        new_events   INTEGER NOT NULL DEFAULT 0,
        total_events INTEGER NOT NULL DEFAULT 0,
        duration_ms  INTEGER NOT NULL DEFAULT 0,
        note         TEXT,
        trigger      TEXT NOT NULL DEFAULT 'manual',
        FOREIGN KEY (source_id) REFERENCES sources (id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_checks_source ON checks (source_id, ran_at DESC);

      CREATE TABLE IF NOT EXISTS routines (
        id              TEXT PRIMARY KEY NOT NULL,
        name            TEXT NOT NULL,
        kind            TEXT NOT NULL,
        prompt          TEXT,
        schedule_kind   TEXT NOT NULL DEFAULT 'daily',
        hour            INTEGER NOT NULL DEFAULT 8,
        minute          INTEGER NOT NULL DEFAULT 0,
        weekday         INTEGER NOT NULL DEFAULT 2,
        interval_min    INTEGER NOT NULL DEFAULT 720,
        enabled         INTEGER NOT NULL DEFAULT 1,
        last_run_at     INTEGER,
        last_result     TEXT,
        notification_id TEXT,
        created_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id         TEXT PRIMARY KEY NOT NULL,
        role       TEXT NOT NULL,
        text       TEXT NOT NULL,
        tool_trail TEXT,
        grounding  TEXT,
        created_at INTEGER NOT NULL,
        error      INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at);
    `);
  },

  // v2 — rules (model-authored automations) and modules (model-authored tools)
  async (db) => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS rules (
        id            TEXT PRIMARY KEY NOT NULL,
        name          TEXT NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 1,
        priority      INTEGER NOT NULL DEFAULT 100,
        source_id     TEXT,
        author        TEXT NOT NULL DEFAULT 'user',
        all_json      TEXT NOT NULL DEFAULT '[]',
        any_json      TEXT NOT NULL DEFAULT '[]',
        actions_json  TEXT NOT NULL DEFAULT '[]',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        last_fired_at INTEGER,
        fire_count    INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (source_id) REFERENCES sources (id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_rules_active ON rules (enabled, priority);

      CREATE TABLE IF NOT EXISTS modules (
        id            TEXT PRIMARY KEY NOT NULL,
        name          TEXT NOT NULL,
        description   TEXT,
        icon          TEXT NOT NULL DEFAULT 'cube-outline',
        html          TEXT NOT NULL,
        prompt        TEXT,
        capabilities  TEXT NOT NULL DEFAULT '[]',
        version       INTEGER NOT NULL DEFAULT 1,
        enabled       INTEGER NOT NULL DEFAULT 1,
        pinned        INTEGER NOT NULL DEFAULT 0,
        last_error    TEXT,
        last_opened_at INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      -- Every generation is kept so a broken revision can be rolled back.
      CREATE TABLE IF NOT EXISTS module_versions (
        id         TEXT PRIMARY KEY NOT NULL,
        module_id  TEXT NOT NULL,
        version    INTEGER NOT NULL,
        html       TEXT NOT NULL,
        prompt     TEXT,
        note       TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (module_id) REFERENCES modules (id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_module_versions_unique
        ON module_versions (module_id, version);

      -- Module-scoped key/value storage, so a module can remember state without
      -- reaching into the app's own tables.
      CREATE TABLE IF NOT EXISTS module_storage (
        module_id TEXT NOT NULL,
        key       TEXT NOT NULL,
        value     TEXT NOT NULL,
        PRIMARY KEY (module_id, key),
        FOREIGN KEY (module_id) REFERENCES modules (id) ON DELETE CASCADE
      );
    `);
  },
];

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let version = row?.user_version ?? 0;

  while (version < MIGRATIONS.length) {
    await MIGRATIONS[version](db);
    version += 1;
    // PRAGMA does not accept bound parameters, and `version` is a loop counter.
    await db.execAsync(`PRAGMA user_version = ${version}`);
  }
}

/** Opens (once) and migrates the database. Safe to call from anywhere. */
export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync(DB_NAME);
      await migrate(db);
      return db;
    })().catch((e) => {
      // Let the next caller retry rather than caching a rejected promise.
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

/** Wipes user data but keeps the schema. Used by Settings → Reset. */
export async function resetAllData(): Promise<void> {
  const db = await getDb();
  await db.execAsync(`
    DELETE FROM messages;
    DELETE FROM checks;
    DELETE FROM snapshots;
    DELETE FROM events;
    DELETE FROM routines;
    DELETE FROM rules;
    DELETE FROM module_storage;
    DELETE FROM module_versions;
    DELETE FROM modules;
    DELETE FROM sources;
  `);
}

export const boolToInt = (b: boolean): number => (b ? 1 : 0);
export const intToBool = (n: number | null | undefined): boolean => !!n;
