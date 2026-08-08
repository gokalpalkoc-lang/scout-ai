import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, View } from 'react-native';

import { EventItem } from '../lib/types';
import { daysUntil, formatEventDate, isPast, parseEventDate } from '../lib/util/date';
import { useTheme } from '../theme';
import { Badge, BadgeTone, Row, Text } from './ui';

/** Urgency of a registration deadline, expressed as a pill. */
export function DeadlinePill({ event }: { event: EventItem }) {
  const days = daysUntil(event.deadlineAt);
  if (!event.deadlineAt || days === null) return null;

  const label =
    days < 0
      ? 'Deadline passed'
      : days === 0
        ? 'Deadline today'
        : days === 1
          ? 'Deadline tomorrow'
          : `${days} days to apply`;

  const tone: BadgeTone = days < 0 ? 'neutral' : days <= 2 ? 'danger' : days <= 7 ? 'warning' : 'info';
  return <Badge label={label} tone={tone} icon="alarm-outline" />;
}

const CATEGORY_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  concert: 'musical-notes-outline',
  music: 'musical-notes-outline',
  festival: 'sparkles-outline',
  conference: 'people-outline',
  workshop: 'construct-outline',
  course: 'school-outline',
  exhibition: 'image-outline',
  theatre: 'ticket-outline',
  theater: 'ticket-outline',
  screening: 'film-outline',
  sport: 'football-outline',
  meetup: 'chatbubbles-outline',
  deadline: 'alarm-outline',
  other: 'calendar-outline',
};

export function categoryIcon(category: string | null): keyof typeof Ionicons.glyphMap {
  if (!category) return 'calendar-outline';
  return CATEGORY_ICONS[category.toLowerCase()] ?? 'calendar-outline';
}

export function EventCard({
  event,
  sourceTitle,
  compact,
  onPress,
  onToggleStar,
}: {
  event: EventItem;
  sourceTitle?: string | null;
  compact?: boolean;
  onPress: () => void;
  onToggleStar: () => void;
}) {
  const t = useTheme();
  const past = isPast(event.startsAt);
  const start = parseEventDate(event.startsAt);

  const accent = event.isNew
    ? t.color.accent
    : event.starred
      ? t.color.warning
      : past
        ? t.color.border
        : 'transparent';

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${event.title}, ${formatEventDate(event.startsAt)}`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        backgroundColor: pressed ? t.color.surfaceAlt : t.color.surface,
        borderRadius: t.radius.lg,
        borderWidth: 1,
        borderColor: event.isNew ? t.color.accent : t.color.border,
        overflow: 'hidden',
        opacity: past ? 0.6 : 1,
      })}
    >
      <View style={{ width: 3, backgroundColor: accent }} />

      {/* Date rail — scanning a list by date is the primary reading path. */}
      <View
        style={{
          width: 56,
          alignItems: 'center',
          justifyContent: 'center',
          paddingVertical: t.spacing.md,
          backgroundColor: t.color.surfaceAlt,
        }}
      >
        {start ? (
          <>
            <Text variant="caption" tone="muted">
              {start.toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}
            </Text>
            <Text variant="heading" style={{ marginTop: -2 }}>
              {start.getDate()}
            </Text>
            {!event.allDay ? (
              <Text variant="caption" tone="secondary">
                {`${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`}
              </Text>
            ) : null}
          </>
        ) : (
          <Ionicons name="help-outline" size={20} color={t.color.textMuted} />
        )}
      </View>

      <View style={{ flex: 1, padding: t.spacing.md, gap: 6 }}>
        <Row gap={t.spacing.sm} align="flex-start">
          <View style={{ flex: 1 }}>
            <Text variant="bodyStrong" numberOfLines={compact ? 1 : 2}>
              {event.title}
            </Text>
          </View>
          <Pressable
            onPress={onToggleStar}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={event.starred ? 'Remove star' : 'Star this event'}
          >
            <Ionicons
              name={event.starred ? 'star' : 'star-outline'}
              size={19}
              color={event.starred ? t.color.warning : t.color.textMuted}
            />
          </Pressable>
        </Row>

        {!compact && event.location ? (
          <Row gap={4}>
            <Ionicons name="location-outline" size={12} color={t.color.textMuted} />
            <Text variant="caption" tone="muted" numberOfLines={1} style={{ flex: 1 }}>
              {event.location}
            </Text>
          </Row>
        ) : null}

        <Row gap={6} wrap>
          {event.isNew ? <Badge label="New" tone="accent" dot /> : null}
          <DeadlinePill event={event} />
          {event.price ? <Badge label={event.price} tone="neutral" /> : null}
          {event.category && !compact ? (
            <Badge label={event.category} tone="neutral" icon={categoryIcon(event.category)} />
          ) : null}
          {event.calendarEventId ? (
            <Badge label="In calendar" tone="success" icon="checkmark-outline" />
          ) : null}
          {sourceTitle && !compact ? <Badge label={sourceTitle} tone="primary" /> : null}
        </Row>
      </View>
    </Pressable>
  );
}
