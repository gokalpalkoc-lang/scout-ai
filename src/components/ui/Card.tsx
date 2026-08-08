import React from 'react';
import { Pressable, StyleProp, View, ViewStyle } from 'react-native';

import { useTheme } from '../../theme';
import { Text } from './Text';

export interface CardProps {
  children: React.ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  padded?: boolean;
  /** Accent stripe down the left edge — used to flag "new" or status. */
  accent?: string;
  style?: StyleProp<ViewStyle>;
  level?: 0 | 1 | 2 | 3;
}

export function Card({
  children,
  onPress,
  onLongPress,
  padded = true,
  accent,
  style,
  level = 1,
}: CardProps) {
  const t = useTheme();

  const base: ViewStyle = {
    backgroundColor: t.color.surface,
    borderRadius: t.radius.lg,
    borderWidth: 1,
    borderColor: t.color.border,
    padding: padded ? t.spacing.lg : 0,
    overflow: 'hidden',
    ...(t.elevation(level) as ViewStyle),
  };

  const content = (
    <>
      {accent ? (
        <View
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 3,
            backgroundColor: accent,
          }}
        />
      ) : null}
      {children}
    </>
  );

  if (!onPress && !onLongPress) {
    return <View style={[base, style]}>{content}</View>;
  }

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        base,
        pressed && { backgroundColor: t.color.surfaceAlt, transform: [{ scale: 0.995 }] },
        style,
      ]}
    >
      {content}
    </Pressable>
  );
}

export function SectionHeader({
  title,
  action,
  onAction,
  subtitle,
}: {
  title: string;
  subtitle?: string;
  action?: string;
  onAction?: () => void;
}) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        paddingHorizontal: t.spacing.lg,
        marginTop: t.spacing.xl,
        marginBottom: t.spacing.sm,
        gap: t.spacing.md,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text variant="label" tone="muted" style={{ textTransform: 'uppercase' }}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tone="muted" style={{ marginTop: 2 }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {action ? (
        <Pressable onPress={onAction} hitSlop={8} accessibilityRole="button">
          <Text variant="label" tone="primary">
            {action}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Divider({ inset = 0 }: { inset?: number }) {
  const t = useTheme();
  return (
    <View
      style={{
        height: 1,
        backgroundColor: t.color.border,
        marginLeft: inset,
      }}
    />
  );
}
