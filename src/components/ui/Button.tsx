import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import React from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleProp,
  View,
  ViewStyle,
} from 'react-native';

import { useTheme } from '../../theme';
import { Text } from './Text';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  title?: string;
  onPress?: () => void;
  variant?: Variant;
  size?: Size;
  icon?: keyof typeof Ionicons.glyphMap;
  iconRight?: keyof typeof Ionicons.glyphMap;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  haptic?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  loading,
  disabled,
  fullWidth,
  haptic = true,
  style,
  accessibilityLabel,
}: ButtonProps) {
  const t = useTheme();
  const isDisabled = disabled || loading;

  const sizing = {
    sm: { padV: 7, padH: 12, font: t.fontSize.sm, icon: 15, gap: 6, radius: t.radius.sm },
    md: { padV: 11, padH: 16, font: t.fontSize.base, icon: 18, gap: 8, radius: t.radius.md },
    lg: { padV: 15, padH: 20, font: t.fontSize.md, icon: 20, gap: 10, radius: t.radius.md },
  }[size];

  const scheme: Record<Variant, { bg: string; bgPressed: string; fg: string; border?: string }> = {
    primary: {
      bg: t.color.primary,
      bgPressed: t.color.primaryPressed,
      fg: t.color.onPrimary,
    },
    secondary: {
      bg: t.color.surfaceAlt,
      bgPressed: t.color.surfacePressed,
      fg: t.color.text,
      border: t.color.border,
    },
    ghost: { bg: 'transparent', bgPressed: t.color.surfaceAlt, fg: t.color.primary },
    danger: { bg: t.color.dangerSoft, bgPressed: t.color.danger, fg: t.color.danger },
    success: { bg: t.color.successSoft, bgPressed: t.color.success, fg: t.color.success },
  };

  const s = scheme[variant];

  const handlePress = () => {
    if (isDisabled) return;
    if (haptic && Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    onPress?.();
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      onPress={handlePress}
      disabled={isDisabled}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: sizing.gap,
          paddingVertical: sizing.padV,
          paddingHorizontal: sizing.padH,
          borderRadius: sizing.radius,
          backgroundColor: pressed ? s.bgPressed : s.bg,
          borderWidth: s.border ? 1 : 0,
          borderColor: s.border,
          opacity: isDisabled ? 0.45 : 1,
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={s.fg} />
      ) : icon ? (
        <Ionicons name={icon} size={sizing.icon} color={s.fg} />
      ) : null}
      {title ? (
        <Text style={{ color: s.fg, fontSize: sizing.font, fontWeight: '600' }}>{title}</Text>
      ) : null}
      {iconRight && !loading ? <Ionicons name={iconRight} size={sizing.icon} color={s.fg} /> : null}
    </Pressable>
  );
}

export function IconButton({
  icon,
  onPress,
  size = 20,
  tone,
  disabled,
  accessibilityLabel,
  badge,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
  size?: number;
  tone?: string;
  disabled?: boolean;
  accessibilityLabel: string;
  badge?: number;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={() => {
        if (disabled) return;
        if (Platform.OS !== 'web') {
          Haptics.selectionAsync().catch(() => {});
        }
        onPress?.();
      }}
      disabled={disabled}
      hitSlop={8}
      style={({ pressed }) => ({
        width: size + 18,
        height: size + 18,
        borderRadius: t.radius.pill,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? t.color.surfacePressed : 'transparent',
        opacity: disabled ? 0.4 : 1,
      })}
    >
      <Ionicons name={icon} size={size} color={tone ?? t.color.textSecondary} />
      {badge !== undefined && badge > 0 ? (
        <View
          style={{
            position: 'absolute',
            top: 2,
            right: 2,
            minWidth: 16,
            height: 16,
            paddingHorizontal: 4,
            borderRadius: 8,
            backgroundColor: t.color.danger,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text variant="caption" style={{ color: '#fff', fontSize: 10 }}>
            {badge > 99 ? '99+' : badge}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}
