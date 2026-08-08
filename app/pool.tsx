import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Switch, View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  Field,
  Header,
  Row,
  Screen,
  SectionHeader,
  Text,
} from '../src/components/ui';
import { PoolMember, poolMemberLabel } from '../src/lib/ai/contract';
import { BackendHealth, clearBench, describeHealth, isBenched, readHealth } from '../src/lib/ai/pool';
import { readAnthropicKey } from '../src/lib/anthropic/auth';
import { readApiKey } from '../src/lib/gemini/auth';
import {
  clearBackendKey,
  looksLikeBackendKey,
  readBackendKey,
  saveBackendKey,
} from '../src/lib/openai/auth';
import { OPENAI_BACKENDS, OpenAiBackend, backendById } from '../src/lib/openai/catalog';
import { verifyBackend } from '../src/lib/openai/client';
import { maskSecret } from '../src/lib/gemini/auth';
import { errorMessage } from '../src/lib/util';
import { useSettings } from '../src/store/settings';
import { useTheme } from '../src/theme';

/**
 * The free model pool.
 *
 * One card per backend Scout knows about. A backend joins the rotation when it
 * is switched on *and* its key resolves; everything else here — the resting
 * countdown, the "key rejected" badge — is the pool's learned health surfacing
 * so the user can see why a backend is being skipped rather than guessing.
 */

function HealthBadge({ health }: { health: BackendHealth | undefined }) {
  if (!health) return null;
  if (health.keyRejected) return <Badge label="Key rejected" tone="danger" />;
  if (isBenched(health)) return <Badge label={describeHealth(health)} tone="warning" />;
  if (health.lastOkAt) return <Badge label={`${health.successes} used`} tone="success" />;
  return null;
}

