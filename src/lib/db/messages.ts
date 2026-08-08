import { ChatMessage, GroundingRef, ToolTrailEntry } from '../types';
import { uid } from '../util';
import { boolToInt, getDb, intToBool } from './index';

interface MessageRow {
  id: string;
  role: string;
  text: string;
  tool_trail: string | null;
  grounding: string | null;
  created_at: number;
  error: number;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toMessage(r: MessageRow): ChatMessage {
  return {
    id: r.id,
    role: r.role as ChatMessage['role'],
    text: r.text,
    toolTrail: parseJson<ToolTrailEntry[]>(r.tool_trail),
    grounding: parseJson<GroundingRef[]>(r.grounding),
    createdAt: r.created_at,
    error: intToBool(r.error),
  };
}

export async function listMessages(limit = 300): Promise<ChatMessage[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<MessageRow>(
    'SELECT * FROM messages ORDER BY created_at DESC, id DESC LIMIT ?',
    limit,
  );
  return rows.map(toMessage).reverse();
}

export async function appendMessage(
  msg: Omit<ChatMessage, 'id' | 'createdAt'> & { id?: string; createdAt?: number },
): Promise<ChatMessage> {
  const db = await getDb();
  const id = msg.id ?? uid('msg_');
  const createdAt = msg.createdAt ?? Date.now();
  await db.runAsync(
    `INSERT INTO messages (id, role, text, tool_trail, grounding, created_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       text = excluded.text, tool_trail = excluded.tool_trail,
       grounding = excluded.grounding, error = excluded.error`,
    id,
    msg.role,
    msg.text,
    msg.toolTrail ? JSON.stringify(msg.toolTrail) : null,
    msg.grounding ? JSON.stringify(msg.grounding) : null,
    createdAt,
    boolToInt(msg.error),
  );
  return { ...msg, id, createdAt };
}

export async function deleteMessage(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM messages WHERE id = ?', id);
}

export async function clearMessages(): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM messages');
}
