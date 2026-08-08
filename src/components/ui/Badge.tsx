import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { View } from 'react-native';

import { useTheme } from '../../theme';
import { Text } from './Text';

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

export function Badge({
  label,
  tone = 'neutral',
  icon,
  dot,
}: {
  label: string;
  tone?: BadgeTone;
  icon?: keyof typeof Ionicons.glyphMap;
  dot?: boolean;
}) {
  const t = useTheme();

  const map: Record<BadgeTone, { bg: string; fg: string }> = {
    neutral: { bg: t.color.surfaceAlt, fg: t.color.textSecondary },
    primary: { bg: t.color.primarySoft, fg: t.color.primary },
    success: { bg: t.color.successSoft, fg: t.color.success },
    warning: { bg: t.color.warningSoft, fg: t.color.warning },
    danger: { bg: t.color.dangerSoft, fg: t.color.danger },
    info: { bg: t.color.infoSoft, fg: t.color.info },
    accent: { bg: t.color.accentSoft, fg: t.color.accent },
  };
  const c = map[tone];

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        backgroundColor: c.bg,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: t.radius.sm,
        alignSelf: 'flex-start',
      }}
    >
      {dot ? (
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.fg }} />
      ) : null}
      {icon ? <Ionicons name={icon} size={11} color={c.fg} /> : null}
      <Text variant="caption" style={{ color: c.fg }}>
        {label}
      </Text>
    </View>
  );
}
