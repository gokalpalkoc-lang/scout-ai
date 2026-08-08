import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EventCard } from '../../src/components/EventCard';
import { intervalLabel } from '../../src/components/SourceCard';
import {
  Badge,
  Button,
  Card,
  Chip,
  Divider,
  EmptyState,
  Field,
  Header,
  IconButton,
  Row,
  Text,
} from '../../src/components/ui';
import { CheckRun, WatchMode } from '../../src/lib/types';
import { hostOf, truncate } from '../../src/lib/util';
import { relative } from '../../src/lib/util/date';
import { useApp } from '../../src/store/app';
import { useTheme } from '../../src/theme';

const INTERVALS = [
  { label: '1h', value: 60 },
  { label: '6h', value: 360 },
  { label: '12h', value: 720 },
  { label: 'Daily', value: 1440 },
  { label: 'Weekly', value: 10_080 },
];

const MODE_OPTIONS: { value: WatchMode; label: string }[] = [
  { value: 'both', label: 'Events + changes' },
  { value: 'events', label: 'Events only' },
  { value: 'changes', label: 'Changes only' },
];

function HistoryRow({ run }: { run: CheckRun }) {
  const t = useTheme();
  const tone =
    run.status === 'error' ? t.color.danger : run.newEvents > 0 ? t.color.accent : t.color.textMuted;

  return (
    <Row gap={t.spacing.md} align="flex-start" style={{ paddingVertical: t.spacing.sm }}>
      <View style={{ width: 8, alignItems: 'center', paddingTop: 5 }}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: tone }} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Row gap={t.spacing.sm}>
          <Text variant="caption" tone="secondary">
            {relative(run.ranAt)}
          </Text>
          <Text variant="caption" tone="muted">
            · {run.trigger}
          </Text>
          {run.newEvents > 0 ? <Badge label={`${run.newEvents} new`} tone="accent" /> : null}
          {run.status === 'error' ? <Badge label="error" tone="danger" /> : null}
        </Row>
        {run.note ? (
          <Text variant="caption" tone={run.status === 'error' ? 'danger' : 'muted'} numberOfLines={3}>
            {run.note}
          </Text>
        ) : null}
      </View>
    </Row>
  );
}

