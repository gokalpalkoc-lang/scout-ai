import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Credential storage for the Gemini backends.
 *
 * Two providers are supported:
 *
 *  - `aistudio` — an API key from https://aistudio.google.com/apikey, tied to
 *    your Google account and its free Gemini quota. This is the default and the
 *    only one that works with no cloud setup.
 *  - `vertex` — Vertex AI on a Google Cloud project, reached with an OAuth
 *    access token. Google's Gemini API does not accept a bare consumer Google
 *    sign-in, so this path needs a real GCP project; see README.
 *
 * Secrets never touch AsyncStorage or the Zustand persisted state — they live in
 * the platform keystore (Android EncryptedSharedPreferences / iOS Keychain).
 */

export type ProviderId = 'aistudio' | 'vertex';

const KEY_API = 'scout.gemini.apiKey';
const KEY_VERTEX_TOKEN = 'scout.vertex.accessToken';

export interface AiStudioCredential {
  provider: 'aistudio';
  apiKey: string;
}

export interface VertexCredential {
  provider: 'vertex';
  accessToken: string;
  project: string;
  location: string;
}

export type Credential = AiStudioCredential | VertexCredential;

// SecureStore has no web implementation; fall back to localStorage so
// `expo start --web` remains usable for development.
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

export async function saveApiKey(key: string): Promise<void> {
  await store.setItemAsync(KEY_API, key.trim());
}

export async function readApiKey(): Promise<string | null> {
  const v = await store.getItemAsync(KEY_API);
  return v && v.trim() ? v.trim() : null;
}

export async function clearApiKey(): Promise<void> {
  await store.deleteItemAsync(KEY_API);
}

export async function saveVertexToken(token: string): Promise<void> {
  await store.setItemAsync(KEY_VERTEX_TOKEN, token.trim());
}

export async function readVertexToken(): Promise<string | null> {
  const v = await store.getItemAsync(KEY_VERTEX_TOKEN);
  return v && v.trim() ? v.trim() : null;
}

export async function clearVertexToken(): Promise<void> {
  await store.deleteItemAsync(KEY_VERTEX_TOKEN);
}

/** Shows only the last 4 characters, e.g. "AIza••••••••dK3f". */
export function maskSecret(secret: string | null): string {
  if (!secret) return 'not set';
  if (secret.length <= 8) return '••••••••';
  return `${secret.slice(0, 4)}${'•'.repeat(8)}${secret.slice(-4)}`;
}

/** Cheap client-side sanity check so obvious paste errors fail fast. */
export function looksLikeApiKey(key: string): boolean {
  const k = key.trim();
  return k.length >= 30 && !/\s/.test(k);
}

export interface ProviderConfig {
  provider: ProviderId;
  vertexProject: string;
  vertexLocation: string;
}

/** Assembles the credential for the active provider, or explains what's missing. */
export async function resolveCredential(
  config: ProviderConfig,
): Promise<{ credential: Credential } | { error: string }> {
  if (config.provider === 'vertex') {
    const token = await readVertexToken();
    if (!config.vertexProject.trim()) {
      return { error: 'Vertex AI needs a Google Cloud project ID. Add it in Settings.' };
    }
    if (!token) {
      return {
        error:
          'Vertex AI needs an OAuth access token. Add one in Settings → Gemini access, or switch back to an AI Studio key.',
      };
    }
    return {
      credential: {
        provider: 'vertex',
        accessToken: token,
        project: config.vertexProject.trim(),
        location: config.vertexLocation.trim() || 'us-central1',
      },
    };
  }

  const apiKey = await readApiKey();
  if (!apiKey) {
    return {
      error: 'No Gemini API key yet. Add one in Settings → Gemini access to start using Scout.',
    };
  }
  return { credential: { provider: 'aistudio', apiKey } };
}
