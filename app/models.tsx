import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Badge, Button, Card, Field, Header, Row, Text } from '../src/components/ui';
import { readAnthropicKey } from '../src/lib/anthropic/auth';
import { FALLBACK_CLAUDE_MODELS, listAnthropicModels } from '../src/lib/anthropic/client';
import { resolveCredential } from '../src/lib/gemini/auth';
import { FALLBACK_MODELS, listModels } from '../src/lib/gemini/client';
import { ModelInfo } from '../src/lib/gemini/types';
import { errorMessage } from '../src/lib/util';
import { relative } from '../src/lib/util/date';
import { useSettings } from '../src/store/settings';
import { useTheme } from '../src/theme';

/** Short, honest guidance for the models people will actually see. */
function noteFor(id: string): { tone: 'success' | 'primary' | 'warning' | 'neutral'; text: string } | null {
  if (/haiku/.test(id))
    return { tone: 'success', text: 'Fastest and cheapest Claude. Fine for simple questions.' };
  if (/opus/.test(id))
    return { tone: 'primary', text: 'Strongest reasoning and code writing. Best for building panels.' };
  if (/sonnet/.test(id))
    return { tone: 'primary', text: 'Near-Opus quality at lower cost. A good default.' };
  if (/flash-lite/.test(id))
    return { tone: 'success', text: 'Cheapest. Good for frequent background checks.' };
  if (/flash/.test(id))
    return { tone: 'primary', text: 'Best balance of speed, cost and accuracy. Recommended.' };
  if (/pro/.test(id))
    return { tone: 'warning', text: 'Strongest reasoning, but slower and uses far more quota.' };
  if (/preview|exp/.test(id))
    return { tone: 'warning', text: 'Preview model — may change or disappear without notice.' };
  return null;
}

function ModelRow({
  model,
  selected,
  onSelect,
}: {
  model: ModelInfo;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useTheme();
  const note = noteFor(model.id);

  return (
    <Pressable
      onPress={onSelect}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        gap: t.spacing.md,
        padding: t.spacing.lg,
        borderRadius: t.radius.lg,
        borderWidth: 1,
        borderColor: selected ? t.color.primary : t.color.border,
        backgroundColor: selected ? t.color.primarySoft : pressed ? t.color.surfaceAlt : t.color.surface,
      })}
    >
      <Ionicons
        name={selected ? 'radio-button-on' : 'radio-button-off'}
        size={20}
        color={selected ? t.color.primary : t.color.textMuted}
        style={{ marginTop: 2 }}
      />
      <View style={{ flex: 1, gap: 4 }}>
        <Text variant="bodyStrong">{model.displayName}</Text>
        <Text variant="caption" tone="muted">
          {model.id}
        </Text>
        {note ? (
          <Text variant="caption" tone={note.tone === 'neutral' ? 'muted' : note.tone}>
            {note.text}
          </Text>
        ) : model.description ? (
          <Text variant="caption" tone="muted" numberOfLines={2}>
            {model.description}
          </Text>
        ) : null}
        {model.inputTokenLimit ? (
          <Row gap={6} wrap>
            <Badge label={`${Math.round(model.inputTokenLimit / 1000)}k in`} tone="neutral" />
            {model.outputTokenLimit ? (
              <Badge label={`${Math.round(model.outputTokenLimit / 1000)}k out`} tone="neutral" />
            ) : null}
          </Row>
        ) : null}
      </View>
    </Pressable>
  );
}

