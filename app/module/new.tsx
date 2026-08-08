import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Badge, Button, Card, Field, Header, Row, Text } from '../../src/components/ui';
import { createModule } from '../../src/lib/db/modules';
import { generateModule } from '../../src/lib/modules/generate';
import { CAPABILITY_LABELS, Capability } from '../../src/lib/modules/types';
import { errorMessage } from '../../src/lib/util';
import { useApp } from '../../src/store/app';
import { useSettings } from '../../src/store/settings';
import { useTheme } from '../../src/theme';

const IDEAS = [
  'A bar chart of how many events each watched site has produced',
  'A weekly view: this week, next week, the week after — with counts and titles',
  'A countdown list of every deadline, most urgent first, colour-coded',
  'A checklist of starred events I can tick off, remembering what I ticked',
  'A price overview: which upcoming events are free and which cost money',
  'A “stale sites” panel showing which watched pages have not changed in a month',
];

export default function NewModuleScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const settings = useSettings();
  const refreshModules = useApp((s) => s.refreshModules);

  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const build = useCallback(async () => {
    const text = request.trim();
    if (text.length < 8) {
      Alert.alert('Say a little more', 'Describe what the panel should show and do.');
      return;
    }

    setBusy(true);
    setProblems([]);
    try {
      const generated = await generateModule({ settings, request: text });
      if (!generated.ok) {
        setProblems(generated.problems ?? []);
        Alert.alert('Could not build that panel', generated.error);
        return;
      }

      const module = await createModule({
        name: generated.module.name,
        description: generated.module.description || null,
        icon: generated.module.icon,
        html: generated.module.fragment,
        prompt: text,
        capabilities: generated.module.capabilities,
        enabled: true,
        pinned: false,
      });
      await refreshModules();
      router.replace({ pathname: '/module/[id]', params: { id: module.id } });
    } catch (e) {
      Alert.alert('Could not build that panel', errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [request, settings, refreshModules]);

  const providerLabel = settings.assistantProvider === 'claude' ? 'Claude' : 'Gemini';

  return (
    <View style={{ flex: 1, backgroundColor: t.color.bg, paddingTop: insets.top }}>
      <Header title="Build a panel" onBack={() => router.back()} />

      <ScrollView
        contentContainerStyle={{
          padding: t.spacing.lg,
          paddingBottom: insets.bottom + 120,
          gap: t.spacing.lg,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ gap: t.spacing.sm }}>
          <Text variant="title">What should it do?</Text>
          <Text variant="body" tone="secondary">
            {providerLabel} writes a small panel and Scout runs it inside the app. It becomes part of
            your Studio and you can revise it later.
          </Text>
        </View>

        <Field
          label="Describe the panel"
          value={request}
          onChangeText={setRequest}
          placeholder="A bar chart of events per watched site, tallest first"
          icon="sparkles-outline"
          multiline
          hint="Be specific about what to show, how to group it, and how to sort it."
        />

        <View style={{ gap: t.spacing.sm }}>
          <Text variant="label" tone="secondary">
            Ideas
          </Text>
          {IDEAS.map((idea) => (
            <Pressable
              key={idea}
              onPress={() => setRequest(idea)}
              accessibilityRole="button"
              style={({ pressed }) => ({
                padding: t.spacing.md,
                borderRadius: t.radius.sm,
                borderWidth: 1,
                borderColor: t.color.border,
                backgroundColor: pressed ? t.color.surfaceAlt : t.color.surface,
              })}
            >
              <Text variant="caption" tone="secondary">
                {idea}
              </Text>
            </Pressable>
          ))}
        </View>

        {problems.length ? (
          <Card accent={t.color.danger}>
            <Text variant="label" tone="danger">
              The generated panel was rejected
            </Text>
            <View style={{ gap: 4, marginTop: t.spacing.sm }}>
              {problems.map((p) => (
                <Text key={p} variant="caption" tone="muted">
                  • {p}
                </Text>
              ))}
            </View>
            <Text variant="caption" tone="muted" style={{ marginTop: t.spacing.sm }}>
              Try again — the sandbox refuses panels that reach the network or load outside code.
            </Text>
          </Card>
        ) : null}

        <Card>
          <Row gap={t.spacing.sm} align="flex-start">
            <Ionicons name="shield-checkmark-outline" size={17} color={t.color.success} />
            <View style={{ flex: 1, gap: t.spacing.sm }}>
              <Text variant="label" tone="secondary">
                What a panel can and cannot do
              </Text>
              <Text variant="caption" tone="muted">
                It runs in a sandbox with no network access at all, so it cannot send your data
                anywhere or fetch new code. It never sees your API keys. It can only read what you
                grant it:
              </Text>
              <Row gap={6} wrap>
                {(Object.keys(CAPABILITY_LABELS) as Capability[]).slice(0, 4).map((c) => (
                  <Badge key={c} label={CAPABILITY_LABELS[c]} tone="neutral" />
                ))}
              </Row>
              <Text variant="caption" tone="muted">
                Permissions are listed on the panel’s screen and you can revoke any of them.
              </Text>
            </View>
          </Row>
        </Card>
      </ScrollView>

      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          padding: t.spacing.lg,
          paddingBottom: insets.bottom + t.spacing.lg,
          backgroundColor: t.color.surface,
          borderTopWidth: 1,
          borderTopColor: t.color.border,
        }}
      >
        <Button
          title={busy ? 'Building…' : 'Build it'}
          icon="hammer-outline"
          size="lg"
          fullWidth
          loading={busy}
          disabled={!request.trim()}
          onPress={() => void build()}
        />
      </View>
    </View>
  );
}
