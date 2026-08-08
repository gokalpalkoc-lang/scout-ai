import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SourceCard } from '../../src/components/SourceCard';
import { Button, EmptyState, Header, IconButton, Row, Text } from '../../src/components/ui';
import { Source } from '../../src/lib/types';
import { relative } from '../../src/lib/util/date';
import { dueSourcesOf, useApp } from '../../src/store/app';
import { useTheme } from '../../src/theme';

/** Compact banner across the top: what needs attention right now. */
function StatusStrip({
  due,
  failing,
  total,
  onCheckDue,
  busy,
}: {
  due: number;
  failing: number;
  total: number;
  onCheckDue: () => void;
  busy: boolean;
}) {
  const t = useTheme();
  if (!total) return null;

  const tone = failing ? t.color.danger : due ? t.color.warning : t.color.success;
  const message = failing
    ? `${failing} site${failing === 1 ? '' : 's'} failing`
    : due
      ? `${due} site${due === 1 ? '' : 's'} due for a check`
      : 'Everything is up to date';

  return (
    <View style={{ paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.md }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: t.spacing.md,
          backgroundColor: t.color.surface,
          borderRadius: t.radius.md,
          borderWidth: 1,
          borderLeftWidth: 3,
          borderColor: t.color.border,
          borderLeftColor: tone,
          paddingVertical: t.spacing.md,
          paddingHorizontal: t.spacing.lg,
        }}
      >
        <Ionicons
          name={failing ? 'alert-circle' : due ? 'refresh-circle' : 'checkmark-circle'}
          size={20}
          color={tone}
        />
        <Text variant="body" style={{ flex: 1 }}>
          {message}
        </Text>
        {due > 0 ? (
          <Button title="Check now" size="sm" variant="secondary" loading={busy} onPress={onCheckDue} />
        ) : null}
      </View>
    </View>
  );
}

export default function SourcesScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();

  const sources = useApp((s) => s.sources);
  const events = useApp((s) => s.events);
  const checking = useApp((s) => s.checking);
  const sweepProgress = useApp((s) => s.sweepProgress);
  const lastSweep = useApp((s) => s.lastSweep);
  const checkOne = useApp((s) => s.checkOne);
  const checkAll = useApp((s) => s.checkAll);

  const [busy, setBusy] = useState(false);

  // Derived here rather than in a selector: a selector returning a fresh array
  // would re-render on every unrelated store change under Zustand v5.
  const dueSources = useMemo(() => dueSourcesOf(sources), [sources]);

  const perSource = useMemo(() => {
    const map = new Map<string, { total: number; fresh: number }>();
    for (const e of events) {
      if (!e.sourceId) continue;
      const entry = map.get(e.sourceId) ?? { total: 0, fresh: 0 };
      entry.total += 1;
      if (e.isNew) entry.fresh += 1;
      map.set(e.sourceId, entry);
    }
    return map;
  }, [events]);

  const failing = sources.filter((s) => s.lastStatus === 'error').length;
  const dueIds = useMemo(() => new Set(dueSources.map((s) => s.id)), [dueSources]);

  const runCheckAll = useCallback(
    async (all: boolean) => {
      setBusy(true);
      try {
        const result = await checkAll({ all });
        const parts = [
          `${result.checked} checked`,
          result.skipped ? `${result.skipped} unchanged` : '',
          `${result.newEvents} new event${result.newEvents === 1 ? '' : 's'}`,
          result.errors.length ? `${result.errors.length} error${result.errors.length === 1 ? '' : 's'}` : '',
        ].filter(Boolean);

        Alert.alert(
          'Check complete',
          `${parts.join(' · ')}${result.errors.length ? `\n\nFirst error: ${result.errors[0].title} — ${result.errors[0].error}` : ''}`,
        );
      } finally {
        setBusy(false);
      }
    },
    [checkAll],
  );

  const onCardCheck = useCallback(
    async (source: Source) => {
      const outcome = await checkOne(source.id, { force: false, silent: true });
      if (!outcome.ok) {
        Alert.alert(source.title, outcome.error ?? 'The check failed.');
        return;
      }
      const message = outcome.skippedExtraction
        ? 'No change since the last check.'
        : [
            outcome.newEvents.length
              ? `${outcome.newEvents.length} new event${outcome.newEvents.length === 1 ? '' : 's'}`
              : 'No new events',
            outcome.totalEvents ? `${outcome.totalEvents} on the page` : '',
            outcome.change?.headline ?? '',
          ]
            .filter(Boolean)
            .join('\n');
      Alert.alert(source.title, message);
    },
    [checkOne],
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.color.bg, paddingTop: insets.top }}>
      <Header
        title="Watchlist"
        subtitle={
          sweepProgress
            ? `Checking ${sweepProgress.current || '…'} (${sweepProgress.done}/${sweepProgress.total})`
            : `${sources.length} site${sources.length === 1 ? '' : 's'}${
                lastSweep ? ` · last sweep ${relative(Date.now() - lastSweep.durationMs)}` : ''
              }`
        }
        right={
          <Row gap={0}>
            <IconButton
              icon="refresh"
              accessibilityLabel="Check every site now"
              disabled={busy || !!sweepProgress || !sources.length}
              onPress={() => void runCheckAll(true)}
            />
            <IconButton
              icon="add-circle"
              tone={t.color.primary}
              accessibilityLabel="Add a site to watch"
              onPress={() => router.push('/source/new')}
            />
          </Row>
        }
      />

      <FlatList
        data={sources}
        keyExtractor={(s) => s.id}
        refreshControl={
          <RefreshControl
            refreshing={busy || !!sweepProgress}
            onRefresh={() => void runCheckAll(false)}
            tintColor={t.color.primary}
            colors={[t.color.primary]}
          />
        }
        ListHeaderComponent={
          <StatusStrip
            due={dueSources.length}
            failing={failing}
            total={sources.length}
            busy={busy || !!sweepProgress}
            onCheckDue={() => void runCheckAll(false)}
          />
        }
        renderItem={({ item }) => {
          const counts = perSource.get(item.id) ?? { total: 0, fresh: 0 };
          return (
            <View style={{ paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.md }}>
              <SourceCard
                source={item}
                eventCount={counts.total}
                newCount={counts.fresh}
                checking={checking.includes(item.id)}
                isDue={dueIds.has(item.id)}
                onPress={() => router.push({ pathname: '/source/[id]', params: { id: item.id } })}
                onCheck={() => void onCardCheck(item)}
              />
            </View>
          );
        }}
        ListEmptyComponent={
          <EmptyState
            icon="eye-outline"
            title="Nothing watched yet"
            message="Give Scout the address of a page that lists events — a venue, a university department, a conference site — and it will keep an eye on it for you."
            action={
              <Button title="Add your first site" icon="add" onPress={() => router.push('/source/new')} />
            }
          />
        }
        ListFooterComponent={
          sources.length ? (
            <View style={{ padding: t.spacing.lg, gap: t.spacing.sm }}>
              <Text variant="caption" tone="muted" center>
                Scout checks pages in the background when Android lets it, and always when you open
                the app. Pull down to check now.
              </Text>
              <Pressable
                onPress={() => router.push('/routines')}
                accessibilityRole="button"
                style={{ alignSelf: 'center', marginTop: t.spacing.sm }}
              >
                <Row gap={6}>
                  <Ionicons name="repeat-outline" size={14} color={t.color.primary} />
                  <Text variant="label" tone="primary">
                    Schedule automatic checks
                  </Text>
                </Row>
              </Pressable>
            </View>
          ) : null
        }
        contentContainerStyle={{ paddingBottom: t.spacing.xxxl, flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}
