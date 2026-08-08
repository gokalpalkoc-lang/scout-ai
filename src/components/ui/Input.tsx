import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import {
  Platform,
  Pressable,
  StyleProp,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from 'react-native';

import { useTheme } from '../../theme';
import { Text } from './Text';

export interface FieldProps extends TextInputProps {
  label?: string;
  hint?: string;
  error?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  secretToggle?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  right?: React.ReactNode;
}

export function Field({
  label,
  hint,
  error,
  icon,
  secretToggle,
  containerStyle,
  right,
  style,
  multiline,
  ...rest
}: FieldProps) {
  const t = useTheme();
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(!!secretToggle);

  return (
    <View style={[{ gap: 6 }, containerStyle]}>
      {label ? (
        <Text variant="label" tone="secondary">
          {label}
        </Text>
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: multiline ? 'flex-start' : 'center',
          gap: t.spacing.sm,
          backgroundColor: t.color.surfaceAlt,
          borderRadius: t.radius.md,
          borderWidth: 1,
          borderColor: error ? t.color.danger : focused ? t.color.primary : t.color.border,
          paddingHorizontal: t.spacing.md,
          paddingVertical: multiline ? t.spacing.md : Platform.OS === 'ios' ? 12 : 4,
        }}
      >
        {icon ? (
          <Ionicons
            name={icon}
            size={18}
            color={focused ? t.color.primary : t.color.textMuted}
            style={{ marginTop: multiline ? 2 : 0 }}
          />
        ) : null}
        <TextInput
          {...rest}
          multiline={multiline}
          secureTextEntry={secretToggle ? hidden : rest.secureTextEntry}
          onFocus={(e) => {
            setFocused(true);
            rest.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            rest.onBlur?.(e);
          }}
          placeholderTextColor={t.color.textMuted}
          style={[
            {
              flex: 1,
              color: t.color.text,
              fontSize: t.fontSize.base,
              minHeight: multiline ? 80 : undefined,
              textAlignVertical: multiline ? 'top' : 'center',
              paddingVertical: 0,
            },
            style,
          ]}
        />
        {secretToggle ? (
          <Pressable
            onPress={() => setHidden((h) => !h)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={hidden ? 'Show value' : 'Hide value'}
          >
            <Ionicons
              name={hidden ? 'eye-outline' : 'eye-off-outline'}
              size={18}
              color={t.color.textMuted}
            />
          </Pressable>
        ) : null}
        {right}
      </View>
      {error ? (
        <Text variant="caption" tone="danger">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" tone="muted">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  icon,
  count,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  count?: number;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: t.spacing.md,
        paddingVertical: 7,
        borderRadius: t.radius.pill,
        borderWidth: 1,
        borderColor: selected ? t.color.primary : t.color.border,
        backgroundColor: selected
          ? t.color.primarySoft
          : pressed
            ? t.color.surfacePressed
            : t.color.surface,
      })}
    >
      {icon ? (
        <Ionicons name={icon} size={14} color={selected ? t.color.primary : t.color.textMuted} />
      ) : null}
      <Text variant="label" tone={selected ? 'primary' : 'secondary'}>
        {label}
      </Text>
      {count !== undefined ? (
        <Text variant="caption" tone={selected ? 'primary' : 'muted'}>
          {count}
        </Text>
      ) : null}
    </Pressable>
  );
}
