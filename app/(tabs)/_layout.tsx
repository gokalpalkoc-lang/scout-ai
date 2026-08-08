import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import React from 'react';
import { ColorValue, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '../../src/components/ui';
import { dueSourcesOf, useApp } from '../../src/store/app';
import { useTheme } from '../../src/theme';

/** Small count badge drawn over a tab icon. */
function TabBadge({ count, color }: { count: number; color: string }) {
  const t = useTheme();
  if (count <= 0) return null;
  return (
    <View
      style={{
        position: 'absolute',
        top: -4,
        right: -10,
        minWidth: 17,
        height: 17,
        paddingHorizontal: 4,
        borderRadius: 9,
        backgroundColor: color,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1.5,
        borderColor: t.color.bg,
      }}
    >
      <Text variant="caption" style={{ color: '#fff', fontSize: 10, lineHeight: 13 }}>
        {count > 99 ? '99+' : count}
      </Text>
    </View>
  );
}

function TabIcon({
  name,
  color,
  focused,
  badge,
  badgeColor,
}: {
  name: keyof typeof Ionicons.glyphMap;
  color: ColorValue;
  focused: boolean;
  badge?: number;
  badgeColor?: string;
}) {
  // Fixed box: an icon font's line height varies by platform, and letting it
  // grow squeezes the label underneath (which clips rather than wraps).
  return (
    <View style={{ width: 28, height: 26, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name={name} size={focused ? 24 : 22} color={color} />
      {badge !== undefined && badgeColor ? <TabBadge count={badge} color={badgeColor} /> : null}
    </View>
  );
}

export default function TabsLayout() {
  const t = useTheme();
  const insets = useSafeAreaInsets();

  const newEvents = useApp((s) => s.stats.newCount);
  const dueCount = useApp((s) => dueSourcesOf(s.sources).length);
  const failing = useApp((s) => s.sources.filter((x) => x.lastStatus === 'error').length);
  const studioCount = useApp((s) => s.modules.length + s.rules.length);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.color.primary,
        tabBarInactiveTintColor: t.color.textMuted,
        // Height is the icon + label stack plus padding; the safe-area inset is
        // added to both height and bottom padding so the usable box stays the
        // same on a device with a gesture bar as on one without.
        tabBarStyle: {
          backgroundColor: t.color.surface,
          borderTopColor: t.color.border,
          borderTopWidth: 1,
          height: 62 + insets.bottom,
          paddingTop: 8,
          paddingBottom: insets.bottom + 8,
          elevation: 0,
        },
        tabBarIconStyle: { marginBottom: 2 },
        tabBarLabelStyle: {
          fontSize: 11,
          lineHeight: 14,
          fontWeight: '600',
          flexShrink: 0,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Assistant',
          tabBarIcon: ({ color, focused }: { color: ColorValue; focused: boolean }) => (
            <TabIcon name={focused ? 'sparkles' : 'sparkles-outline'} color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="events"
        options={{
          title: 'Agenda',
          tabBarIcon: ({ color, focused }: { color: ColorValue; focused: boolean }) => (
            <TabIcon
              name={focused ? 'calendar' : 'calendar-outline'}
              color={color}
              focused={focused}
              badge={newEvents}
              badgeColor={t.color.accent}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="sources"
        options={{
          title: 'Watchlist',
          tabBarIcon: ({ color, focused }: { color: ColorValue; focused: boolean }) => (
            <TabIcon
              name={focused ? 'eye' : 'eye-outline'}
              color={color}
              focused={focused}
              badge={failing || dueCount}
              badgeColor={failing ? t.color.danger : t.color.warning}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="routines"
        options={{
          title: 'Studio',
          tabBarIcon: ({ color, focused }: { color: ColorValue; focused: boolean }) => (
            <TabIcon
              name={focused ? 'construct' : 'construct-outline'}
              color={color}
              focused={focused}
              badge={studioCount}
              badgeColor={t.color.accent}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, focused }: { color: ColorValue; focused: boolean }) => (
            <TabIcon
              name={focused ? 'settings' : 'settings-outline'}
              color={color}
              focused={focused}
            />
          ),
        }}
      />
    </Tabs>
  );
}
