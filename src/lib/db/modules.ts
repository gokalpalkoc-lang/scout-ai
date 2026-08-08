import { Module, ModuleDraft, ModuleVersion, parseCapabilities } from '../modules/types';
import { uid } from '../util';
import { boolToInt, getDb, intToBool } from './index';

interface ModuleRow {
  id: string;
  name: string;
  description: string | null;
  icon: string;
  html: string;
  prompt: string | null;
  capabilities: string;
  version: number;
  enabled: number;
  pinned: number;
  last_error: string | null;
  last_opened_at: number | null;
  created_at: number;
  updated_at: number;
}

function toModule(r: ModuleRow): Module {
  let caps: unknown = [];
  try {
    caps = JSON.parse(r.capabilities);
  } catch {
    caps = [];
  }
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    icon: r.icon,
    html: r.html,
    prompt: r.prompt,
    capabilities: parseCapabilities(caps),
    version: r.version,
    enabled: intToBool(r.enabled),
    pinned: intToBool(r.pinned),
    lastError: r.last_error,
    lastOpenedAt: r.last_opened_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listModules(): Promise<Module[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<ModuleRow>(
    'SELECT * FROM modules ORDER BY pinned DESC, updated_at DESC',
  );
  return rows.map(toModule);
}

export async function getModule(id: string): Promise<Module | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<ModuleRow>('SELECT * FROM modules WHERE id = ?', id);
  return row ? toModule(row) : null;
}

export async function createModule(draft: ModuleDraft): Promise<Module> {
  const db = await getDb();
  const id = uid('mod_');
  const now = Date.now();

  await db.runAsync(
    `INSERT INTO modules
       (id, name, description, icon, html, prompt, capabilities, version, enabled, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    id,
    draft.name,
    draft.description,
    draft.icon,
    draft.html,
    draft.prompt,
    JSON.stringify(draft.capabilities),
    boolToInt(draft.enabled),
    boolToInt(draft.pinned),
    now,
    now,
  );
  await saveVersion(id, 1, draft.html, draft.prompt, 'First version');

  const created = await getModule(id);
  if (!created) throw new Error('Failed to create module');
  return created;
}

/**
 * Replaces a module's code and bumps its version.
 *
 * The previous body stays in `module_versions`, so a revision that breaks the
 * module can be rolled back without regenerating it.
 */
export async function reviseModule(
  id: string,
  html: string,
  prompt: string | null,
  note: string | null,
): Promise<Module> {
  const db = await getDb();
  const existing = await getModule(id);
  if (!existing) throw new Error('That module no longer exists');

  const nextVersion = existing.version + 1;
  await db.runAsync(
    'UPDATE modules SET html = ?, prompt = ?, version = ?, last_error = NULL, updated_at = ? WHERE id = ?',
    html,
    prompt,
    nextVersion,
    Date.now(),
    id,
  );
  await saveVersion(id, nextVersion, html, prompt, note);

  const updated = await getModule(id);
  if (!updated) throw new Error('Failed to revise module');
  return updated;
}

export async function updateModule(id: string, patch: Partial<Module>): Promise<void> {
  const db = await getDb();
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  const push = (column: string, value: string | number | null) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.name !== undefined) push('name', patch.name);
  if (patch.description !== undefined) push('description', patch.description);
  if (patch.icon !== undefined) push('icon', patch.icon);
  if (patch.enabled !== undefined) push('enabled', boolToInt(patch.enabled));
  if (patch.pinned !== undefined) push('pinned', boolToInt(patch.pinned));
  if (patch.lastError !== undefined) push('last_error', patch.lastError);
  if (patch.lastOpenedAt !== undefined) push('last_opened_at', patch.lastOpenedAt);
  if (patch.capabilities !== undefined) push('capabilities', JSON.stringify(patch.capabilities));

  if (!sets.length) return;
  push('updated_at', Date.now());
  await db.runAsync(`UPDATE modules SET ${sets.join(', ')} WHERE id = ?`, [...values, id]);
}

export async function deleteModule(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM module_storage WHERE module_id = ?', id);
  await db.runAsync('DELETE FROM module_versions WHERE module_id = ?', id);
  await db.runAsync('DELETE FROM modules WHERE id = ?', id);
}

// ----------------------------------------------------------------- versions

interface VersionRow {
  id: string;
  module_id: string;
  version: number;
  html: string;
  prompt: string | null;
  note: string | null;
  created_at: number;
}

async function saveVersion(
  moduleId: string,
  version: number,
  html: string,
  prompt: string | null,
  note: string | null,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO module_versions (id, module_id, version, html, prompt, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (module_id, version) DO UPDATE SET html = excluded.html, note = excluded.note`,
    uid('mvr_'),
    moduleId,
    version,
    html,
    prompt,
    note,
    Date.now(),
  );
  // Keep the ten most recent revisions per module.
  await db.runAsync(
    `DELETE FROM module_versions WHERE module_id = ? AND id NOT IN (
       SELECT id FROM module_versions WHERE module_id = ? ORDER BY version DESC LIMIT 10
     )`,
    moduleId,
    moduleId,
  );
}

export async function listVersions(moduleId: string): Promise<ModuleVersion[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<VersionRow>(
    'SELECT * FROM module_versions WHERE module_id = ? ORDER BY version DESC',
    moduleId,
  );
  return rows.map((r) => ({
    id: r.id,
    moduleId: r.module_id,
    version: r.version,
    html: r.html,
    prompt: r.prompt,
    note: r.note,
    createdAt: r.created_at,
  }));
}

/** Restores an earlier revision as a new version, so history stays append-only. */
export async function rollbackModule(moduleId: string, version: number): Promise<Module> {
  const db = await getDb();
  const row = await db.getFirstAsync<VersionRow>(
    'SELECT * FROM module_versions WHERE module_id = ? AND version = ?',
    moduleId,
    version,
  );
  if (!row) throw new Error('That version is no longer stored');
  return reviseModule(moduleId, row.html, row.prompt, `Rolled back to v${version}`);
}

// ------------------------------------------------------------- module storage

export async function moduleStorageGet(moduleId: string, key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM module_storage WHERE module_id = ? AND key = ?',
    moduleId,
    key,
  );
  return row?.value ?? null;
}

export async function moduleStorageSet(
  moduleId: string,
  key: string,
  value: string,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO module_storage (module_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (module_id, key) DO UPDATE SET value = excluded.value`,
    moduleId,
    key,
    value,
  );
}
