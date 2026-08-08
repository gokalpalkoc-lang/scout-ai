import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { EventItem } from '../types';
import { errorMessage, truncate } from '../util';
import { formatEventDate, parseEventDate } from '../util/date';

/**
 * Local notifications only — Scout has no server, so nothing leaves the device.
 * Channels are split so the user can silence page-change noise while keeping
 * deadline reminders loud.
 */

export const CHANNELS = {
  events: 'scout-events',
  changes: 'scout-changes',
  deadlines: 'scout-deadlines',
  digest: 'scout-digest',
} as const;

export type ChannelId = (typeof CHANNELS)[keyof typeof CHANNELS];

let handlerInstalled = false;

export function installNotificationHandler(): void {
  if (handlerInstalled) return;
  handlerInstalled = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
}

export async function configureChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const common = {
    lightColor: '#5B9DF9',
    vibrationPattern: [0, 200],
  };
  await Notifications.setNotificationChannelAsync(CHANNELS.events, {
    ...common,
    name: 'New events',
    description: 'Events found on the pages you watch',
    importance: Notifications.AndroidImportance.HIGH,
  });
  await Notifications.setNotificationChannelAsync(CHANNELS.changes, {
    ...common,
    name: 'Page changes',
    description: 'A watched page changed in a way that matters',
    importance: Notifications.AndroidImportance.DEFAULT,
  });
  await Notifications.setNotificationChannelAsync(CHANNELS.deadlines, {
    ...common,
    name: 'Deadline reminders',
    description: 'Registration and application cutoffs',
    importance: Notifications.AndroidImportance.HIGH,
  });
  await Notifications.setNotificationChannelAsync(CHANNELS.digest, {
    ...common,
    name: 'Daily digest',
    description: 'Scheduled summaries from your routines',
    importance: Notifications.AndroidImportance.LOW,
  });
}

export interface PermissionState {
  granted: boolean;
  canAskAgain: boolean;
  reason?: string;
}

/**
 * Reads the current permission state without prompting.
 *
 * Kept separate from `ensurePermission` so that merely opening Settings never
 * throws a system dialog at the user — the prompt belongs to a deliberate tap.
 */
export async function readPermission(): Promise<PermissionState> {
  if (Platform.OS === 'web') {
    return { granted: false, canAskAgain: false, reason: 'Notifications are not available on web.' };
  }
  try {
    const existing = await Notifications.getPermissionsAsync();
    return {
      granted: existing.granted,
      canAskAgain: existing.canAskAgain,
      reason: existing.granted
        ? undefined
        : existing.canAskAgain
          ? 'Scout has not asked for notification permission yet.'
          : 'Notifications are blocked. Enable them for Scout in the system settings.',
    };
  } catch {
    return { granted: false, canAskAgain: true };
  }
}

export async function ensurePermission(): Promise<PermissionState> {
  if (Platform.OS === 'web') {
    return { granted: false, canAskAgain: false, reason: 'Notifications are not available on web.' };
  }
  if (!Device.isDevice) {
    // Emulators can register but never display; say so rather than failing quietly.
    const existing = await Notifications.getPermissionsAsync();
    return {
      granted: existing.granted,
      canAskAgain: existing.canAskAgain,
      reason: 'Running on an emulator — notifications may not appear.',
    };
  }

  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted) return { granted: true, canAskAgain: false };
  if (!existing.canAskAgain) {
    return {
      granted: false,
      canAskAgain: false,
      reason: 'Notifications are blocked. Enable them for Scout in the system settings.',
    };
  }
  const asked = await Notifications.requestPermissionsAsync();
  return { granted: asked.granted, canAskAgain: asked.canAskAgain };
}

interface NotifyArgs {
  title: string;
  body: string;
  channel: ChannelId;
  /** Deep-link payload consumed by the root layout's response listener. */
  data?: Record<string, unknown>;
}

async function present({ title, body, channel, data }: NotifyArgs): Promise<string | null> {
  try {
    return await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data: data ?? {},
        ...(Platform.OS === 'android' ? { channelId: channel } : {}),
      },
      trigger: null,
    });
  } catch (e) {
    console.warn('[notify] failed to present notification', errorMessage(e));
    return null;
  }
}

