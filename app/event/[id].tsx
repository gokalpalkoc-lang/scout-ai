import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DeadlinePill, categoryIcon } from '../../src/components/EventCard';
import { Badge, Button, Card, EmptyState, Header, IconButton, Row, Text } from '../../src/components/ui';
import { exportEvent, removeExportedEvent } from '../../src/lib/calendar';
import { scheduleDeadlineReminder, cancel as cancelNotification } from '../../src/lib/notify';
import { errorMessage } from '../../src/lib/util';
import { daysUntil, formatEventDate, isPast, relative } from '../../src/lib/util/date';
import { useApp } from '../../src/store/app';
import { useTheme } from '../../src/theme';

function DetailRow({
  icon,
  label,
  value,
  onPress,
  tone,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  onPress?: () => void;
  tone?: 'default' | 'primary';
}) {
  const t = useTheme();
  const body = (
    <Row gap={t.spacing.md} align="flex-start" style={{ paddingVertical: t.spacing.sm }}>
      <Ionicons name={icon} size={17} color={t.color.textMuted} style={{ marginTop: 2 }} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="caption" tone="muted">
          {label}
        </Text>
        <Text variant="body" tone={tone === 'primary' ? 'primary' : 'default'}>
          {value}
        </Text>
      </View>
      {onPress ? <Ionicons name="chevron-forward" size={16} color={t.color.textMuted} /> : null}
    </Row>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label}: ${value}`}>
      {body}
    </Pressable>
  );
}

export default function EventDetailScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();

  const event = useApp((s) => s.events.find((e) => e.id === id));
  const sources = useApp((s) => s.sources);
  const toggleStar = useApp((s) => s.toggleStar);
  const dismissEvent = useApp((s) => s.dismissEvent);
  const removeEvent = useApp((s) => s.removeEvent);
  const editEvent = useApp((s) => s.editEvent);
  const refreshEvents = useApp((s) => s.refreshEvents);

  const [busy, setBusy] = useState<string | null>(null);

  const source = useMemo(
    () => (event?.sourceId ? sources.find((s) => s.id === event.sourceId) : undefined),
    [event?.sourceId, sources],
  );

  // Opening the detail counts as seeing it.
  useEffect(() => {
    if (event?.isNew) void editEvent(event.id, { isNew: false });
  }, [event?.id, event?.isNew, editEvent]);

  const addToCalendar = useCallback(async () => {
    if (!event) return;
    setBusy('calendar');
    try {
      if (event.calendarEventId) {
        await removeExportedEvent(event);
        await refreshEvents();
        return;
      }
      const result = await exportEvent(event, { sourceLabel: source?.title });
      await refreshEvents();
      if (!result.ok) Alert.alert('Could not add to calendar', result.error ?? 'Unknown error');
    } catch (e) {
      Alert.alert('Calendar error', errorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [event, source?.title, refreshEvents]);

  const setReminder = useCallback(
    async (days: number) => {
      if (!event) return;
      setBusy('reminder');
      try {
        await cancelNotification(event.reminderId);
        const notificationId = await scheduleDeadlineReminder(event, days);
        if (!notificationId) {
          Alert.alert('Could not set a reminder', 'The deadline may already have passed.');
          return;
        }
        await editEvent(event.id, { reminderId: notificationId });
        Alert.alert(
          'Reminder set',
          days === 0 ? 'You will be reminded on the day.' : `You will be reminded ${days} day(s) before.`,
        );
      } finally {
        setBusy(null);
      }
    },
    [event, editEvent],
  );

  const confirmDelete = useCallback(() => {
    if (!event) return;
    Alert.alert('Delete this event?', 'It will come back if the page still lists it.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await removeEvent(event.id);
          router.back();
        },
      },
    ]);
  }, [event, removeEvent]);

  if (!event) {
    return (
      <View style={{ flex: 1, backgroundColor: t.color.bg, paddingTop: insets.top }}>
        <Header title="Not found" onBack={() => router.back()} />
        <EmptyState
          icon="help-circle-outline"
          title="This event is gone"
          message="It may have been dismissed or deleted."
          action={<Button title="Back to agenda" onPress={() => router.back()} />}
        />
      </View>
    );
  }

  const past = isPast(event.startsAt);
  const deadlineDays = daysUntil(event.deadlineAt);

  return (
    <View style={{ flex: 1, backgroundColor: t.color.bg, paddingTop: insets.top }}>
      <Header
        title="Event"
        onBack={() => router.back()}
        right={
          <Row gap={0}>
            <IconButton
              icon={event.starred ? 'star' : 'star-outline'}
              tone={event.starred ? t.color.warning : undefined}
              accessibilityLabel={event.starred ? 'Remove star' : 'Star this event'}
              onPress={() => void toggleStar(event.id)}
            />
            <IconButton
              icon="copy-outline"
              accessibilityLabel="Copy event details"
              onPress={() => {
                const text = [
                  event.title,
                  formatEventDate(event.startsAt),
                  event.location,
                  event.price,
                  event.url,
                ]
                  .filter(Boolean)
                  .join('\n');
                void Clipboard.setStringAsync(text).then(() =>
                  Alert.alert('Copied', 'Event details are on your clipboard.'),
                );
              }}
            />
          </Row>
        }
      />

      <ScrollView
        contentContainerStyle={{ padding: t.spacing.lg, paddingBottom: insets.bottom + 100, gap: t.spacing.lg }}
        showsVerticalScrollIndicator={false}
      >
        {/* --------------------------------------------------------------- head */}
        <View style={{ gap: t.spacing.md }}>
          <Row gap={6} wrap>
            {past ? <Badge label="Past" tone="neutral" icon="time-outline" /> : null}
            {event.isNew ? <Badge label="New" tone="accent" dot /> : null}
            {event.category ? (
              <Badge label={event.category} tone="primary" icon={categoryIcon(event.category)} />
            ) : null}
            {event.confidence < 0.5 ? (
              <Badge label="Low confidence" tone="warning" icon="help-circle-outline" />
            ) : null}
          </Row>

          <Text variant="display">{event.title}</Text>

          <Row gap={t.spacing.sm} wrap>
            <Badge
              label={formatEventDate(event.startsAt)}
              tone={past ? 'neutral' : 'info'}
              icon="calendar-outline"
            />
            <DeadlinePill event={event} />
          </Row>
        </View>

        {/* ---------------------------------------------------------- deadlines */}
        {event.deadlineAt ? (
          <Card
            accent={
              deadlineDays !== null && deadlineDays <= 2
                ? t.color.danger
                : deadlineDays !== null && deadlineDays <= 7
                  ? t.color.warning
                  : t.color.info
            }
          >
            <Row gap={t.spacing.md} align="flex-start">
              <Ionicons name="alarm-outline" size={20} color={t.color.warning} />
              <View style={{ flex: 1, gap: 4 }}>
                <Text variant="subheading">
                  {event.deadlineLabel
                    ? `${event.deadlineLabel[0].toUpperCase()}${event.deadlineLabel.slice(1)}`
                    : 'Registration'}{' '}
                  deadline
                </Text>
                <Text variant="body" tone="secondary">
                  {formatEventDate(event.deadlineAt)}
                  {deadlineDays !== null
                    ? ` · ${deadlineDays < 0 ? 'passed' : deadlineDays === 0 ? 'today' : `${deadlineDays} day(s) left`}`
                    : ''}
                </Text>
                {event.reminderId ? (
                  <Badge label="Reminder scheduled" tone="success" icon="notifications-outline" />
                ) : null}
              </View>
            </Row>

            <Row gap={t.spacing.sm} wrap style={{ marginTop: t.spacing.lg }}>
              {[
                { label: 'On the day', days: 0 },
                { label: '1 day before', days: 1 },
                { label: '3 days', days: 3 },
                { label: '1 week', days: 7 },
              ].map((option) => (
                <Button
                  key={option.days}
                  title={option.label}
                  size="sm"
                  variant="secondary"
                  loading={busy === 'reminder'}
                  onPress={() => void setReminder(option.days)}
                />
              ))}
            </Row>
            {event.reminderId ? (
              <Button
                title="Cancel reminder"
                variant="ghost"
                size="sm"
                style={{ marginTop: t.spacing.sm }}
                onPress={async () => {
                  await cancelNotification(event.reminderId);
                  await editEvent(event.id, { reminderId: null });
                }}
              />
            ) : null}
          </Card>
        ) : null}

        {/* -------------------------------------------------------- description */}
        {event.description ? (
          <Card>
            <Text variant="body" tone="secondary" style={{ lineHeight: 22 }}>
              {event.description}
            </Text>
          </Card>
        ) : null}

        {/* ------------------------------------------------------------ details */}
        <Card>
          <Text variant="label" tone="muted">
            DETAILS
          </Text>
          <View style={{ marginTop: t.spacing.sm }}>
            {event.location ? (
              <DetailRow icon="location-outline" label="Where" value={event.location} />
            ) : null}
            {event.endsAt ? (
              <DetailRow icon="hourglass-outline" label="Ends" value={formatEventDate(event.endsAt)} />
            ) : null}
            {event.price ? <DetailRow icon="cash-outline" label="Price" value={event.price} /> : null}
            {event.url ? (
              <DetailRow
                icon="link-outline"
                label="Page"
                value={event.url}
                tone="primary"
                onPress={() => void WebBrowser.openBrowserAsync(event.url!)}
              />
            ) : null}
            {source ? (
              <DetailRow
                icon="eye-outline"
                label="Found on"
                value={source.title}
                onPress={() => router.push({ pathname: '/source/[id]', params: { id: source.id } })}
              />
            ) : (
              <DetailRow icon="create-outline" label="Source" value="Added by hand" />
            )}
            <DetailRow
              icon="time-outline"
              label="First seen"
              value={relative(event.firstSeenAt)}
            />
          </View>
        </Card>

        {/* ------------------------------------------------------------ actions */}
        <View style={{ gap: t.spacing.sm }}>
          <Button
            title={event.calendarEventId ? 'Remove from calendar' : 'Add to calendar'}
            icon={event.calendarEventId ? 'calendar-clear-outline' : 'calendar-outline'}
            variant={event.calendarEventId ? 'secondary' : 'primary'}
            size="lg"
            fullWidth
            loading={busy === 'calendar'}
            disabled={!event.startsAt}
            onPress={() => void addToCalendar()}
          />
          {!event.startsAt ? (
            <Text variant="caption" tone="muted" center>
              This event has no date yet, so it cannot go in the calendar.
            </Text>
          ) : null}

          <Row gap={t.spacing.sm}>
            <View style={{ flex: 1 }}>
              <Button
                title={event.dismissed ? 'Restore' : 'Hide'}
                icon={event.dismissed ? 'eye-outline' : 'eye-off-outline'}
                variant="secondary"
                fullWidth
                onPress={() => void dismissEvent(event.id, !event.dismissed)}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                title="Delete"
                icon="trash-outline"
                variant="danger"
                fullWidth
                onPress={confirmDelete}
              />
            </View>
          </Row>
        </View>
      </ScrollView>
    </View>
  );
}
