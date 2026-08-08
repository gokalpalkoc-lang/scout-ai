/**
 * Modules — Layer 4 of "the app changes itself".
 *
 * A module is a small tool the assistant *writes* and the app then *runs*: a
 * panel, a chart, a checklist, a different way to look at your agenda. It is
 * real code, generated on demand, persisted, versioned, and executed on-device.
 *
 * Why a WebView rather than the app's own React tree: Metro is a Node toolchain
 * and cannot run on a phone, so the app can never compile new React components
 * for itself. A WebView carries its own JS engine, so generated code runs there
 * with no build step — and, crucially, in a sandbox. The module gets no network
 * (blocked by CSP), no filesystem, no API keys; the only way in or out is the
 * capability bridge below, and every capability is granted per module.
 */

export const CAPABILITIES = [
  'events.read',
  'events.write',
  'sources.read',
  'sources.check',
  'routines.read',
  'stats.read',
  'storage',
  'notify',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  'events.read': 'Read your events',
  'events.write': 'Star, hide and re-categorise events',
  'sources.read': 'See your watched sites',
  'sources.check': 'Trigger a site check',
  'routines.read': 'See your routines',
  'stats.read': 'Read agenda counts',
  storage: 'Remember its own settings',
  notify: 'Send you a notification',
};

/** Capabilities that change data — surfaced more prominently before granting. */
export const WRITE_CAPABILITIES: Capability[] = ['events.write', 'sources.check', 'notify'];

export interface Module {
  id: string;
  name: string;
  description: string | null;
  /** Ionicons glyph name. */
  icon: string;
  /** Body fragment: markup plus its own <style> and <script>. */
  html: string;
  /** The request that produced this version, kept so it can be revised. */
  prompt: string | null;
  capabilities: Capability[];
  version: number;
  enabled: boolean;
  pinned: boolean;
  lastError: string | null;
  lastOpenedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type ModuleDraft = Omit<
  Module,
  'id' | 'version' | 'lastError' | 'lastOpenedAt' | 'createdAt' | 'updatedAt'
>;

export interface ModuleVersion {
  id: string;
  moduleId: string;
  version: number;
  html: string;
  prompt: string | null;
  note: string | null;
  createdAt: number;
}

export function parseCapabilities(raw: unknown): Capability[] {
  if (!Array.isArray(raw)) return [];
  const valid = new Set<string>(CAPABILITIES);
  const out = raw.filter((c): c is Capability => typeof c === 'string' && valid.has(c));
  return [...new Set(out)];
}
