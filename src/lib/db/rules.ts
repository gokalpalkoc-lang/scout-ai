import { Action, Condition, Rule, RuleDraft } from '../rules/types';
import { uid } from '../util';
import { boolToInt, getDb, intToBool } from './index';

interface RuleRow {
  id: string;
  name: string;
  enabled: number;
  priority: number;
  source_id: string | null;
  author: string;
  all_json: string;
  any_json: string;
  actions_json: string;
  created_at: number;
  updated_at: number;
  last_fired_at: number | null;
  fire_count: number;
}

function parseArray<T>(raw: string): T[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function toRule(r: RuleRow): Rule {
  return {
    id: r.id,
    name: r.name,
    enabled: intToBool(r.enabled),
    priority: r.priority,
    sourceId: r.source_id,
    author: r.author === 'assistant' ? 'assistant' : 'user',
    all: parseArray<Condition>(r.all_json),
    any: parseArray<Condition>(r.any_json),
    actions: parseArray<Action>(r.actions_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastFiredAt: r.last_fired_at,
    fireCount: r.fire_count,
  };
}

export async function listRules(): Promise<Rule[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<RuleRow>(
    'SELECT * FROM rules ORDER BY enabled DESC, priority ASC, created_at ASC',
  );
  return rows.map(toRule);
}

export async function getRule(id: string): Promise<Rule | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<RuleRow>('SELECT * FROM rules WHERE id = ?', id);
  return row ? toRule(row) : null;
}

export async function createRule(draft: RuleDraft): Promise<Rule> {
  const db = await getDb();
  const id = uid('rul_');
  const now = Date.now();
  await db.runAsync(
    `INSERT INTO rules
       (id, name, enabled, priority, source_id, author, all_json, any_json, actions_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    draft.name,
    boolToInt(draft.enabled),
    draft.priority,
    draft.sourceId,
    draft.author,
    JSON.stringify(draft.all),
    JSON.stringify(draft.any),
    JSON.stringify(draft.actions),
    now,
    now,
  );
  const created = await getRule(id);
  if (!created) throw new Error('Failed to create rule');
  return created;
}

export async function updateRule(id: string, patch: Partial<Rule>): Promise<void> {
  const db = await getDb();
  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  const push = (column: string, value: string | number | null) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.name !== undefined) push('name', patch.name);
  if (patch.enabled !== undefined) push('enabled', boolToInt(patch.enabled));
  if (patch.priority !== undefined) push('priority', patch.priority);
  if (patch.sourceId !== undefined) push('source_id', patch.sourceId);
  if (patch.all !== undefined) push('all_json', JSON.stringify(patch.all));
  if (patch.any !== undefined) push('any_json', JSON.stringify(patch.any));
  if (patch.actions !== undefined) push('actions_json', JSON.stringify(patch.actions));
  if (patch.lastFiredAt !== undefined) push('last_fired_at', patch.lastFiredAt);
  if (patch.fireCount !== undefined) push('fire_count', patch.fireCount);

  if (!sets.length) return;
  push('updated_at', Date.now());

  await db.runAsync(`UPDATE rules SET ${sets.join(', ')} WHERE id = ?`, [...values, id]);
}

export async function deleteRule(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM rules WHERE id = ?', id);
}

/** Bumps the fire counter after a rule actually did something. */
export async function recordFirings(counts: Map<string, number>): Promise<void> {
  if (!counts.size) return;
  const db = await getDb();
  const now = Date.now();
  for (const [ruleId, n] of counts) {
    await db.runAsync(
      'UPDATE rules SET fire_count = fire_count + ?, last_fired_at = ? WHERE id = ?',
      n,
      now,
      ruleId,
    );
  }
}
