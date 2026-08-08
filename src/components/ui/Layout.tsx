import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControlProps,
  ScrollView,
  StyleProp,
  View,
  ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../../theme';
import { Text } from './Text';

/** Full-bleed screen background that respects safe areas at the top. */
export function Screen({
  children,
  scroll,
  style,
  contentStyle,
  refreshControl,
  edges = ['top'],
}: {
  children: React.ReactNode;
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  refreshControl?: React.ReactElement<RefreshControlProps>;
  edges?: ('top' | 'bottom')[];
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();

  const pad = {
    paddingTop: edges.includes('top') ? insets.top : 0,
    paddingBottom: edges.includes('bottom') ? insets.bottom : 0,
  };

  if (scroll) {
    return (
      <View style={[{ flex: 1, backgroundColor: t.color.bg }, pad, style]}>
        <ScrollView
          contentContainerStyle={[{ paddingBottom: t.spacing.xxxl }, contentStyle]}
          keyboardShouldPersistTaps="handled"
          refreshControl={refreshControl}
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      </View>
    );
  }

  return <View style={[{ flex: 1, backgroundColor: t.color.bg }, pad, style]}>{children}</View>;
}

export function Row({
  children,
  gap,
  align = 'center',
  justify = 'flex-start',
  wrap,
  style,
}: {
  children: React.ReactNode;
  gap?: number;
  align?: ViewStyle['alignItems'];
  justify?: ViewStyle['justifyContent'];
  wrap?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: align,
          justifyContent: justify,
          gap: gap ?? t.spacing.sm,
          flexWrap: wrap ? 'wrap' : 'nowrap',
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Screen-level header with optional back chevron and trailing actions. */
export function Header({
  title,
  subtitle,
  onBack,
  right,
  large,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  right?: React.ReactNode;
  large?: boolean;
}) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.spacing.md,
        paddingHorizontal: t.spacing.lg,
        paddingTop: t.spacing.md,
        paddingBottom: t.spacing.md,
      }}
    >
      {onBack ? (
        <Pressable
          onPress={onBack}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          style={{ marginLeft: -4 }}
        >
          <Ionicons name="chevron-back" size={26} color={t.color.text} />
        </Pressable>
      ) : null}
      <View style={{ flex: 1 }}>
        <Text variant={large ? 'display' : 'title'} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tone="muted" numberOfLines={1} style={{ marginTop: 2 }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </View>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  message?: string;
  action?: React.ReactNode;
}) {
  const t = useTheme();
  return (
    <View
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: t.spacing.xxxl,
        paddingHorizontal: t.spacing.xl,
        gap: t.spacing.md,
      }}
    >
      <View
        style={{
          width: 62,
          height: 62,
          borderRadius: t.radius.xl,
          backgroundColor: t.color.surfaceAlt,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name={icon} size={28} color={t.color.textMuted} />
      </View>
      <Text variant="subheading" center>
        {title}
      </Text>
      {message ? (
        <Text variant="body" tone="muted" center style={{ maxWidth: 320 }}>
          {message}
        </Text>
      ) : null}
      {action ? <View style={{ marginTop: t.spacing.sm }}>{action}</View> : null}
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  const t = useTheme();
  return (
    <View style={{ padding: t.spacing.xl, alignItems: 'center', gap: t.spacing.md }}>
      <ActivityIndicator color={t.color.primary} />
      {label ? (
        <Text variant="caption" tone="muted">
          {label}
        </Text>
      ) : null}
    </View>
  );
}

/** Tappable settings/detail row. */
export function ListRow({
  title,
  subtitle,
  icon,
  iconTone,
  right,
  onPress,
  destructive,
}: {
  title: string;
  subtitle?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  iconTone?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  destructive?: boolean;
}) {
  const t = useTheme();
  const body = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.spacing.md,
        paddingVertical: t.spacing.md,
        paddingHorizontal: t.spacing.lg,
        minHeight: 56,
      }}
    >
      {icon ? (
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: t.radius.sm,
            backgroundColor: t.color.surfaceAlt,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons
            name={icon}
            size={17}
            color={destructive ? t.color.danger : (iconTone ?? t.color.textSecondary)}
          />
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <Text variant="body" tone={destructive ? 'danger' : 'default'}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tone="muted" style={{ marginTop: 2 }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ??
        (onPress ? <Ionicons name="chevron-forward" size={17} color={t.color.textMuted} /> : null)}
    </View>
  );

  if (!onPress) return body;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({ backgroundColor: pressed ? t.color.surfacePressed : 'transparent' })}
    >
      {body}
    </Pressable>
  );
}
