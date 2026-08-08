import React from 'react';
import { StyleProp, Text as RNText, TextProps as RNTextProps, TextStyle } from 'react-native';

import { useTheme } from '../../theme';

export type TextVariant =
  | 'display'
  | 'title'
  | 'heading'
  | 'subheading'
  | 'body'
  | 'bodyStrong'
  | 'label'
  | 'caption'
  | 'mono';

export type TextTone = 'default' | 'secondary' | 'muted' | 'primary' | 'success' | 'warning' | 'danger' | 'accent' | 'inverse';

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
  tone?: TextTone;
  center?: boolean;
  style?: StyleProp<TextStyle>;
}

export function Text({ variant = 'body', tone = 'default', center, style, ...rest }: TextProps) {
  const t = useTheme();

  const variantStyle: Record<TextVariant, TextStyle> = {
    display: { fontSize: t.fontSize.xxl, fontWeight: '700', letterSpacing: -0.6 },
    title: { fontSize: t.fontSize.xl, fontWeight: '700', letterSpacing: -0.4 },
    heading: { fontSize: t.fontSize.lg, fontWeight: '600', letterSpacing: -0.2 },
    subheading: { fontSize: t.fontSize.md, fontWeight: '600' },
    body: { fontSize: t.fontSize.base, fontWeight: '400', lineHeight: 22 },
    bodyStrong: { fontSize: t.fontSize.base, fontWeight: '600', lineHeight: 22 },
    label: { fontSize: t.fontSize.sm, fontWeight: '600', letterSpacing: 0.2 },
    caption: { fontSize: t.fontSize.xs, fontWeight: '500', letterSpacing: 0.3 },
    mono: { fontSize: t.fontSize.sm, fontFamily: 'monospace' },
  };

  const toneColor: Record<TextTone, string> = {
    default: t.color.text,
    secondary: t.color.textSecondary,
    muted: t.color.textMuted,
    primary: t.color.primary,
    success: t.color.success,
    warning: t.color.warning,
    danger: t.color.danger,
    accent: t.color.accent,
    inverse: t.color.textInverse,
  };

  return (
    <RNText
      {...rest}
      style={[
        variantStyle[variant],
        { color: toneColor[tone] },
        center && { textAlign: 'center' },
        style,
      ]}
    />
  );
}