export default function ModelPickerScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { target } = useLocalSearchParams<{ target?: 'chat' | 'extract' | 'claude' }>();
  const settings = useSettings();

  const isClaude = target === 'claude';
  const isExtract = target === 'extract';
  const current = isClaude
    ? settings.claudeModel
    : isExtract
      ? settings.extractModel
      : settings.chatModel;

  const [refreshing, setRefreshing] = useState(false);
  const [customId, setCustomId] = useState('');
  const [showCustom, setShowCustom] = useState(false);

  const models = useMemo(() => {
    if (isClaude) {
      const claude = (
        settings.knownClaudeModels.length ? settings.knownClaudeModels : FALLBACK_CLAUDE_MODELS
      ).map<ModelInfo>((m) => ({
        name: m.id,
        id: m.id,
        displayName: m.display_name || m.id,
        description: '',
        inputTokenLimit: m.max_input_tokens ?? 0,
        outputTokenLimit: m.max_tokens ?? 0,
        supportedActions: [],
      }));
      if (claude.some((m) => m.id === current)) return claude;
      return [
        {
          name: current,
          id: current,
          displayName: current,
          description: 'Currently selected. Not in the list returned by your key.',
          inputTokenLimit: 0,
          outputTokenLimit: 0,
          supportedActions: [],
        },
        ...claude,
      ];
    }
    const list = settings.knownModels.length ? settings.knownModels : FALLBACK_MODELS;
    // Always show whatever is currently selected, even if the list lacks it.
    if (list.some((m) => m.id === current)) return list;
    return [
      {
        name: `models/${current}`,
        id: current,
        displayName: current,
        description: 'Currently selected. Not present in the model list from your key.',
        inputTokenLimit: 0,
        outputTokenLimit: 0,
        supportedActions: [],
      },
      ...list,
    ];
  }, [settings.knownModels, settings.knownClaudeModels, current, isClaude]);

  const select = useCallback(
    (id: string) => {
      settings.set(isClaude ? 'claudeModel' : isExtract ? 'extractModel' : 'chatModel', id);
      router.back();
    },
    [isClaude, isExtract, settings],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      if (isClaude) {
        const apiKey = await readAnthropicKey();
        if (!apiKey) {
          Alert.alert('Not connected', 'Add an Anthropic key in Settings first.');
          return;
        }
        const fetched = await listAnthropicModels({ provider: 'anthropic', apiKey });
        settings.patch({ knownClaudeModels: fetched, claudeModelsFetchedAt: Date.now() });
        return;
      }
      const resolved = await resolveCredential(settings);
      if ('error' in resolved) {
        Alert.alert('Not connected', resolved.error);
        return;
      }
      const fetched = await listModels(resolved.credential);
      settings.patch({ knownModels: fetched, modelsFetchedAt: Date.now() });
    } catch (e) {
      Alert.alert('Could not list models', errorMessage(e));
    } finally {
      setRefreshing(false);
    }
  }, [settings, isClaude]);

  return (
    <View style={{ flex: 1, backgroundColor: t.color.bg, paddingTop: insets.top }}>
      <Header
        title={isClaude ? 'Claude model' : isExtract ? 'Extraction model' : 'Chat model'}
        subtitle={
          (isClaude ? settings.claudeModelsFetchedAt : settings.modelsFetchedAt)
            ? `${models.length} available · updated ${relative(isClaude ? settings.claudeModelsFetchedAt : settings.modelsFetchedAt)}`
            : 'Built-in list — refresh to see what your key allows'
        }
        onBack={() => router.back()}
      />

      <FlatList
        data={models}
        keyExtractor={(m) => m.id}
        ListHeaderComponent={
          <View style={{ gap: t.spacing.md, paddingBottom: t.spacing.md }}>
            <Card>
              <Text variant="caption" tone="muted" style={{ lineHeight: 18 }}>
                {isClaude
                  ? 'This Claude model answers you in the Assistant tab and writes panels and rules. Opus is the strongest; Sonnet is a cheaper middle ground; Haiku is the fastest.'
                  : isExtract
                    ? 'This model reads every page you watch. It runs far more often than the chat model, so a cheaper one here saves the most quota.'
                    : 'This model answers you in the Assistant tab and runs your routines.'}
              </Text>
            </Card>
            <Button
              title={refreshing ? 'Refreshing…' : 'Refresh from Google'}
              icon="cloud-download-outline"
              variant="secondary"
              size="sm"
              loading={refreshing}
              onPress={() => void refresh()}
            />
          </View>
        }
        renderItem={({ item }) => (
          <View style={{ paddingBottom: t.spacing.sm }}>
            <ModelRow model={item} selected={item.id === current} onSelect={() => select(item.id)} />
          </View>
        )}
        ListFooterComponent={
          <View style={{ gap: t.spacing.md, paddingTop: t.spacing.md }}>
            {showCustom ? (
              <Card>
                <Field
                  label="Model id"
                  value={customId}
                  onChangeText={setCustomId}
                  placeholder="gemini-2.5-flash"
                  autoCapitalize="none"
                  autoCorrect={false}
                  icon="code-outline"
                  hint="Use this to try a model that is not in the list yet."
                />
                <Row gap={t.spacing.sm} style={{ marginTop: t.spacing.md }}>
                  <Button
                    title="Use it"
                    icon="checkmark"
                    disabled={!customId.trim()}
                    onPress={() => select(customId.trim())}
                  />
                  <Button title="Cancel" variant="ghost" onPress={() => setShowCustom(false)} />
                </Row>
              </Card>
            ) : (
              <Button
                title="Enter a model id by hand"
                icon="create-outline"
                variant="ghost"
                size="sm"
                onPress={() => setShowCustom(true)}
              />
            )}
          </View>
        }
        contentContainerStyle={{ padding: t.spacing.lg, paddingBottom: insets.bottom + t.spacing.xxl }}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}
