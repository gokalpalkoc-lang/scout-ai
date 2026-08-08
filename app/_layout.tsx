import * as Notifications from 'expo-notifications';
import { Stack, router, useRootNavigationState } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, AppStateStatus, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Text } from '../src/components/ui';
import * as background from '../src/lib/background';
import { getDb } from '../src/lib/db';
import { syncAllRoutineSchedules } from '../src/lib/engine/routines';
import { setUsageRecorder } from '../src/lib/gemini/client';
import * as notify from '../src/lib/notify';
import { recordUsage } from '../src/lib/usage';
import { errorMessage } from '../src/lib/util';
import { foregroundSweep, useApp } from '../src/store/app';
import { useSettings } from '../src/store/settings';
import { ThemeProvider, useTheme } from '../src/theme';

// Registered at module scope: the background task must be defined on every JS
// start, including the headless one the OS uses to wake the app.
background.defineBackgroundTask();
notify.installNotificationHandler();
setUsageRecorder(recordUsage);

function Splash({ error }: { error?: string | null }) {
  const t = useTheme();
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: t.color.bg,
        padding: t.spacing.xl,
        gap: t.spacing.md,
      }}
    >
      {error ? (
        <>
          <Text variant="subheading" center>
            Scout could not start
          </Text>
          <Text variant="body" tone="muted" center>
            {error}
          </Text>
        </>
      ) : (
        <>
          <ActivityIndicator color={t.color.primary} />
          <Text variant="caption" tone="muted">
            Opening your watchlist…
          </Text>
        </>
      )}
    </View>
  );
}

function Navigator() {
  const t = useTheme();
  return (
    <>
      <StatusBar style={t.scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: t.color.bg },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="onboarding" options={{ animation: 'fade', gestureEnabled: false }} />
        <Stack.Screen name="source/new" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="source/[id]" />
        <Stack.Screen name="event/[id]" />
        <Stack.Screen name="routine/new" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="rule/new" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="module/new" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="module/[id]" />
        <Stack.Screen name="models" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="usage" />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const theme = useSettings((s) => s.theme);
  const hydrated = useSettings((s) => s.hydrated);
  const hasOnboarded = useSettings((s) => s.hasOnboarded);

  const [bootError, setBootError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const appState = useRef<AppStateStatus>(AppState.currentState);
  // Navigating before the root navigator has a key is a no-op, so wait for it.
  const navigationKey = useRootNavigationState()?.key;

  // ------------------------------------------------------------------- boot
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await getDb();
        await useApp.getState().init();
        if (cancelled) return;
        setBooted(true);

        // Best-effort side setup; none of it should block first paint.
        void notify.configureChannels();
        void background.reconcile();
        void syncAllRoutineSchedules();
      } catch (e) {
        if (!cancelled) setBootError(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Send a first-run user to onboarding, once settings are hydrated and the
  // navigator is actually mounted.
  useEffect(() => {
    if (!hydrated || !booted || !navigationKey) return;
    if (!hasOnboarded) router.replace('/onboarding');
  }, [hydrated, booted, hasOnboarded, navigationKey]);

  // ------------------------------------------------- catch up when reopened
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const cameForward = appState.current.match(/inactive|background/) && next === 'active';
      appState.current = next;
      if (cameForward && booted) {
        // The OS may have skipped background wakes; quietly cover the gap.
        void foregroundSweep().catch(() => {});
      }
    });
    return () => sub.remove();
  }, [booted]);

  // ------------------------------------------------- notification deep links
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as
        | { route?: string; sourceId?: string; eventId?: string; routineId?: string }
        | undefined;
      if (!data) return;

      try {
        if (data.eventId) router.push({ pathname: '/event/[id]', params: { id: data.eventId } });
        else if (data.sourceId && data.route?.includes('source'))
          router.push({ pathname: '/source/[id]', params: { id: data.sourceId } });
        else if (data.route === '/events') router.push('/events');
        else if (data.route === '/routines') router.push('/routines');
        else if (data.route === '/studio') router.push('/routines');
        else if (data.route === '/sources') router.push('/sources');
      } catch {
        // A deep link that cannot resolve should never crash the app.
      }
    });
    return () => sub.remove();
  }, []);

  if (!hydrated || (!booted && !bootError)) {
    return (
      <ThemeProvider preference="system">
        <Splash />
      </ThemeProvider>
    );
  }

  if (bootError) {
    return (
      <ThemeProvider preference={theme}>
        <Splash error={bootError} />
      </ThemeProvider>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider preference={theme}>
          <Navigator />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