/** "3 new events at Salon IKSV" plus the first few titles. */
export async function notifyNewEvents(
  sourceTitle: string,
  sourceId: string,
  events: EventItem[],
): Promise<void> {
  if (!events.length) return;

  const lines = events.slice(0, 4).map((e) => {
    const when = e.startsAt ? formatEventDate(e.startsAt) : 'date TBC';
    return `• ${truncate(e.title, 60)} — ${when}`;
  });
  if (events.length > 4) lines.push(`• and ${events.length - 4} more`);

  await present({
    title:
      events.length === 1
        ? `New at ${truncate(sourceTitle, 30)}`
        : `${events.length} new at ${truncate(sourceTitle, 26)}`,
    body: lines.join('\n'),
    channel: CHANNELS.events,
    data: { route: '/events', sourceId },
  });
}

export async function notifyChange(
  sourceTitle: string,
  sourceId: string,
  headline: string,
  detail: string,
): Promise<void> {
  await present({
    title: truncate(sourceTitle, 40),
    body: detail ? `${headline}\n${truncate(detail, 200)}` : headline,
    channel: CHANNELS.changes,
    data: { route: '/source/[id]', sourceId },
  });
}

export async function notifyDigest(title: string, body: string): Promise<void> {
  await present({ title, body, channel: CHANNELS.digest, data: { route: '/routines' } });
}

export async function notifyError(title: string, body: string): Promise<void> {
  await present({ title, body, channel: CHANNELS.changes, data: { route: '/sources' } });
}

/**
 * Schedules a one-off reminder ahead of a deadline. Returns the notification id
 * so it can be cancelled if the event is deleted or the deadline moves.
 */
export async function scheduleDeadlineReminder(
  event: EventItem,
  daysBefore: number,
): Promise<string | null> {
  const deadline = parseEventDate(event.deadlineAt);
  if (!deadline) return null;

  const fireAt = new Date(deadline.getTime() - daysBefore * 86_400_000);
  // Deadline is already inside the reminder window: fire in a minute instead of
  // silently dropping it.
  const target =
    fireAt.getTime() <= Date.now() + 60_000 ? new Date(Date.now() + 60_000) : fireAt;
  if (deadline.getTime() < Date.now()) return null;

  try {
    return await Notifications.scheduleNotificationAsync({
      content: {
        title: `Deadline ${daysBefore === 0 ? 'today' : `in ${daysBefore} day${daysBefore === 1 ? '' : 's'}`}`,
        body: `${truncate(event.title, 70)}${event.deadlineLabel ? ` — ${event.deadlineLabel}` : ''}`,
        data: { route: '/event/[id]', eventId: event.id },
        ...(Platform.OS === 'android' ? { channelId: CHANNELS.deadlines } : {}),
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: target,
      },
    });
  } catch (e) {
    console.warn('[notify] could not schedule deadline reminder', errorMessage(e));
    return null;
  }
}

/** Recurring notification for a daily/weekly routine. */
export async function scheduleRoutine(
  name: string,
  routineId: string,
  when: { kind: 'daily'; hour: number; minute: number } | { kind: 'weekly'; hour: number; minute: number; weekday: number },
): Promise<string | null> {
  try {
    const trigger =
      when.kind === 'daily'
        ? {
            type: Notifications.SchedulableTriggerInputTypes.DAILY as const,
            hour: when.hour,
            minute: when.minute,
          }
        : {
            type: Notifications.SchedulableTriggerInputTypes.WEEKLY as const,
            weekday: when.weekday,
            hour: when.hour,
            minute: when.minute,
          };

    return await Notifications.scheduleNotificationAsync({
      content: {
        title: truncate(name, 50),
        body: 'Tap to run this routine now.',
        data: { route: '/routines', routineId, runRoutine: routineId },
        ...(Platform.OS === 'android' ? { channelId: CHANNELS.digest } : {}),
      },
      trigger,
    });
  } catch (e) {
    console.warn('[notify] could not schedule routine', errorMessage(e));
    return null;
  }
}

export async function cancel(notificationId: string | null | undefined): Promise<void> {
  if (!notificationId) return;
  try {
    await Notifications.cancelScheduledNotificationAsync(notificationId);
  } catch {
    /* already gone */
  }
}

export async function cancelAll(): Promise<void> {
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch {
    /* ignore */
  }
}

export async function scheduledCount(): Promise<number> {
  try {
    return (await Notifications.getAllScheduledNotificationsAsync()).length;
  } catch {
    return 0;
  }
}
