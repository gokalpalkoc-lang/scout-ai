import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Badge, Button, Card, Field, Header, Row, Text } from '../../src/components/ui';
import { previewRule } from '../../src/lib/rules/engine';
import { generateRule } from '../../src/lib/rules/generate';
import { Rule, describeRule } from '../../src/lib/rules/types';
import { errorMessage, truncate } from '../../src/lib/util';
import { useApp } from '../../src/store/app';
import { useSettings } from '../../src/store/settings';
import { useTheme } from '../../src/theme';

const EXAMPLES = [
  'Star anything that is free',
  'Remind me a week before any application deadline',
  'Hide anything with "cancelled" in the title',
  'Add every concert to my calendar automatically',
  'Notify me about anything happening in the next three days',
  'Tag anything from the university as "work"',
];

export default function NewRuleScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const settings = useSettings();

  const sources = useApp((s) => s.sources);
  const events = useApp((s) => s.events);
  const addRule = useApp((s) => s.addRule);

  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<{
    rule: Omit<Rule, 'id' | 'createdAt' | 'updatedAt' | 'lastFiredAt' | 'fireCount'>;
    matched: number;
    examples: string[];
  } | null>(null);

  const propose = useCallback(async () => {
    const text = request.trim();
    if (text.length < 5) {
      Alert.alert('Say a little more', 'Describe the automation in a sentence.');
      return;
    }

    setBusy(true);
    setProposal(null);
    try {
      const generated = await generateRule({ settings, request: text, sources });
      if (!generated.ok) {
        Alert.alert(
          'Could not build that rule',
          [generated.error, ...(generated.problems ?? [])].join('\n\n'),
        );
        return;
      }

      const draft = {
        name: generated.rule.name,
        enabled: true,
        priority: 100,
        sourceId: generated.rule.sourceId,
        author: 'assistant' as const,
        all: generated.rule.all,
        any: generated.rule.any,
        actions: generated.rule.actions,
      };

      // Dry run against what is already in the agenda, so the user can sanity
      // check the rule before it starts acting on new events.
      const preview = previewRule(
        { ...draft, id: 'preview', createdAt: 0, updatedAt: 0, lastFiredAt: null, fireCount: 0 },
        events,
        sources,
      );

      setProposal({
        rule: draft,
        matched: preview.matched.length,
        examples: preview.matched.slice(0, 5).map((e) => truncate(e.title, 60)),
      });
    } catch (e) {
      Alert.alert('Could not build that rule', errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [request, settings, sources, events]);

  const save = useCallback(async () => {
    if (!proposal) return;
    try {
      await addRule(proposal.rule);
      router.back();
    } catch (e) {
      Alert.alert('Could not save', errorMessage(e));
    }
  }, [proposal, addRule]);

  return (
    <View style={{ flex: 1, backgroundColor: t.color.bg, paddingTop: insets.top }}>
      <Header title="New rule" onBack={() => router.back()} />

      <ScrollView
        contentContainerStyle={{
          padding: t.spacing.lg,
          paddingBottom: insets.bottom + 120,
          gap: t.spacing.lg,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ gap: t.spacing.sm }}>
          <Text variant="title">Describe the automation</Text>
          <Text variant="body" tone="secondary">
            Scout turns your sentence into a rule, then the app applies it to every new event on its
            own — no model involved at that point, so it is fast and predictable.
          </Text>
        </View>

        <Field
          label="What should happen?"
          value={request}
          onChangeText={setRequest}
          placeholder="Star anything free at Salon IKSV"
          icon="git-branch-outline"
          multiline
        />

        <View style={{ gap: t.spacing.sm }}>
          <Text variant="label" tone="secondary">
            Examples
          </Text>
          {EXAMPLES.map((example) => (
            <Pressable
              key={example}
              onPress={() => setRequest(example)}
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
                {example}
              </Text>
            </Pressable>
          ))}
        </View>

        {proposal ? (
          <Card accent={t.color.primary}>
            <Row gap={6} wrap>
              <Text variant="subheading" style={{ flexShrink: 1 }}>
                {proposal.rule.name}
              </Text>
              <Badge label="proposed" tone="primary" />
            </Row>
            <Text variant="body" tone="secondary" style={{ marginTop: t.spacing.sm }}>
              {describeRule(proposal.rule)}
            </Text>

            <View
              style={{
                marginTop: t.spacing.md,
                padding: t.spacing.md,
                borderRadius: t.radius.sm,
                backgroundColor: t.color.surfaceAlt,
                gap: 4,
              }}
            >
              <Text variant="label" tone="secondary">
                Dry run against your current agenda
              </Text>
              <Text variant="caption" tone={proposal.matched ? 'success' : 'warning'}>
                {proposal.matched
                  ? `Would have matched ${proposal.matched} existing event${proposal.matched === 1 ? '' : 's'}`
                  : 'Matches nothing you have right now — it may still be correct for future events.'}
              </Text>
              {proposal.examples.map((title) => (
                <Text key={title} variant="caption" tone="muted">
                  • {title}
                </Text>
              ))}
            </View>

            <Text variant="caption" tone="muted" style={{ marginTop: t.spacing.md }}>
              Saving applies it to newly found events from now on. Existing events are left alone.
            </Text>
          </Card>
        ) : null}

        <Card>
          <Row gap={t.spacing.sm} align="flex-start">
            <Ionicons name="information-circle-outline" size={16} color={t.color.textMuted} />
            <Text variant="caption" tone="muted" style={{ flex: 1 }}>
              A rule can star, hide, notify, set a category, add to your calendar, or book a deadline
              reminder. Anything outside that list is refused when the rule is built.
            </Text>
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
          gap: t.spacing.sm,
        }}
      >
        {proposal ? (
          <>
            <Button title="Save this rule" icon="checkmark" size="lg" fullWidth onPress={() => void save()} />
            <Button
              title="Try a different wording"
              variant="ghost"
              fullWidth
              onPress={() => setProposal(null)}
            />
          </>
        ) : (
          <Button
            title={busy ? 'Building…' : 'Build the rule'}
            icon="construct-outline"
            size="lg"
            fullWidth
            loading={busy}
            disabled={!request.trim()}
            onPress={() => void propose()}
          />
        )}
      </View>
    </View>
  );
}
