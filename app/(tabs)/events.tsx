import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, RefreshControl, ScrollView, SectionList, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EventCard } from '../../src/components/EventCard';
import { Button, Chip, EmptyState, Header, IconButton, Row, Text } from '../../src/components/ui';
import { exportMany } from '../../src/lib/calendar';
import { EventItem } from '../../src/lib/types';
import { groupBy } from '../../src/lib/util';
import { dayHeading, isPast, parseEventDate, sortKey } from '../../src/lib/util/date';
import { useApp } from '../../src/store/app';
import { useSettings } from '../../src/store/settings';
import { useTheme } from '../../src/theme';

type Filter = 'all' | 'new' | 'starred' | 'deadlines' | 'week' | 'past';

const FILTERS: { key: Filter; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'all', label: 'All', icon: 'apps-outline' },
  { key: 'new', label: 'New', icon: 'flash-outline' },
  { key: 'week', label: 'This week', icon: 'today-outline' },
  { key: 'deadlines', label: 'Deadlines', icon: 'alarm-outline' },
  { key: 'starred', label: 'Starred', icon: 'star-outline' },
  { key: 'past', label: 'Past', icon: 'time-outline' },
];

export default function EventsScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();

  const events = useApp((s) => s.events);
  const sources = useApp((s) => s.sources);
  const stats = useApp((s) => s.stats);
  const checkAll = useApp((s) => s.checkAll);
  const toggleStar = useApp((s) => s.toggleStar);
  const markSeen = useApp((s) => s.markSeen);
  const refreshEvents = useApp((s) => s.refreshEvents);
  const sweepProgress = useApp((s) => s.sweepProgress);
  const compact = useSettings((s) => s.compactEvents);

  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);

  const sourceTitles = useMemo(
    () => new Map(sources.map((s) => [s.id, s.title])),
    [sources],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const weekEnd = Date.now() + 7 * 86_400_000;

    return events
      .filter((e) => {
        if (needle) {
          const haystack = `${e.title} ${e.location ?? ''} ${e.description ?? ''} ${e.category ?? ''}`.toLowerCase();
          if (!haystack.includes(needle)) return false;
        }
        switch (filter) {
          case 'new':
            return e.isNew;
          case 'starred':
            return e.starred;
          case 'deadlines':
            return !!e.deadlineAt;
          case 'week': {
            const d = parseEventDate(e.startsAt);
            return !!d && d.getTime() <= weekEnd && !isPast(e.startsAt);
          }
          case 'past':
            return isPast(e.startsAt);
          default:
            return !isPast(e.startsAt);
        }
      })
      .sort((a, b) =>
        filter === 'past'
          ? sortKey(b.startsAt) - sortKey(a.startsAt)
          : filter === 'deadlines'
            ? sortKey(a.deadlineAt) - sortKey(b.deadlineAt)
            : sortKey(a.startsAt) - sortKey(b.startsAt),
      );
  }, [events, filter, query]);

  const sections = useMemo(
    () =>
      groupBy(filtered, (e) =>
        filter === 'deadlines' ? dayHeading(e.deadlineAt) : dayHeading(e.startsAt),
      ).map(([title, data]) => ({ title, data })),
    [filtered, filter],
  );

  const onRefresh = useCallback(async () => {
    setBusy(true);
    try {
      await checkAll();
    } finally {
      setBusy(false);
    }
  }, [checkAll]);

  const addStarredToCalendar = useCallback(() => {
    const starred = events.filter((e) => e.starred && !e.calendarEventId && e.startsAt);
    if (!starred.length) {
      Alert.alert('Nothing to add', 'Star the events you want in your calendar first.');
      return;
    }
    Alert.alert(
      'Add to calendar',
      `Add ${starred.length} starred event${starred.length === 1 ? '' : 's'} to your phone calendar?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Add',
          onPress: async () => {
            const result = await exportMany(starred);
            await refreshEvents();
            Alert.alert(
              'Calendar updated',
              `${result.added} added${result.skipped ? `, ${result.skipped} skipped` : ''}.${
                result.errors.length ? `\n\n${result.errors[0]}` : ''
              }`,
            );
          },
        },
      ],
    );
  }, [events, refreshEvents]);

  const counts: Record<Filter, number> = useMemo(
    () => ({
      all: events.filter((e) => !isPast(e.startsAt)).length,
      new: stats.newCount,
      starred: stats.starred,
      deadlines: events.filter((e) => !!e.deadlineAt).length,
      week: stats.next7Days,
      past: events.filter((e) => isPast(e.startsAt)).length,
    }),
    [events, stats],
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.color.bg, paddingTop: insets.top }}>
      <Header
        title="Agenda"
        subtitle={
          sweepProgress
            ? `Checking ${sweepProgress.current || '…'} (${sweepProgress.done}/${sweepProgress.total})`
            : `${counts.all} upcoming${stats.newCount ? ` · ${stats.newCount} new` : ''}`
        }
        right={
          <Row gap={0}>
            <IconButton
              icon={searching ? 'close' : 'search'}
              accessibilityLabel={searching ? 'Close search' : 'Search events'}
              onPress={() => {
                setSearching((s) => !s);
                if (searching) setQuery('');
              }}
            />
            <IconButton
              icon="calendar-outline"
              accessibilityLabel="Add starred events to calendar"
              onPress={addStarredToCalendar}
            />
            {stats.newCount > 0 ? (
              <IconButton
                icon="checkmark-done-outline"
                accessibilityLabel="Mark all as seen"
                onPress={() => void markSeen()}
              />
            ) : null}
          </Row>
        }
      />

      {searching ? (
        <View style={{ paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.sm }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: t.spacing.sm,
              backgroundColor: t.color.surfaceAlt,
              borderRadius: t.radius.md,
              borderWidth: 1,
              borderColor: t.color.border,
              paddingHorizontal: t.spacing.md,
            }}
          >
            <Ionicons name="search" size={16} color={t.color.textMuted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search title, place, description…"
              placeholderTextColor={t.color.textMuted}
              autoFocus
              accessibilityLabel="Search events"
              style={{ flex: 1, color: t.color.text, fontSize: t.fontSize.base, paddingVertical: 10 }}
            />
          </View>
        </View>
      ) : null}

      {/*
        A horizontal ScrollView stretches its children on the cross axis and will
        happily grow to fill a flex parent, which turns these chips into
        full-height pills. Pin it to its content height and centre the row.
      */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, flexShrink: 0 }}
        contentContainerStyle={{
          alignItems: 'center',
          paddingHorizontal: t.spacing.lg,
          gap: t.spacing.sm,
          paddingBottom: t.spacing.md,
        }}
      >
        {FILTERS.map((f) => (
          <Chip
            key={f.key}
            label={f.label}
            icon={f.icon}
            selected={filter === f.key}
            count={counts[f.key]}
            onPress={() => setFilter(f.key)}
          />
        ))}
      </ScrollView>

      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        stickySectionHeadersEnabled
        refreshControl={
          <RefreshControl
            refreshing={busy || !!sweepProgress}
            onRefresh={onRefresh}
            tintColor={t.color.primary}
            colors={[t.color.primary]}
          />
        }
        renderSectionHeader={({ section }) => (
          <View
            style={{
              backgroundColor: t.color.bg,
              paddingHorizontal: t.spacing.lg,
              paddingTop: t.spacing.md,
              paddingBottom: t.spacing.sm,
            }}
          >
            <Row gap={t.spacing.sm}>
              <Text variant="label" tone={section.title === 'Today' ? 'primary' : 'secondary'}>
                {section.title}
              </Text>
              <View style={{ flex: 1, height: 1, backgroundColor: t.color.border }} />
              <Text variant="caption" tone="muted">
                {section.data.length}
              </Text>
            </Row>
          </View>
        )}
        renderItem={({ item }: { item: EventItem }) => (
          <View style={{ paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.sm }}>
            <EventCard
              event={item}
              compact={compact}
              sourceTitle={item.sourceId ? sourceTitles.get(item.sourceId) : 'Added by hand'}
              onPress={() => router.push({ pathname: '/event/[id]', params: { id: item.id } })}
              onToggleStar={() => void toggleStar(item.id)}
            />
          </View>
        )}
        ListEmptyComponent={
          <EmptyState
            icon={query ? 'search-outline' : filter === 'all' ? 'calendar-outline' : 'funnel-outline'}
            title={
              query
                ? 'Nothing matches that'
                : sources.length === 0
                  ? 'No events yet'
                  : filter === 'all'
                    ? 'Nothing upcoming'
                    : `No ${FILTERS.find((f) => f.key === filter)?.label.toLowerCase()} events`
            }
            message={
              sources.length === 0
                ? 'Add a website to watch and Scout will start collecting events from it.'
                : filter === 'all'
                  ? 'Pull down to check your watched sites for anything new.'
                  : 'Try a different filter.'
            }
            action={
              sources.length === 0 ? (
                <Button title="Watch a website" icon="add" onPress={() => router.push('/source/new')} />
              ) : undefined
            }
          />
        }
        contentContainerStyle={{ paddingBottom: t.spacing.xxxl, flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
      />

      {stats.deadlinesSoon > 0 && filter !== 'deadlines' ? (
        <View style={{ position: 'absolute', bottom: t.spacing.lg, left: 0, right: 0, alignItems: 'center' }}>
          <Button
            title={`${stats.deadlinesSoon} deadline${stats.deadlinesSoon === 1 ? '' : 's'} closing soon`}
            icon="alarm"
            size="sm"
            variant="secondary"
            onPress={() => setFilter('deadlines')}
          />
        </View>
      ) : null}
    </View>
  );
}