function OpenAiMemberCard({
  backend,
  member,
  health,
  hasKey,
  onKeyChanged,
  onHealthChanged,
}: {
  backend: OpenAiBackend;
  member: PoolMember;
  health: BackendHealth | undefined;
  hasKey: boolean;
  onKeyChanged: () => void;
  onHealthChanged: () => void;
}) {
  const t = useTheme();
  const settings = useSettings();
  const [keyInput, setKeyInput] = useState('');
  const [storedKey, setStoredKey] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);

  useEffect(() => {
    void readBackendKey(backend.id).then(setStoredKey);
  }, [backend.id, hasKey]);

  const patchMember = useCallback(
    (patch: Partial<PoolMember>) => {
      settings.set(
        'poolMembers',
        settings.poolMembers.map((m) => (m.id === member.id ? { ...m, ...patch } : m)),
      );
    },
    [member.id, settings],
  );

  const save = useCallback(async () => {
    const value = keyInput.trim();
    if (!looksLikeBackendKey(backend.id, value)) {
      Alert.alert(
        `That does not look like a ${backend.label} key`,
        backend.keyUrl ? `Create one at ${backend.keyUrl}.` : 'Check the value and try again.',
      );
      return;
    }
    setBusy('save');
    try {
      await saveBackendKey(backend.id, value);
      // A newly pasted key deserves a clean slate even if the old one was benched.
      await clearBench(member.id);
      const result = await verifyBackend({
        backend: backend.id,
        apiKey: value,
        baseUrl: (member.baseUrl || backend.baseUrl).replace(/\/+$/, ''),
        model: member.model || backend.defaultModel,
      });
      if (!result.ok) {
        Alert.alert('Key rejected', result.error);
        return;
      }
      patchMember({ enabled: true });
      setKeyInput('');
      setEditing(false);
      Alert.alert('Connected', `${backend.label} replied: "${result.reply}"`);
    } catch (e) {
      Alert.alert('Could not save the key', errorMessage(e));
    } finally {
      setBusy(null);
      onKeyChanged();
      onHealthChanged();
    }
  }, [backend, keyInput, member, onHealthChanged, onKeyChanged, patchMember]);

  const test = useCallback(async () => {
    setBusy('test');
    try {
      const key = await readBackendKey(backend.id);
      if (!key && !backend.userBaseUrl) {
        Alert.alert('No key', `Add a ${backend.label} key first.`);
        return;
      }
      const result = await verifyBackend({
        backend: backend.id,
        apiKey: key ?? '',
        baseUrl: (member.baseUrl || backend.baseUrl).replace(/\/+$/, ''),
        model: member.model || backend.defaultModel,
      });
      if (result.ok) {
        await clearBench(member.id);
        Alert.alert('Working', `${member.model || backend.defaultModel} replied: "${result.reply}"`);
      } else {
        Alert.alert('Failed', result.error);
      }
    } finally {
      setBusy(null);
      onHealthChanged();
    }
  }, [backend, member, onHealthChanged]);

  const remove = useCallback(() => {
    Alert.alert(`Remove the ${backend.label} key?`, 'It leaves the rotation until you add one again.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await clearBackendKey(backend.id);
          await clearBench(member.id);
          patchMember({ enabled: false });
          setStoredKey(null);
          onKeyChanged();
          onHealthChanged();
        },
      },
    ]);
  }, [backend, member.id, onHealthChanged, onKeyChanged, patchMember]);

  const usable = !!storedKey || !!backend.userBaseUrl;

  return (
    <Card>
      <Row gap={t.spacing.md} align="flex-start">
        <View
          style={{
            width: 38,
            height: 38,
            borderRadius: t.radius.md,
            backgroundColor: member.enabled ? t.color.successSoft : t.color.surfaceAlt,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons
            name={member.enabled ? 'flash' : 'flash-outline'}
            size={19}
            color={member.enabled ? t.color.success : t.color.textMuted}
          />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Row gap={t.spacing.sm} wrap>
            <Text variant="subheading">{backend.label}</Text>
            <HealthBadge health={health} />
          </Row>
          <Text variant="caption" tone="muted">
            {backend.freeTier}
          </Text>
          {storedKey ? (
            <Text variant="caption" tone="muted">
              {maskSecret(storedKey)}
            </Text>
          ) : null}
          {health?.lastError && !health.keyRejected ? (
            <Text variant="caption" tone="warning" numberOfLines={2}>
              {health.lastError}
            </Text>
          ) : null}
        </View>
        <Switch
          value={member.enabled}
          onValueChange={(enabled) => {
            if (enabled && !usable) {
              setEditing(true);
              Alert.alert(`${backend.label} key needed`, 'Add a key below to put it in the rotation.');
              return;
            }
            patchMember({ enabled });
          }}
          trackColor={{ false: t.color.surfaceAlt, true: t.color.primarySoft }}
          thumbColor={member.enabled ? t.color.primary : t.color.textMuted}
        />
      </Row>

      <View style={{ marginTop: t.spacing.lg, gap: t.spacing.md }}>
        {backend.userBaseUrl ? (
          <Field
            label="Base URL"
            value={member.baseUrl ?? ''}
            onChangeText={(v) => patchMember({ baseUrl: v })}
            placeholder="http://192.168.1.10:11434/v1"
            icon="server-outline"
            autoCapitalize="none"
            autoCorrect={false}
            hint="Anything that speaks OpenAI chat completions. Include the version segment."
          />
        ) : null}

        <Field
          label="Model"
          value={member.model}
          onChangeText={(v) => patchMember({ model: v })}
          placeholder={backend.defaultModel || 'model id'}
          icon="cube-outline"
          autoCapitalize="none"
          autoCorrect={false}
          hint={
            backend.suggestedModels.length
              ? `Also available: ${backend.suggestedModels.slice(1).join(', ')}`
              : undefined
          }
        />

        {editing || !storedKey ? (
          <>
            <Field
              label={`${backend.label} key`}
              value={keyInput}
              onChangeText={setKeyInput}
              placeholder={backend.userBaseUrl ? 'optional' : 'paste the key'}
              icon="key-outline"
              secretToggle
              autoCapitalize="none"
              autoCorrect={false}
              hint="Stored in the phone's keystore, never in a backup."
            />
            <Row gap={t.spacing.sm} wrap>
              <Button
                title="Save and verify"
                icon="checkmark"
                size="sm"
                loading={busy === 'save'}
                disabled={!keyInput.trim()}
                onPress={() => void save()}
              />
              <Button
                title="Paste"
                icon="clipboard-outline"
                variant="secondary"
                size="sm"
                onPress={async () => setKeyInput((await Clipboard.getStringAsync()).trim())}
              />
              {backend.keyUrl ? (
                <Button
                  title="Get a key"
                  icon="open-outline"
                  variant="ghost"
                  size="sm"
                  onPress={() => void WebBrowser.openBrowserAsync(backend.keyUrl)}
                />
              ) : null}
              {storedKey ? (
                <Button title="Cancel" variant="ghost" size="sm" onPress={() => setEditing(false)} />
              ) : null}
            </Row>
          </>
        ) : (
          <Row gap={t.spacing.sm} wrap>
            <Button
              title="Test"
              icon="pulse-outline"
              variant="secondary"
              size="sm"
              loading={busy === 'test'}
              onPress={() => void test()}
            />
            <Button
              title="Replace key"
              icon="create-outline"
              variant="ghost"
              size="sm"
              onPress={() => setEditing(true)}
            />
            <Button
              title="Remove"
              icon="trash-outline"
              variant="ghost"
              size="sm"
              onPress={remove}
            />
            {health && isBenched(health) ? (
              <Button
                title="Clear rest"
                icon="refresh-outline"
                variant="ghost"
                size="sm"
                onPress={async () => {
                  await clearBench(member.id);
                  onHealthChanged();
                }}
              />
            ) : null}
          </Row>
        )}
      </View>
    </Card>
  );
}

/** Gemini and Claude reuse the keys already on the Settings screen. */
function NativeMemberCard({
  member,
  health,
  hasKey,
  fallbackModel,
  onHealthChanged,
}: {
  member: PoolMember;
  health: BackendHealth | undefined;
  hasKey: boolean;
  fallbackModel: string;
  onHealthChanged: () => void;
}) {
  const t = useTheme();
  const settings = useSettings();
  const label = poolMemberLabel(member);

  return (
    <Card>
      <Row gap={t.spacing.md} align="flex-start">
        <View
          style={{
            width: 38,
            height: 38,
            borderRadius: t.radius.md,
            backgroundColor: member.enabled ? t.color.successSoft : t.color.surfaceAlt,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons
            name={member.enabled ? 'sparkles' : 'sparkles-outline'}
            size={19}
            color={member.enabled ? t.color.success : t.color.textMuted}
          />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Row gap={t.spacing.sm} wrap>
            <Text variant="subheading">{label}</Text>
            <HealthBadge health={health} />
          </Row>
          <Text variant="caption" tone="muted">
            {hasKey
              ? `Uses the ${label} key already in Settings. Falls back to ${fallbackModel}.`
              : `Add a ${label} key in Settings to include it in the rotation.`}
          </Text>
          {health?.lastError && !health.keyRejected ? (
            <Text variant="caption" tone="warning" numberOfLines={2}>
              {health.lastError}
            </Text>
          ) : null}
        </View>
        <Switch
          value={member.enabled}
          onValueChange={(enabled) => {
            if (enabled && !hasKey) {
              Alert.alert(`${label} key needed`, `Add one in Settings first.`);
              return;
            }
            settings.set(
              'poolMembers',
              settings.poolMembers.map((m) => (m.id === member.id ? { ...m, enabled } : m)),
            );
          }}
          trackColor={{ false: t.color.surfaceAlt, true: t.color.primarySoft }}
          thumbColor={member.enabled ? t.color.primary : t.color.textMuted}
        />
      </Row>

      <View style={{ marginTop: t.spacing.lg }}>
        <Field
          label="Model override"
          value={member.model}
          onChangeText={(v) =>
            settings.set(
              'poolMembers',
              settings.poolMembers.map((m) => (m.id === member.id ? { ...m, model: v } : m)),
            )
          }
          placeholder={fallbackModel}
          icon="cube-outline"
          autoCapitalize="none"
          autoCorrect={false}
          hint="Leave empty to use whatever is selected in Settings."
        />
        {health && isBenched(health) ? (
          <Button
            title="Clear rest"
            icon="refresh-outline"
            variant="ghost"
            size="sm"
            style={{ marginTop: t.spacing.md, alignSelf: 'flex-start' }}
            onPress={async () => {
              await clearBench(member.id);
              onHealthChanged();
            }}
          />
        ) : null}
      </View>
    </Card>
  );
}

export default function PoolScreen() {
  const t = useTheme();
  const settings = useSettings();

  const [health, setHealth] = useState<Record<string, BackendHealth>>({});
  const [keyed, setKeyed] = useState<Record<string, boolean>>({});

  const refreshHealth = useCallback(() => {
    void readHealth().then(setHealth);
  }, []);

  const refreshKeys = useCallback(() => {
    void (async () => {
      const entries = await Promise.all(
        OPENAI_BACKENDS.map(async (b) => [b.id, !!(await readBackendKey(b.id))] as const),
      );
      const [gemini, claude] = await Promise.all([readApiKey(), readAnthropicKey()]);
      setKeyed({
        ...Object.fromEntries(entries),
        gemini: !!gemini,
        claude: !!claude,
      });
    })();
  }, []);

  useEffect(() => {
    refreshHealth();
    refreshKeys();
  }, [refreshHealth, refreshKeys]);

  // A resting backend counts down, so the badges need to keep moving.
  useEffect(() => {
    const timer = setInterval(refreshHealth, 15_000);
    return () => clearInterval(timer);
  }, [refreshHealth]);

  const enabled = settings.poolMembers.filter((m) => m.enabled);
  const ready = enabled.filter((m) => !isBenched(health[m.id] ?? ({} as BackendHealth)));

  return (
    <Screen scroll>
      <Header title="Free model pool" onBack={() => router.back()} />

      <View style={{ paddingHorizontal: t.spacing.lg, gap: t.spacing.md }}>
        <Card>
          <Text variant="body">
            {enabled.length === 0
              ? 'Nothing in the rotation yet. Switch on a backend below and paste its key.'
              : `${enabled.length} backend${enabled.length === 1 ? '' : 's'} in the rotation, ${ready.length} ready now.`}
          </Text>
          <Text variant="caption" tone="muted" style={{ marginTop: 6 }}>
            Scout spreads turns across these and moves on when one is rate limited. A backend that
            refuses rests for as long as it asked for, then rejoins on its own. Set the assistant to
            “Free pool” in Settings to use them.
          </Text>
        </Card>
      </View>

      <SectionHeader title="Free tiers" subtitle="Each needs its own key — all are free to create" />
      <View style={{ paddingHorizontal: t.spacing.lg, gap: t.spacing.md }}>
        {settings.poolMembers
          .filter((m) => m.kind === 'openai')
          .map((member) => {
            const backend = backendById(member.backend!);
            if (!backend) return null;
            return (
              <OpenAiMemberCard
                key={member.id}
                backend={backend}
                member={member}
                health={health[member.id]}
                hasKey={!!keyed[member.id]}
                onKeyChanged={refreshKeys}
                onHealthChanged={refreshHealth}
              />
            );
          })}
      </View>

      <SectionHeader
        title="Keys you already have"
        subtitle="Mix a paid key into the rotation as a last resort"
      />
      <View style={{ paddingHorizontal: t.spacing.lg, gap: t.spacing.md, paddingBottom: t.spacing.xl }}>
        {settings.poolMembers
          .filter((m) => m.kind !== 'openai')
          .map((member) => (
            <NativeMemberCard
              key={member.id}
              member={member}
              health={health[member.id]}
              hasKey={!!keyed[member.id]}
              fallbackModel={member.kind === 'claude' ? settings.claudeModel : settings.chatModel}
              onHealthChanged={refreshHealth}
            />
          ))}
      </View>
    </Screen>
  );
}
