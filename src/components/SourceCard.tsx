import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { Source } from '../lib/types';
import { hostOf } from '../lib/util';
import { relative } from '../lib/util/date';
import { useTheme } from '../theme';
import { Badge, BadgeTone, Row, Text } from './ui';

const MODE_LABEL: Record<Source['mode'], string> = {
  events: 'Events',
  changes: 'Changes',
  both: 'Events + changes',
};

export function intervalLabel(minutes: number): string {
  if (minutes < 60) return `every ${minutes} min`;
  if (minutes < 1440) {
    const h = Math.round(minutes / 60);
    return `every ${h} hour${h === 1 ? '' : 's'}`;
  }
  const d = Math.round(minutes / 1440);
  return `every ${d} day${d === 1 ? '' : 's'}`;
}

export function SourceCard({
  source,
  eventCount,
  newCount,
  checking,
  isDue,
  onPress,
  onCheck,
}: {
  source: Source;
  eventCount: number;
  newCount: number;
  checking: boolean;
  isDue: boolean;
  onPress: () => void;
  onCheck: () => void;
}) {
  const t = useTheme();

  const status: { tone: BadgeTone; label: string; icon: keyof typeof Ionicons.glyphMap } = !source.enabled
    ? { tone: 'neutral', label: 'Paused', icon: 'pause-outline' }
    : source.lastStatus === 'error'
      ? { tone: 'danger', label: 'Failing', icon: 'alert-circle-outline' }
      : source.lastStatus === 'never'
        ? { tone: 'info', label: 'Not checked', icon: 'time-outline' }
        : isDue
          ? { tone: 'warning', label: 'Due', icon: 'refresh-outline' }
          : { tone: 'success', label: 'Up to date', icon: 'checkmark-circle-outline' };

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${source.title}, ${status.label}`}
      style={({ pressed }) => ({
        backgroundColor: pressed ? t.color.surfaceAlt : t.color.surface,
        borderRadius: t.radius.lg,
        borderWidth: 1,
        borderColor: source.lastStatus === 'error' ? t.color.danger : t.color.border,
        padding: t.spacing.lg,
        gap: t.spacing.sm,
        opacity: source.enabled ? 1 : 0.65,
      })}
    >
      <Row gap={t.spacing.md} align="flex-start">
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="subheading" numberOfLines={1}>
            {source.title}
          </Text>
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {hostOf(source.url)}
          </Text>
        </View>

        <Pressable
          onPress={onCheck}
          disabled={checking}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`Check ${source.title} now`}
          style={({ pressed }) => ({
            width: 38,
            height: 38,
            borderRadius: t.radius.md,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? t.color.primary : t.color.primarySoft,
          })}
        >
          {checking ? (
            <ActivityIndicator size="small" color={t.color.primary} />
          ) : (
            <Ionicons name="refresh" size={18} color={t.color.primary} />
          )}
        </Pressable>
      </Row>

      <Row gap={6} wrap>
        <Badge label={status.label} tone={status.tone} icon={status.icon} />
        {newCount > 0 ? <Badge label={`${newCount} new`} tone="accent" dot /> : null}
        {eventCount > 0 ? <Badge label={`${eventCount} events`} tone="neutral" /> : null}
        {source.category ? <Badge label={source.category} tone="primary" /> : null}
      </Row>

      {source.lastStatus === 'error' && source.lastError ? (
        <Text variant="caption" tone="danger" numberOfLines={2}>
          {source.lastError}
        </Text>
      ) : source.lastSummary ? (
        <Text variant="caption" tone="secondary" numberOfLines={2}>
          {source.lastSummary}
        </Text>
      ) : null}

      <Row gap={t.spacing.sm} justify="space-between">
        <Text variant="caption" tone="muted">
          {MODE_LABEL[source.mode]} · {intervalLabel(source.intervalMin)}
        </Text>
        <Text variant="caption" tone="muted">
          {source.lastCheckedAt ? relative(source.lastCheckedAt) : 'never checked'}
        </Text>
      </Row>
    </Pressable>
  );
}
