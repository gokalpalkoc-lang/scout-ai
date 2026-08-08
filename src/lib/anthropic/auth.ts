import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Anthropic credential storage.
 *
 * Same rules as the Gemini key: the secret lives in the platform keystore, never
 * in AsyncStorage, the persisted Zustand state, or a backup file.
 */

const KEY_ANTHROPIC = 'scout.anthropic.apiKey';

export interface AnthropicCredential {
  provider: 'anthropic';
  apiKey: string;
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

export async function saveAnthropicKey(key: string): Promise<void> {
  await store.setItemAsync(KEY_ANTHROPIC, key.trim());
}

export async function readAnthropicKey(): Promise<string | null> {
  const v = await store.getItemAsync(KEY_ANTHROPIC);
  return v && v.trim() ? v.trim() : null;
}

export async function clearAnthropicKey(): Promise<void> {
  await store.deleteItemAsync(KEY_ANTHROPIC);
}

/** Anthropic keys start with `sk-ant-`; catch obvious paste errors early. */
export function looksLikeAnthropicKey(key: string): boolean {
  const k = key.trim();
  return k.startsWith('sk-ant-') && k.length >= 40 && !/\s/.test(k);
}

export async function resolveAnthropicCredential(): Promise<
  { credential: AnthropicCredential } | { error: string }
> {
  const apiKey = await readAnthropicKey();
  if (!apiKey) {
    return {
      error:
        'No Anthropic API key yet. Add one in Settings → Assistant provider to use Claude.',
    };
  }
  return { credential: { provider: 'anthropic', apiKey } };
}