export default function SourceDetailScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();

  const source = useApp((s) => s.sources.find((x) => x.id === id));
  const events = useApp((s) => s.events);
  const checking = useApp((s) => s.checking.includes(id ?? ''));
  const editSource = useApp((s) => s.editSource);
  const removeSource = useApp((s) => s.removeSource);
  const checkOne = useApp((s) => s.checkOne);
  const toggleStar = useApp((s) => s.toggleStar);
  const markSeen = useApp((s) => s.markSeen);
  const historyFor = useApp((s) => s.historyFor);

  const [history, setHistory] = useState<CheckRun[]>([]);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftHint, setDraftHint] = useState('');
  const [draftCategory, setDraftCategory] = useState('');

  const sourceEvents = useMemo(
    () => events.filter((e) => e.sourceId === id).slice(0, 60),
    [events, id],
  );

  const loadHistory = useCallback(async () => {
    if (!id) return;
    setHistory(await historyFor(id));
  }, [id, historyFor]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory, source?.lastCheckedAt]);

  useEffect(() => {
    if (!source) return;
    setDraftTitle(source.title);
    setDraftHint(source.hint ?? '');
    setDraftCategory(source.category ?? '');
  }, [source?.id, source?.title, source?.hint, source?.category]);

  const runCheck = useCallback(
    async (force: boolean) => {
      if (!id) return;
      const outcome = await checkOne(id, { force, silent: true });
      await loadHistory();
      if (!outcome.ok) {
        Alert.alert('Check failed', outcome.error ?? 'Unknown error');
        return;
      }
      Alert.alert(
        outcome.sourceTitle,
        outcome.skippedExtraction
          ? 'No change since the last check. Use "Re-extract" to read it again anyway.'
          : [
              outcome.newEvents.length
                ? `${outcome.newEvents.length} new event${outcome.newEvents.length === 1 ? '' : 's'}`
                : 'No new events',
              outcome.totalEvents ? `${outcome.totalEvents} found on the page` : '',
              outcome.change?.headline ? `\n${outcome.change.headline}` : '',
              outcome.note && outcome.note !== outcome.change?.headline ? `\n${outcome.note}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
      );
    },
    [id, checkOne, loadHistory],
  );

  const saveEdits = useCallback(async () => {
    if (!id) return;
    await editSource(id, {
      title: draftTitle.trim() || hostOf(source?.url ?? ''),
      hint: draftHint.trim() || null,
      category: draftCategory.trim() || null,
    });
    setEditing(false);
  }, [id, draftTitle, draftHint, draftCategory, editSource, source?.url]);

  const confirmDelete = useCallback(() => {
    if (!source) return;
    Alert.alert(
      'Stop watching this page?',
      `"${source.title}" and the ${sourceEvents.length} event(s) found through it will be deleted.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await removeSource(source.id);
            router.back();
          },
        },
      ],
    );
  }, [source, sourceEvents.length, removeSource]);

  if (!source) {
    return (
      <View style={{ flex: 1, backgroundColor: t.color.bg, paddingTop: insets.top }}>
        <Header title="Not found" onBack={() => router.back()} />
        <EmptyState
          icon="help-circle-outline"
          title="This site is gone"
          message="It may have been deleted from another screen."
          action={<Button title="Back to watchlist" onPress={() => router.back()} />}
        />
      </View>
    );
  }

  const newCount = sourceEvents.filter((e) => e.isNew).length;

  return (
    <View style={{ flex: 1, backgroundColor: t.color.bg, paddingTop: insets.top }}>
      <Header
        title={source.title}
        subtitle={hostOf(source.url)}
        onBack={() => router.back()}
        right={
          <Row gap={0}>
            <IconButton
              icon="open-outline"
              accessibilityLabel="Open the page in a browser"
              onPress={() => void WebBrowser.openBrowserAsync(source.url)}
            />
            <IconButton
              icon={editing ? 'close' : 'create-outline'}
              accessibilityLabel={editing ? 'Cancel editing' : 'Edit this site'}
              onPress={() => setEditing((e) => !e)}
            />
          </Row>
        }
      />

      <ScrollView
        contentContainerStyle={{ padding: t.spacing.lg, paddingBottom: insets.bottom + 100, gap: t.spacing.lg }}
        showsVerticalScrollIndicator={false}
      >
        {/* ------------------------------------------------------------- status */}
        <Card accent={source.lastStatus === 'error' ? t.color.danger : t.color.primary}>
          <Row justify="space-between" align="flex-start">
            <View style={{ gap: 4, flex: 1 }}>
              <Text variant="label" tone="muted">
                LAST CHECK
              </Text>
              <Text variant="subheading">
                {source.lastCheckedAt ? relative(source.lastCheckedAt) : 'Never checked'}
              </Text>
            </View>
            <Switch
              value={source.enabled}
              onValueChange={(enabled) => void editSource(source.id, { enabled })}
              trackColor={{ false: t.color.surfacePressed, true: t.color.primarySoft }}
              thumbColor={source.enabled ? t.color.primary : t.color.textMuted}
              accessibilityLabel={source.enabled ? 'Pause this site' : 'Resume this site'}
            />
          </Row>

          {source.lastStatus === 'error' && source.lastError ? (
            <View
              style={{
                marginTop: t.spacing.md,
                padding: t.spacing.md,
                borderRadius: t.radius.sm,
                backgroundColor: t.color.dangerSoft,
              }}
            >
              <Text variant="caption" tone="danger">
                {source.lastError}
              </Text>
            </View>
          ) : source.lastSummary ? (
            <Text variant="body" tone="secondary" style={{ marginTop: t.spacing.md }}>
              {source.lastSummary}
            </Text>
          ) : null}

          <Row gap={6} wrap style={{ marginTop: t.spacing.md }}>
            <Badge
              label={source.enabled ? intervalLabel(source.intervalMin) : 'Paused'}
              tone={source.enabled ? 'primary' : 'neutral'}
              icon="timer-outline"
            />
            <Badge label={`${sourceEvents.length} events`} tone="neutral" />
            {newCount ? <Badge label={`${newCount} new`} tone="accent" dot /> : null}
            {!source.notify ? <Badge label="Muted" tone="warning" icon="notifications-off-outline" /> : null}
          </Row>

          <Row gap={t.spacing.sm} wrap style={{ marginTop: t.spacing.lg }}>
            <Button
              title="Check now"
              icon="refresh"
              size="sm"
              loading={checking}
              onPress={() => void runCheck(false)}
            />
            <Button
              title="Re-extract"
              icon="reload-outline"
              variant="secondary"
              size="sm"
              loading={checking}
              onPress={() => void runCheck(true)}
            />
            {newCount ? (
              <Button
                title="Mark seen"
                icon="checkmark-done-outline"
                variant="ghost"
                size="sm"
                onPress={() => void markSeen(source.id)}
              />
            ) : null}
          </Row>
        </Card>

        {/* ------------------------------------------------------------ editing */}
        {editing ? (
          <Card>
            <Text variant="label" tone="secondary">
              Edit
            </Text>
            <View style={{ gap: t.spacing.md, marginTop: t.spacing.md }}>
              <Field label="Name" value={draftTitle} onChangeText={setDraftTitle} icon="pricetag-outline" />
              <Field
                label="Group"
                value={draftCategory}
                onChangeText={setDraftCategory}
                placeholder="music, work…"
                icon="folder-outline"
                autoCapitalize="none"
              />
              <Field
                label="Extraction hint"
                value={draftHint}
                onChangeText={setDraftHint}
                placeholder="Only the concerts section"
                icon="bulb-outline"
                multiline
                hint="Changing this takes effect on the next re-extract."
              />

              <View style={{ gap: t.spacing.sm }}>
                <Text variant="label" tone="secondary">
                  Watch for
                </Text>
                <Row gap={t.spacing.sm} wrap>
                  {MODE_OPTIONS.map((m) => (
                    <Chip
                      key={m.value}
                      label={m.label}
                      selected={source.mode === m.value}
                      onPress={() => void editSource(source.id, { mode: m.value })}
                    />
                  ))}
                </Row>
              </View>

              <View style={{ gap: t.spacing.sm }}>
                <Text variant="label" tone="secondary">
                  Check every
                </Text>
                <Row gap={t.spacing.sm} wrap>
                  {INTERVALS.map((i) => (
                    <Chip
                      key={i.value}
                      label={i.label}
                      selected={source.intervalMin === i.value}
                      onPress={() => void editSource(source.id, { intervalMin: i.value })}
                    />
                  ))}
                </Row>
              </View>

              <Row justify="space-between">
                <Text variant="body">Allow notifications</Text>
                <Switch
                  value={source.notify}
                  onValueChange={(notify) => void editSource(source.id, { notify })}
                  trackColor={{ false: t.color.surfacePressed, true: t.color.primarySoft }}
                  thumbColor={source.notify ? t.color.primary : t.color.textMuted}
                  accessibilityLabel="Allow notifications for this site"
                />
              </Row>

              <Row gap={t.spacing.sm}>
                <Button title="Save" icon="checkmark" onPress={() => void saveEdits()} />
                <Button title="Cancel" variant="ghost" onPress={() => setEditing(false)} />
              </Row>
            </View>
          </Card>
        ) : source.hint ? (
          <Card>
            <Row gap={t.spacing.sm} align="flex-start">
              <Ionicons name="bulb-outline" size={16} color={t.color.accent} />
              <View style={{ flex: 1 }}>
                <Text variant="label" tone="secondary">
                  Extraction hint
                </Text>
                <Text variant="body" tone="secondary" style={{ marginTop: 2 }}>
                  {source.hint}
                </Text>
              </View>
            </Row>
          </Card>
        ) : null}

        {/* ------------------------------------------------------------- events */}
        <View style={{ gap: t.spacing.sm }}>
          <Row justify="space-between">
            <Text variant="label" tone="muted">
              EVENTS FROM THIS PAGE
            </Text>
            <Text variant="caption" tone="muted">
              {sourceEvents.length}
            </Text>
          </Row>

          {sourceEvents.length ? (
            sourceEvents.map((event) => (
              <EventCard
                key={event.id}
                event={event}
                onPress={() => router.push({ pathname: '/event/[id]', params: { id: event.id } })}
                onToggleStar={() => void toggleStar(event.id)}
              />
            ))
          ) : (
            <Card>
              <Text variant="body" tone="muted" center>
                {source.mode === 'changes'
                  ? 'This page is watched for changes only, so no events are extracted from it.'
                  : source.lastCheckedAt
                    ? 'Nothing dated was found here. Try an extraction hint, or check whether the page needs JavaScript.'
                    : 'Run the first check to see what is on this page.'}
              </Text>
            </Card>
          )}
        </View>

        {/* ------------------------------------------------------------ history */}
        <View style={{ gap: t.spacing.sm }}>
          <Text variant="label" tone="muted">
            CHECK HISTORY
          </Text>
          <Card>
            {history.length ? (
              history.map((run, i) => (
                <View key={run.id}>
                  <HistoryRow run={run} />
                  {i < history.length - 1 ? <Divider /> : null}
                </View>
              ))
            ) : (
              <Text variant="caption" tone="muted">
                No checks recorded yet.
              </Text>
            )}
          </Card>
        </View>

        {/* --------------------------------------------------------------- meta */}
        <Card>
          <Text variant="label" tone="muted">
            DETAILS
          </Text>
          <View style={{ gap: t.spacing.sm, marginTop: t.spacing.md }}>
            {[
              ['Address', truncate(source.url, 70)],
              ['Added', relative(source.createdAt)],
              ['Content fingerprint', source.contentHash ?? 'not captured yet'],
            ].map(([label, value]) => (
              <Row key={label} justify="space-between" align="flex-start" gap={t.spacing.md}>
                <Text variant="caption" tone="muted">
                  {label}
                </Text>
                <Text variant="caption" tone="secondary" style={{ flex: 1, textAlign: 'right' }}>
                  {value}
                </Text>
              </Row>
            ))}
          </View>
        </Card>

        <Pressable onPress={confirmDelete} accessibilityRole="button" style={{ paddingVertical: t.spacing.md }}>
          <Row gap={6} justify="center">
            <Ionicons name="trash-outline" size={15} color={t.color.danger} />
            <Text variant="label" tone="danger">
              Stop watching this page
            </Text>
          </Row>
        </Pressable>
      </ScrollView>
    </View>
  );
}
