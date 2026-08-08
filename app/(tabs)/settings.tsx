import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, Platform, Switch, View } from 'react-native';

import {
  Button,
  Card,
  Divider,
  Field,
  Header,
  ListRow,
  Row,
  Screen,
  SectionHeader,
  Text,
} from '../../src/components/ui';
import { PROVIDER_LABELS } from '../../src/lib/ai/contract';
import {
  clearAnthropicKey,
  looksLikeAnthropicKey,
  readAnthropicKey,
  saveAnthropicKey,
} from '../../src/lib/anthropic/auth';
import {
  FALLBACK_CLAUDE_MODELS,
  listAnthropicModels,
  verifyAnthropicCredential,
} from '../../src/lib/anthropic/client';
import * as background from '../../src/lib/background';
import { resetAllData } from '../../src/lib/db';
import { rebuildDeadlineReminders } from '../../src/lib/engine/checkSource';
import { syncAllRoutineSchedules } from '../../src/lib/engine/routines';
import {
  clearApiKey,
  clearVertexToken,
  looksLikeApiKey,
  maskSecret,
  readApiKey,
  readVertexToken,
  resolveCredential,
  saveApiKey,
  saveVertexToken,
} from '../../src/lib/gemini/auth';
import { listModels, verifyCredential } from '../../src/lib/gemini/client';
import * as notify from '../../src/lib/notify';
import { UsageSummary, formatTokens, loadUsage, subscribeUsage, summarize } from '../../src/lib/usage';
import { errorMessage } from '../../src/lib/util';
import { relative } from '../../src/lib/util/date';
import { exportBackup } from '../../src/lib/backup';
import { useApp } from '../../src/store/app';
import { useSettings } from '../../src/store/settings';
import { useTheme } from '../../src/theme';

const API_KEY_URL = 'https://aistudio.google.com/apikey';

function Toggle({
  title,
  subtitle,
  value,
  onChange,
  icon,
  disabled,
}: {
  title: string;
  subtitle?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  icon?: keyof typeof Ionicons.glyphMap;
  disabled?: boolean;
}) {
  const t = useTheme();
  return (
    <ListRow
      title={title}
      subtitle={subtitle}
      icon={icon}
      right={
        <Switch
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          trackColor={{ false: t.color.surfacePressed, true: t.color.primarySoft }}
          thumbColor={value ? t.color.primary : t.color.textMuted}
          accessibilityLabel={title}
        />
      }
    />
  );
}

/** Choice row rendered as segmented buttons — used for small enums. */
function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const t = useTheme();
  return (
    <Row gap={0} style={{ backgroundColor: t.color.surfaceAlt, borderRadius: t.radius.md, padding: 3 }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <View key={String(o.value)} style={{ flex: 1 }}>
            <Button
              title={o.label}
              size="sm"
              variant={active ? 'primary' : 'ghost'}
              haptic={false}
              fullWidth
              onPress={() => onChange(o.value)}
              style={{ justifyContent: 'center' }}
            />
          </View>
        );
      })}
    </Row>
  );
}

