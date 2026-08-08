import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { OpenAiBackendId, backendById } from './catalog';

/**
 * Key storage for the OpenAI-compatible backends.
 *
 * Same rule as every other secret in Scout: the platform keystore, never
 * AsyncStorage, the persisted Zustand state, or a backup file. One key per
 * backend, so revoking Groq does not disturb OpenRouter.
 */

const KEY_PREFIX = 'scout.openai.';

export interface OpenAiCredential {
  backend: OpenAiBackendId;
  apiKey: string;
  /** Resolved base URL — the catalog's, or the user's for `custom`. */
  baseUrl: string;
  model: string;
}

const webStore = {
  async getItemAsync(k: string) {
    try {
      return globalThis.localStorage?.getItem(k) ?? null;
    } catch {
      return null;
    }
  },
  async setItemAsync(k: string, v: string) {
    try {
      globalThis.localStorage?.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
  async deleteItemAsync(k: string) {
    try {
      globalThis.localStorage?.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

const store = Platform.OS === 'web' ? webStore : SecureStore;

// SecureStore keys must be alphanumeric plus `.-_`; every backend id already is.
const slotFor = (id: OpenAiBackendId) => `${KEY_PREFIX}${id}`;

export async function saveBackendKey(id: OpenAiBackendId, key: string): Promise<void> {
  await store.setItemAsync(slotFor(id), key.trim());
}

export async function readBackendKey(id: OpenAiBackendId): Promise<string | null> {
  const v = await store.getItemAsync(slotFor(id));
  return v && v.trim() ? v.trim() : null;
}

export async function clearBackendKey(id: OpenAiBackendId): Promise<void> {
  await store.deleteItemAsync(slotFor(id));
}

/** Which backends currently hold a key, for the Settings list and the pool. */
export async function backendsWithKeys(ids: OpenAiBackendId[]): Promise<Set<OpenAiBackendId>> {
  const present = new Set<OpenAiBackendId>();
  await Promise.all(
    ids.map(async (id) => {
      if (await readBackendKey(id)) present.add(id);
    }),
  );
  return present;
}

/** Cheap client-side sanity check so obvious paste errors fail before a request. */
export function looksLikeBackendKey(id: OpenAiBackendId, key: string): boolean {
  const k = key.trim();
  if (k.length < 16 || /\s/.test(k)) return false;
  const hint = backendById(id)?.keyHint;
  // A hint that fails is worth flagging, but a backend without one still passes.
  return hint ? hint(k) : true;
}

export interface BackendConfig {
  id: OpenAiBackendId;
  model: string;
  /** Only consulted for backends whose catalog entry sets `userBaseUrl`. */
  baseUrl?: string;
}

export async function resolveBackendCredential(
  config: BackendConfig,
): Promise<{ credential: OpenAiCredential } | { error: string }> {
  const backend = backendById(config.id);
  if (!backend) return { error: `Unknown backend "${config.id}".` };

  const baseUrl = (backend.userBaseUrl ? config.baseUrl?.trim() : backend.baseUrl) ?? '';
  if (!baseUrl) {
    return { error: `${backend.label} needs a base URL. Add one in Settings → Free model pool.` };
  }

  const apiKey = await readBackendKey(config.id);
  // A local server (Ollama, LM Studio) has no key; only the hosted ones require it.
  if (!apiKey && !backend.userBaseUrl) {
    return {
      error: `No ${backend.label} key yet. Add one in Settings → Free model pool.`,
    };
  }

  const model = config.model.trim() || backend.defaultModel;
  if (!model) {
    return { error: `${backend.label} needs a model name. Add one in Settings → Free model pool.` };
  }

  return {
    credential: {
      backend: config.id,
      apiKey: apiKey ?? '',
      baseUrl: baseUrl.replace(/\/+$/, ''),
      model,
    },
  };
}