export default function SettingsScreen() {
  const t = useTheme();
  const settings = useSettings();
  const sources = useApp((s) => s.sources);
  const events = useApp((s) => s.events);
  const refreshAll = useApp((s) => s.refreshAll);

  const [keyInput, setKeyInput] = useState('');
  const [storedKey, setStoredKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [vertexToken, setVertexToken] = useState<string | null>(null);
  const [claudeKey, setClaudeKey] = useState<string | null>(null);
  const [claudeInput, setClaudeInput] = useState('');
  const [editingClaude, setEditingClaude] = useState(false);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [notifState, setNotifState] = useState<notify.PermissionState | null>(null);
  const [bgState, setBgState] = useState<background.BackgroundAvailability>('unsupported');
  const [busy, setBusy] = useState<string | null>(null);

  // ------------------------------------------------------------------ load
  useEffect(() => {
    void (async () => {
      setStoredKey(await readApiKey());
      setVertexToken(await readVertexToken());
      setClaudeKey(await readAnthropicKey());
      setUsage(summarize(await loadUsage()));
      setBgState(await background.availability());
      // Read only — asking for permission is the job of the row the user taps.
      setNotifState(await notify.readPermission().catch(() => null));
    })();
    return subscribeUsage((ledger) => setUsage(summarize(ledger)));
  }, []);

  // ---------------------------------------------------------------- actions
  const saveKey = useCallback(async () => {
    const value = keyInput.trim();
    if (!looksLikeApiKey(value)) {
      Alert.alert(
        'That does not look like a key',
        'A Gemini API key is a single long string with no spaces. Copy it from aistudio.google.com/apikey.',
      );
      return;
    }

    setVerifying(true);
    try {
      await saveApiKey(value);
      const result = await verifyCredential({ provider: 'aistudio', apiKey: value }, settings.chatModel);

      if (!result.ok) {
        Alert.alert('Key rejected', result.error);
        settings.set('credentialVerifiedAt', null);
        setStoredKey(value);
        return;
      }

      settings.set('credentialVerifiedAt', Date.now());
      setStoredKey(value);
      setKeyInput('');
      setEditingKey(false);

      // A working key means we can replace the curated model list with the real one.
      try {
        const models = await listModels({ provider: 'aistudio', apiKey: value });
        if (models.length) {
          settings.patch({ knownModels: models, modelsFetchedAt: Date.now() });
        }
      } catch {
        /* the fallback list still works */
      }

      Alert.alert('Connected', 'Your Gemini key works. Scout is ready to use.');
    } catch (e) {
      Alert.alert('Could not save the key', errorMessage(e));
    } finally {
      setVerifying(false);
    }
  }, [keyInput, settings]);

  const saveClaude = useCallback(async () => {
    const value = claudeInput.trim();
    if (!looksLikeAnthropicKey(value)) {
      Alert.alert(
        'That does not look like an Anthropic key',
        'Anthropic keys start with "sk-ant-". Create one at console.anthropic.com/settings/keys.',
      );
      return;
    }

    setBusy('claude');
    try {
      await saveAnthropicKey(value);
      const result = await verifyAnthropicCredential(
        { provider: 'anthropic', apiKey: value },
        settings.claudeModel,
      );
      if (!result.ok) {
        Alert.alert('Key rejected', result.error);
        settings.set('claudeVerifiedAt', null);
        setClaudeKey(value);
        return;
      }

      settings.patch({ claudeVerifiedAt: Date.now(), assistantProvider: 'claude' });
      setClaudeKey(value);
      setClaudeInput('');
      setEditingClaude(false);

      try {
        const models = await listAnthropicModels({ provider: 'anthropic', apiKey: value });
        if (models.length) {
          settings.patch({ knownClaudeModels: models, claudeModelsFetchedAt: Date.now() });
        }
      } catch {
        /* the curated list still works */
      }
      Alert.alert('Connected', 'Claude is now answering in the Assistant tab.');
    } catch (e) {
      Alert.alert('Could not save the key', errorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [claudeInput, settings]);

  const removeClaudeKey = useCallback(() => {
    Alert.alert('Remove Anthropic key?', 'Scout will fall back to Gemini for the assistant.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await clearAnthropicKey();
          setClaudeKey(null);
          settings.patch({ claudeVerifiedAt: null, assistantProvider: 'gemini' });
        },
      },
    ]);
  }, [settings]);

  const removeKey = useCallback(() => {
    Alert.alert('Remove API key?', 'Scout will stop working until you add a key again.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await clearApiKey();
          setStoredKey(null);
          settings.patch({ credentialVerifiedAt: null });
        },
      },
    ]);
  }, [settings]);

  const testConnection = useCallback(async () => {
    setBusy('test');
    try {
      const resolved = await resolveCredential(settings);
      if ('error' in resolved) {
        Alert.alert('Not connected', resolved.error);
        return;
      }
      const result = await verifyCredential(resolved.credential, settings.chatModel);
      if (result.ok) {
        settings.set('credentialVerifiedAt', Date.now());
        Alert.alert('Working', `${settings.chatModel} replied: "${result.reply}"`);
      } else {
        Alert.alert('Failed', result.error);
      }
    } finally {
      setBusy(null);
    }
  }, [settings]);

  const refreshModels = useCallback(async () => {
    setBusy('models');
    try {
      const resolved = await resolveCredential(settings);
      if ('error' in resolved) {
        Alert.alert('Not connected', resolved.error);
        return;
      }
      const models = await listModels(resolved.credential);
      settings.patch({ knownModels: models, modelsFetchedAt: Date.now() });
      Alert.alert('Models updated', `${models.length} models are available to your account.`);
    } catch (e) {
      Alert.alert('Could not list models', errorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [settings]);

  const toggleBackground = useCallback(
    async (enabled: boolean) => {
      setBusy('background');
      try {
        if (enabled) {
          const result = await background.register(settings.backgroundIntervalMin);
          if (!result.ok) {
            Alert.alert('Could not enable background checks', result.reason ?? 'Unknown error');
            return;
          }
          settings.set('backgroundEnabled', true);
        } else {
          await background.unregister();
          settings.set('backgroundEnabled', false);
        }
      } finally {
        setBusy(null);
      }
    },
    [settings],
  );

  const askNotifications = useCallback(async () => {
    const state = await notify.ensurePermission();
    setNotifState(state);
    if (!state.granted) {
      Alert.alert(
        'Notifications off',
        state.reason ?? 'Scout cannot alert you about new events without notification permission.',
        state.canAskAgain
          ? undefined
          : [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Open settings', onPress: () => void Linking.openSettings() },
            ],
      );
      return;
    }
    await notify.configureChannels();
    const booked = await syncAllRoutineSchedules();
    Alert.alert('Notifications on', booked ? `${booked} routine(s) scheduled.` : 'You are all set.');
  }, []);

  const applyReminderLeads = useCallback(
    async (days: number[]) => {
      settings.set('deadlineReminderDays', days);
      setBusy('reminders');
      try {
        const booked = await rebuildDeadlineReminders();
        Alert.alert('Reminders updated', `${booked} deadline reminder(s) scheduled.`);
      } finally {
        setBusy(null);
      }
    },
    [settings],
  );

  const doExport = useCallback(async () => {
    setBusy('export');
    try {
      const result = await exportBackup();
      if (!result.ok) Alert.alert('Export failed', result.error ?? 'Unknown error');
    } finally {
      setBusy(null);
    }
  }, []);

  const wipe = useCallback(() => {
    Alert.alert(
      'Delete everything?',
      'Watched sites, events, routines and chat history are all removed from this device. Your API key is kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete all',
          style: 'destructive',
          onPress: async () => {
            await notify.cancelAll();
            await resetAllData();
            await refreshAll();
            Alert.alert('Done', 'Scout is back to a clean slate.');
          },
        },
      ],
    );
  }, [refreshAll]);

  const connected = settings.provider === 'aistudio' ? !!storedKey : !!vertexToken;

  return (
    <Screen scroll>
      <Header title="Settings" large />

      {/* -------------------------------------------------- assistant provider */}
      <SectionHeader
        title="Assistant"
        subtitle="Which model answers you, and builds panels and rules"
      />
      <View style={{ paddingHorizontal: t.spacing.lg, gap: t.spacing.md }}>
        <Segmented
          options={[
            { label: PROVIDER_LABELS.gemini, value: 'gemini' as const },
            { label: PROVIDER_LABELS.claude, value: 'claude' as const },
          ]}
          value={settings.assistantProvider}
          onChange={(v) => {
            if (v === 'claude' && !claudeKey) {
              setEditingClaude(true);
              Alert.alert(
                'Anthropic key needed',
                'Add an Anthropic API key below to use Claude as the assistant.',
              );
              return;
            }
            settings.set('assistantProvider', v);
          }}
        />

        <Card>
          <Row gap={t.spacing.md} align="flex-start">
            <View
              style={{
                width: 38,
                height: 38,
                borderRadius: t.radius.md,
                backgroundColor: claudeKey ? t.color.successSoft : t.color.surfaceAlt,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons
                name={claudeKey ? 'shield-checkmark' : 'sparkles-outline'}
                size={19}
                color={claudeKey ? t.color.success : t.color.textMuted}
              />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <Text variant="subheading">
                {claudeKey ? 'Anthropic connected' : 'Anthropic not connected'}
              </Text>
              <Text variant="caption" tone="muted">
                {claudeKey ? maskSecret(claudeKey) : 'Optional — Gemini works on its own.'}
              </Text>
              {settings.claudeVerifiedAt ? (
                <Text variant="caption" tone="success">
                  Verified {relative(settings.claudeVerifiedAt)}
                </Text>
              ) : null}
            </View>
          </Row>

          {editingClaude || !claudeKey ? (
            <View style={{ marginTop: t.spacing.lg, gap: t.spacing.md }}>
              <Field
                label="Anthropic API key"
                value={claudeInput}
                onChangeText={setClaudeInput}
                placeholder="sk-ant-…"
                icon="key-outline"
                secretToggle
                autoCapitalize="none"
                autoCorrect={false}
                hint="From console.anthropic.com/settings/keys. Stored in the phone's keystore, same as the Gemini key."
              />
              <Row gap={t.spacing.sm} wrap>
                <Button
                  title="Save and verify"
                  icon="checkmark"
                  loading={busy === 'claude'}
                  disabled={!claudeInput.trim()}
                  onPress={() => void saveClaude()}
                />
                <Button
                  title="Paste"
                  icon="clipboard-outline"
                  variant="secondary"
                  onPress={async () => setClaudeInput((await Clipboard.getStringAsync()).trim())}
                />
                <Button
                  title="Get a key"
                  icon="open-outline"
                  variant="ghost"
                  onPress={() =>
                    void WebBrowser.openBrowserAsync('https://console.anthropic.com/settings/keys')
                  }
                />
                {claudeKey ? (
                  <Button title="Cancel" variant="ghost" onPress={() => setEditingClaude(false)} />
                ) : null}
              </Row>
            </View>
          ) : (
            <Row gap={t.spacing.sm} wrap style={{ marginTop: t.spacing.lg }}>
              <Button
                title="Replace"
                icon="create-outline"
                variant="ghost"
                size="sm"
                onPress={() => setEditingClaude(true)}
              />
              <Button
                title="Remove"
                icon="trash-outline"
                variant="ghost"
                size="sm"
                onPress={removeClaudeKey}
              />
            </Row>
          )}
        </Card>

        {settings.assistantProvider === 'claude' ? (
          <>
            <Card padded={false}>
              <ListRow
                title="Claude model"
                subtitle={settings.claudeModel}
                icon="chatbubbles-outline"
                onPress={() => router.push({ pathname: '/models', params: { target: 'claude' } })}
              />
              <Divider inset={60} />
              <ListRow
                title="Refresh Claude model list"
                subtitle={
                  settings.claudeModelsFetchedAt
                    ? `${settings.knownClaudeModels.length} models · updated ${relative(settings.claudeModelsFetchedAt)}`
                    : `Using the built-in list (${FALLBACK_CLAUDE_MODELS.length})`
                }
                icon="cloud-download-outline"
                onPress={async () => {
                  if (!claudeKey) {
                    Alert.alert('Not connected', 'Add an Anthropic key first.');
                    return;
                  }
                  setBusy('claude-models');
                  try {
                    const models = await listAnthropicModels({
                      provider: 'anthropic',
                      apiKey: claudeKey,
                    });
                    settings.patch({
                      knownClaudeModels: models,
                      claudeModelsFetchedAt: Date.now(),
                    });
                    Alert.alert('Models updated', `${models.length} models available to your key.`);
                  } catch (e) {
                    Alert.alert('Could not list models', errorMessage(e));
                  } finally {
                    setBusy(null);
                  }
                }}
                right={
                  busy === 'claude-models' ? (
                    <Text variant="caption" tone="muted">
                      Loading…
                    </Text>
                  ) : undefined
                }
              />
            </Card>

            <Card>
              <Text variant="label" tone="secondary">
                Thinking effort
              </Text>
              <Text variant="caption" tone="muted" style={{ marginTop: 2, marginBottom: t.spacing.md }}>
                How hard Claude thinks before answering. Higher costs more and takes longer; `high` is
                the API default and a good place to stay.
              </Text>
              <Segmented
                options={[
                  { label: 'Low', value: 'low' as const },
                  { label: 'Medium', value: 'medium' as const },
                  { label: 'High', value: 'high' as const },
                  { label: 'Max', value: 'xhigh' as const },
                ]}
                value={settings.claudeEffort}
                onChange={(v) => settings.set('claudeEffort', v)}
              />
            </Card>
          </>
        ) : null}

        <Card>
          <Row gap={t.spacing.sm} align="flex-start">
            <Ionicons name="information-circle-outline" size={16} color={t.color.textMuted} />
            <Text variant="caption" tone="muted" style={{ flex: 1 }}>
              Page extraction always runs on Gemini, whichever assistant you pick. It runs on every
              site check, and a cheap Flash model is the right tool for turning page text into JSON —
              so a Gemini key is required either way.
            </Text>
          </Row>
        </Card>
      </View>

      {/* ------------------------------------------------------ Gemini access */}
      <SectionHeader title="Gemini access" subtitle="Your key stays in this phone's keystore" />
      <View style={{ paddingHorizontal: t.spacing.lg, gap: t.spacing.md }}>
        <Card>
          <Row gap={t.spacing.md} align="flex-start">
            <View
              style={{
                width: 38,
                height: 38,
                borderRadius: t.radius.md,
                backgroundColor: connected ? t.color.successSoft : t.color.warningSoft,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons
                name={connected ? 'shield-checkmark' : 'shield-outline'}
                size={19}
                color={connected ? t.color.success : t.color.warning}
              />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <Text variant="subheading">
                {connected ? 'Connected to Gemini' : 'No key yet'}
              </Text>
              <Text variant="caption" tone="muted">
                {settings.provider === 'aistudio'
                  ? `AI Studio key · ${maskSecret(storedKey)}`
                  : `Vertex AI · ${settings.vertexProject || 'no project set'}`}
              </Text>
              {settings.credentialVerifiedAt ? (
                <Text variant="caption" tone="success">
                  Last verified {relative(settings.credentialVerifiedAt)}
                </Text>
              ) : null}
            </View>
          </Row>

          {editingKey || !storedKey ? (
            <View style={{ marginTop: t.spacing.lg, gap: t.spacing.md }}>
              <Field
                label="API key"
                value={keyInput}
                onChangeText={setKeyInput}
                placeholder="AIza…"
                icon="key-outline"
                secretToggle
                autoCapitalize="none"
                autoCorrect={false}
                hint="Create one free at aistudio.google.com/apikey — it uses your Google account's Gemini quota."
              />
              <Row gap={t.spacing.sm} wrap>
                <Button
                  title="Save and verify"
                  icon="checkmark"
                  loading={verifying}
                  disabled={!keyInput.trim()}
                  onPress={() => void saveKey()}
                />
                <Button
                  title="Paste"
                  icon="clipboard-outline"
                  variant="secondary"
                  onPress={async () => setKeyInput((await Clipboard.getStringAsync()).trim())}
                />
                <Button
                  title="Get a key"
                  icon="open-outline"
                  variant="ghost"
                  onPress={() => void WebBrowser.openBrowserAsync(API_KEY_URL)}
                />
                {storedKey ? (
                  <Button title="Cancel" variant="ghost" onPress={() => setEditingKey(false)} />
                ) : null}
              </Row>
            </View>
          ) : (
            <Row gap={t.spacing.sm} wrap style={{ marginTop: t.spacing.lg }}>
              <Button
                title="Test connection"
                icon="pulse-outline"
                variant="secondary"
                size="sm"
                loading={busy === 'test'}
                onPress={() => void testConnection()}
              />
              <Button title="Replace" icon="create-outline" variant="ghost" size="sm" onPress={() => setEditingKey(true)} />
              <Button title="Remove" icon="trash-outline" variant="ghost" size="sm" onPress={removeKey} />
            </Row>
          )}
        </Card>

        <Card padded={false}>
          <ListRow
            title="Chat model"
            subtitle={settings.chatModel}
            icon="chatbubbles-outline"
            onPress={() => router.push({ pathname: '/models', params: { target: 'chat' } })}
          />
          <Divider inset={60} />
          <ListRow
            title="Page extraction model"
            subtitle={`${settings.extractModel} · used for every site check`}
            icon="document-text-outline"
            onPress={() => router.push({ pathname: '/models', params: { target: 'extract' } })}
          />
          <Divider inset={60} />
          <ListRow
            title="Refresh model list"
            subtitle={
              settings.modelsFetchedAt
                ? `${settings.knownModels.length} models · updated ${relative(settings.modelsFetchedAt)}`
                : 'Using the built-in list'
            }
            icon="cloud-download-outline"
            onPress={() => void refreshModels()}
            right={busy === 'models' ? <Text variant="caption" tone="muted">Loading…</Text> : undefined}
          />
        </Card>

        {settings.provider === 'vertex' ? (
          <Card>
            <Text variant="label" tone="secondary">
              Vertex AI
            </Text>
            <View style={{ gap: t.spacing.md, marginTop: t.spacing.md }}>
              <Field
                label="Google Cloud project ID"
                value={settings.vertexProject}
                onChangeText={(v) => settings.set('vertexProject', v)}
                placeholder="my-project-123456"
                autoCapitalize="none"
                icon="cube-outline"
              />
              <Field
                label="Location"
                value={settings.vertexLocation}
                onChangeText={(v) => settings.set('vertexLocation', v)}
                placeholder="us-central1"
                autoCapitalize="none"
                icon="globe-outline"
              />
              <Field
                label="OAuth access token"
                value=""
                onChangeText={(v) => {
                  if (v.trim().length > 20) void saveVertexToken(v).then(() => setVertexToken(v));
                }}
                placeholder={vertexToken ? maskSecret(vertexToken) : 'ya29.…'}
                secretToggle
                autoCapitalize="none"
                icon="key-outline"
                hint="From `gcloud auth print-access-token`. These expire after about an hour — see the README for the trade-offs."
              />
              {vertexToken ? (
                <Button
                  title="Clear token"
                  variant="ghost"
                  size="sm"
                  onPress={async () => {
                    await clearVertexToken();
                    setVertexToken(null);
                  }}
                />
              ) : null}
            </View>
          </Card>
        ) : null}

        <Segmented
          options={[
            { label: 'AI Studio key', value: 'aistudio' as const },
            { label: 'Vertex AI', value: 'vertex' as const },
          ]}
          value={settings.provider}
          onChange={(v) => settings.set('provider', v)}
        />
      </View>

      {/* -------------------------------------------------------------- usage */}
      <SectionHeader title="Token usage" action="Details" onAction={() => router.push('/usage')} />
      <View style={{ paddingHorizontal: t.spacing.lg }}>
        <Card onPress={() => router.push('/usage')}>
          <Row gap={t.spacing.lg}>
            {[
              { label: 'Today', value: usage?.today.totalTokens ?? 0, requests: usage?.today.requests ?? 0 },
              { label: '7 days', value: usage?.last7Days.totalTokens ?? 0, requests: usage?.last7Days.requests ?? 0 },
              { label: 'All time', value: usage?.allTime.totalTokens ?? 0, requests: usage?.allTime.requests ?? 0 },
            ].map((stat) => (
              <View key={stat.label} style={{ flex: 1, gap: 2 }}>
                <Text variant="caption" tone="muted">
                  {stat.label}
                </Text>
                <Text variant="heading">{formatTokens(stat.value)}</Text>
                <Text variant="caption" tone="muted">
                  {stat.requests} call{stat.requests === 1 ? '' : 's'}
                </Text>
              </View>
            ))}
          </Row>
        </Card>
      </View>

      {/* ------------------------------------------------------ notifications */}
      <SectionHeader title="Notifications" />
      <View style={{ paddingHorizontal: t.spacing.lg }}>
        <Card padded={false}>
          {notifState && !notifState.granted ? (
            <>
              <ListRow
                title="Notifications are off"
                subtitle={notifState.reason ?? 'Scout cannot tell you about new events.'}
                icon="notifications-off-outline"
                iconTone={t.color.warning}
                onPress={() => void askNotifications()}
              />
              <Divider inset={60} />
            </>
          ) : null}
          <Toggle
            title="New events"
            subtitle="When a watched site publishes something new"
            icon="flash-outline"
            value={settings.notifyNewEvents}
            onChange={(v) => settings.set('notifyNewEvents', v)}
          />
          <Divider inset={60} />
          <Toggle
            title="Page changes"
            subtitle="Only when Gemini judges the change worth knowing"
            icon="git-compare-outline"
            value={settings.notifyChanges}
            onChange={(v) => settings.set('notifyChanges', v)}
          />
          <Divider inset={60} />
          <Toggle
            title="Check failures"
            subtitle="When a site cannot be read at all"
            icon="alert-circle-outline"
            value={settings.notifyErrors}
            onChange={(v) => settings.set('notifyErrors', v)}
          />
          <Divider inset={60} />
          <Toggle
            title="Deadline reminders"
            subtitle={`Automatic, ${settings.deadlineReminderDays.join(' and ')} day(s) before`}
            icon="alarm-outline"
            value={settings.autoDeadlineReminders}
            onChange={(v) => {
              settings.set('autoDeadlineReminders', v);
              void rebuildDeadlineReminders();
            }}
          />
        </Card>

        {settings.autoDeadlineReminders ? (
          <View style={{ marginTop: t.spacing.md, gap: t.spacing.sm }}>
            <Text variant="caption" tone="muted">
              Remind me this far ahead
            </Text>
            <Segmented
              options={[
                { label: '1 day', value: '1' },
                { label: '3 + 1', value: '3,1' },
                { label: '7 + 1', value: '7,1' },
                { label: '14 + 3', value: '14,3' },
              ]}
              value={settings.deadlineReminderDays.join(',')}
              onChange={(v) => void applyReminderLeads(v.split(',').map(Number))}
            />
          </View>
        ) : null}
      </View>

      {/* --------------------------------------------------------- background */}
      <SectionHeader title="Automatic checking" />
      <View style={{ paddingHorizontal: t.spacing.lg }}>
        <Card padded={false}>
          <Toggle
            title="Check in the background"
            subtitle={
              bgState === 'available'
                ? 'Android wakes Scout periodically to check your sites'
                : bgState === 'restricted'
                  ? 'Restricted by the system — check Battery settings for Scout'
                  : 'Not supported on this platform'
            }
            icon="cloud-outline"
            value={settings.backgroundEnabled}
            disabled={bgState === 'unsupported' || busy === 'background'}
            onChange={(v) => void toggleBackground(v)}
          />
          <Divider inset={60} />
          <ListRow
            title="Wake interval"
            subtitle="The system treats this as a minimum, not a promise"
            icon="timer-outline"
            right={
              <Text variant="label" tone="secondary">
                {settings.backgroundIntervalMin >= 60
                  ? `${Math.round(settings.backgroundIntervalMin / 60)}h`
                  : `${settings.backgroundIntervalMin}m`}
              </Text>
            }
          />
          <View style={{ paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.lg }}>
            <Segmented
              options={[
                { label: '15m', value: 15 },
                { label: '1h', value: 60 },
                { label: '4h', value: 240 },
                { label: '12h', value: 720 },
              ]}
              value={settings.backgroundIntervalMin}
              onChange={(v) => {
                settings.set('backgroundIntervalMin', v);
                if (settings.backgroundEnabled) void background.register(v);
              }}
            />
          </View>
          <Divider inset={60} />
          <ListRow
            title="Default interval for new sites"
            subtitle="How often a newly added site gets checked"
            icon="add-circle-outline"
            right={
              <Text variant="label" tone="secondary">
                {settings.defaultCheckIntervalMin >= 60
                  ? `${Math.round(settings.defaultCheckIntervalMin / 60)}h`
                  : `${settings.defaultCheckIntervalMin}m`}
              </Text>
            }
          />
          <View style={{ paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.lg }}>
            <Segmented
              options={[
                { label: '1h', value: 60 },
                { label: '6h', value: 360 },
                { label: '12h', value: 720 },
                { label: 'Daily', value: 1440 },
              ]}
              value={settings.defaultCheckIntervalMin}
              onChange={(v) => settings.set('defaultCheckIntervalMin', v)}
            />
          </View>
        </Card>

        {__DEV__ ? (
          <Button
            title="Trigger a background run now (dev)"
            variant="ghost"
            size="sm"
            style={{ marginTop: t.spacing.sm }}
            onPress={async () => {
              const fired = await background.triggerForTesting();
              Alert.alert('Background', fired ? 'Task triggered.' : 'Could not trigger the task.');
            }}
          />
        ) : null}
      </View>

      {/* ---------------------------------------------------------- behaviour */}
      <SectionHeader title="Replies" />
      <View style={{ paddingHorizontal: t.spacing.lg }}>
        <Card padded={false}>
          <Toggle
            title="Stream replies"
            subtitle="Show the answer as it is written"
            icon="pulse-outline"
            value={settings.streamResponses}
            onChange={(v) => settings.set('streamResponses', v)}
          />
          <Divider inset={60} />
          <Toggle
            title="Google Search grounding"
            subtitle="Let Gemini search the web for general questions"
            icon="globe-outline"
            value={settings.webGrounding}
            onChange={(v) => settings.set('webGrounding', v)}
          />
        </Card>
      </View>

      {/* ---------------------------------------------------------- extraction */}
      <SectionHeader title="Event extraction" />
      <View style={{ paddingHorizontal: t.spacing.lg, gap: t.spacing.md }}>
        <Card>
          <Text variant="label" tone="secondary">
            Confidence floor
          </Text>
          <Text variant="caption" tone="muted" style={{ marginTop: 2, marginBottom: t.spacing.md }}>
            Discard events Gemini is less sure about. Higher keeps the agenda clean; lower catches more.
          </Text>
          <Segmented
            options={[
              { label: 'Everything', value: 0 },
              { label: 'Balanced', value: 0.35 },
              { label: 'Strict', value: 0.6 },
              { label: 'Very strict', value: 0.8 },
            ]}
            value={settings.minConfidence}
            onChange={(v) => settings.set('minConfidence', v)}
          />
        </Card>
        <Card>
          <Text variant="label" tone="secondary">
            How far ahead to look
          </Text>
          <Text variant="caption" tone="muted" style={{ marginTop: 2, marginBottom: t.spacing.md }}>
            Events further out than this are ignored — usually mis-parsed dates.
          </Text>
          <Segmented
            options={[
              { label: '3 months', value: 90 },
              { label: '1 year', value: 400 },
              { label: '2 years', value: 800 },
            ]}
            value={settings.horizonDays}
            onChange={(v) => settings.set('horizonDays', v)}
          />
        </Card>
      </View>

      {/* ---------------------------------------------------------- appearance */}
      <SectionHeader title="Appearance" />
      <View style={{ paddingHorizontal: t.spacing.lg, gap: t.spacing.md }}>
        <Segmented
          options={[
            { label: 'System', value: 'system' as const },
            { label: 'Light', value: 'light' as const },
            { label: 'Dark', value: 'dark' as const },
          ]}
          value={settings.theme}
          onChange={(v) => settings.set('theme', v)}
        />
        <Card padded={false}>
          <Toggle
            title="Compact event cards"
            subtitle="Fit more on screen"
            icon="list-outline"
            value={settings.compactEvents}
            onChange={(v) => settings.set('compactEvents', v)}
          />
        </Card>
      </View>

      {/* ---------------------------------------------------------------- data */}
      <SectionHeader title="Your data" subtitle="Everything lives on this phone only" />
      <View style={{ paddingHorizontal: t.spacing.lg }}>
        <Card padded={false}>
          <ListRow
            title="Export a backup"
            subtitle={`${sources.length} site(s), ${events.length} event(s) as JSON`}
            icon="download-outline"
            onPress={() => void doExport()}
            right={busy === 'export' ? <Text variant="caption" tone="muted">Preparing…</Text> : undefined}
          />
          <Divider inset={60} />
          <ListRow
            title="Replay onboarding"
            subtitle="See the setup walkthrough again"
            icon="help-buoy-outline"
            onPress={() => {
              settings.set('hasOnboarded', false);
              router.push('/onboarding');
            }}
          />
          <Divider inset={60} />
          <ListRow
            title="Delete all data"
            subtitle="Sites, events, routines and chat history"
            icon="trash-outline"
            destructive
            onPress={wipe}
          />
        </Card>
      </View>

      <View style={{ padding: t.spacing.xl, gap: t.spacing.xs, alignItems: 'center' }}>
        <Text variant="caption" tone="muted">
          Scout 1.0.0 · {Platform.OS} · Expo SDK 57
        </Text>
        <Text variant="caption" tone="muted" center>
          Scout has no server. Page contents go to Google's Gemini API and nowhere else.
        </Text>
      </View>
    </Screen>
  );
}
